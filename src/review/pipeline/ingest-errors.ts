import { SourceError, sourceErrorCode } from "../../review-sources/errors.js";
import type { ReviewError } from "../types.js";
import { errorMessage } from "./result.js";

/**
 * A fatal ingestion failure as data. Source failures arrive typed, so the code
 * and retryability come from the error itself; the message is never inspected.
 * A cancelled collection is retryable by re-running, like any other abort.
 */
export function ingestFailure(error: unknown, aborted: boolean): ReviewError {
  if (error instanceof SourceError)
    return {
      stage: "ingest",
      message: error.message,
      fatal: true,
      code: sourceErrorCode(error),
      source: error.source,
      retryable: error.kind === "aborted" ? true : error.retryable,
    };
  if (aborted)
    return {
      stage: "ingest",
      message: "Review cancelled (total review deadline exceeded)",
      fatal: true,
      code: "REVIEW_ABORTED",
      retryable: true,
    };
  return { stage: "ingest", message: errorMessage(error), fatal: true };
}
