import { randomUUID } from "node:crypto";
import type { ReviewConfig } from "../../config/config.js";
import { ExternalRequestBudget } from "../../model/budget.js";
import { emitEvent, noOpEventSink } from "../../observability/events.js";
import type { ReviewResult } from "../types.js";
import { aggregateOutcomes } from "./aggregate.js";
import { analyzeStage } from "./analyze-stage.js";
import { contextStage } from "./context-stage.js";
import { filterStage } from "./filter-stage.js";
import {
  assembleResult,
  finalizeDryRun,
  finalizeIndexOnly,
  finalizeReview,
  withRunMetrics,
} from "./finalize-stage.js";
import { ingestStage } from "./ingest-stage.js";
import { requestBudgetProblem } from "../request-plan.js";
import { createBaseResult, failedResult, sourceSummary } from "./result.js";
import type {
  PipelineContext,
  ReviewRunRequest,
  ReviewRuntime,
} from "./types.js";

/**
 * ingest -> filter/policy -> repository context -> analyze -> finalize.
 *
 * Each stage is a plain function over explicit inputs that returns a value;
 * this function only sequences them and decides when to stop early.
 */
type Staged = { result: ReviewResult; finalizeMs: number };
const done = (result: ReviewResult, finalizeMs = 0): Staged => ({
  result,
  finalizeMs,
});
function finalizing(ctx: PipelineContext, build: () => ReviewResult): Staged {
  const started = ctx.now();
  const result = build();
  return done(result, ctx.now() - started);
}

async function runStages(ctx: PipelineContext): Promise<Staged> {
  const { request, config } = ctx;
  const base = createBaseResult(ctx.runId, request, {
    provider: ctx.model?.provider ?? "none",
    name: config.model,
  });

  const budgetProblem = requestBudgetProblem(config);
  if (budgetProblem)
    return done(
      failedResult(
        base,
        { stage: "config", message: budgetProblem, fatal: true },
        `Review failed: the request budget is not workable. ${budgetProblem}`,
      ),
    );

  if (!ctx.model && !request.dryRun && !request.indexOnly)
    return done(
      failedResult(
        base,
        {
          stage: "config",
          message: config.allowExternal
            ? "No review model was supplied to the pipeline; providers are composed by the CLI bootstrap."
            : "External model transmission is disabled. Set AI_REVIEW_ALLOW_EXTERNAL=true and pass --allow-external, or use --dry-run.",
          fatal: true,
        },
        "Review failed: external transmission was not explicitly authorized.",
      ),
    );

  const ingested = await ingestStage(ctx);
  if (!ingested.ok)
    return done(
      failedResult(
        base,
        ingested.error,
        `Ingestion failed: ${ingested.error.message}`,
      ),
    );
  const { source } = ingested;

  const filtered = await filterStage(ctx, source, ingested.localPolicy);
  if (!filtered.ok)
    return done(
      failedResult(
        { ...base, source: sourceSummary(source) },
        filtered.error,
        `Filtering failed: ${filtered.error.message}`,
      ),
    );

  const context = await contextStage(ctx, source, filtered.policy);
  const prepared = assembleResult(base, source, filtered, context);

  if (request.indexOnly)
    return finalizing(ctx, () => finalizeIndexOnly(prepared, context));
  if (request.dryRun)
    return finalizing(ctx, () =>
      finalizeDryRun(prepared, ctx, source, filtered.files, filtered.skipped),
    );

  const outcomes = await analyzeStage(ctx, {
    source,
    files: filtered.files,
    context,
  });
  return finalizing(ctx, () =>
    finalizeReview(prepared, source, aggregateOutcomes(outcomes)),
  );
}

/**
 * Run one review. Core entry point: it takes an application request plus
 * already-composed runtime ports and never reads CLI arguments or constructs a
 * provider.
 */
export async function executeReviewPipeline(
  request: ReviewRunRequest,
  config: ReviewConfig,
  runtime: ReviewRuntime = {},
): Promise<ReviewResult> {
  const runId = randomUUID();
  const events = runtime.events ?? noOpEventSink;
  const now = runtime.now ?? Date.now;
  const started = now();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), config.totalTimeoutMs);
  timer.unref?.();
  const ctx: PipelineContext = {
    runId,
    request,
    config,
    model: runtime.model,
    embedding: runtime.embedding,
    sourceOverride: runtime.source,
    events,
    now,
    signal: deadline.signal,
    deadlineAt: started + config.totalTimeoutMs,
    embeddingSeams: runtime.embeddingExecution,
    githubSeams: runtime.github,
    budget: new ExternalRequestBudget(config.maxRequests, deadline.signal),
  };
  let result: ReviewResult | undefined;
  try {
    const staged = await runStages(ctx);
    result = withRunMetrics(staged.result, ctx, now() - started);
    emitEvent(events, runId, "finalize", "complete", {
      durationMs: result.usage.latencyMs,
      message: result.status,
      data: {
        finalizeMs: staged.finalizeMs,
        revision: result.source?.snapshotId ?? "unavailable",
        discovered: result.coverage.discovered,
        eligible: result.coverage.eligible,
        reviewed: result.coverage.reviewed,
        failed: result.coverage.failed,
        skipped: result.coverage.skipped,
        omitted: result.coverage.omitted,
        truncated: result.coverage.truncated,
        requests: result.usage.requests,
        attempts: result.usage.attempts,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        actualRequests: result.usage.actualRequests,
        cacheHits: result.usage.cacheHits,
      },
    });
    return result;
  } finally {
    clearTimeout(timer);
    if (!result)
      emitEvent(events, runId, "finalize", "error", {
        durationMs: now() - started,
        message: "pipeline terminated by an unexpected exception",
      });
  }
}
