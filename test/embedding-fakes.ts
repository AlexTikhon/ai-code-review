import {
  DeterministicTestEmbedding,
  type EmbeddingAdapter,
} from "../src/retrieval/embeddings.js";
import { EmbeddingError } from "../src/retrieval/embedding-errors.js";

const delegate = new DeterministicTestEmbedding();

export const rateLimit = (retryAfterMs?: number) =>
  new EmbeddingError({
    kind: "rate_limit",
    provider: "fake",
    message: "fake embeddings error 429",
    statusCode: 429,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
export const unavailable = (statusCode = 503) =>
  new EmbeddingError({
    kind: "provider_unavailable",
    provider: "fake",
    message: `fake embeddings error ${statusCode}`,
    statusCode,
  });
export const networkReset = () =>
  new EmbeddingError({
    kind: "network",
    provider: "fake",
    message: "fake connection error",
  });
export const attemptTimeout = () =>
  new EmbeddingError({
    kind: "timeout",
    provider: "fake",
    message: "fake request timed out",
  });
export const unauthorized = () =>
  new EmbeddingError({
    kind: "authentication",
    provider: "fake",
    message: "fake embeddings error 401",
    statusCode: 401,
  });

export type ScriptedEmbeddingState = {
  /** Provider attempts actually started (calls of embed). */
  attempts: number;
  /** Texts carried by successful attempts. */
  texts: number;
  /** The signal each attempt was given. */
  signals: Array<AbortSignal | undefined>;
  /** 1-based attempt number -> what that attempt throws. */
  failures: Record<number, unknown>;
  /** Attempts that never settle until their signal aborts. */
  hang: Set<number>;
  /** Replace the vectors an attempt returns (e.g. to corrupt them). */
  respond?: (attempt: number, vectors: number[][]) => number[][];
  /** Runs after each completed attempt. */
  afterAttempt?: (attempt: number) => void;
};

/**
 * A deterministic embedding provider with failure injection by attempt
 * number: the fake every retry test drives instead of HTTP or timers.
 */
export function scriptedEmbedding(
  failures: Record<number, unknown> = {},
  extra: { assertReady?: () => void } = {},
) {
  const state: ScriptedEmbeddingState = {
    attempts: 0,
    texts: 0,
    signals: [],
    failures,
    hang: new Set(),
  };
  const adapter: EmbeddingAdapter = {
    provider: "fake",
    model: delegate.model,
    version: delegate.version,
    dimensions: delegate.dimensions,
    ...(extra.assertReady ? { assertReady: extra.assertReady } : {}),
    async embed(texts, signal) {
      const attempt = ++state.attempts;
      state.signals.push(signal);
      if (state.hang.has(attempt))
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      if (attempt in state.failures) throw state.failures[attempt];
      state.texts += texts.length;
      const vectors = await delegate.embed(texts);
      const out = state.respond ? state.respond(attempt, vectors) : vectors;
      state.afterAttempt?.(attempt);
      return out;
    },
  };
  return { adapter, state };
}
