import { DeterministicTestEmbedding } from "../src/retrieval/embeddings.js";
import { embeddingInputHash } from "../src/retrieval/index-store.js";
import type {
  ContextChunk,
  RepositoryIndex,
  RetrievalCandidate,
  StoredVector,
} from "../src/retrieval/types.js";

const embedding = new DeterministicTestEmbedding();

/**
 * Reference implementation: the pre-optimization algorithm, kept verbatim in
 * spirit (score every chunk against every query; linear scan of all vectors per
 * chunk). Optimized retrieval must reproduce its output exactly.
 */
export function referenceLexical(
  index: Pick<RepositoryIndex, "chunks">,
  query: string,
  changedPath: string,
  candidates: number,
): RetrievalCandidate[] {
  const tokens = (value: string) =>
    new Set(value.toLowerCase().match(/[a-z_$][\w$]{2,}/g) ?? []);
  const queryTokens = tokens(query);
  return index.chunks
    .map((chunk) => {
      const haystack = tokens(
        `${chunk.path} ${chunk.name ?? ""} ${chunk.signature ?? ""} ${chunk.imports.join(" ")} ${chunk.content}`,
      );
      let overlap = 0;
      for (const token of queryTokens) if (haystack.has(token)) overlap++;
      const importBoost = chunk.imports.some((item) =>
        changedPath.includes(item.replace(/^\.\//, "")),
      )
        ? 0.2
        : 0;
      const symbolBoost =
        chunk.name && queryTokens.has(chunk.name.toLowerCase()) ? 0.35 : 0;
      const sameFileBoost = chunk.path === changedPath ? 0.05 : 0;
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
    .slice(0, candidates);
}

export async function referenceRetrieve(
  index: RepositoryIndex,
  query: string,
  changedPath: string,
  mode: "lexical" | "hybrid",
  candidates: number,
  topK: number,
  threshold: number,
): Promise<RetrievalCandidate[]> {
  const lexical = referenceLexical(index, query, changedPath, candidates);
  const semantic: RetrievalCandidate[] = [];
  if (mode === "hybrid") {
    const queryVector = (await embedding.embed([query]))[0]!;
    for (const chunk of index.chunks) {
      const hash = embeddingInputHash(chunk);
      const stored = Object.values(index.vectors).find(
        (vector: StoredVector) =>
          vector.inputHash === hash &&
          vector.provider === embedding.provider &&
          vector.model === embedding.model &&
          vector.version === embedding.version &&
          vector.dimensionIdentity === String(embedding.dimensions) &&
          vector.chunkerVersion === index.chunkerVersion &&
          vector.maxChunkTokens === index.maxChunkTokens,
      );
      if (!stored) continue;
      let dot = 0;
      let aa = 0;
      let bb = 0;
      for (let i = 0; i < queryVector.length; i++) {
        dot += queryVector[i]! * stored.values[i]!;
        aa += queryVector[i]! ** 2;
        bb += stored.values[i]! ** 2;
      }
      const score = Math.max(0, aa && bb ? dot / Math.sqrt(aa * bb) : 0);
      semantic.push({
        chunk,
        score,
        reasons: [`semantic:${score.toFixed(3)}`],
      });
    }
    semantic.sort((a, b) => b.score - a.score).splice(candidates);
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
  for (const c of lexical)
    union.set(c.chunk.id, {
      chunk: c.chunk,
      lexical: c.score,
      semantic: 0,
      reasons: [...c.reasons],
    });
  for (const c of semantic) {
    const existing = union.get(c.chunk.id);
    if (existing) {
      existing.semantic = c.score;
      existing.reasons.push(...c.reasons);
    } else
      union.set(c.chunk.id, {
        chunk: c.chunk,
        lexical: 0,
        semantic: c.score,
        reasons: [...c.reasons],
      });
  }
  const ranked = [...union.values()]
    .map((u) => ({
      chunk: u.chunk,
      score: mode === "hybrid" ? u.lexical * 0.4 + u.semantic * 0.6 : u.lexical,
      reasons: u.reasons,
    }))
    .sort((a, b) => b.score - a.score);
  const deduped = new Map<string, RetrievalCandidate>();
  for (const c of ranked)
    if (c.score >= threshold && !deduped.has(c.chunk.contentHash))
      deduped.set(c.chunk.contentHash, c);
  return [...deduped.values()].slice(0, topK);
}
