import { setTimeout as delay } from "node:timers/promises";
import { RequestBudgetError } from "../model/budget.js";
import {
  EmbeddingError,
  abortedEmbeddingError,
  type EmbeddingErrorKind,
} from "./embedding-errors.js";
import { validateEmbeddingBatch, type EmbeddingAdapter } from "./embeddings.js";

/** Bounds on how an embedding request is retried. Conservative by default. */
export type EmbeddingRetryPolicy = {
  /** Provider attempts per request, the first one included. */
  maxAttempts: number;
  /** Backoff step: waits are base, 2 x base, 4 x base ... up to maxDelayMs. */
  baseDelayMs: number;
  /** Upper bound on any single wait, including a provider's Retry-After. */
  maxDelayMs: number;
};

export const DEFAULT_EMBEDDING_RETRY_POLICY: EmbeddingRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 10_000,
};

export function validateEmbeddingRetryPolicy(
  policy: EmbeddingRetryPolicy,
): EmbeddingRetryPolicy {
  const { maxAttempts, baseDelayMs, maxDelayMs } = policy;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
    throw new Error(
      "Embedding retry policy: maxAttempts must be an integer >= 1",
    );
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0)
    throw new Error(
      "Embedding retry policy: baseDelayMs must be finite and >= 0",
    );
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs)
    throw new Error(
      "Embedding retry policy: maxDelayMs must be finite and >= baseDelayMs",
    );
  return policy;
}

/**
 * How long to wait before the next attempt, after `attempt` failed.
 *
 * A valid provider Retry-After is honored exactly, clamped to maxDelayMs, and
 * not jittered (the provider already chose the moment). Otherwise: capped
 * exponential backoff with "equal jitter", uniform in [step/2, step], so
 * clients that failed together do not retry together and the wait never drops
 * below half the step. `random` is injected so tests are deterministic.
 */
export function retryDelayMs(input: {
  attempt: number;
  policy: EmbeddingRetryPolicy;
  retryAfterMs?: number;
  random?: () => number;
}): number {
  const { policy } = input;
  const retryAfter = input.retryAfterMs;
  if (retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter > 0)
    return Math.min(Math.ceil(retryAfter), policy.maxDelayMs);
  const step = Math.min(
    policy.baseDelayMs * 2 ** Math.min(input.attempt - 1, 30),
    policy.maxDelayMs,
  );
  const random = Math.min(1, Math.max(0, (input.random ?? Math.random)()));
  return Math.floor(step / 2 + (random * step) / 2);
}

/** One value-free progress note per request lifecycle step: counts and kinds only. */
export type EmbeddingExecutionEvent = {
  type:
    | "request_started"
    | "request_retry"
    | "request_succeeded"
    | "request_failed";
  provider: string;
  model: string;
  /** 1-based provider attempt this note is about. */
  attempt: number;
  batchSize: number;
  durationMs?: number;
  /** An EmbeddingErrorKind, or "budget_exhausted" (not a provider failure). */
  errorKind?: EmbeddingErrorKind | "budget_exhausted";
  retryable?: boolean;
  statusCode?: number;
  retryAfterMs?: number;
  /** Delay before the next attempt, on `request_retry`. */
  waitMs?: number;
  budgetRemaining?: number;
};

export type EmbeddingExecutionOptions = {
  policy?: EmbeddingRetryPolicy;
  /** Per-attempt timeout. The caller's signal is the overall deadline. */
  attemptTimeoutMs?: number;
  /** Budget remaining after the last reservation, for diagnostics only. */
  budgetRemaining?: () => number;
  /** Time left before the overall deadline; a retry that cannot fit is skipped. */
  remainingMs?: () => number;
  onEvent?: (event: EmbeddingExecutionEvent) => void;
  /** Test seams: wait, jitter source and clock. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

export type EmbeddingExecution = {
  vectors: number[][];
  dimensions: number;
  /** Provider attempts actually started, retries included. */
  attempts: number;
};

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  delay(ms, undefined, signal ? { signal } : undefined).then(() => undefined);

/**
 * The single retry owner for embedding requests. One adapter.embed() call is
 * one provider attempt and one budget unit; nothing below this function
 * retries. Per attempt:
 *
 *   assertReady (misconfiguration costs nothing)
 *     -> reserve budget (only now, never ahead of a wait)
 *     -> adapter.embed under a fresh attempt-timeout signal
 *     -> validate the answer against the request
 *
 * A failure is retried iff it is retryable, attempts remain, the caller's
 * signal (cancellation / total deadline) is still live and the wait fits in
 * the time left. The attempt's own timeout is retryable; the overall deadline
 * never is. Failures are thrown typed: EmbeddingError for the provider
 * domain, RequestBudgetError for the application's own cap.
 */
