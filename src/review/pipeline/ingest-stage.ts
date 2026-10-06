import { emitEvent } from "../../observability/events.js";
import { isMandatorySensitivePath } from "../../privacy/policy.js";
import { localContextIdentity } from "../context-identity.js";
import { createGithubRequester } from "../../review-sources/github/client.js";
import { getGithubReviewSource } from "../../review-sources/github/pulls.js";
import {
  getLocalDiff,
  resolveRepositoryRoot,
} from "../../review-sources/local/local.js";
import {
  isIgnoredPath,
  loadIgnorePolicy,
  type LoadedIgnore,
} from "../ignore.js";
import type { ReviewError, ReviewSource } from "../types.js";
import { ingestFailure } from "./ingest-errors.js";
import { sourceEventSink } from "./source-events.js";
import type { PipelineContext } from "./types.js";

export type IngestOutcome =
  | {
      ok: true;
      source: ReviewSource;
      /** Local mode loads the checkout's ignore file while collecting. */
      localPolicy?: LoadedIgnore;
    }
  | { ok: false; error: ReviewError };

async function collectSource(
  ctx: PipelineContext,
): Promise<{ source: ReviewSource; localPolicy?: LoadedIgnore }> {
  const { target } = ctx.request;
  if (target.kind === "pull-request") {
    // GitHub reads are operational source calls: they never touch the AI
    // request budget; bounds come from the retry policy and the total deadline.
    const github = createGithubRequester({
      ...ctx.githubSeams,
      requestTimeoutMs: ctx.config.requestTimeoutMs,
      remainingMs: () => ctx.deadlineAt - ctx.now(),
      onEvent: sourceEventSink(ctx, "github"),
    });
    const source = await getGithubReviewSource(
      target.owner,
      target.repo,
      target.pullNumber,
      github,
      ctx.signal,
    );
    if (target.localRepoPath) {
      // `owner/repo` stays the source's identity; retrieval is keyed by the checkout.
      const root = await resolveRepositoryRoot(
        target.localRepoPath,
        ctx.signal,
      );
      source.repositoryRoot = root;
      source.contextIdentity = localContextIdentity(root);
    }
    return { source };
  }
  const root = await resolveRepositoryRoot(target.localRepoPath, ctx.signal);
  const localPolicy = await loadIgnorePolicy(root);
  const source = await getLocalDiff(target.baseRef, root, {
    // Sensitive and user-ignored paths are rejected before their bytes are read.
    pathAllowed: (filename) =>
      !isMandatorySensitivePath(filename) &&
      !isIgnoredPath(filename, localPolicy),
    signal: ctx.signal,
  });
  return { source, localPolicy };
}

/** Stage 1: obtain the source from the Git/GitHub adapters (or an override). */
export async function ingestStage(
  ctx: PipelineContext,
): Promise<IngestOutcome> {
  const started = ctx.now();
  emitEvent(ctx.events, ctx.runId, "ingest", "start");
  try {
    const collected = ctx.sourceOverride
      ? { source: ctx.sourceOverride }
      : await collectSource(ctx);
    emitEvent(ctx.events, ctx.runId, "ingest", "complete", {
      durationMs: ctx.now() - started,
      data: {
        revision: collected.source.snapshotId,
        files: collected.source.files.length,
        coverageComplete: collected.source.coverageComplete,
      },
    });
    return { ok: true, ...collected };
  } catch (error) {
    const failure = ingestFailure(error, ctx.signal.aborted);
    emitEvent(ctx.events, ctx.runId, "ingest", "error", {
      durationMs: ctx.now() - started,
      message: failure.message,
      ...(failure.code
        ? {
            data: {
              code: failure.code,
              retryable: failure.retryable ?? false,
            },
          }
        : {}),
    });
    return { ok: false, error: failure };
  }
}
