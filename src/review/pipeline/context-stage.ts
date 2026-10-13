import { emitEvent } from "../../observability/events.js";
import type { EmbeddingAdapter } from "../../retrieval/embeddings.js";
import {
  indexPath,
  refreshRepositoryIndex,
} from "../../retrieval/index-store.js";
import {
  prepareRepositoryIndex,
  type PreparedRepositoryIndex,
} from "../../retrieval/prepared-index.js";
import { contextRepositoryId } from "../context-identity.js";
import type { LoadedIgnore } from "../ignore.js";
import type {
  ContextDegradation,
  ReviewError,
  ReviewResult,
  ReviewSource,
} from "../types.js";
import { embeddingExecutionFor } from "./embedding-execution.js";
import {
  contextFailure,
  degradationError,
  embeddingDegradation,
} from "./analysis-errors.js";
import { errorMessage } from "./result.js";
import type { PipelineContext } from "./types.js";

export type ContextOutcome = {
  /** Initial `context` block for the result; `selected` starts empty. */
  context: ReviewResult["context"];
  /** Compiled once here and reused by every segment. */
  prepared?: PreparedRepositoryIndex;
  /** Present only when semantic retrieval is both requested and supplied. */
  embedding?: EmbeddingAdapter;
  indexLocation?: string;
  chunkCount?: number;
  errors: ReviewError[];
};

/**
 * Stage 3: build/refresh the repository index and compile it for retrieval.
 *
 * Embeddings are optional work that shares the one request cap with model
 * review, so they are bounded to what `modelRequestsToProtect` leaves free
 * (one request per planned review segment). When they cannot be made, or fail
 * while the run is still active, the stage builds the lexical index and says
 * so in `context.degradations`; it never silently reports hybrid success.
 */
