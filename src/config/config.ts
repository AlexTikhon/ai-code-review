/** The only invocation fact configuration depends on; CliArgs satisfies it. */
export type ConfigOptions = { allowExternal: boolean };
export const REVIEW_PROVIDERS = ["openai", "anthropic"] as const;
export type ReviewProviderName = (typeof REVIEW_PROVIDERS)[number];
/** Preserves the behavior from before provider selection existed. */
export const DEFAULT_REVIEW_PROVIDER: ReviewProviderName = "openai";
const DEFAULT_MODELS: Record<ReviewProviderName, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-opus-5-5",
};
const MODEL_ENV: Record<ReviewProviderName, string> = {
  openai: "AI_REVIEW_MODEL",
  anthropic: "ANTHROPIC_MODEL",
};

export type ReviewConfig = {
  /** Which ReviewModel the bootstrap layer composes. Embeddings are separate. */
  reviewProvider: ReviewProviderName;
  /** Model name for the selected review provider. */
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
  /**
   * Retry bounds for embedding requests, independent of the review model's
   * `maxAttempts`. Absent means the defaults; loadConfig always sets it.
   */
  embeddingRetry?: { maxAttempts: number; baseDelayMs: number };
  retrievalCandidates: number;
  retrievalTopK: number;
  relevanceThreshold: number;
  /** Cache namespace label; never a path inside the reviewed repository. */
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
function boundedInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (
    raw.trim() === "" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function reviewProvider(): ReviewProviderName {
  const raw = process.env.AI_REVIEW_PROVIDER?.trim();
  if (!raw) return DEFAULT_REVIEW_PROVIDER;
  if (!(REVIEW_PROVIDERS as readonly string[]).includes(raw))
    throw new Error(
      `AI_REVIEW_PROVIDER must be one of ${REVIEW_PROVIDERS.join(", ")} (got "${raw.slice(0, 40)}")`,
    );
  return raw as ReviewProviderName;
}
function modelFor(provider: ReviewProviderName): string {
  return process.env[MODEL_ENV[provider]] || DEFAULT_MODELS[provider];
}
/** Best-effort model name for reports; never throws, even on a bad provider. */
export function selectedModelName(): string {
  const raw = process.env.AI_REVIEW_PROVIDER?.trim();
  const provider = (REVIEW_PROVIDERS as readonly string[]).includes(raw ?? "")
    ? (raw as ReviewProviderName)
    : DEFAULT_REVIEW_PROVIDER;
  return modelFor(provider);
}
export function loadConfig(options: ConfigOptions): ReviewConfig {
  const allowed = process.env.AI_REVIEW_ALLOW_EXTERNAL === "true";
  if (options.allowExternal && !allowed)
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
  const provider = reviewProvider();
  return {
    reviewProvider: provider,
    model: modelFor(provider),
    embeddingModel:
      process.env.AI_REVIEW_EMBEDDING_MODEL ?? "text-embedding-3-small",
    allowExternal: options.allowExternal && allowed,
    allowEmbeddings:
      options.allowExternal &&
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
    embeddingRetry: {
      maxAttempts: boundedInt("AI_REVIEW_EMBEDDING_MAX_ATTEMPTS", 3, 1, 10),
      baseDelayMs: boundedInt(
        "AI_REVIEW_EMBEDDING_RETRY_BASE_MS",
        250,
        0,
        10_000,
      ),
    },
    retrievalCandidates: positiveInt("AI_REVIEW_RETRIEVAL_CANDIDATES", 20),
    retrievalTopK: positiveInt("AI_REVIEW_RETRIEVAL_TOP_K", 5),
    relevanceThreshold: threshold,
    cacheDirName: ".ai-reviewer/cache",
  };
}
