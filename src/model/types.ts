import type { ReviewResponse } from "../schemas/review.schema.js";
export type ModelRequest = {
  system: string;
  user: string;
  model: string;
  maxOutputTokens: number;
};
export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  actual: boolean;
};
export type ModelResult = { response: ReviewResponse; usage: ModelUsage };
/**
 * Provider-neutral port. Implementations are chosen by the bootstrap layer
 * (src/cli/providers.ts); the pipeline only ever sees this interface. Every
 * failure an implementation throws must be a ReviewModelError (see errors.ts):
 * SDK and HTTP details stop at the adapter.
 */
export interface ReviewModel {
  readonly provider: string;
  /**
   * Stable, non-secret description of the provider contract that influences
   * results (API flavor, endpoint origin and path, response-format version).
   * It is part of the review-cache key, so it must never contain credentials,
   * query strings, or environment values.
   */
  readonly identity?: string;
  review(request: ModelRequest, signal: AbortSignal): Promise<ModelResult>;
}
/** The subset of a model that scopes cached results. */
export type ModelIdentity = Pick<ReviewModel, "provider" | "identity">;
