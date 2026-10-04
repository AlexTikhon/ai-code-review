import { RequestBudgetError } from "../../model/budget.js";
import { ReviewModelError, modelErrorCode } from "../../model/errors.js";
import type { ReviewError } from "../types.js";
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
  /** Anything else: request budget, prompt assembly, retrieval, cache I/O. */
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

/** Classify a failure that did not come from the model call itself. */
export function unexpectedFailure(
  filename: string,
  error: unknown,
  aborted: boolean,
): SegmentFailure {
  if (error instanceof ReviewModelError) return modelFailure(filename, error);
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
