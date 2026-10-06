import {
  readReviewCache,
  reviewCacheKey,
  writeReviewCache,
} from "../../cache/review-cache.js";
import { ReviewModelError } from "../../model/errors.js";
import { executeModel } from "../../model/execution.js";
import type { ModelResult } from "../../model/types.js";
import { emitEvent } from "../../observability/events.js";
import { assembleReviewPrompt } from "../../prompts/review.js";
import type { EmbeddingAdapter } from "../../retrieval/embeddings.js";
import type { PreparedRepositoryIndex } from "../../retrieval/prepared-index.js";
import { retrieveContext } from "../../retrieval/retrieve.js";
import type { RetrievalCandidate } from "../../retrieval/types.js";
import { contextRepositoryId } from "../context-identity.js";
import { deduplicateFindings, validateFindings } from "../findings.js";
import type {
  ContextUse,
  PatchSegment,
  ReviewError,
  ReviewSource,
  ReviewableFile,
  ReviewerFinding,
} from "../types.js";
import { embeddingExecutionFor } from "./embedding-execution.js";
import { addUsage, emptyUsageDelta } from "./aggregate.js";
import {
  invalidEvidenceFailure,
  modelFailure,
  unexpectedFailure,
  type SegmentFailure,
  type SegmentStatus,
} from "./analysis-errors.js";
import type {
  Abstention,
  FileReviewOutcome,
  PipelineContext,
  UsageDelta,
} from "./types.js";

export type FileJob = {
  order: number;
  source: ReviewSource;
  file: ReviewableFile;
  prepared?: PreparedRepositoryIndex;
  embedding?: EmbeddingAdapter;
};

type SegmentOutcome = {
  /** Context is reported even when the segment later fails. */
  selectedContext: ContextUse[];
  usage: UsageDelta;
} & (
  | {
      status: "success";
      findings: ReviewerFinding[];
      abstention?: Abstention;
    }
  | SegmentFailure
);

function contextUses(candidates: RetrievalCandidate[]): ContextUse[] {
  return candidates.map(({ chunk, score, reasons }) => ({
    id: chunk.id,
    path: chunk.path,
    score,
    reasons,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  }));
}

