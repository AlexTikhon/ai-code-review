/**
 * Source-ingestion failure taxonomy, shared by the GitHub and Git adapters.
 *
 * Adapters translate whatever HTTP, fetch or child-process layer failed into one
 * of these kinds, so the retry executor and the pipeline can answer "what
 * failed, is it worth retrying, which source" without parsing messages.
 */
export const SOURCE_ERROR_KINDS = [
  "authentication",
  "authorization",
  "not_found",
  "rate_limit",
  "timeout",
  "network",
  "provider_unavailable",
  "invalid_response",
  "revision_changed",
  "coverage_incomplete",
  "aborted",
  "configuration",
  "unknown",
] as const;
export type SourceErrorKind = (typeof SOURCE_ERROR_KINDS)[number];
export type SourceName = "github" | "git";

/** Whether another attempt could plausibly succeed, absent any better signal. */
const RETRYABLE_BY_DEFAULT: Record<SourceErrorKind, boolean> = {
  authentication: false,
  authorization: false,
  not_found: false,
  rate_limit: true,
  timeout: true,
  network: true,
  provider_unavailable: true,
  invalid_response: false,
  // The pull request moved while it was being read; a rerun sees a new snapshot.
  revision_changed: true,
  coverage_incomplete: false,
  aborted: false,
  configuration: false,
  unknown: false,
};

export type SourceErrorInit = {
  kind: SourceErrorKind;
  source: SourceName;
  /** Must already be safe to show: no token, no response body, no repository text. */
  message: string;
  retryable?: boolean;
  statusCode?: number;
  retryAfterMs?: number;
  /** A short machine-readable detail, e.g. "ECONNRESET" or "not_a_repository". */
  code?: string;
};

export class SourceError extends Error {
  readonly kind: SourceErrorKind;
  readonly source: SourceName;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly code?: string;

  constructor(init: SourceErrorInit) {
    super(init.message);
    this.name = "SourceError";
    this.kind = init.kind;
    this.source = init.source;
    this.retryable = init.retryable ?? RETRYABLE_BY_DEFAULT[init.kind];
    if (init.statusCode !== undefined) this.statusCode = init.statusCode;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    if (init.code !== undefined) this.code = init.code;
  }
}

export function sourceAbortedError(
  source: SourceName,
  message = "Source collection was cancelled",
): SourceError {
  return new SourceError({ kind: "aborted", source, message });
}

/** Stop between requests: nothing further starts once the caller has aborted. */
export function throwIfSourceAborted(
  signal: AbortSignal | undefined,
  source: SourceName,
): void {
  if (signal?.aborted) throw sourceAbortedError(source);
}

/** Stable, machine-readable ingestion codes as exposed in review results. */
export type SourceErrorCode =
  | "GITHUB_AUTHENTICATION_FAILED"
  | "GITHUB_AUTHORIZATION_FAILED"
  | "GITHUB_NOT_FOUND"
  | "GITHUB_RATE_LIMIT"
  | "GITHUB_PROVIDER_UNAVAILABLE"
  | "GITHUB_INVALID_RESPONSE"
  | "GITHUB_REVISION_CHANGED"
  | "GITHUB_COVERAGE_INCOMPLETE"
  | "GIT_NOT_A_REPOSITORY"
  | "GIT_INVALID_REF"
  | "GIT_COMMAND_FAILED"
  | "SOURCE_TIMEOUT"
  | "SOURCE_NETWORK"
  | "SOURCE_CONFIGURATION"
  | "SOURCE_FAILED";

const GITHUB_CODES: Partial<Record<SourceErrorKind, SourceErrorCode>> = {
  authentication: "GITHUB_AUTHENTICATION_FAILED",
  authorization: "GITHUB_AUTHORIZATION_FAILED",
  not_found: "GITHUB_NOT_FOUND",
  rate_limit: "GITHUB_RATE_LIMIT",
  provider_unavailable: "GITHUB_PROVIDER_UNAVAILABLE",
  invalid_response: "GITHUB_INVALID_RESPONSE",
  revision_changed: "GITHUB_REVISION_CHANGED",
  coverage_incomplete: "GITHUB_COVERAGE_INCOMPLETE",
};

/** Cancellation is the review-wide `REVIEW_ABORTED`, shared with the analysis stages. */
export function sourceErrorCode(
  error: SourceError,
): SourceErrorCode | "REVIEW_ABORTED" {
  if (error.kind === "aborted") return "REVIEW_ABORTED";
  if (error.kind === "timeout") return "SOURCE_TIMEOUT";
  if (error.kind === "network") return "SOURCE_NETWORK";
  if (error.source === "git") {
    if (error.code === "not_a_repository") return "GIT_NOT_A_REPOSITORY";
    if (error.code === "invalid_ref" || error.code === "no_merge_base")
      return "GIT_INVALID_REF";
    return error.kind === "configuration"
      ? "SOURCE_CONFIGURATION"
      : "GIT_COMMAND_FAILED";
  }
  if (error.kind === "configuration") return "SOURCE_CONFIGURATION";
  return GITHUB_CODES[error.kind] ?? "SOURCE_FAILED";
}
