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
): Promise<PullRequestResponse> {
  return request(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
  );
}
export async function getPullRequestFiles(
  owner: string,
  repo: string,
  number: number,
  expected?: number,
  request: GithubRequester = githubRequest,
): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];
  for (
    let page = 1;
    page <= Math.ceil(GITHUB_FILES_LIMIT / PAGE_SIZE);
    page++
  ) {
    const batch = await request<PullRequestFile[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files?per_page=${PAGE_SIZE}&page=${page}`,
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
): Promise<string | undefined> {
  try {
    const response = await request<{ content?: string; encoding?: string }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/.ai-reviewer-ignore?ref=${encodeURIComponent(baseSha)}`,
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
): Promise<ReviewSource> {
  const pr = await getPullRequest(owner, repo, number, request);
  const [files, policy] = await Promise.all([
    getPullRequestFiles(owner, repo, number, pr.changed_files, request),
    trustedIgnore(owner, repo, pr.base.sha, request),
  ]);
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
