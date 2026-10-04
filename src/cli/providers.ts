import type { ReviewConfig } from "../config/config.js";
import { AnthropicReviewModel } from "../model/anthropic.js";
import { OpenAIReviewModel } from "../model/openai.js";
import type { ReviewModel } from "../model/types.js";
import {
  OpenAIEmbeddingAdapter,
  type EmbeddingAdapter,
} from "../retrieval/embeddings.js";
import type { ReviewRunRequest } from "../review/pipeline/types.js";

/**
 * Production provider composition: the only place concrete providers are
 * chosen. Adapters exist only if the effective configuration authorizes
 * transmission, so an unauthorized run holds no provider at all.
 * (Construction makes no network call.) The review provider and the embedding
 * provider are independent choices: any review provider can pair with the
 * (optional) embedding adapter.
 */
function createReviewModel(config: ReviewConfig): ReviewModel {
  switch (config.reviewProvider) {
    case "openai":
      return new OpenAIReviewModel();
    case "anthropic":
      return new AnthropicReviewModel();
  }
}

export function createProviders(
  config: ReviewConfig,
  request: Pick<ReviewRunRequest, "contextMode">,
): { model?: ReviewModel; embedding?: EmbeddingAdapter } {
  return {
    model: config.allowExternal ? createReviewModel(config) : undefined,
    embedding:
      config.allowEmbeddings && request.contextMode === "hybrid"
        ? new OpenAIEmbeddingAdapter(config.embeddingModel)
        : undefined,
  };
}
