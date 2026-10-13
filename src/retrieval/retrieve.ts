import { RequestBudgetError } from "../model/budget.js";
import { EmbeddingError } from "./embedding-errors.js";
import {
  executeEmbeddingRequest,
  type EmbeddingExecutionOptions,
} from "./embedding-execution.js";
import type { EmbeddingAdapter } from "./embeddings.js";
import { rankLexicalCandidates } from "./lexical-index.js";
import {
  isPreparedIndex,
  prepareRepositoryIndex,
  semanticSpaceFor,
  type PreparedRepositoryIndex,
} from "./prepared-index.js";
import { searchSemanticIndex } from "./semantic-index.js";
import type {
  ContextChunk,
  RepositoryIndex,
  RetrievalCandidate,
} from "./types.js";

export type RetrievalInput = {
  index: RepositoryIndex | PreparedRepositoryIndex;
  repositoryId: string;
  revision: string;
  query: string;
  changedPath: string;
  mode: "lexical" | "hybrid";
  candidates: number;
  topK: number;
  threshold: number;
  embedding?: EmbeddingAdapter;
  signal?: AbortSignal;
  /** Reserves one request-budget unit; called before every provider attempt, retries included. */
  beforeEmbeddingRequest?: () => void;
  embeddingExecution?: EmbeddingExecutionOptions;
};

export type RetrievalOutcome = {
  candidates: RetrievalCandidate[];
  /**
   * Set when semantic retrieval was requested and failed: the candidates are
   * then lexical only, ranked exactly as in lexical mode.
   */
  semanticFailure?: EmbeddingError | RequestBudgetError;
};

/**
 * A failure of optional semantic work that must not stop a review: a typed
 * provider failure, or the application's own request cap. Cancellation and
 * the total deadline are never degradable, and neither is anything untyped.
 */
export function isDegradableEmbeddingFailure(
  error: unknown,
  signal?: AbortSignal,
): error is EmbeddingError | RequestBudgetError {
  if (signal?.aborted) return false;
  if (error instanceof RequestBudgetError) return true;
  return error instanceof EmbeddingError && error.kind !== "aborted";
}

/**
 * Rank repository chunks for one review segment.
 *
 * Pass a PreparedRepositoryIndex to reuse tokenization and vector lookup across
 * segments; a raw RepositoryIndex is prepared on the fly (one O(chunks +
 * vectors) pass) so one-off callers keep working.
 *
 * Strict: a failed query embedding throws. See retrieveContextDetailed for the
 * variant that keeps the lexical candidates instead.
 */
export async function retrieveContext(
  input: RetrievalInput,
): Promise<RetrievalCandidate[]> {
  return (await rank(input, false)).candidates;
}

/**
 * Like retrieveContext, but a degradable semantic failure (see
 * isDegradableEmbeddingFailure) returns the lexical candidates together with
 * the failure, so the caller can report degradation and continue.
 */
export function retrieveContextDetailed(
  input: RetrievalInput,
): Promise<RetrievalOutcome> {
  return rank(input, true);
}

async function rank(
  input: RetrievalInput,
  degrade: boolean,
): Promise<RetrievalOutcome> {
  if (
    input.index.repositoryId !== input.repositoryId ||
    input.index.revision !== input.revision
  )
    throw new Error(
      "Repository context index is stale or belongs to a different repository/revision",
    );
  input.signal?.throwIfAborted();
  const index = isPreparedIndex(input.index)
    ? input.index
    : prepareRepositoryIndex(input.index);
  const { candidates: lexical } = rankLexicalCandidates(
    index.lexical,
    input.query,
    input.changedPath,
    input.candidates,
  );

  const semantic: RetrievalCandidate[] = [];
  let semanticFailure: EmbeddingError | RequestBudgetError | undefined;
  if (input.mode === "hybrid" && input.embedding) {
    input.signal?.throwIfAborted();
    try {
      const { vectors } = await executeEmbeddingRequest({
        ...input.embeddingExecution,
        adapter: input.embedding,
        texts: [input.query],
        signal: input.signal,
        beforeAttempt: input.beforeEmbeddingRequest,
      });
      // Packed once per prepared index. The search scores numbers only; chunk
      // objects are resolved below for the winning ordinals alone.
      const space = semanticSpaceFor(index, input.embedding);
      const { hits } = searchSemanticIndex(
        space.index,
        vectors[0]!,
        input.candidates,
      );
      for (const { ordinal, score } of hits)
        semantic.push({
          chunk: space.chunks[ordinal]!,
          score,
          reasons: [`semantic:${score.toFixed(3)}`],
        });
    } catch (error) {
      if (!degrade || !isDegradableEmbeddingFailure(error, input.signal))
        throw error;
      semanticFailure = error;
    }
  }
  const semanticUsed = Boolean(
    input.mode === "hybrid" && input.embedding && !semanticFailure,
  );

  const union = new Map<
    string,
    {
      chunk: ContextChunk;
      lexical: number;
      semantic: number;
      reasons: string[];
    }
  >();
  for (const candidate of lexical)
    union.set(candidate.chunk.id, {
      chunk: candidate.chunk,
      lexical: candidate.score,
      semantic: 0,
      reasons: [...candidate.reasons],
    });
  for (const candidate of semantic) {
    const existing = union.get(candidate.chunk.id);
    if (existing) {
      existing.semantic = candidate.score;
      existing.reasons.push(...candidate.reasons);
    } else
      union.set(candidate.chunk.id, {
        chunk: candidate.chunk,
        lexical: 0,
        semantic: candidate.score,
        reasons: [...candidate.reasons],
      });
  }
  const ranked = [...union.values()]
    .map(
      ({ chunk, lexical: lexicalScore, semantic: semanticScore, reasons }) => ({
        chunk,
        score: semanticUsed
          ? lexicalScore * 0.4 + semanticScore * 0.6
          : lexicalScore,
        reasons,
      }),
    )
    .sort((a, b) => b.score - a.score);
  const deduped = new Map<string, RetrievalCandidate>();
  for (const candidate of ranked)
    if (
      candidate.score >= input.threshold &&
      !deduped.has(candidate.chunk.contentHash)
    )
      deduped.set(candidate.chunk.contentHash, candidate);
  return {
    candidates: [...deduped.values()].slice(0, input.topK),
    ...(semanticFailure ? { semanticFailure } : {}),
  };
}
