import {
  CHUNKER_VERSION,
  type RepositoryIndex,
  type RetrievalCandidate,
} from "./types.js";
import type { EmbeddingAdapter } from "./embeddings.js";
const tokens = (value: string) =>
  new Set(value.toLowerCase().match(/[a-z_$][\w$]{2,}/g) ?? []);
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! ** 2;
    bb += b[i]! ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
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
}): Promise<RetrievalCandidate[]> {
  if (
    input.index.repositoryId !== input.repositoryId ||
    input.index.revision !== input.revision
  )
    throw new Error(
      "Repository context index is stale or belongs to a different repository/revision",
    );
  const queryTokens = tokens(input.query);
  const lexical = input.index.chunks
    .filter((chunk) => chunk.path !== input.changedPath)
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
      const score = queryTokens.size
        ? overlap / queryTokens.size + importBoost + symbolBoost
        : 0;
      const reasons = [
        overlap ? `keyword-overlap:${overlap}` : "",
        importBoost ? "import-link" : "",
        symbolBoost ? "symbol-match" : "",
      ].filter(Boolean);
      return { chunk, score, reasons } as RetrievalCandidate;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, input.candidates);
  if (input.mode === "hybrid" && input.embedding) {
    const [queryVector] = await input.embedding.embed(
      [input.query],
      input.signal,
    );
    for (const candidate of lexical) {
      const key = `${candidate.chunk.contentHash}:${input.embedding.model}:${input.embedding.version}:${CHUNKER_VERSION}`;
      const vector = input.index.vectors[key]?.values;
      if (vector) {
        const semantic = cosine(queryVector!, vector);
        candidate.score = candidate.score * 0.55 + semantic * 0.45;
        candidate.reasons.push(`semantic:${semantic.toFixed(3)}`);
      }
    }
  }
  const deduped = new Map<string, RetrievalCandidate>();
  for (const candidate of lexical.sort((a, b) => b.score - a.score))
    if (
      !deduped.has(candidate.chunk.contentHash) &&
      candidate.score >= input.threshold
    )
      deduped.set(candidate.chunk.contentHash, candidate);
  return [...deduped.values()].slice(0, input.topK);
}
