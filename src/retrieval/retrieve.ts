import { embeddingInputHash } from "./index-store.js";
import { validateEmbeddingBatch, type EmbeddingAdapter } from "./embeddings.js";
import type {
  ContextChunk,
  RepositoryIndex,
  RetrievalCandidate,
  StoredVector,
} from "./types.js";

const tokens = (value: string) =>
  new Set(value.toLowerCase().match(/[a-z_$][\w$]{2,}/g) ?? []);

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length)
    throw new Error(
      `Embedding vector dimension mismatch: query=${a.length}, stored=${b.length}`,
    );
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! ** 2;
    bb += b[i]! ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

function vectorFor(
  index: RepositoryIndex,
  chunk: ContextChunk,
  embedding: EmbeddingAdapter,
): StoredVector | undefined {
  const inputHash = embeddingInputHash(chunk);
  return Object.values(index.vectors).find(
    (vector) =>
      vector.inputHash === inputHash &&
      vector.provider === embedding.provider &&
      vector.model === embedding.model &&
      vector.version === embedding.version &&
      vector.dimensionIdentity ===
        String(embedding.dimensions ?? "provider-default") &&
      vector.chunkerVersion === index.chunkerVersion &&
      vector.maxChunkTokens === index.maxChunkTokens,
  );
}

export async function retrieveContext(input: {
  index: RepositoryIndex;
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
  beforeEmbeddingRequest?: () => void;
}): Promise<RetrievalCandidate[]> {
  if (
    input.index.repositoryId !== input.repositoryId ||
    input.index.revision !== input.revision
  )
    throw new Error(
      "Repository context index is stale or belongs to a different repository/revision",
    );
  input.signal?.throwIfAborted();
  const queryTokens = tokens(input.query);
  const lexical = input.index.chunks
    .map((chunk) => {
      const haystack = tokens(
        `${chunk.path} ${chunk.name ?? ""} ${chunk.signature ?? ""} ${chunk.imports.join(" ")} ${chunk.content}`,
      );
      let overlap = 0;
      for (const token of queryTokens) if (haystack.has(token)) overlap++;
      const importBoost = chunk.imports.some((item) =>
        input.changedPath.includes(item.replace(/^\.\//, "")),
      )
        ? 0.2
        : 0;
      const symbolBoost =
        chunk.name && queryTokens.has(chunk.name.toLowerCase()) ? 0.35 : 0;
      const sameFileBoost = chunk.path === input.changedPath ? 0.05 : 0;
      const score = Math.min(
        1,
        (queryTokens.size ? overlap / queryTokens.size : 0) +
          importBoost +
          symbolBoost +
          sameFileBoost,
      );
      const reasons = [
        overlap ? `keyword-overlap:${overlap}` : "",
        importBoost ? "import-link" : "",
        symbolBoost ? "symbol-match" : "",
        sameFileBoost ? "same-file" : "",
      ].filter(Boolean);
      return { chunk, score, reasons } as RetrievalCandidate;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, input.candidates);

  const semantic: RetrievalCandidate[] = [];
  if (input.mode === "hybrid" && input.embedding) {
    input.signal?.throwIfAborted();
    input.beforeEmbeddingRequest?.();
    const vectors = await input.embedding.embed([input.query], input.signal);
    const dimensions = validateEmbeddingBatch(
      vectors,
      1,
      input.embedding.dimensions,
    );
    const queryVector = vectors[0]!;
    for (const chunk of input.index.chunks) {
      const stored = vectorFor(input.index, chunk, input.embedding);
      if (!stored) continue;
      if (
        stored.dimensions !== dimensions ||
        stored.values.length !== dimensions
      )
        throw new Error(
          `Embedding vector dimension mismatch: query=${dimensions}, stored=${stored.dimensions}`,
        );
      const score = Math.max(0, cosine(queryVector, stored.values));
      semantic.push({
        chunk,
        score,
        reasons: [`semantic:${score.toFixed(3)}`],
      });
    }
    semantic.sort((a, b) => b.score - a.score).splice(input.candidates);
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
