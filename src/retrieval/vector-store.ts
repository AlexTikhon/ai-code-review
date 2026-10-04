import {
  packedSquaredNorms,
  type SemanticExactIndex,
} from "./semantic-index.js";
import type { StoredVector } from "./types.js";

/**
 * Runtime home of every embedding vector of a repository index.
 *
 * Vectors are never held as number[]: each embedding space owns one contiguous
 * Float64Array (row-major), which is the same memory the persisted blob was read
 * into and the same memory exact semantic search scans. Everything else about a
 * vector (its cache key and the hash of the chunk input it embeds) lives in
 * parallel string arrays indexed by row.
 */

/** What makes two vectors comparable: the embedding space they live in. */
export type EmbeddingSpace = {
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  /** The configured dimension, or "provider-default"; not always the count. */
  readonly dimensionIdentity: string;
  /** Actual length of every vector in the segment. */
  readonly dimensions: number;
};

export const spaceKey = (space: EmbeddingSpace): string =>
  JSON.stringify([
    space.provider,
    space.model,
    space.version,
    space.dimensionIdentity,
    space.dimensions,
  ]);

/** All stored vectors of one embedding space. Row `r` is `vectors[r*d .. (r+1)*d)`. */
export type VectorSegment = {
  readonly space: EmbeddingSpace;
  readonly count: number;
  readonly cacheKeys: readonly string[];
  readonly inputHashes: readonly string[];
  readonly vectors: Float64Array;
  /** Derived once when the segment is created; never persisted. */
  readonly squaredNorms: Float64Array;
};

/** One stored vector: a segment and a row in it. Small, and creates no copy. */
export type VectorRef = {
  readonly segment: VectorSegment;
  readonly row: number;
};

export const refCacheKey = (ref: VectorRef): string =>
  ref.segment.cacheKeys[ref.row]!;
export const refInputHash = (ref: VectorRef): string =>
  ref.segment.inputHashes[ref.row]!;
/** The row as a view of the segment's memory. */
export const refValues = (ref: VectorRef): Float64Array => {
  const { dimensions } = ref.segment.space;
  return ref.segment.vectors.subarray(
    ref.row * dimensions,
    (ref.row + 1) * dimensions,
  );
};

/**
 * Validate and finish one segment. Computing the squared norms is the one pass
 * over the numbers: it rejects non-finite values, so no store can hold NaN or
 * Infinity, whether it came from the provider or from a file.
 */
export function createSegment(
  space: EmbeddingSpace,
  cacheKeys: readonly string[],
  inputHashes: readonly string[],
  vectors: Float64Array,
): VectorSegment {
  const count = cacheKeys.length;
  if (inputHashes.length !== count)
    throw new Error("Vector keys and input hashes disagree");
  if (!Number.isInteger(space.dimensions) || space.dimensions <= 0)
    throw new Error("Embedding vectors must have a positive dimension");
  return {
    space,
    count,
    cacheKeys,
    inputHashes,
    vectors,
    squaredNorms: packedSquaredNorms(vectors, count, space.dimensions),
  };
}

export class VectorStore {
  readonly segments: readonly VectorSegment[];
  readonly count: number;
  private readonly byKey = new Map<string, VectorRef>();

  constructor(segments: readonly VectorSegment[]) {
    this.segments = segments;
    let count = 0;
    for (const segment of segments) {
      for (let row = 0; row < segment.count; row++) {
        const key = segment.cacheKeys[row]!;
        if (this.byKey.has(key))
          throw new Error("Vector store holds a duplicate cache key");
        this.byKey.set(key, { segment, row });
      }
      count += segment.count;
    }
    this.count = count;
  }

  static empty(): VectorStore {
    return new VectorStore([]);
  }

  has(cacheKey: string): boolean {
    return this.byKey.has(cacheKey);
  }

  locate(cacheKey: string): VectorRef | undefined {
    return this.byKey.get(cacheKey);
  }

  /** Every vector, in persisted order: space by space, row by row. */
  refs(): IterableIterator<VectorRef> {
    return this.byKey.values();
  }

  /** Cache keys in persisted order. */
  keys(): string[] {
    return [...this.byKey.keys()];
  }
}

/**
 * Copy one vector into a plain StoredVector. This allocates a number[] and
 * exists for the checkpoint file and for tests: nothing on the load, search or
 * persistence path calls it.
 */
export function materializeVector(
  ref: VectorRef,
  identity: { chunkerVersion: string; maxChunkTokens: number },
): StoredVector {
  const { space } = ref.segment;
  return {
    cacheKey: refCacheKey(ref),
    values: Array.from(refValues(ref)),
    inputHash: refInputHash(ref),
    dimensions: space.dimensions,
    provider: space.provider,
    model: space.model,
    version: space.version,
    dimensionIdentity: space.dimensionIdentity,
    chunkerVersion: identity.chunkerVersion,
    maxChunkTokens: identity.maxChunkTokens,
  };
}

export const spaceOf = (vector: StoredVector): EmbeddingSpace => ({
  provider: vector.provider,
  model: vector.model,
  version: vector.version,
  dimensionIdentity: vector.dimensionIdentity,
  dimensions: vector.dimensions,
});

