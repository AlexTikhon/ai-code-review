import { RequestBudgetError } from "../../model/budget.js";
import { ReviewModelError, modelErrorCode } from "../../model/errors.js";
import {
  EmbeddingError,
  embeddingErrorCode,
} from "../../retrieval/embedding-errors.js";
import { isDegradableEmbeddingFailure } from "../../retrieval/retrieve.js";
import type { ContextDegradation, ReviewError } from "../types.js";
import { errorMessage } from "./result.js";

/** What a reviewed segment came to. Only `success` may contribute a clean result. */
export type SegmentStatus =
  | "success"
  /** The model answered validly, but cited evidence that was not supplied. */
  | "invalid_evidence"
  /** The provider or its response failed: auth, rate limit, malformed, truncated... */
  | "model_failure"
  /** Cancelled by the total deadline or the caller. */
  | "aborted"
  /** Anything else: request budget, prompt assembly, or retrieval. */
  | "internal_failure";

export type SegmentFailure = {
  status: Exclude<SegmentStatus, "success">;
  error: ReviewError;
};

const analyze = (
  filename: string,
  rest: Partial<ReviewError>,
): ReviewError => ({
  stage: "analyze",
  filename,
  message: "",
  fatal: false,
  ...rest,
});

export function modelFailure(
  filename: string,
  error: ReviewModelError,
): SegmentFailure {
  if (error.kind === "aborted")
    return {
      status: "aborted",
      error: analyze(filename, {
        message: error.message,
        code: "REVIEW_ABORTED",
        provider: error.provider,
        retryable: true,
      }),
    };
  return {
    status: "model_failure",
    error: analyze(filename, {
      message: error.message,
      code: modelErrorCode(error.kind),
      provider: error.provider,
      retryable: error.retryable,
    }),
  };
}

export function invalidEvidenceFailure(
  filename: string,
  invalid: number,
  provider: string,
): SegmentFailure {
  return {
    status: "invalid_evidence",
    error: analyze(filename, {
      message: `Model returned ${invalid} finding(s) citing evidence that was not supplied; the response was discarded`,
      code: "MODEL_INVALID_EVIDENCE",
      provider,
      retryable: true,
    }),
  };
}

/**
 * A failure of the embedding provider or of the request cap around it. Budget
 * exhaustion is an application constraint, never an EMBEDDING_* provider error.
 */
function embeddingFailure(
  stage: ReviewError["stage"],
  error: unknown,
): ReviewError | undefined {
  if (error instanceof EmbeddingError)
    return error.kind === "aborted"
      ? {
          stage,
          message: error.message,
          fatal: false,
          code: "REVIEW_ABORTED",
          provider: error.provider,
          retryable: true,
        }
      : {
          stage,
          message: error.message,
          fatal: false,
          code: embeddingErrorCode(error.kind),
          provider: error.provider,
          retryable: error.retryable,
        };
  if (error instanceof RequestBudgetError)
    return {
      stage,
      message: error.message,
      fatal: false,
      code: "REQUEST_BUDGET_EXHAUSTED",
      retryable: false,
    };
  return undefined;
}

/**
 * Requested semantic context that could not be obtained while the review went
 * on with lexical evidence. Returns undefined for anything that is not a typed,
 * degradable failure (cancellation among them): those must propagate.
 *
 * The message is composed here from the failure's stable code and never
 * repeats provider text, the query, or any source content.
 */
export function embeddingDegradation(
  stage: "index" | "retrieve",
  error: unknown,
  signal: AbortSignal | undefined,
  scope: { filename: string; segmentId: string } | undefined,
): ContextDegradation | undefined {
  if (!isDegradableEmbeddingFailure(error, signal)) return undefined;
  const typed = embeddingFailure(stage, error);
  if (!typed) return undefined;
  const budget = error instanceof RequestBudgetError;
  const where = scope
    ? "for this segment"
    : stage === "index"
      ? "for the repository index"
      : "for retrieval";
  return {
    stage,
    reason: budget ? "embedding_withheld" : "embedding_failed",
    ...(typed.code ? { code: typed.code } : {}),
    ...(typed.provider ? { provider: typed.provider } : {}),
    ...(typed.retryable !== undefined ? { retryable: typed.retryable } : {}),
    ...(scope ?? {}),
    message: budget
      ? `Embedding work was withheld ${where} to keep the request budget for model review; lexical retrieval was used.`
      : `Embedding failed ${where} (${typed.code}); lexical retrieval was used.`,
  };
}

/** The non-fatal result error that accompanies a coded degradation. */
export function degradationError(degradation: ContextDegradation): ReviewError {
  return {
    stage: degradation.stage,
    message: degradation.message,
    fatal: false,
    ...(degradation.filename ? { filename: degradation.filename } : {}),
    ...(degradation.code ? { code: degradation.code } : {}),
    ...(degradation.provider ? { provider: degradation.provider } : {}),
    ...(degradation.retryable !== undefined
      ? { retryable: degradation.retryable }
      : {}),
  };
}

/** The repository-context stage failed; reviewing continues without context. */
export function contextFailure(error: unknown, message: string): ReviewError {
  const typed = embeddingFailure("index", error);
  return typed
    ? { ...typed, message }
    : { stage: "index", message, fatal: false };
}

/** Classify a failure that did not come from the model call itself. */
export function unexpectedFailure(
  filename: string,
  error: unknown,
  aborted: boolean,
): SegmentFailure {
  if (error instanceof ReviewModelError) return modelFailure(filename, error);
  // Retrieval embeds the query; its provider failures are not analysis bugs.
  if (error instanceof EmbeddingError) {
    const typed = embeddingFailure("retrieve", error)!;
    return {
      status: error.kind === "aborted" ? "aborted" : "internal_failure",
      error: { ...typed, filename },
    };
  }
  if (error instanceof RequestBudgetError)
    return {
      status: "internal_failure",
      error: analyze(filename, {
        message: error.message,
        code: "REQUEST_BUDGET_EXHAUSTED",
        retryable: false,
      }),
    };
  if (aborted)
    return {
      status: "aborted",
      error: analyze(filename, {
        message: "Review cancelled (total review deadline exceeded)",
        code: "REVIEW_ABORTED",
        retryable: true,
      }),
    };
  return {
    status: "internal_failure",
    error: analyze(filename, {
      message: errorMessage(error),
      code: "ANALYSIS_FAILED",
    }),
  };
}
