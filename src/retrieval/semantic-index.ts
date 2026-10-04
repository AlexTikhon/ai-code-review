/**
 * Exact cosine search over packed vectors. This module is purely numeric: it
 * knows nothing about chunks, embedding providers, or the review pipeline.
 * Callers keep their own ordinal -> entity mapping and resolve only the few
 * winning ordinals afterwards.
 *
 * The result is bit-for-bit the one a naive "score every vector with a
 * freshly computed norm, sort everything, take K" scan produces:
 *
 *  - each dot product accumulates over dimensions in ascending order, exactly
 *    like the naive loop; vectors are scored four at a time, but every vector
 *    keeps its own accumulator, so scoring several at once only adds
 *    independent work to the pipeline and never reorders a sum;
 *  - squared norms use the same accumulation, computed once at build time for
 *    stored vectors and once per query for the query;
 *  - the score is max(0, dot / sqrt(|q|^2 * |v|^2)), and 0 when either norm is 0;
 *  - ties on score keep ascending ordinal, the order a stable sort gives.
 */

export type SemanticExactIndex = {
  readonly dimensions: number;
  readonly count: number;
  /** Row-major: vector `r` is `vectors[r * dimensions ... (r + 1) * dimensions)`. */
  readonly vectors: Float64Array;
  /** Per-row sum of squares, accumulated in dimension order. */
  readonly squaredNorms: Float64Array;
};

export type SemanticHit = { ordinal: number; score: number };

/** Counters for what a search actually did; used by tests and the benchmark. */
export type SemanticSearchWork = {
  vectorsCompared: number;
  dimensionsProcessed: number;
  queryNormsComputed: number;
  /** Times a candidate entered the bounded top-K buffer. */
  insertions: number;
};

/**
 * Pack equal-length, finite rows into one contiguous Float64Array. Float64 is
 * deliberate: it keeps persisted precision, so scores equal the unpacked
 * reference exactly (see docs/ARCHITECTURE.md for the Float32 trade-off).
 * Malformed rows are rejected here so the scoring loop can stay branch-free.
 */
export function buildSemanticIndex(
  rows: ReadonlyArray<ReadonlyArray<number>>,
): SemanticExactIndex {
  const count = rows.length;
  if (count === 0)
    return {
      dimensions: 0,
      count: 0,
      vectors: new Float64Array(0),
      squaredNorms: new Float64Array(0),
    };
  const dimensions = rows[0]!.length;
  if (dimensions <= 0)
    throw new Error("Embedding vectors must have a positive dimension");
  const vectors = new Float64Array(count * dimensions);
  const squaredNorms = new Float64Array(count);
  for (let row = 0; row < count; row++) {
    const values = rows[row]!;
    if (values.length !== dimensions)
      throw new Error(
        `Embedding vector dimension mismatch: stored=${dimensions} and stored=${values.length}`,
      );
    const offset = row * dimensions;
    let sum = 0;
    for (let d = 0; d < dimensions; d++) {
      const value = values[d]!;
      if (!Number.isFinite(value))
        throw new Error("Embedding vectors must contain only finite values");
      vectors[offset + d] = value;
      sum += value * value;
    }
    if (!Number.isFinite(sum))
      throw new Error("Embedding vector norm is not finite");
    squaredNorms[row] = sum;
  }
  return { dimensions, count, vectors, squaredNorms };
}

/** Cosine similarity clamped at 0; every degenerate case scores 0. */
function similarity(dot: number, queryNorm: number, storedNorm: number) {
  if (queryNorm === 0 || storedNorm === 0) return 0;
  const score = dot / Math.sqrt(queryNorm * storedNorm);
  return score > 0 && score < Infinity ? score : 0;
}

/**
 * Bounded buffer of the best `capacity` hits, kept sorted by descending score.
 * Rows are offered in ascending ordinal, so an offered row that merely ties the
 * current worst entry has the higher ordinal and correctly loses; an entry is
 * inserted after every entry with an equal score. No sort ever runs, and the
 * work is O(1) per losing row.
 */
