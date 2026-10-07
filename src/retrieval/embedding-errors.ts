import {
  kindForHttpStatus,
  retryAfterFromHeaders,
  safeProviderCode,
  type HttpErrorKind,
} from "../model/errors.js";

/**
 * Provider-neutral failure taxonomy for one embedding request.
 *
 * It is deliberately a separate domain from ReviewModelError: a rate limit on
 * the embedding endpoint and a rate limit on the review model are different
 * incidents with different remedies, and their stable codes differ
 * (EMBEDDING_RATE_LIMIT vs MODEL_RATE_LIMIT). The HTTP status table and the
 * Retry-After parsing are shared with the model domain, not copied.
 *
 * Adapters translate whatever their transport throws into one of these kinds;
 * the retry executor and the index code consume only this shape and never look
 * at SDK classes, status numbers or message text.
 */
export const EMBEDDING_ERROR_KINDS = [
  "authentication",
  "rate_limit",
  "timeout",
  "network",
  "provider_unavailable",
  "invalid_request",
  "unsupported_model",
  "malformed_response",
  "dimension_mismatch",
  "aborted",
  "unknown",
] as const;
export type EmbeddingErrorKind = (typeof EMBEDDING_ERROR_KINDS)[number];

/** Whether another attempt could plausibly succeed, absent any better signal. */
const RETRYABLE_BY_DEFAULT: Record<EmbeddingErrorKind, boolean> = {
  authentication: false,
  rate_limit: true,
  timeout: true,
  network: true,
  provider_unavailable: true,
  invalid_request: false,
  unsupported_model: false,
  // A deterministic bad payload would be paid for again and come back the same.
  malformed_response: false,
  dimension_mismatch: false,
  aborted: false,
  unknown: false,
};

export type EmbeddingErrorCode = `EMBEDDING_${Uppercase<EmbeddingErrorKind>}`;

/** Stable machine-readable code for a kind, as exposed in review results. */
export function embeddingErrorCode(
  kind: EmbeddingErrorKind,
): EmbeddingErrorCode {
  return `EMBEDDING_${kind.toUpperCase()}` as EmbeddingErrorCode;
}

export type EmbeddingErrorInit = {
  kind: EmbeddingErrorKind;
  provider: string;
  /** Must already be safe to show: no key, no input text, no response body. */
  message: string;
  retryable?: boolean;
  statusCode?: number;
  retryAfterMs?: number;
  /** The provider's own short error code, e.g. "model_not_found". */
  code?: string;
};

export class EmbeddingError extends Error {
  readonly kind: EmbeddingErrorKind;
  readonly provider: string;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly code?: string;

  constructor(init: EmbeddingErrorInit) {
    super(init.message);
    this.name = "EmbeddingError";
    this.kind = init.kind;
    this.provider = init.provider;
    this.retryable = init.retryable ?? RETRYABLE_BY_DEFAULT[init.kind];
    if (init.statusCode !== undefined) this.statusCode = init.statusCode;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    const code = safeProviderCode(init.code);
    if (code !== undefined) this.code = code;
  }
}

const embeddingKind = (kind: HttpErrorKind): EmbeddingErrorKind => kind;

export function missingEmbeddingKeyError(
  provider: string,
  variable: string,
): EmbeddingError {
  return new EmbeddingError({
    kind: "authentication",
    provider,
    message: `Missing ${variable} for embeddings`,
  });
}

export function abortedEmbeddingError(
  provider: string,
  signal: AbortSignal | undefined,
): EmbeddingError {
  const reason = signal?.reason as { name?: unknown } | undefined;
  const timedOut = reason?.name === "TimeoutError";
  return timedOut
    ? new EmbeddingError({
        kind: "timeout",
        provider,
        message: `${provider} embedding request timed out`,
      })
    : new EmbeddingError({
        kind: "aborted",
        provider,
        message: `${provider} embedding request aborted`,
      });
}

export function malformedEmbeddingError(
  provider: string,
  message: string,
): EmbeddingError {
  return new EmbeddingError({ kind: "malformed_response", provider, message });
}

export function dimensionMismatchError(
  provider: string,
  message: string,
): EmbeddingError {
  return new EmbeddingError({ kind: "dimension_mismatch", provider, message });
}

/**
 * An HTTP failure. The provider's message text is never kept: it can echo the
 * request, i.e. source code. Only the status and the short provider code are.
 */
export function embeddingHttpError(input: {
  provider: string;
  label: string;
  status: number;
  code?: string;
  headers?: Pick<Headers, "get"> | null;
}): EmbeddingError {
  const code = safeProviderCode(input.code) ?? "";
  // The one provider code that is more specific than any status.
  const kind: EmbeddingErrorKind =
    code === "model_not_found"
      ? "unsupported_model"
      : embeddingKind(kindForHttpStatus(input.status));
  return new EmbeddingError({
    kind,
    provider: input.provider,
    message: `${input.label} error ${input.status}${code ? ` (${code})` : ""}`,
    statusCode: input.status,
    retryAfterMs: RETRYABLE_BY_DEFAULT[kind]
      ? retryAfterFromHeaders(input.headers)
      : undefined,
    code: code || undefined,
  });
}

/**
 * Last-resort classification of anything thrown around a provider call that
 * the adapter did not already recognize. Never retains the raw error.
 */
export function normalizeEmbeddingThrown(
  error: unknown,
  input: {
    provider: string;
    label: string;
    signal: AbortSignal | undefined;
  },
): EmbeddingError {
  if (error instanceof EmbeddingError) return error;
  if (input.signal?.aborted)
    return abortedEmbeddingError(input.provider, input.signal);
  if (error instanceof Error && error.name === "AbortError")
    return new EmbeddingError({
      kind: "aborted",
      provider: input.provider,
      message: `${input.label} request aborted`,
    });
  // fetch() rejects with a TypeError when the connection itself fails.
  if (error instanceof TypeError)
    return new EmbeddingError({
      kind: "network",
      provider: input.provider,
      message: `${input.label} connection error`,
    });
  return new EmbeddingError({
    kind: "unknown",
    provider: input.provider,
    message: `${input.label} request failed`,
  });
}
