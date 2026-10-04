import { embeddingInputHash } from "./index-store.js";
import type { EmbeddingAdapter } from "./embeddings.js";
import { buildLexicalIndex, type LexicalIndex } from "./lexical-index.js";
import {
  buildSemanticIndex,
  type SemanticExactIndex,
} from "./semantic-index.js";
import type { ContextChunk, RepositoryIndex, StoredVector } from "./types.js";

export type PreparedChunk = {
  readonly chunk: ContextChunk;
  /** Hash of the exact embedding input, computed once per run. */
  readonly inputHash: string;
};

/**
 * Packed vectors for one embedding space, plus the ordinal -> chunk mapping.
 * Row `o` of `index` is the vector of `chunks[o]`; the numeric search never
 * touches `chunks`, which is read only for the few winning ordinals.
 */
export type SemanticSpace = {
  readonly index: SemanticExactIndex;
  readonly chunks: readonly ContextChunk[];
};

/**
 * Packed spaces built so far, one per embedding identity. A repository index may
 * hold vectors from several embedding spaces, and only the adapter in use is
 * known at query time, so a space is packed on first use and then shared by
 * every later query and review segment. `builds` makes that observable.
 */
export type SemanticSpaceCache = {
  readonly spaces: Map<string, SemanticSpace>;
  builds: number;
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
  /** Chunks in deterministic repository order. */
  readonly chunks: readonly PreparedChunk[];
  /** Inverted lexical lookups over the same chunks, tokenized once. */
  readonly lexical: LexicalIndex;
  /** Stored vectors grouped by input hash, in persisted order. */
  readonly vectorsByInputHash: ReadonlyMap<string, readonly StoredVector[]>;
  /** Exact-search vectors, packed lazily per embedding identity. */
  readonly semantic: SemanticSpaceCache;
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
      inputHash: embeddingInputHash(chunk),
    })),
    lexical: buildLexicalIndex(index.chunks),
    vectorsByInputHash,
    semantic: { spaces: new Map(), builds: 0 },
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

/**
 * The packed exact-search space for this embedding, built at most once per
 * prepared index. Rows follow repository chunk order and include exactly the
 * chunks findStoredVector resolves, so a chunk's vector is the same one the
 * unpacked lookup would have used.
 */
export function semanticSpaceFor(
  index: PreparedRepositoryIndex,
  embedding: EmbeddingAdapter,
): SemanticSpace {
  const key = JSON.stringify([
    embedding.provider,
    embedding.model,
    embedding.version,
    embedding.dimensions ?? "provider-default",
  ]);
  const cached = index.semantic.spaces.get(key);
  if (cached) return cached;
  const chunks: ContextChunk[] = [];
  const rows: number[][] = [];
  for (const prepared of index.chunks) {
    const stored = findStoredVector(index, prepared, embedding);
    if (!stored) continue;
    if (stored.dimensions !== stored.values.length)
      throw new Error(
        `Embedding vector dimension mismatch: stored=${stored.dimensions} but holds ${stored.values.length} values`,
      );
    chunks.push(prepared.chunk);
    rows.push(stored.values);
  }
  const space: SemanticSpace = { index: buildSemanticIndex(rows), chunks };
  index.semantic.spaces.set(key, space);
  index.semantic.builds++;
  return space;
}
