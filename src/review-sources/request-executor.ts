import { setTimeout as delay } from "node:timers/promises";
import {
  SourceError,
  sourceAbortedError,
  throwIfSourceAborted,
  type SourceErrorKind,
  type SourceName,
} from "./errors.js";

export type SourceRetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  /** Longest wait ever taken; a provider asking for more fails the request. */
  maxDelayMs: number;
};

export const DEFAULT_SOURCE_RETRY_POLICY: SourceRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 10_000,
};

/** Value-free progress notes: counts, kinds and timings only. */
export type SourceRequestEvent = {
  type:
    | "request_started"
    | "request_retry"
    | "request_succeeded"
    | "request_failed";
  attempt: number;
  durationMs?: number;
  waitMs?: number;
  kind?: SourceErrorKind;
  retryable?: boolean;
  statusCode?: number;
  operation?: string;
  page?: number;
};

export type SourceRequestOptions<T> = {
  source: SourceName;
  /** Exactly one request. Its signal is the caller's signal plus the attempt timeout. */
  attempt: (signal: AbortSignal) => Promise<T>;
  /** The overall (caller or total-deadline) cancellation. */
  signal?: AbortSignal;
  attemptTimeoutMs: number;
  policy?: SourceRetryPolicy;
  /** Time left before the total deadline; a wait that does not fit is not taken. */
  remainingMs?: () => number;
  onEvent?: (event: SourceRequestEvent) => void;
  /** Test seams: the wait and the per-attempt timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timeoutSignal?: (ms: number) => AbortSignal;
};

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  delay(ms, undefined, signal ? { signal } : undefined);

function failureOf<T>(
  raised: unknown,
  options: SourceRequestOptions<T>,
  attemptSignal: AbortSignal,
): SourceError {
  // Overall cancellation outranks everything: it must stop every retry.
  if (options.signal?.aborted) return sourceAbortedError(options.source);
  if (raised instanceof SourceError) return raised;
  // Only this attempt's own timer fired: the request may be tried again.
  if (attemptSignal.aborted)
    return new SourceError({
      kind: "timeout",
      source: options.source,
      message: `${options.source} request timed out after ${options.attemptTimeoutMs} ms`,
    });
  return new SourceError({
    kind: "unknown",
    source: options.source,
    message: `${options.source} request failed unexpectedly`,
  });
}

/**
 * The one retry layer for source requests. It consumes only SourceError
 * metadata: an attempt is retried iff the error is `retryable`, attempts remain,
 * and the wait the provider asked for (or the backoff) is no longer than the
 * policy maximum and fits before the total deadline. Caller cancellation is
 * checked before every attempt and during every wait, so no request starts
 * after an abort. Callers must only use this for idempotent requests.
 */
export async function executeSourceRequest<T>(
  options: SourceRequestOptions<T>,
): Promise<T> {
  const policy = options.policy ?? DEFAULT_SOURCE_RETRY_POLICY;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutSignal = options.timeoutSignal ?? AbortSignal.timeout;
  const emit = (event: SourceRequestEvent) => options.onEvent?.(event);

  for (let attempt = 1; ; attempt++) {
    throwIfSourceAborted(options.signal, options.source);
    const attemptSignal = timeoutSignal(options.attemptTimeoutMs);
    const requestSignal = options.signal
      ? AbortSignal.any([options.signal, attemptSignal])
      : attemptSignal;
    emit({ type: "request_started", attempt });
    const started = performance.now();
    let error: SourceError;
    try {
      const value = await options.attempt(requestSignal);
      emit({
        type: "request_succeeded",
        attempt,
        durationMs: performance.now() - started,
      });
      return value;
    } catch (raised) {
      error = failureOf(raised, options, attemptSignal);
    }
    const failed = (extra: Partial<SourceRequestEvent> = {}) =>
      emit({
        type: "request_failed",
        attempt,
        durationMs: performance.now() - started,
        kind: error.kind,
        retryable: error.retryable,
        ...(error.statusCode !== undefined
          ? { statusCode: error.statusCode }
          : {}),
        ...extra,
      });

    const waitMs =
      error.retryAfterMs ??
      Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
    const remaining = options.remainingMs?.();
    if (
      !error.retryable ||
      attempt >= policy.maxAttempts ||
      waitMs > policy.maxDelayMs ||
      (remaining !== undefined && waitMs >= remaining)
    ) {
      failed();
      throw error;
    }
    emit({
      type: "request_retry",
      attempt,
      waitMs,
      kind: error.kind,
      retryable: true,
      ...(error.statusCode !== undefined
        ? { statusCode: error.statusCode }
        : {}),
    });
    try {
      await sleep(waitMs, options.signal);
    } catch (raised) {
      if (!options.signal?.aborted) throw raised;
      failed({ kind: "aborted", retryable: false });
      throw sourceAbortedError(options.source);
    }
  }
}
