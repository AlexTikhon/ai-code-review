import { embeddingInputHash } from "./index-store.js";
import type { EmbeddingAdapter } from "./embeddings.js";
import type { ContextChunk, RepositoryIndex, StoredVector } from "./types.js";

/** Lexical terms shared by index preparation and query tokenization. */
export function lexicalTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z_$][\w$]{2,}/g) ?? []);
}

export type PreparedChunk = {
  readonly chunk: ContextChunk;
  /** Pre-tokenized path, name, signature, imports and content. */
  readonly terms: ReadonlySet<string>;
  /** Lower-cased symbol name; undefined when the chunk has none. */
  readonly nameTerm?: string;
  /** Imports with a leading "./" removed, for import-link matching. */
  readonly importNeedles: readonly string[];
  /** Hash of the exact embedding input, computed once per run. */
  readonly inputHash: string;
};

/**
 * Transient runtime form of a RepositoryIndex. It holds Sets and Maps, so it is
 * never serialized: the persisted JSON-safe RepositoryIndex stays the source of
 * truth and this is compiled from it once per run, then reused by every review
 * segment.
 */
export type PreparedRepositoryIndex = {
  readonly kind: "prepared-repository-index";
  readonly repositoryId: string;
  readonly revision: string;
  readonly chunkerVersion: string;
  readonly maxChunkTokens: number;
  readonly chunks: readonly PreparedChunk[];
  /** Stored vectors grouped by input hash, in persisted order. */
  readonly vectorsByInputHash: ReadonlyMap<string, readonly StoredVector[]>;
};

export function isPreparedIndex(
  value: RepositoryIndex | PreparedRepositoryIndex,
): value is PreparedRepositoryIndex {
  return (
    (value as PreparedRepositoryIndex).kind === "prepared-repository-index"
  );
}

export function prepareRepositoryIndex(
  index: RepositoryIndex,
): PreparedRepositoryIndex {
  const vectorsByInputHash = new Map<string, StoredVector[]>();
  for (const vector of Object.values(index.vectors)) {
    const group = vectorsByInputHash.get(vector.inputHash);
    if (group) group.push(vector);
    else vectorsByInputHash.set(vector.inputHash, [vector]);
  }
  return {
    kind: "prepared-repository-index",
    repositoryId: index.repositoryId,
    revision: index.revision,
    chunkerVersion: index.chunkerVersion,
    maxChunkTokens: index.maxChunkTokens,
    chunks: index.chunks.map((chunk) => ({
      chunk,
      terms: lexicalTokens(
        `${chunk.path} ${chunk.name ?? ""} ${chunk.signature ?? ""} ${chunk.imports.join(" ")} ${chunk.content}`,
      ),
      nameTerm: chunk.name ? chunk.name.toLowerCase() : undefined,
      importNeedles: chunk.imports.map((item) => item.replace(/^\.\//, "")),
      inputHash: embeddingInputHash(chunk),
    })),
    vectorsByInputHash,
  };
}

/**
 * The stored vector compatible with this chunk and embedding space, or
 * undefined. Constant-time in the number of stored vectors: candidates are the
 * (normally single-element) group sharing the chunk's input hash.
 */
export function findStoredVector(
  index: PreparedRepositoryIndex,
  chunk: PreparedChunk,
  embedding: EmbeddingAdapter,
): StoredVector | undefined {
  const dimensionIdentity = String(embedding.dimensions ?? "provider-default");
  return index.vectorsByInputHash
    .get(chunk.inputHash)
    ?.find(
      (vector) =>
        vector.provider === embedding.provider &&
        vector.model === embedding.model &&
        vector.version === embedding.version &&
        vector.dimensionIdentity === dimensionIdentity &&
        vector.chunkerVersion === index.chunkerVersion &&
        vector.maxChunkTokens === index.maxChunkTokens,
    );
}
