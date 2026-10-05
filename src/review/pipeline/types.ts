import type { ReviewConfig } from "../../config/config.js";
import type { ExternalRequestBudget } from "../../model/budget.js";
import type { ReviewModel } from "../../model/types.js";
import type { EventSink } from "../../observability/events.js";
import type { EmbeddingExecutionOptions } from "../../retrieval/embedding-execution.js";
import type { EmbeddingAdapter } from "../../retrieval/embeddings.js";
import type {
  ContextMode,
  ContextUse,
  ReviewError,
  ReviewResult,
  ReviewSource,
  ReviewerFinding,
  Usage,
} from "../types.js";

/** What to review. Independent of how the request was typed on a command line. */
export type ReviewTarget =
  | {
      kind: "pull-request";
      owner: string;
      repo: string;
      pullNumber: number;
      /** Checkout whose object database contains the PR head, for retrieval. */
      localRepoPath?: string;
    }
  | { kind: "local"; baseRef?: string; localRepoPath?: string };

export type ReviewRunRequest = {
  target: ReviewTarget;
  contextMode: ContextMode;
  /** Build the manifest only; no provider call of any kind. */
  dryRun: boolean;
  /** Build repository context and stop before analysis. */
  indexOnly: boolean;
};

/**
 * Ports and runtime collaborators supplied by the caller. The pipeline never
 * constructs a provider: composing a concrete provider is the bootstrap
 * layer's job (src/cli/providers.ts).
 */
export type ReviewRuntime = {
  /** Absent means external transmission is not authorized. */
  model?: ReviewModel;
  /** Used only for hybrid retrieval. */
  embedding?: EmbeddingAdapter;
  events?: EventSink;
  /** Pre-collected source (tests, evaluation); skips Git/GitHub ingestion. */
  source?: ReviewSource;
  now?: () => number;
  /** Test seams for embedding retries: the wait and the jitter source. */
  embeddingExecution?: Pick<EmbeddingExecutionOptions, "sleep" | "random">;
};

/** Immutable facts about one run, threaded through the stages. */
export type PipelineContext = {
  readonly runId: string;
  readonly request: ReviewRunRequest;
  readonly config: ReviewConfig;
  readonly model?: ReviewModel;
  readonly embedding?: EmbeddingAdapter;
  readonly sourceOverride?: ReviewSource;
  readonly events: EventSink;
  readonly now: () => number;
  /** Aborted by the total deadline; covers every stage. */
  readonly signal: AbortSignal;
  /** When the total deadline fires, on the `now` clock; retries must fit before it. */
  readonly deadlineAt: number;
  readonly embeddingSeams?: ReviewRuntime["embeddingExecution"];
  /** The single counter of external provider calls. */
  readonly budget: ExternalRequestBudget;
};

/** Per-file additions to Usage; summed centrally. */
export type UsageDelta = Pick<
  Usage,
  | "requests"
  | "attempts"
  | "inputTokens"
  | "outputTokens"
  | "estimatedInputTokens"
  | "estimated"
  | "cacheHits"
>;

export type Abstention = ReviewResult["abstentions"][number];

/** Everything one file's analysis produced; no shared state is touched. */
export type FileReviewOutcome = {
  /** Position in the eligible-file list; the deterministic aggregation key. */
  order: number;
  filename: string;
  /** False when the file was never started (e.g. deadline passed first). */
  started: boolean;
  failed: boolean;
  completedSegments: number;
  totalSegments: number;
  findings: ReviewerFinding[];
  abstentions: Abstention[];
  errors: ReviewError[];
  selectedContext: ContextUse[];
  usage: UsageDelta;
};
