import { emitEvent } from "../../observability/events.js";
import type { EmbeddingAdapter } from "../../retrieval/embeddings.js";
import {
  buildRepositoryIndex,
  indexPath,
} from "../../retrieval/index-store.js";
import {
  prepareRepositoryIndex,
  type PreparedRepositoryIndex,
} from "../../retrieval/prepared-index.js";
import type { LoadedIgnore } from "../ignore.js";
import type { ReviewError, ReviewResult, ReviewSource } from "../types.js";
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

/** Stage 3: build/refresh the repository index and compile it for retrieval. */
export async function contextStage(
  ctx: PipelineContext,
  source: ReviewSource,
  policy: LoadedIgnore,
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
  const embedding = hybrid ? ctx.embedding : undefined;
  const diagnostics: string[] = [];
  try {
    const index = await buildRepositoryIndex({
      root: source.repositoryRoot,
      repositoryId: source.repositoryId,
      revision: source.snapshotId,
      gitRevision: source.mode === "pr" ? source.headRevision : undefined,
      cacheDirName: ctx.config.cacheDirName,
      maxChunkTokens: Math.min(ctx.config.maxContextTokens, 800),
      ignorePolicy: policy,
      embedding: hybrid && !ctx.request.dryRun ? embedding : undefined,
      signal: ctx.signal,
      beforeEmbeddingRequest: () => ctx.budget.reserve("embedding"),
      onDiagnostic: (message) => diagnostics.push(message),
    });
    const prepared = prepareRepositoryIndex(index);
    const messages = [
      ...(hybrid && !embedding
        ? [
            "Semantic embeddings were not permitted; lexical/symbol retrieval was used.",
          ]
        : []),
      ...diagnostics,
    ];
    emitEvent(ctx.events, ctx.runId, "index", "complete", {
      durationMs: ctx.now() - started,
      data: {
        revision: source.snapshotId,
        chunks: index.chunks.length,
        vectors: Object.keys(index.vectors).length,
        semantic: Boolean(embedding),
      },
    });
    return {
      context: {
        mode: contextMode,
        state: "used",
        selected: [],
        ...(messages.length ? { message: messages.join(" ") } : {}),
      },
      prepared,
      embedding,
      indexLocation: indexPath(source.repositoryRoot, ctx.config.cacheDirName),
      chunkCount: index.chunks.length,
      errors: [],
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
      errors: [{ stage: "index", message, fatal: false }],
    };
  }
}