export async function contextStage(
  ctx: PipelineContext,
  source: ReviewSource,
  policy: LoadedIgnore,
  blockedPaths: readonly string[] = [],
  modelRequestsToProtect = 0,
): Promise<ContextOutcome> {
  const { contextMode } = ctx.request;
  if (contextMode === "diff")
    return {
      context: { mode: contextMode, state: "disabled", selected: [] },
      errors: [],
    };
  if (!source.repositoryRoot)
    return {
      context: {
        mode: contextMode,
        state: "unavailable",
        selected: [],
        message:
          "Repository retrieval for GitHub PRs requires --repo pointing to a checkout at the PR head; using diff-only review.",
      },
      errors: [],
    };

  const started = ctx.now();
  const hybrid = contextMode === "hybrid";
  // A dry run reads the index but never calls a provider.
  const live = !ctx.request.dryRun;
  const allowance = Math.max(
    0,
    ctx.config.maxRequests - modelRequestsToProtect,
  );
  if (hybrid && live) ctx.budget.capEmbeddings(allowance);
  let embedding = hybrid ? ctx.embedding : undefined;
  const diagnostics: string[] = [];
  const degradations: ContextDegradation[] = [];
  const errors: ReviewError[] = [];
  const degrade = (degradation: ContextDegradation) => {
    degradations.push(degradation);
    emitEvent(ctx.events, ctx.runId, "index", "warning", {
      message: `context_degraded:${degradation.reason}`,
      data: {
        stage: degradation.stage,
        ...(degradation.code ? { code: degradation.code } : {}),
      },
    });
    // A coded degradation is also a non-fatal error, so consumers that only
    // read notifications still see it; the authorization case has no code.
    if (degradation.code) errors.push(degradationError(degradation));
  };
  if (hybrid && !ctx.embedding)
    degrade({
      stage: "index",
      reason: "embedding_withheld",
      message:
        "Semantic embeddings were not permitted; lexical/symbol retrieval was used.",
    });
  else if (hybrid && live && embedding && allowance === 0) {
    // Withheld before any call: nothing is counted as a provider request.
    degrade({
      stage: "index",
      reason: "embedding_withheld",
      code: "REQUEST_BUDGET_EXHAUSTED",
      retryable: false,
      message:
        "Embedding work was withheld: the whole request budget is reserved for model review; lexical retrieval was used.",
    });
    embedding = undefined;
  }
  const refresh = (withEmbedding: EmbeddingAdapter | undefined) =>
    refreshRepositoryIndex({
      root: source.repositoryRoot!,
      repositoryId: contextRepositoryId(source),
      revision: source.snapshotId,
      gitRevision: source.mode === "pr" ? source.headRevision : undefined,
      cacheDirName: ctx.config.cacheDirName,
      maxChunkTokens: Math.min(ctx.config.maxContextTokens, 800),
      ignorePolicy: policy,
      excludePaths: new Set(blockedPaths),
      embedding: hybrid && live ? withEmbedding : undefined,
      signal: ctx.signal,
      beforeEmbeddingRequest: () => ctx.budget.reserve("embedding"),
      embeddingExecution: embeddingExecutionFor(ctx),
      onDiagnostic: (message) => diagnostics.push(message),
      // Counts and reasons only: never vectors, prompts or source text.
      onCheckpoint: ({ type, ...data }) =>
        emitEvent(
          ctx.events,
          ctx.runId,
          "embedding",
          type === "save_failed" || type === "discarded"
            ? "warning"
            : "complete",
          { message: `checkpoint_${type}`, data },
        ),
      // Sizes, counts and reasons about loading/migrating/publishing; no vectors.
      onStoreEvent: ({ type, ...data }) =>
        emitEvent(
          ctx.events,
          ctx.runId,
          "index_store",
          type === "migration_failed" ? "warning" : "complete",
          { message: type, data },
        ),
    });
  try {
    let refreshed: Awaited<ReturnType<typeof refresh>>;
    try {
      refreshed = await refresh(embedding);
    } catch (error) {
      // Provider failure or request cap while the run is active: the failed
      // attempt left the canonical index and the checkpoint as they were, so
      // the lexical index can be built and published from the same source.
      // Cancellation and the deadline are not degradable and propagate.
      const degradation =
        embedding && live
          ? embeddingDegradation("index", error, ctx.signal, undefined)
          : undefined;
      if (!degradation) throw error;
      degrade(degradation);
      embedding = undefined;
      refreshed = await refresh(undefined);
    }
    const { index, stats, loaded } = refreshed;
    const prepared = prepareRepositoryIndex(index);
    const messages = [
      ...degradations.map((degradation) => degradation.message),
      ...diagnostics,
    ];
    emitEvent(ctx.events, ctx.runId, "index", "complete", {
      durationMs: ctx.now() - started,
      data: {
        revision: source.snapshotId,
        chunks: index.chunks.length,
        vectors: index.vectors.count,
        semantic: Boolean(embedding),
        // Counters only: never file names, source text, or vectors.
        loaded,
        previous: stats.previous,
        filesTotal: stats.filesTotal,
        filesReused: stats.filesReused,
        filesIndexed: stats.filesIndexed,
        filesDeleted: stats.filesDeleted,
        filesRead: stats.filesRead,
        chunksReused: stats.chunksReused,
        chunksCreated: stats.chunksCreated,
        vectorsReused: stats.vectorsReused,
        vectorsCreated: stats.vectorsCreated,
        embeddingRequests: stats.embeddingRequests,
        embeddingRetries: stats.embeddingRetries,
        vectorsFromCheckpoint: stats.vectorsFromCheckpoint,
        embeddingRequestsAvoided: stats.embeddingRequestsAvoided,
        checkpointSaves: stats.checkpointSaves,
      },
    });
    return {
      context: {
        mode: contextMode,
        state: degradations.length ? "degraded" : "used",
        selected: [],
        ...(messages.length ? { message: messages.join(" ") } : {}),
        ...(degradations.length ? { degradations } : {}),
      },
      prepared,
      embedding,
      indexLocation: indexPath(source.repositoryRoot, ctx.config.cacheDirName),
      chunkCount: index.chunks.length,
      errors,
    };
  } catch (error) {
    const message = `Repository context unavailable: ${errorMessage(error)}; using diff-only review.`;
    emitEvent(ctx.events, ctx.runId, "index", "error", {
      durationMs: ctx.now() - started,
      message: errorMessage(error),
    });
    return {
      context: {
        mode: contextMode,
        state: "unavailable",
        selected: [],
        message,
      },
      errors: [...errors, contextFailure(error, message)],
    };
  }
}