type PendingRow = {
  cacheKey: string;
  inputHash: string;
  source: ArrayLike<number>;
  offset: number;
};

/**
 * Accumulates rows, then packs each embedding space into one Float64Array.
 * Sources are read only in build(): a row taken from an existing segment is a
 * single typed-array copy, never an element-by-element conversion through
 * number[]. The first row added under a cache key wins.
 */
export class VectorStoreBuilder {
  private readonly groups = new Map<
    string,
    { space: EmbeddingSpace; rows: PendingRow[] }
  >();
  private readonly keys = new Set<string>();

  has(cacheKey: string): boolean {
    return this.keys.has(cacheKey);
  }

  get size(): number {
    return this.keys.size;
  }

  add(
    space: EmbeddingSpace,
    cacheKey: string,
    inputHash: string,
    source: ArrayLike<number>,
    offset = 0,
  ): boolean {
    if (this.keys.has(cacheKey)) return false;
    this.keys.add(cacheKey);
    const key = spaceKey(space);
    let group = this.groups.get(key);
    if (!group) this.groups.set(key, (group = { space, rows: [] }));
    group.rows.push({ cacheKey, inputHash, source, offset });
    return true;
  }

  addStored(vector: StoredVector): boolean {
    return this.add(
      spaceOf(vector),
      vector.cacheKey,
      vector.inputHash,
      vector.values,
    );
  }

  /**
   * Pack the rows. When `reuse` already holds exactly these rows (same spaces,
   * same keys, same order) it is returned as is: its bytes cannot differ, since
   * a key fixes the vector, and the caller can then keep the persisted blob it
   * came from instead of copying and rewriting it.
   */
  build(reuse?: VectorStore): VectorStore {
    const groups = [...this.groups.values()];
    if (reuse && sameRows(reuse, groups)) return reuse;
    const segments = groups.map(({ space, rows }) => {
      const { dimensions } = space;
      const vectors = new Float64Array(rows.length * dimensions);
      rows.forEach((row, index) => {
        const target = index * dimensions;
        if (row.source.length < row.offset + dimensions)
          throw new Error(
            "Embedding vector length does not match declared dimensions",
          );
        if (row.source instanceof Float64Array)
          vectors.set(
            row.source.subarray(row.offset, row.offset + dimensions),
            target,
          );
        else
          for (let d = 0; d < dimensions; d++)
            vectors[target + d] = row.source[row.offset + d]!;
      });
      return createSegment(
        space,
        rows.map((row) => row.cacheKey),
        rows.map((row) => row.inputHash),
        vectors,
      );
    });
    return new VectorStore(segments);
  }
}

function sameRows(
  store: VectorStore,
  groups: ReadonlyArray<{ space: EmbeddingSpace; rows: readonly PendingRow[] }>,
): boolean {
  if (store.segments.length !== groups.length) return false;
  return groups.every(({ space, rows }, position) => {
    const segment = store.segments[position]!;
    return (
      spaceKey(segment.space) === spaceKey(space) &&
      segment.count === rows.length &&
      rows.every((row, index) => segment.cacheKeys[index] === row.cacheKey)
    );
  });
}

/** Build a store from plain StoredVectors (checkpoints, fixtures, tests). */
export function vectorStoreFromStored(
  vectors: Iterable<StoredVector>,
): VectorStore {
  const builder = new VectorStoreBuilder();
  for (const vector of vectors) builder.addStored(vector);
  return builder.build();
}

const EMPTY_SEARCH_INDEX: SemanticExactIndex = {
  dimensions: 0,
  count: 0,
  vectors: new Float64Array(0),
  squaredNorms: new Float64Array(0),
};

/**
 * The exact-search index over `refs`, one row per ref in the given order.
 *
 * When the refs are exactly one whole segment in row order, which is what an
 * index written by this code yields for its active space, the segment's own
 * arrays are returned: the search then scans the memory the blob was loaded
 * into, with no copy. Otherwise (a space holding vectors no chunk uses, rows
 * out of chunk order, or two chunks sharing a vector) the selected rows and
 * their norms are gathered into a new array; that is a copy of the active space
 * only, made once per prepared index.
 */
export function packSearchIndex(
  refs: readonly VectorRef[],
): SemanticExactIndex {
  if (refs.length === 0) return EMPTY_SEARCH_INDEX;
  const { segment } = refs[0]!;
  const whole =
    refs.length === segment.count &&
    refs.every((ref, row) => ref.segment === segment && ref.row === row);
  if (whole)
    return {
      dimensions: segment.space.dimensions,
      count: segment.count,
      vectors: segment.vectors,
      squaredNorms: segment.squaredNorms,
    };
  const dimensions = segment.space.dimensions;
  const vectors = new Float64Array(refs.length * dimensions);
  const squaredNorms = new Float64Array(refs.length);
  refs.forEach((ref, row) => {
    const other = ref.segment.space.dimensions;
    if (other !== dimensions)
      throw new Error(
        `Embedding vector dimension mismatch: stored=${dimensions} and stored=${other}`,
      );
    vectors.set(refValues(ref), row * dimensions);
    squaredNorms[row] = ref.segment.squaredNorms[ref.row]!;
  });
  return { dimensions, count: refs.length, vectors, squaredNorms };
}
