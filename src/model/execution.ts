import { setTimeout as delay } from "node:timers/promises";
import type { EventSink } from "../observability/events.js";
import { emitEvent } from "../observability/events.js";
import { RequestBudgetError } from "./budget.js";
import { ReviewModelError, modelErrorCode } from "./errors.js";
import type { ModelRequest, ModelResult, ReviewModel } from "./types.js";

/** Failure data, never a throw: callers learn the attempts actually made. */
export type ModelExecution =
  | { ok: true; result: ModelResult; attempts: number }
  | {
      ok: false;
      error: ReviewModelError | RequestBudgetError;
      /** Provider attempts that were actually started. */
      attempts: number;
    };

const MAX_RETRY_AFTER_MS = 10_000;

function backoffMs(error: ReviewModelError, attempt: number): number {
  return error.retryAfterMs
    ? Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS)
    : Math.min(250 * 2 ** (attempt - 1), 2000);
}

/**
 * The one retry layer. It consumes only normalized ReviewModelError metadata:
 * an attempt is retried iff the error is `retryable`, attempts remain, and
 * neither the attempt's own timeout nor the total deadline has fired. Every
 * attempt, including a retry, passes through `beforeAttempt` (the request
 * budget), so nothing reaches a provider without being counted.
 */
export async function executeModel(input: {
  model: ReviewModel;
  request: ModelRequest;
  runId: string;
  filename: string;
  maxAttempts: number;
  requestTimeoutMs: number;
  totalSignal: AbortSignal;
  events: EventSink;
  beforeAttempt?: () => void;
}): Promise<ModelExecution> {
  const provider = input.model.provider;
  const deadlineError = () =>
    new ReviewModelError({
      kind: "aborted",
      provider,
      message: "Total review deadline exceeded",
    });
  const fail = (
    error: ReviewModelError | RequestBudgetError,
    attempts: number,
  ): ModelExecution => {
    if (error instanceof ReviewModelError)
      emitEvent(input.events, input.runId, "analyze", "error", {
        filename: input.filename,
        attempt: attempts,
        message: modelErrorCode(error.kind),
        data: {
          kind: error.kind,
          provider: error.provider,
          retryable: error.retryable,
          ...(error.statusCode !== undefined
            ? { statusCode: error.statusCode }
            : {}),
        },
      });
    return { ok: false, error, attempts };
  };

  for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
    if (input.totalSignal.aborted) return fail(deadlineError(), attempt - 1);
    const requestSignal = AbortSignal.any([
      input.totalSignal,
      AbortSignal.timeout(input.requestTimeoutMs),
    ]);
    try {
      input.beforeAttempt?.();
    } catch (error) {
      if (error instanceof RequestBudgetError) return fail(error, attempt - 1);
      if (input.totalSignal.aborted) return fail(deadlineError(), attempt - 1);
      throw error;
    }
    emitEvent(input.events, input.runId, "analyze", "request", {
      filename: input.filename,
      attempt,
    });
    let failure: ReviewModelError;
    try {
      return {
        ok: true,
        result: await input.model.review(input.request, requestSignal),
        attempts: attempt,
      };
    } catch (error) {
      failure =
        error instanceof ReviewModelError
          ? error
          : // An adapter that leaks a raw error is a bug; do not echo it.
            new ReviewModelError({
              kind: "unknown",
              provider,
              message: `${provider} adapter raised an unclassified error`,
            });
    }
    if (input.totalSignal.aborted) return fail(deadlineError(), attempt);
    // An attempt whose own timeout fired is not retried: the provider may
    // still be processing it, and a second copy would be a second charge.
    const retry =
      failure.retryable &&
      attempt < input.maxAttempts &&
      !requestSignal.aborted;
    if (!retry) return fail(failure, attempt);
    const waitMs = backoffMs(failure, attempt);
    emitEvent(input.events, input.runId, "analyze", "warning", {
      filename: input.filename,
      attempt,
      message: `retry after ${modelErrorCode(failure.kind)}`,
      data: { kind: failure.kind, provider, waitMs },
    });
    try {
      await delay(waitMs, undefined, { signal: input.totalSignal });
    } catch {
      return fail(deadlineError(), attempt);
    }
  }
  // maxAttempts < 1: nothing was attempted.
  return fail(
    new ReviewModelError({
      kind: "invalid_request",
      provider,
      message: "No model attempt was allowed (maxAttempts < 1)",
    }),
    0,
  );
}
