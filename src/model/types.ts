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
export interface ReviewModel {
  readonly provider: string;
  review(request: ModelRequest, signal: AbortSignal): Promise<ModelResult>;
}
export class ModelError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
