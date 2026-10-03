import { randomUUID } from "node:crypto";
import type { CliArgs } from "../cli/args.js";
import { requestFromCliArgs } from "../cli/request.js";
import { loadConfig, type ReviewConfig } from "../config/config.js";
import { executeReviewPipeline } from "./pipeline/run-review-pipeline.js";
import { configFailureResult } from "./pipeline/result.js";
import type { ReviewRuntime } from "./pipeline/types.js";
import type { ReviewResult } from "./types.js";

export type {
  FileReviewOutcome,
  ReviewRunRequest,
  ReviewRuntime,
  ReviewTarget,
} from "./pipeline/types.js";
export { executeReviewPipeline } from "./pipeline/run-review-pipeline.js";

/** Runtime ports plus an optional pre-built config. */
export type PipelineDependencies = ReviewRuntime & { config?: ReviewConfig };

/**
 * Compatibility entry point taking CLI-shaped arguments. It translates them to
 * a ReviewRunRequest and delegates to the core; it does not compose providers.
 * A caller that wants real OpenAI adapters goes through runReview() in
 * src/cli/run-review.ts, which composes them from the loaded configuration.
 */
export async function runReviewPipeline(
  args: CliArgs,
  deps: PipelineDependencies = {},
): Promise<ReviewResult> {
  const request = requestFromCliArgs(args);
  let config: ReviewConfig;
  try {
    config = deps.config ?? loadConfig(args);
  } catch (error) {
    return configFailureResult(randomUUID(), request, error, {
      provider: deps.model?.provider ?? "none",
      name: process.env.AI_REVIEW_MODEL ?? "gpt-4o-mini",
    });
  }
  return executeReviewPipeline(request, config, deps);
}
