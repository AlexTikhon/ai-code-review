import type { EmbeddingAdapter } from "./embeddings.js";
import { buildLexicalIndex, type LexicalIndex } from "./lexical-index.js";
import type { SemanticExactIndex } from "./semantic-index.js";
import { embeddingInputHash } from "./embedding-keys.js";
import type { ContextChunk, RepositoryIndex } from "./types.js";
import {
  packSearchIndex,
  refInputHash,
  type VectorRef,
} from "./vector-store.js";

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
 * never serialized: the persisted index stays the source of truth and this is
 * compiled from it once per run, then reused by every review segment. It points
 * into the packed vector store (VectorRef) and copies no vector values.
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
  readonly vectorsByInputHash: ReadonlyMap<string, readonly VectorRef[]>;
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
  const vectorsByInputHash = new Map<string, VectorRef[]>();
  for (const ref of index.vectors.refs()) {
    const hash = refInputHash(ref);
    const group = vectorsByInputHash.get(hash);
    if (group) group.push(ref);
    else vectorsByInputHash.set(hash, [ref]);
  }
  // Persisted indexes carry their chunk hashes; hand-built ones are hashed here.
  const inputHashes =
    index.inputHashes.length === index.chunks.length
      ? index.inputHashes
      : index.chunks.map(embeddingInputHash);
  return {
    kind: "prepared-repository-index",
    repositoryId: index.repositoryId,
    revision: index.revision,
    chunkerVersion: index.chunkerVersion,
    maxChunkTokens: index.maxChunkTokens,
    chunks: index.chunks.map((chunk, position) => ({
      chunk,
      inputHash: inputHashes[position]!,
    })),
    lexical: buildLexicalIndex(index.chunks),
    vectorsByInputHash,
    semantic: { spaces: new Map(), builds: 0 },
  };
}

/**
 * The stored vector compatible with this chunk and embedding space, or
 * undefined. Constant-time in the number of stored vectors: candidates are the
 * (normally single-element) group sharing the chunk's input hash. Every vector
 * of an index was made under the index's own chunker version and chunk budget,
 * so only the embedding space has to match.
 */
export function findStoredVector(
  index: PreparedRepositoryIndex,
  chunk: PreparedChunk,
  embedding: EmbeddingAdapter,
): VectorRef | undefined {
  const dimensionIdentity = String(embedding.dimensions ?? "provider-default");
  return index.vectorsByInputHash.get(chunk.inputHash)?.find(({ segment }) => {
    const { space } = segment;
    return (
      space.provider === embedding.provider &&
      space.model === embedding.model &&
      space.version === embedding.version &&
      space.dimensionIdentity === dimensionIdentity
    );
  });
}

/**
 * The packed exact-search space for this embedding, built at most once per
 * prepared index. Rows follow repository chunk order and include exactly the
 * chunks findStoredVector resolves. For an index written by this code that is
 * the whole active segment in row order, which the search scans in place (see
 * packSearchIndex); only an irregular index pays for a gathered copy.
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
  const refs: VectorRef[] = [];
  for (const prepared of index.chunks) {
    const stored = findStoredVector(index, prepared, embedding);
    if (!stored) continue;
    chunks.push(prepared.chunk);
    refs.push(stored);
  }
  const space: SemanticSpace = { index: packSearchIndex(refs), chunks };
  index.semantic.spaces.set(key, space);
  index.semantic.builds++;
  return space;
}
