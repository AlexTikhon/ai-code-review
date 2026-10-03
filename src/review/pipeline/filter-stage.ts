import { emitEvent } from "../../observability/events.js";
import { filterReviewFiles, ignoreFromTrustedContents } from "../filter.js";
import { loadIgnorePolicy, type LoadedIgnore } from "../ignore.js";
import type {
  ReviewError,
  ReviewSource,
  ReviewableFile,
  SkippedFile,
} from "../types.js";
import { errorMessage } from "./result.js";
import type { PipelineContext } from "./types.js";

export type FilterOutcome =
  | {
      ok: true;
      /** The trusted ignore policy that governed filtering (and indexing). */
      policy: LoadedIgnore;
      files: ReviewableFile[];
      skipped: SkippedFile[];
      eligible: number;
      omitted: number;
      truncated: number;
      /** Non-fatal notes, e.g. incomplete source coverage. */
      errors: ReviewError[];
    }
  | { ok: false; error: ReviewError };

/**
 * Trusted policy selection. PR mode only ever uses the base-revision policy
 * fetched by the adapter; the proposed PR contents can never relax it.
 */
async function resolvePolicy(
  source: ReviewSource,
  localPolicy: LoadedIgnore | undefined,
): Promise<LoadedIgnore> {
  if (source.mode === "pr")
    return ignoreFromTrustedContents(source.trustedIgnoreContents);
  if (localPolicy) return localPolicy;
  return source.repositoryRoot
    ? loadIgnorePolicy(source.repositoryRoot)
    : ignoreFromTrustedContents();
}

/** Stage 2: apply privacy, ignore, file-type and work-limit policy. */
export async function filterStage(
  ctx: PipelineContext,
  source: ReviewSource,
  localPolicy: LoadedIgnore | undefined,
): Promise<FilterOutcome> {
  const started = ctx.now();
  let policy: LoadedIgnore;
  try {
    policy = await resolvePolicy(source, localPolicy);
  } catch (error) {
    emitEvent(ctx.events, ctx.runId, "filter", "error", {
      durationMs: ctx.now() - started,
      message: errorMessage(error),
    });
    return {
      ok: false,
      error: { stage: "filter", message: errorMessage(error), fatal: true },
    };
  }
  const filtered = filterReviewFiles(source, policy, ctx.config);
  const errors: ReviewError[] = source.coverageComplete
    ? []
    : [
        {
          stage: "ingest",
          message: source.coverageError ?? "Source coverage is incomplete",
          fatal: false,
        },
      ];
  const outcome = {
    ok: true as const,
    policy,
    files: filtered.files,
    skipped: filtered.skipped,
    eligible: filtered.eligible,
    omitted: filtered.omitted,
    truncated: filtered.files.filter((file) => file.truncated).length,
    errors,
  };
  emitEvent(ctx.events, ctx.runId, "filter", "complete", {
    durationMs: ctx.now() - started,
    data: {
      discovered: source.files.length,
      eligible: outcome.eligible,
      skipped: outcome.skipped.length - outcome.omitted,
    },
  });
  return outcome;
}