export async function executeEmbeddingRequest(
  input: {
    adapter: EmbeddingAdapter;
    texts: string[];
    signal?: AbortSignal;
    /** Reserves one unit of the request budget; throws if none is left. */
    beforeAttempt?: () => void;
  } & EmbeddingExecutionOptions,
): Promise<EmbeddingExecution> {
  const { adapter, texts, signal } = input;
  const policy = validateEmbeddingRetryPolicy(
    input.policy ?? DEFAULT_EMBEDDING_RETRY_POLICY,
  );
  const now = input.now ?? (() => performance.now());
  const sleep = input.sleep ?? defaultSleep;
  const emit = (
    type: EmbeddingExecutionEvent["type"],
    attempt: number,
    fields: Partial<EmbeddingExecutionEvent> = {},
  ) =>
    input.onEvent?.({
      type,
      provider: adapter.provider,
      model: adapter.model,
      attempt,
      batchSize: texts.length,
      ...fields,
    });
  const fail = (
    attempt: number,
    started: number | undefined,
    error: unknown,
  ) => {
    if (error instanceof EmbeddingError)
      emit("request_failed", attempt, {
        errorKind: error.kind,
        retryable: error.retryable,
        ...(error.statusCode !== undefined
          ? { statusCode: error.statusCode }
          : {}),
        ...(started !== undefined ? { durationMs: now() - started } : {}),
      });
    return error;
  };
  const deadlineError = () => abortedEmbeddingError(adapter.provider, signal);

  let attempts = 0;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (signal?.aborted) throw fail(attempts, undefined, deadlineError());
    try {
      adapter.assertReady?.();
    } catch (error) {
      throw fail(attempts, undefined, error);
    }
    try {
      input.beforeAttempt?.();
    } catch (error) {
      if (error instanceof RequestBudgetError) {
        emit("request_failed", attempts, {
          errorKind: "budget_exhausted",
          retryable: false,
        });
        throw error;
      }
      // The reservation also observes cancellation.
      if (signal?.aborted) throw fail(attempts, undefined, deadlineError());
      throw error;
    }
    // The reservation may itself have observed cancellation; a request must
    // never start after it.
    if (signal?.aborted) throw fail(attempts, undefined, deadlineError());
    attempts++;
    emit("request_started", attempt, {
      ...(input.budgetRemaining
        ? { budgetRemaining: input.budgetRemaining() }
        : {}),
    });
    const attemptSignal =
      input.attemptTimeoutMs === undefined
        ? signal
        : signal
          ? AbortSignal.any([
              signal,
              AbortSignal.timeout(input.attemptTimeoutMs),
            ])
          : AbortSignal.timeout(input.attemptTimeoutMs);
    const started = now();
    let failure: EmbeddingError;
    try {
      const vectors = await adapter.embed(texts, attemptSignal);
      const dimensions = validateEmbeddingBatch(
        vectors,
        texts.length,
        adapter.dimensions,
        adapter.provider,
      );
      emit("request_succeeded", attempt, { durationMs: now() - started });
      return { vectors, dimensions, attempts };
    } catch (error) {
      failure = unclassified(error, adapter, attemptSignal);
    }
    // Cancellation and the total deadline end the request, whatever failed.
    if (signal?.aborted) throw fail(attempt, started, deadlineError());
    if (!failure.retryable || attempt >= policy.maxAttempts)
      throw fail(attempt, started, failure);

    const waitMs = retryDelayMs({
      attempt,
      policy,
      retryAfterMs: failure.retryAfterMs,
      random: input.random,
    });
    const remaining = input.remainingMs?.();
    if (remaining !== undefined && waitMs >= remaining)
      throw fail(
        attempt,
        started,
        new EmbeddingError({
          kind: "timeout",
          provider: adapter.provider,
          message: `Embedding retry skipped: ${remaining} ms left before the overall deadline, next wait is ${waitMs} ms (last failure: ${failure.kind})`,
          retryable: false,
          ...(failure.statusCode !== undefined
            ? { statusCode: failure.statusCode }
            : {}),
        }),
      );
    emit("request_retry", attempt, {
      durationMs: now() - started,
      errorKind: failure.kind,
      retryable: true,
      waitMs,
      ...(failure.statusCode !== undefined
        ? { statusCode: failure.statusCode }
        : {}),
      ...(failure.retryAfterMs !== undefined
        ? { retryAfterMs: failure.retryAfterMs }
        : {}),
    });
    try {
      if (waitMs > 0) await sleep(waitMs, signal);
    } catch (error) {
      if (signal?.aborted) throw fail(attempt, undefined, deadlineError());
      throw error;
    }
    if (signal?.aborted) throw fail(attempt, undefined, deadlineError());
  }
  // Unreachable: validateEmbeddingRetryPolicy guarantees maxAttempts >= 1.
  throw new Error("No embedding attempt was allowed");
}

/** An adapter that leaks a raw error breaks the contract; classify, do not retry. */
function unclassified(
  error: unknown,
  adapter: EmbeddingAdapter,
  signal: AbortSignal | undefined,
): EmbeddingError {
  if (error instanceof EmbeddingError) return error;
  if (signal?.aborted) return abortedEmbeddingError(adapter.provider, signal);
  // The raw message may carry the texts that were being embedded: never kept.
  return new EmbeddingError({
    kind: "unknown",
    provider: adapter.provider,
    message: `${adapter.provider} embedding adapter raised an unclassified error`,
  });
}
