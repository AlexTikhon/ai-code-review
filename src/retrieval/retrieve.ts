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

/**
 * Rank repository chunks for one review segment.
 *
 * Pass a PreparedRepositoryIndex to reuse tokenization and vector lookup across
 * segments; a raw RepositoryIndex is prepared on the fly (one O(chunks +
 * vectors) pass) so one-off callers keep working.
 */
export async function retrieveContext(input: {
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
}): Promise<RetrievalCandidate[]> {
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
  if (input.mode === "hybrid" && input.embedding) {
    input.signal?.throwIfAborted();
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
  }

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
        score:
          input.mode === "hybrid" && input.embedding
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
  return [...deduped.values()].slice(0, input.topK);
}