class TopK {
  readonly scores: Float64Array;
  readonly ordinals: Int32Array;
  size = 0;
  insertions = 0;

  constructor(private readonly capacity: number) {
    this.scores = new Float64Array(capacity);
    this.ordinals = new Int32Array(capacity);
  }

  offer(ordinal: number, score: number): void {
    const { scores, ordinals } = this;
    let size = this.size;
    if (size === this.capacity) {
      if (score <= scores[size - 1]!) return;
      size--;
    }
    let position = size;
    while (position > 0 && scores[position - 1]! < score) {
      scores[position] = scores[position - 1]!;
      ordinals[position] = ordinals[position - 1]!;
      position--;
    }
    scores[position] = score;
    ordinals[position] = ordinal;
    this.size = size + 1;
    this.insertions++;
  }
}

/** Rows scored per pass: independent accumulators keep the FPU pipeline full. */
const BLOCK = 4;

/**
 * The `limit` most similar rows, best first. Throws when the query does not
 * match the index dimensions or holds non-finite values; an empty index
 * returns no hits for any query.
 */
export function searchSemanticIndex(
  index: SemanticExactIndex,
  query: ReadonlyArray<number>,
  limit: number,
): { hits: SemanticHit[]; work: SemanticSearchWork } {
  const { dimensions, count, vectors, squaredNorms } = index;
  const work: SemanticSearchWork = {
    vectorsCompared: 0,
    dimensionsProcessed: 0,
    queryNormsComputed: 0,
    insertions: 0,
  };
  if (count === 0) return { hits: [], work };
  if (query.length !== dimensions)
    throw new Error(
      `Embedding vector dimension mismatch: query=${query.length}, stored=${dimensions}`,
    );
  const q = Float64Array.from(query);
  let queryNorm = 0;
  for (let d = 0; d < dimensions; d++) queryNorm += q[d]! * q[d]!;
  work.queryNormsComputed = 1;
  if (!Number.isFinite(queryNorm))
    throw new Error("Query embedding must contain only finite values");

  const capacity = limit > 0 ? Math.min(Math.floor(limit), count) : 0;
  if (capacity === 0) return { hits: [], work };
  const top = new TopK(capacity);

  const blocked = count - (count % BLOCK);
  let row = 0;
  for (; row < blocked; row += BLOCK) {
    const o0 = row * dimensions;
    const o1 = o0 + dimensions;
    const o2 = o1 + dimensions;
    const o3 = o2 + dimensions;
    let dot0 = 0;
    let dot1 = 0;
    let dot2 = 0;
    let dot3 = 0;
    for (let d = 0; d < dimensions; d++) {
      const x = q[d]!;
      dot0 += x * vectors[o0 + d]!;
      dot1 += x * vectors[o1 + d]!;
      dot2 += x * vectors[o2 + d]!;
      dot3 += x * vectors[o3 + d]!;
    }
    top.offer(row, similarity(dot0, queryNorm, squaredNorms[row]!));
    top.offer(row + 1, similarity(dot1, queryNorm, squaredNorms[row + 1]!));
    top.offer(row + 2, similarity(dot2, queryNorm, squaredNorms[row + 2]!));
    top.offer(row + 3, similarity(dot3, queryNorm, squaredNorms[row + 3]!));
  }
  for (; row < count; row++) {
    const offset = row * dimensions;
    let dot = 0;
    for (let d = 0; d < dimensions; d++) dot += q[d]! * vectors[offset + d]!;
    top.offer(row, similarity(dot, queryNorm, squaredNorms[row]!));
  }

  work.vectorsCompared = count;
  work.dimensionsProcessed = count * dimensions;
  work.insertions = top.insertions;
  const hits: SemanticHit[] = new Array(top.size);
  for (let i = 0; i < top.size; i++)
    hits[i] = { ordinal: top.ordinals[i]!, score: top.scores[i]! };
  return { hits, work };
}
