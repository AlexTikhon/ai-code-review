import { createHash } from "node:crypto";
import type { EmbeddingAdapter } from "./embeddings.js";
import { CHUNKER_VERSION, type ContextChunk } from "./types.js";

export function normalizedEmbeddingInput(chunk: ContextChunk): string {
  return `${chunk.path.replaceAll("\\", "/")}\n${chunk.signature ?? ""}\n${chunk.content.replace(/\r\n/g, "\n")}`;
}

export function embeddingInputHash(chunk: ContextChunk): string {
  return createHash("sha256")
    .update(normalizedEmbeddingInput(chunk))
    .digest("hex");
}

/** The non-secret part of an adapter that decides whether vectors are comparable. */
export function embeddingDimensionIdentity(
  embedding: EmbeddingAdapter,
): string {
  return String(embedding.dimensions ?? "provider-default");
}

/** Cache key from an already computed input hash, so callers hash each chunk once. */
export function embeddingCacheKeyForHash(
  inputHash: string,
  embedding: EmbeddingAdapter,
  maxChunkTokens: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        inputHash,
        provider: embedding.provider,
        model: embedding.model,
        version: embedding.version,
        dimensions: embedding.dimensions ?? "provider-default",
        chunkerVersion: CHUNKER_VERSION,
        maxChunkTokens,
      }),
    )
    .digest("hex");
}

export function embeddingCacheKey(
  chunk: ContextChunk,
  embedding: EmbeddingAdapter,
  maxChunkTokens: number,
): string {
  return embeddingCacheKeyForHash(
    embeddingInputHash(chunk),
    embedding,
    maxChunkTokens,
  );
}
