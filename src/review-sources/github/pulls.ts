import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReviewSource } from "../../review/types.js";
import { SourceError, throwIfSourceAborted } from "../errors.js";
import { githubRequest, type GithubRequester } from "./client.js";
import {
  contentsSchema,
  invalidGithubResponse,
  parseGithubResponse,
  pullRequestFileSchema,
  pullRequestSchema,
  type PullRequestFile,
  type PullRequestResponse,
} from "./schemas.js";

const PAGE_SIZE = 100;
const GITHUB_FILES_LIMIT = 3000;
const MAX_PAGES = GITHUB_FILES_LIMIT / PAGE_SIZE;
const PULL_CHANGED_MESSAGE =
  "Pull request changed during collection or returned duplicate files; retry against a stable revision";

const repositoryPath = (owner: string, repo: string) =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export async function getPullRequest(
  owner: string,
  repo: string,
  number: number,
  request: GithubRequester = githubRequest,
  signal?: AbortSignal,
): Promise<PullRequestResponse> {
  return parseGithubResponse(
    pullRequestSchema,
    await request<unknown>(
      `${repositoryPath(owner, repo)}/pulls/${number}`,
      signal,
      { operation: "pull" },
    ),
    "pull request metadata",
  );
}

function incompleteCoverage(detail: string): SourceError {
  return new SourceError({
    kind: "coverage_incomplete",
    source: "github",
    message: `Incomplete GitHub file coverage: ${detail}`,
  });
}

/**
 * Every changed file, page by page. GitHub exposes at most 3000 files; a pull
 * request reporting more is never silently truncated. Cancellation is checked
 * before every page, and a file repeated across pages (a push shifting the
 * pagination) is a revision change, never merged.
 */
export async function getPullRequestFiles(
  owner: string,
  repo: string,
  number: number,
  expected?: number,
  request: GithubRequester = githubRequest,
  signal?: AbortSignal,
): Promise<PullRequestFile[]> {
  if (expected !== undefined && expected > GITHUB_FILES_LIMIT)
    throw incompleteCoverage(
      `PR reports ${expected} changed files but GitHub exposes at most ${GITHUB_FILES_LIMIT}.`,
    );
  const files: PullRequestFile[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    throwIfSourceAborted(signal, "github");
    const batch = parseGithubResponse(
      z.array(pullRequestFileSchema).max(PAGE_SIZE),
      await request<unknown>(
        `${repositoryPath(owner, repo)}/pulls/${number}/files?per_page=${PAGE_SIZE}&page=${page}`,
        signal,
        { operation: "files", page },
      ),
      "pull request files",
    );
    for (const file of batch) {
      if (seen.has(file.filename))
        throw new SourceError({
          kind: "revision_changed",
          source: "github",
          message: PULL_CHANGED_MESSAGE,
          code: "duplicate_files",
        });
      seen.add(file.filename);
      files.push(file);
    }
    if (batch.length < PAGE_SIZE) break;
  }
  if (expected !== undefined && files.length !== expected)
    throw incompleteCoverage(
      `PR reports ${expected} changed files but API returned ${files.length}. GitHub exposes at most ${GITHUB_FILES_LIMIT}.`,
    );
  return files;
}

/** The optional `.ai-reviewer-ignore` at the immutable base revision. */
async function trustedIgnore(
  owner: string,
  repo: string,
  baseSha: string,
  request: GithubRequester,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let raw: unknown;
  try {
    raw = await request<unknown>(
      `${repositoryPath(owner, repo)}/contents/.ai-reviewer-ignore?ref=${encodeURIComponent(baseSha)}`,
      signal,
      { operation: "trusted_policy" },
    );
  } catch (error) {
    // Only GitHub's own 404 for this request means the optional file is absent.
    if (error instanceof SourceError && error.kind === "not_found")
      return undefined;
    throw error;
  }
  const label = "trusted ignore policy";
  const { encoding, content } = parseGithubResponse(contentsSchema, raw, label);
  if (encoding !== "base64")
    throw invalidGithubResponse(label, "unsupported_encoding");
  if (!/^[A-Za-z0-9+/=\r\n]*$/.test(content))
    throw invalidGithubResponse(label, "invalid_base64");
  const text = Buffer.from(content.replace(/\r?\n/g, ""), "base64").toString(
    "utf8",
  );
  return text || undefined;
}

export async function getGithubReviewSource(
  owner: string,
  repo: string,
  number: number,
  request: GithubRequester = githubRequest,
  signal?: AbortSignal,
): Promise<ReviewSource> {
  const pr = await getPullRequest(owner, repo, number, request, signal);
  // Cheap fail before any pagination: the API cannot expose these files.
  if (pr.changed_files > GITHUB_FILES_LIMIT)
    throw incompleteCoverage(
      `PR reports ${pr.changed_files} changed files but GitHub exposes at most ${GITHUB_FILES_LIMIT}.`,
    );
  // Sequential on purpose: a failure or abort never leaves a sibling request running.
  const files = await getPullRequestFiles(
    owner,
    repo,
    number,
    undefined,
    request,
    signal,
  );
  const policy = await trustedIgnore(owner, repo, pr.base.sha, request, signal);
  // File pagination follows a mutable PR. A count alone cannot detect a push,
  // so the metadata is read again; retries inside the requests above never
  // weaken this: the snapshot is valid only if it is unchanged at the end.
  const confirmed = await getPullRequest(owner, repo, number, request, signal);
  if (
    confirmed.base.sha !== pr.base.sha ||
    confirmed.head.sha !== pr.head.sha ||
    confirmed.changed_files !== pr.changed_files
  )
    throw new SourceError({
      kind: "revision_changed",
      source: "github",
      message: PULL_CHANGED_MESSAGE,
    });
  if (files.length !== pr.changed_files)
    throw incompleteCoverage(
      `PR reports ${pr.changed_files} changed files but API returned ${files.length}. GitHub exposes at most ${GITHUB_FILES_LIMIT}.`,
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
