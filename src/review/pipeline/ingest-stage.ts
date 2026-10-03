import { emitEvent } from "../../observability/events.js";
import { isMandatorySensitivePath } from "../../privacy/policy.js";
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
import { errorMessage } from "./result.js";
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
    const source = await getGithubReviewSource(
      target.owner,
      target.repo,
      target.pullNumber,
      undefined,
      ctx.signal,
    );
    if (target.localRepoPath)
      source.repositoryRoot = await resolveRepositoryRoot(
        target.localRepoPath,
        ctx.signal,
      );
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
    emitEvent(ctx.events, ctx.runId, "ingest", "error", {
      durationMs: ctx.now() - started,
      message: errorMessage(error),
    });
    return {
      ok: false,
      error: { stage: "ingest", message: errorMessage(error), fatal: true },
    };
  }
}
