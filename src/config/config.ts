import type { CliArgs } from "../cli/args.js";
export type ReviewConfig = {
  model: string;
  embeddingModel: string;
  allowExternal: boolean;
  allowEmbeddings: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxMetadataCharacters: number;
  maxPatchTokens: number;
  maxContextTokens: number;
  maxSegmentsPerFile: number;
  maxFiles: number;
  maxRequests: number;
  concurrency: number;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
  maxAttempts: number;
  retrievalCandidates: number;
  retrievalTopK: number;
  relevanceThreshold: number;
  cacheDirName: string;
};
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive finite integer`);
  return value;
}
export function loadConfig(args: CliArgs): ReviewConfig {
  const allowed = process.env.AI_REVIEW_ALLOW_EXTERNAL === "true";
  if (args.allowExternal && !allowed)
    throw new Error(
      "--allow-external also requires AI_REVIEW_ALLOW_EXTERNAL=true",
    );
  if (
    process.env.LANGCHAIN_TRACING_V2 === "true" ||
    process.env.LANGSMITH_TRACING === "true"
  )
    throw new Error(
      "Tracing export is disabled because review data must not be exported",
    );
  const threshold = Number(process.env.AI_REVIEW_RELEVANCE_THRESHOLD ?? "0.05");
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new Error("AI_REVIEW_RELEVANCE_THRESHOLD must be between 0 and 1");
  return {
    model: process.env.AI_REVIEW_MODEL ?? "gpt-4o-mini",
    embeddingModel:
      process.env.AI_REVIEW_EMBEDDING_MODEL ?? "text-embedding-3-small",
    allowExternal: args.allowExternal && allowed,
    allowEmbeddings:
      args.allowExternal &&
      allowed &&
      process.env.AI_REVIEW_ALLOW_EMBEDDINGS === "true",
    maxInputTokens: positiveInt("AI_REVIEW_MAX_INPUT_TOKENS", 8000),
    maxOutputTokens: positiveInt("AI_REVIEW_MAX_OUTPUT_TOKENS", 1200),
    maxMetadataCharacters: positiveInt("AI_REVIEW_MAX_METADATA_CHARS", 4000),
    maxPatchTokens: positiveInt("AI_REVIEW_MAX_PATCH_TOKENS", 4000),
    maxContextTokens: positiveInt("AI_REVIEW_MAX_CONTEXT_TOKENS", 1800),
    maxSegmentsPerFile: positiveInt("AI_REVIEW_MAX_SEGMENTS_PER_FILE", 4),
    maxFiles: positiveInt("AI_REVIEW_MAX_FILES", 100),
    maxRequests: positiveInt("AI_REVIEW_MAX_REQUESTS", 200),
    concurrency: positiveInt("AI_REVIEW_CONCURRENCY", 2),
    requestTimeoutMs: positiveInt("AI_REVIEW_REQUEST_TIMEOUT_MS", 60000),
    totalTimeoutMs: positiveInt("AI_REVIEW_TOTAL_TIMEOUT_MS", 600000),
    maxAttempts: positiveInt("AI_REVIEW_MAX_ATTEMPTS", 3),
    retrievalCandidates: positiveInt("AI_REVIEW_RETRIEVAL_CANDIDATES", 20),
    retrievalTopK: positiveInt("AI_REVIEW_RETRIEVAL_TOP_K", 5),
    relevanceThreshold: threshold,
    cacheDirName: ".ai-reviewer/cache",
  };
}
