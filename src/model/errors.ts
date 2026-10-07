/**
 * Provider-neutral failure taxonomy for a ReviewModel call.
 *
 * Adapters translate whatever their SDK or HTTP layer throws into one of these
 * kinds, so the retry layer and the pipeline can answer "what failed, is it
 * worth retrying, which provider" without parsing messages or importing an SDK.
 */
export const MODEL_ERROR_KINDS = [
  "authentication",
  "rate_limit",
  "timeout",
  "network",
  "provider_unavailable",
  "invalid_request",
  "unsupported_model",
  "malformed_response",
  "response_truncated",
  "refused",
  "aborted",
  "unknown",
] as const;
export type ModelErrorKind = (typeof MODEL_ERROR_KINDS)[number];

/** Whether another attempt could plausibly succeed, absent any better signal. */
const RETRYABLE_BY_DEFAULT: Record<ModelErrorKind, boolean> = {
  authentication: false,
  rate_limit: true,
  timeout: true,
  network: true,
  provider_unavailable: true,
  invalid_request: false,
  unsupported_model: false,
  // Structured output is occasionally invalid; one more draw can succeed.
  malformed_response: true,
  // The same prompt under the same output cap truncates again.
  response_truncated: false,
  refused: false,
  aborted: false,
  unknown: false,
};

export type ModelErrorCode = `MODEL_${Uppercase<ModelErrorKind>}`;

/** Stable machine-readable code for a kind, as exposed in review results. */
export function modelErrorCode(kind: ModelErrorKind): ModelErrorCode {
  return `MODEL_${kind.toUpperCase()}` as ModelErrorCode;
}

export type ReviewModelErrorInit = {
  kind: ModelErrorKind;
  provider: string;
  /** Must already be safe to show: no key, no prompt, no response body. */
  message: string;
  retryable?: boolean;
  statusCode?: number;
  retryAfterMs?: number;
  /** The provider's own short error code or type, e.g. "model_not_found". */
  code?: string;
};

export class ReviewModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly provider: string;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly code?: string;

  constructor(init: ReviewModelErrorInit) {
    super(init.message);
    this.name = "ReviewModelError";
    this.kind = init.kind;
    this.provider = init.provider;
    this.retryable = init.retryable ?? RETRYABLE_BY_DEFAULT[init.kind];
    if (init.statusCode !== undefined) this.statusCode = init.statusCode;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    const code = safeProviderCode(init.code);
    if (code !== undefined) this.code = code;
  }
}

/** The kinds an HTTP status alone can decide; common to every external-call domain. */
export type HttpErrorKind = Extract<
  ModelErrorKind,
  | "authentication"
  | "unsupported_model"
  | "timeout"
  | "rate_limit"
  | "provider_unavailable"
  | "invalid_request"
  | "unknown"
>;

/** HTTP semantics shared by every provider (and by embedding providers). */
export function kindForHttpStatus(status: number | undefined): HttpErrorKind {
  if (status === undefined) return "unknown";
  if (status === 401 || status === 403) return "authentication";
  if (status === 404) return "unsupported_model";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status === 409 || status >= 500) return "provider_unavailable";
  if (status >= 400) return "invalid_request";
  return "unknown";
}

/**
 * Provider error codes and types that are safe to surface. Anything else a
 * provider (or a hostile response) puts in a code or type field is free text
 * that can echo the request, i.e. source code, so it is dropped, not trimmed.
 */
const KNOWN_PROVIDER_CODES: ReadonlySet<string> = new Set([
  // OpenAI
  "invalid_api_key",
  "invalid_request_error",
  "model_not_found",
  "insufficient_quota",
  "rate_limit_exceeded",
  "context_length_exceeded",
  "server_error",
  "service_unavailable",
  "access_terminated",
  "billing_not_active",
  // Anthropic
  "authentication_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
  "rate_limit_error",
  "api_error",
  "overloaded_error",
  "timeout_error",
  "billing_error",
]);

/** The provider's own error code if it is a known, fixed identifier; otherwise nothing. */
export function safeProviderCode(raw: unknown): string | undefined {
  return typeof raw === "string" && KNOWN_PROVIDER_CODES.has(raw)
    ? raw
    : undefined;
}

export function missingKeyError(
  provider: string,
  variable: string,
): ReviewModelError {
  return new ReviewModelError({
    kind: "authentication",
    provider,
    message: `Missing ${variable}`,
  });
}

export function abortedError(
  provider: string,
  signal: AbortSignal,
): ReviewModelError {
  const timedOut =
    (signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError";
  return timedOut
    ? new ReviewModelError({
        kind: "timeout",
        provider,
        message: `${provider} request timed out`,
      })
    : new ReviewModelError({
        kind: "aborted",
        provider,
        message: `${provider} request aborted`,
      });
}

export function truncatedError(
  provider: string,
  label: string,
): ReviewModelError {
  return new ReviewModelError({
    kind: "response_truncated",
    provider,
    message: `${label} output was cut off at the output token limit; raise AI_REVIEW_MAX_OUTPUT_TOKENS`,
  });
}

export function malformedError(
  provider: string,
  message: string,
): ReviewModelError {
  return new ReviewModelError({
    kind: "malformed_response",
    provider,
    message,
  });
}

export function refusedError(
  provider: string,
  label: string,
): ReviewModelError {
  return new ReviewModelError({
    kind: "refused",
    provider,
    message: `${label} declined to review this content`,
  });
}

/** Seconds-valued `retry-after` header (and a millisecond variant) as ms. */
export function retryAfterFromHeaders(
  headers: Pick<Headers, "get"> | null | undefined,
): number | undefined {
  const ms = Number(headers?.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const seconds = Number(headers?.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * An HTTP failure. The provider's message text is never kept: it can echo the
 * request, i.e. source code. Only the status, retry timing and a code from the
 * known vocabulary are.
 */
export function httpStatusError(input: {
  provider: string;
  label: string;
  status: number;
  code?: string;
  headers?: Pick<Headers, "get"> | null;
}): ReviewModelError {
  const kind = kindForHttpStatus(input.status);
  const retryable = RETRYABLE_BY_DEFAULT[kind];
  const code = safeProviderCode(input.code);
  return new ReviewModelError({
    kind,
    provider: input.provider,
    message: `${input.label} error ${input.status}${code ? ` (${code})` : ""}`,
    statusCode: input.status,
    retryAfterMs: retryable ? retryAfterFromHeaders(input.headers) : undefined,
    code,
  });
}

/**
 * Last-resort classification of anything thrown around a provider call that
 * the adapter did not already recognize. Never retains the raw error or its
 * message: a transport or SDK error can carry request text.
 */
export function normalizeThrown(
  error: unknown,
  input: {
    provider: string;
    label: string;
    signal: AbortSignal;
  },
): ReviewModelError {
  if (error instanceof ReviewModelError) return error;
  if (input.signal.aborted) return abortedError(input.provider, input.signal);
  if (error instanceof Error && error.name === "AbortError")
    return new ReviewModelError({
      kind: "aborted",
      provider: input.provider,
      message: `${input.label} request aborted`,
    });
  // fetch() rejects with a TypeError when the connection itself fails.
  if (error instanceof TypeError)
    return new ReviewModelError({
      kind: "network",
      provider: input.provider,
      message: `${input.label} connection error`,
    });
  return new ReviewModelError({
    kind: "unknown",
    provider: input.provider,
    message: `${input.label} request failed`,
  });
}
