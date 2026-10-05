import {
  DEFAULT_EMBEDDING_RETRY_POLICY,
  type EmbeddingExecutionEvent,
  type EmbeddingExecutionOptions,
} from "../../retrieval/embedding-execution.js";
import { emitEvent, type ReviewEvent } from "../../observability/events.js";
import type { PipelineContext } from "./types.js";

const EVENT: Record<
  EmbeddingExecutionEvent["type"],
  { type: ReviewEvent["type"]; message: string }
> = {
  request_started: { type: "request", message: "embedding.request_started" },
  request_retry: { type: "warning", message: "embedding.request_retry" },
  request_succeeded: {
    type: "complete",
    message: "embedding.request_succeeded",
  },
  request_failed: { type: "error", message: "embedding.request_failed" },
};

/**
 * How this run executes embedding requests: the configured retry policy, the
 * per-attempt timeout, the total deadline, and value-free diagnostics. The
 * budget itself is reserved through each caller's `beforeEmbeddingRequest`, so
 * that every provider attempt, retries included, is counted exactly once.
 */
export function embeddingExecutionFor(
  ctx: PipelineContext,
): EmbeddingExecutionOptions {
  const retry = ctx.config.embeddingRetry;
  return {
    ...ctx.embeddingSeams,
    policy: {
      maxAttempts:
        retry?.maxAttempts ?? DEFAULT_EMBEDDING_RETRY_POLICY.maxAttempts,
      baseDelayMs:
        retry?.baseDelayMs ?? DEFAULT_EMBEDDING_RETRY_POLICY.baseDelayMs,
      maxDelayMs: DEFAULT_EMBEDDING_RETRY_POLICY.maxDelayMs,
    },
    attemptTimeoutMs: ctx.config.requestTimeoutMs,
    budgetRemaining: () => ctx.budget.remaining,
    remainingMs: () => ctx.deadlineAt - ctx.now(),
    // Counts, kinds and timings only: never texts, vectors or provider bodies.
    onEvent: ({ type, durationMs, attempt, ...data }) =>
      emitEvent(ctx.events, ctx.runId, "embedding", EVENT[type].type, {
        message: EVENT[type].message,
        attempt,
        ...(durationMs !== undefined ? { durationMs } : {}),
        data: Object.fromEntries(
          Object.entries(data).filter(([, value]) => value !== undefined),
        ) as Record<string, string | number | boolean>,
      }),
  };
}
