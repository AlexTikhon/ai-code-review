import { createHash } from "node:crypto";
import { githubRequest, type GithubRequester } from "./client.js";
import type { PullRequestFile, PullRequestResponse } from "../types.js";
import type { ReviewSource } from "../../review/types.js";
const PAGE_SIZE = 100;
const GITHUB_FILES_LIMIT = 3000;
export async function getPullRequest(
  owner: string,
  repo: string,
  number: number,
  request: GithubRequester = githubRequest,
  signal?: AbortSignal,
): Promise<PullRequestResponse> {
  return request(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
    signal,
  );
}
export async function getPullRequestFiles(
  owner: string,
  repo: string,
  number: number,
  expected?: number,
  request: GithubRequester = githubRequest,
  signal?: AbortSignal,
): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];
  for (
    let page = 1;
    page <= Math.ceil(GITHUB_FILES_LIMIT / PAGE_SIZE);
    page++
  ) {
    const batch = await request<PullRequestFile[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files?per_page=${PAGE_SIZE}&page=${page}`,
      signal,
    );
    files.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  if (expected !== undefined && files.length !== expected)
    throw new Error(
      `Incomplete GitHub file coverage: PR reports ${expected} changed files but API returned ${files.length}. GitHub exposes at most ${GITHUB_FILES_LIMIT}.`,
    );
  return files;
}
async function trustedIgnore(
  owner: string,
  repo: string,
  baseSha: string,
  request: GithubRequester,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await request<{ content?: string; encoding?: string }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/.ai-reviewer-ignore?ref=${encodeURIComponent(baseSha)}`,
      signal,
    );
    return response.content && response.encoding === "base64"
      ? Buffer.from(response.content.replace(/\n/g, ""), "base64").toString(
          "utf8",
        )
      : undefined;
  } catch (error) {
    if (String(error).includes("404")) return undefined;
    throw new Error(
      `Unable to load trusted base-revision ignore policy: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
export async function getGithubReviewSource(
  owner: string,
  repo: string,
  number: number,
  request: GithubRequester = githubRequest,
  signal?: AbortSignal,
): Promise<ReviewSource> {
  const pr = await getPullRequest(owner, repo, number, request, signal);
  const [files, policy] = await Promise.all([
    getPullRequestFiles(owner, repo, number, pr.changed_files, request, signal),
    trustedIgnore(owner, repo, pr.base.sha, request, signal),
  ]);
  // File pagination follows a mutable PR. A count alone cannot detect a push.
  const confirmed = await getPullRequest(owner, repo, number, request, signal);
  if (
    confirmed.base.sha !== pr.base.sha ||
    confirmed.head.sha !== pr.head.sha ||
    confirmed.changed_files !== pr.changed_files ||
    new Set(files.map((file) => file.filename)).size !== files.length
  )
    throw new Error(
      "Pull request changed during collection or returned duplicate files; retry against a stable revision",
    );
  return {
    mode: "pr",
    title: pr.title,
    description: pr.body ?? "",
    repositoryId: `${owner.toLowerCase()}/${repo.toLowerCase()}`,
    baseRevision: pr.base.sha,
    headRevision: pr.head.sha,
    snapshotId: createHash("sha256")
      .update(`${pr.base.sha}:${pr.head.sha}`)
      .digest("hex"),
    files: files.map((f) => ({
      filename: f.filename,
      previousFilename: f.previous_filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch,
    })),
    coverageComplete: true,
    trustedIgnoreContents: policy,
  };
}
