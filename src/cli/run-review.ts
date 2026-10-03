import { loadConfig, type ReviewConfig } from "../config/config.js";
import type { PipelineDependencies } from "../review/pipeline.js";
import { runReviewPipeline } from "../review/pipeline.js";
import type { ReviewResult } from "../review/types.js";
import type { CliArgs } from "./args.js";
import { createProviders } from "./providers.js";
import { requestFromCliArgs } from "./request.js";

/**
 * Application bootstrap: load configuration, compose production providers from
 * it, then hand ports to the review engine. Explicit `overrides` (tests,
 * evaluation) win over composed providers.
 */
export function runReview(
  args: CliArgs,
  overrides: PipelineDependencies = {},
): Promise<ReviewResult> {
  let config: ReviewConfig;
  try {
    config = overrides.config ?? loadConfig(args);
  } catch {
    // Let the pipeline report the configuration failure as a normal result.
    return runReviewPipeline(args, overrides);
  }
  const providers = createProviders(config, requestFromCliArgs(args));
  return runReviewPipeline(args, {
    ...overrides,
    config,
    model: overrides.model ?? providers.model,
    embedding: overrides.embedding ?? providers.embedding,
  });
}
