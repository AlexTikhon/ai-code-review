import {
  contextAllowanceTokens,
  estimateSegmentRequest,
} from "../request-plan.js";
import type { ReviewConfig } from "../../config/config.js";
import type {
  ReviewResult,
  ReviewSource,
  ReviewableFile,
  SkippedFile,
  Usage,
} from "../types.js";
import type { AnalysisSummary } from "./aggregate.js";
import type { ContextOutcome } from "./context-stage.js";
import type { FilterOutcome } from "./filter-stage.js";
import { sourceSummary } from "./result.js";
import type { PipelineContext } from "./types.js";

type FilterSuccess = Extract<FilterOutcome, { ok: true }>;

/**
 * Fold the ingest, filter and context stages into the result every later
 * outcome (index-only, dry-run, full review) is derived from.
 */
export function assembleResult(
  base: ReviewResult,
  source: ReviewSource,
  filter: FilterSuccess,
  context: ContextOutcome,
): ReviewResult {
  return {
    ...base,
    source: sourceSummary(source),
    coverage: {
      ...base.coverage,
      discovered: source.files.length,
      eligible: filter.eligible,
      omitted: filter.omitted,
      skipped: filter.skipped.length - filter.omitted,
      truncated: filter.truncated,
    },
    skippedFiles: filter.skipped,
    errors: [...base.errors, ...filter.errors, ...context.errors],
    context: context.context,
  };
}

export function finalizeIndexOnly(
  result: ReviewResult,
  context: ContextOutcome,
): ReviewResult {
  const indexed = Boolean(context.prepared);
  return {
    ...result,
    status: indexed || result.context.mode === "diff" ? "complete" : "failed",
    summary: indexed
      ? `Indexed ${context.chunkCount} repository context chunks at ${context.indexLocation}.`
      : "No index was created.",
  };
}

/**
 * Per-file figures from the same planner and renderers execution uses. The
 * segments are the plan itself (filter stage); only sizes are derived here.
 */
function proposedFiles(
  source: ReviewSource,
  files: readonly ReviewableFile[],
  config: ReviewConfig,
  withContext: boolean,
) {
  return files.map((file) => {
    const sizes = file.segments.map((segment) => {
      const mandatory = estimateSegmentRequest(
        {
          title: source.title,
          description: source.description,
          filename: file.filename,
          fileType: file.fileType,
        },
        segment,
        config,
      );
      return {
        mandatory,
        context: withContext ? contextAllowanceTokens(mandatory, config) : 0,
      };
    });
    return {
      filename: file.filename,
      segments: file.segments.length,
      estimatedInputTokens: sizes.reduce((sum, s) => sum + s.mandatory, 0),
      contextTokenBound: sizes.reduce((sum, s) => sum + s.context, 0),
    };
  });
}

/** The privacy-reviewable manifest. Makes, and implies, no provider call. */
export function finalizeDryRun(
  result: ReviewResult,
  ctx: PipelineContext,
  source: ReviewSource,
  files: readonly ReviewableFile[],
  omissions: SkippedFile[],
): ReviewResult {
  // Context can enrich a request only when an index was actually prepared.
  const proposed = proposedFiles(
    source,
    files,
    ctx.config,
    result.context.state === "used",
  );
  const estimatedInputTokens = proposed.reduce(
    (sum, item) => sum + item.estimatedInputTokens,
    0,
  );
  const contextTokenBound = proposed.reduce(
    (sum, item) => sum + item.contextTokenBound,
    0,
  );
  const { config } = ctx;
  return {
    ...result,
    status: "partial",
    dryRun: {
      proposedFiles: proposed,
      omissions,
      destinations: [
        "local cache",
        ...(config.allowExternal
          ? [`${result.model.provider}:${config.model}`]
          : ["external model disabled"]),
        ...(config.allowEmbeddings
          ? [
              `${ctx.embedding?.provider ?? "openai"}:${ctx.embedding?.model ?? config.embeddingModel}`,
            ]
          : []),
      ],
      estimatedRequests: proposed.reduce((sum, item) => sum + item.segments, 0),
      estimatedInputTokens,
      contextTokenBound,
      inputTokenBound: estimatedInputTokens + contextTokenBound,
      estimateBasis:
        "Planned logical requests and conservative application-level input estimates (UTF-8 bytes plus response schema and message framing), not provider billing-token counts. estimatedInputTokens covers the mandatory diff request only; with repository context each request may add up to its context bound, which depends on retrieval and is not known without calling it. Cache hits and retries are not predicted.",
    },
    summary: `Dry run: ${files.length} file(s) proposed, ${omissions.length} omitted. No model or embedding calls were made.`,
  };
}

/** Merge aggregated analysis into the result and decide status and summary. */
export function finalizeReview(
  result: ReviewResult,
  source: ReviewSource,
  analysis: AnalysisSummary,
): ReviewResult {
  const coverage = { ...result.coverage, ...analysis.coverage };
  const incomplete =
    !source.coverageComplete ||
    coverage.failed > 0 ||
    coverage.omitted > 0 ||
    coverage.truncated > 0 ||
    (result.context.mode !== "diff" && result.context.state === "unavailable");
  const status: ReviewResult["status"] =
    coverage.eligible > 0 && coverage.reviewed === 0
      ? "failed"
      : incomplete
        ? "partial"
        : "complete";
  const merged: ReviewResult = {
    ...result,
    coverage,
    status,
    findings: analysis.findings,
    abstentions: analysis.abstentions,
    errors: [...result.errors, ...analysis.errors],
    context: {
      ...result.context,
      selected: [...result.context.selected, ...analysis.selectedContext],
    },
    usage: { ...result.usage, ...analysis.usage },
    summary: "",
  };
  if (coverage.discovered === 0)
    return {
      ...merged,
      status: "complete",
      summary:
        "No changed files were discovered; no clean-code claim was made.",
    };
  if (coverage.eligible === 0)
    return {
      ...merged,
      summary: `${status === "complete" ? "Review policy applied completely" : "Review coverage incomplete"}: no files were eligible (${coverage.skipped} intentionally excluded); no clean-code claim was made.`,
    };
  if (coverage.reviewed === 0)
    return {
      ...merged,
      summary: `No eligible files were fully reviewed (${coverage.omitted} omitted, ${coverage.failed} failed); the input is unreviewed, not clean.`,
    };
  return {
    ...merged,
    summary: `${status === "complete" ? "Review complete" : "Review partial"}: reviewed ${coverage.reviewed}/${coverage.eligible} eligible file(s), found ${analysis.findings.length} validated issue(s), intentionally skipped ${coverage.skipped}, omitted ${coverage.omitted}, truncated ${coverage.truncated}.`,
  };
}

/** Counters that come from the run, not from any one stage. */
export function withRunMetrics(
  result: ReviewResult,
  ctx: PipelineContext,
  latencyMs: number,
): ReviewResult {
  const usage: Usage = {
    ...result.usage,
    actualRequests: ctx.budget.consumed,
    embeddingRequests: ctx.budget.consumedBy("embedding"),
    latencyMs,
  };
  return { ...result, usage };
}
