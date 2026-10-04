import { ReviewModelError, type ModelErrorKind } from "../src/model/errors.js";

/** A typed model failure for fake providers; the retry flag picks a plain kind. */
export function modelError(
  message: string,
  retryable: boolean,
  retryAfterMs?: number,
  kind: ModelErrorKind = retryable ? "provider_unavailable" : "invalid_request",
): ReviewModelError {
  return new ReviewModelError({
    kind,
    provider: "test",
    message,
    retryable,
    retryAfterMs,
  });
}
