import { emitEvent } from "../../observability/events.js";
import type { ReviewSource, ReviewableFile } from "../types.js";
import { emptyUsageDelta } from "./aggregate.js";
import { runBounded } from "./concurrency.js";
import type { ContextOutcome } from "./context-stage.js";
import { errorMessage } from "./result.js";
import { reviewFile } from "./review-file.js";
import type { FileReviewOutcome, PipelineContext } from "./types.js";

function unfinishedOutcome(
  order: number,
  file: ReviewableFile,
  started: boolean,
  message: string,
): FileReviewOutcome {
  return {
    order,
    filename: file.filename,
    started,
    failed: true,
    completedSegments: 0,
    totalSegments: file.segments.length,
    findings: [],
    abstentions: [],
    errors: [
      {
        stage: "analyze",
        filename: file.filename,
        message,
        fatal: false,
      },
    ],
    selectedContext: [],
    usage: emptyUsageDelta(),
  };
}

/**
 * Stage 4: review eligible files with at most `config.concurrency` in flight.
 *
 * Returns one outcome per file, in eligible-file order. A file that fails does
 * not affect its siblings. Once the total deadline aborts, no further file is
 * started; each unstarted file is reported as failed so an interrupted review
 * can never read as complete or clean.
 */
export async function analyzeStage(
  ctx: PipelineContext,
  input: {
    source: ReviewSource;
    files: readonly ReviewableFile[];
    context: ContextOutcome;
  },
): Promise<FileReviewOutcome[]> {
  const started = ctx.now();
  emitEvent(ctx.events, ctx.runId, "analyze", "start", {
    data: { files: input.files.length, concurrency: ctx.config.concurrency },
  });
  const results = await runBounded(
    input.files,
    ctx.config.concurrency,
    ctx.signal,
    (file, order) =>
      reviewFile(ctx, {
        order,
        source: input.source,
        file,
        prepared: input.context.prepared,
        embedding: input.context.embedding,
      }),
  );
  const outcomes = results.map((result, order): FileReviewOutcome => {
    const file = input.files[order]!;
    if (result.status === "fulfilled") return result.value;
    if (result.status === "rejected")
      return unfinishedOutcome(order, file, true, errorMessage(result.reason));
    return unfinishedOutcome(
      order,
      file,
      false,
      "Review cancelled before this file started (total review deadline exceeded)",
    );
  });
  emitEvent(ctx.events, ctx.runId, "analyze", "complete", {
    durationMs: ctx.now() - started,
    data: {
      files: input.files.length,
      failed: outcomes.filter((outcome) => outcome.failed).length,
    },
  });
  return outcomes;
}