/** Review one diff segment. Never throws; failures are returned as data. */
async function reviewSegment(
  ctx: PipelineContext,
  job: FileJob,
  segment: PatchSegment,
): Promise<SegmentOutcome> {
  const { config } = ctx;
  const { source, file } = job;
  let usage = emptyUsageDelta();
  let selectedContext: ContextUse[] = [];
  try {
    ctx.signal.throwIfAborted();
    let candidates: RetrievalCandidate[] = [];
    if (job.prepared && ctx.request.contextMode !== "diff") {
      const retrievalStarted = ctx.now();
      candidates = await retrieveContext({
        index: job.prepared,
        repositoryId: contextRepositoryId(source),
        revision: source.snapshotId,
        query: `${file.filename}\n${segment.text}`,
        changedPath: file.filename,
        mode: ctx.request.contextMode,
        candidates: config.retrievalCandidates,
        topK: config.retrievalTopK,
        threshold: config.relevanceThreshold,
        embedding:
          ctx.request.contextMode === "hybrid" ? job.embedding : undefined,
        signal: ctx.signal,
        beforeEmbeddingRequest: () => ctx.budget.reserve("embedding"),
        embeddingExecution: embeddingExecutionFor(ctx),
      });
      emitEvent(ctx.events, ctx.runId, "retrieve", "complete", {
        filename: file.filename,
        durationMs: ctx.now() - retrievalStarted,
        data: { segment: segment.id, candidates: candidates.length },
      });
    }
    const assembled = assembleReviewPrompt({
      title: source.title,
      description: source.description,
      filename: file.filename,
      fileType: file.fileType,
      segment,
      contexts: candidates.map((item) => item.chunk),
      maxInputTokens: config.maxInputTokens,
      outputReservation: config.maxOutputTokens,
      maxMetadataCharacters: config.maxMetadataCharacters,
      maxContextTokens: config.maxContextTokens,
    });
    const selectedCandidates = candidates.filter((item) =>
      assembled.context.some((chunk) => chunk.id === item.chunk.id),
    );
    selectedContext = contextUses(selectedCandidates);
    for (const candidate of selectedCandidates)
      emitEvent(ctx.events, ctx.runId, "retrieve", "context", {
        filename: file.filename,
        message: candidate.reasons.join(","),
        data: { contextId: candidate.chunk.id, score: candidate.score },
      });
    const request = {
      system: assembled.system,
      user: assembled.user,
      model: config.model,
      maxOutputTokens: config.maxOutputTokens,
    };
    usage = addUsage(usage, {
      ...emptyUsageDelta(),
      requests: 1,
      estimatedInputTokens: assembled.estimatedInputTokens,
    });
    const model = ctx.model;
    if (!model) throw new Error("No review model is available for analysis");
    const key = reviewCacheKey(request, model);
    const root = source.repositoryRoot;

    // A cache entry is reused only if it still validates against the evidence
    // actually supplied for this segment.
    let modelResult: ModelResult | undefined = root
      ? await readReviewCache(root, config.cacheDirName, key)
      : undefined;
    let validated: ReviewerFinding[] | undefined;
    if (modelResult) {
      validated = validateFindings(
        modelResult.response,
        file.filename,
        segment,
        assembled.context,
      );
      if (validated.length !== modelResult.response.findings.length) {
        modelResult = undefined;
        validated = undefined;
      }
    }
    if (modelResult) {
      usage = addUsage(usage, { ...emptyUsageDelta(), cacheHits: 1 });
    } else {
      const executed = await executeModel({
        model,
        request,
        runId: ctx.runId,
        filename: file.filename,
        maxAttempts: config.maxAttempts,
        requestTimeoutMs: config.requestTimeoutMs,
        totalSignal: ctx.signal,
        events: ctx.events,
        beforeAttempt: () => ctx.budget.reserve("model"),
      });
      usage = addUsage(usage, {
        ...emptyUsageDelta(),
        attempts: executed.attempts,
      });
      if (!executed.ok) {
        const failure =
          executed.error instanceof ReviewModelError
            ? modelFailure(file.filename, executed.error)
            : unexpectedFailure(file.filename, executed.error, false);
        return { ...failure, selectedContext, usage };
      }
      modelResult = executed.result;
      // Tokens were spent whether or not the evidence turns out to be usable.
      usage = addUsage(usage, {
        ...emptyUsageDelta(),
        inputTokens: modelResult.usage.actual
          ? modelResult.usage.inputTokens
          : 0,
        outputTokens: modelResult.usage.actual
          ? modelResult.usage.outputTokens
          : 0,
        estimated: !modelResult.usage.actual,
      });
      validated = validateFindings(
        modelResult.response,
        file.filename,
        segment,
        assembled.context,
      );
      // A malformed or invented citation must never become a clean result,
      // and is reported as bad evidence, not as a provider failure.
      if (validated.length !== modelResult.response.findings.length)
        return {
          ...invalidEvidenceFailure(
            file.filename,
            modelResult.response.findings.length - validated.length,
            model.provider,
          ),
          selectedContext,
          usage,
        };
      if (root) {
        try {
          await writeReviewCache(root, config.cacheDirName, key, modelResult);
        } catch {
          emitEvent(ctx.events, ctx.runId, "cache", "warning", {
            filename: file.filename,
            message:
              "Review cache write failed; validated findings were retained",
          });
        }
      }
    }
    return {
      status: "success",
      findings: deduplicateFindings(validated!),
      abstention: modelResult.response.abstained
        ? {
            filename: file.filename,
            segmentId: segment.id,
            reason:
              modelResult.response.abstentionReason ?? "insufficient evidence",
          }
        : undefined,
      selectedContext,
      usage,
    };
  } catch (error) {
    // Anything not already classified above: budget, prompt assembly,
    // retrieval, cache I/O, or cancellation.
    return {
      ...unexpectedFailure(file.filename, error, ctx.signal.aborted),
      selectedContext,
      usage,
    };
  }
}

/**
 * Review every segment of one file, stopping at its first failure. Returns an
 * explicit outcome and touches no shared state, so jobs are safe to run
 * concurrently and to aggregate in any completion order.
 */
export async function reviewFile(
  ctx: PipelineContext,
  job: FileJob,
): Promise<FileReviewOutcome> {
  const started = ctx.now();
  const { file } = job;
  const findings: ReviewerFinding[] = [];
  const abstentions: Abstention[] = [];
  const errors: ReviewError[] = [];
  const selectedContext: ContextUse[] = [];
  let usage = emptyUsageDelta();
  let completedSegments = 0;
  let failed = false;
  let failureStatus: SegmentStatus = "success";
  for (const segment of file.segments) {
    const outcome = await reviewSegment(ctx, job, segment);
    usage = addUsage(usage, outcome.usage);
    selectedContext.push(...outcome.selectedContext);
    if (outcome.status !== "success") {
      errors.push(outcome.error);
      failureStatus = outcome.status;
      failed = true;
      break;
    }
    findings.push(...outcome.findings);
    if (outcome.abstention) abstentions.push(outcome.abstention);
    completedSegments++;
  }
  failed = failed || completedSegments !== file.segments.length;
  emitEvent(ctx.events, ctx.runId, "analyze", "complete", {
    filename: file.filename,
    durationMs: ctx.now() - started,
    data: {
      segments: file.segments.length,
      completedSegments,
      cacheHits: usage.cacheHits,
      attempts: usage.attempts,
      contexts: selectedContext.length,
      failed,
      outcome: failureStatus,
      ...(errors[0]?.code ? { code: errors[0].code } : {}),
    },
  });
  return {
    order: job.order,
    filename: file.filename,
    started: true,
    failed,
    completedSegments,
    totalSegments: file.segments.length,
    findings,
    abstentions,
    errors,
    selectedContext,
    usage,
  };
}
