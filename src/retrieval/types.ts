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
/** Version of the persisted RepositoryIndex layout. */
export const INDEX_SCHEMA_VERSION = 2;
/**
 * Identity of one indexed source file: what is needed to decide, without
 * re-chunking, whether its chunks can be reused. Reuse depends on content
 * identity (blob id or content hash); mtime and size are only a hint.
 */
export type IndexedFile = {
  path: string;
  /** SHA-256 of the file text that was chunked. */
  contentHash: string;
  /** Size in bytes of that text. */
  size: number;
  /** Git object id when the file came from a revision tree. */
  blobId?: string;
  /** Working-tree mtime, recorded only when it cannot be a same-tick race. */
  mtimeMs?: number;
  /** Chunks produced from this file, in order. */
  chunkIds: string[];
};
export type RepositoryIndex = {
  schemaVersion: typeof INDEX_SCHEMA_VERSION;
  chunkerVersion: string;
  /** Privacy policy the indexed files were admitted under. */
  policyVersion: string;
  repositoryId: string;
  revision: string;
  maxChunkTokens: number;
  createdAt: string;
  /** Per-file identity, in repository order; owns every chunk exactly once. */
  files: IndexedFile[];
  chunks: ContextChunk[];
  vectors: Record<string, StoredVector>;
};
export type RetrievalCandidate = {
  chunk: ContextChunk;
  score: number;
  reasons: string[];
};
