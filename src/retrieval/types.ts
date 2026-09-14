export const CHUNKER_VERSION = "ts-js-ast-v2";
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
  /** False only when this chunk is a fragment of one oversized physical line. */
  contentComplete: boolean;
  omissionReason?: string;
};
export type StoredVector = {
  cacheKey: string;
  values: number[];
  inputHash: string;
  dimensions: number;
  provider: string;
  model: string;
  version: string;
  dimensionIdentity: string;
  chunkerVersion: string;
  maxChunkTokens: number;
};
export type RepositoryIndex = {
  schemaVersion: 1;
  chunkerVersion: string;
  repositoryId: string;
  revision: string;
  maxChunkTokens: number;
  createdAt: string;
  chunks: ContextChunk[];
  vectors: Record<string, StoredVector>;
};
export type RetrievalCandidate = {
  chunk: ContextChunk;
  score: number;
  reasons: string[];
};
