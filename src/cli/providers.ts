import type { ReviewConfig } from "../config/config.js";
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
 * (Construction makes no network call.)
 */
export function createProviders(
  config: ReviewConfig,
  request: Pick<ReviewRunRequest, "contextMode">,
): { model?: ReviewModel; embedding?: EmbeddingAdapter } {
  return {
    model: config.allowExternal ? new OpenAIReviewModel() : undefined,
    embedding:
      config.allowEmbeddings && request.contextMode === "hybrid"
        ? new OpenAIEmbeddingAdapter(config.embeddingModel)
        : undefined,
  };
}
