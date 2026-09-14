export const CHUNKER_VERSION = "ts-js-symbols-v1";
export type ContextChunk = {
  id: string;
  repositoryId: string;
  revision: string;
  path: string;
  language: "typescript" | "javascript" | "fallback";
  kind: "symbol" | "file";
  name?: string;
  signature?: string;
  imports: string[];
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
};
export type StoredVector = { cacheKey: string; values: number[] };
export type RepositoryIndex = {
  schemaVersion: 1;
  chunkerVersion: string;
  repositoryId: string;
  revision: string;
  createdAt: string;
  chunks: ContextChunk[];
  vectors: Record<string, StoredVector>;
};
export type RetrievalCandidate = {
  chunk: ContextChunk;
  score: number;
  reasons: string[];
};
