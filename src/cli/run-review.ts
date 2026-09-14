import type { CliArgs } from "./args.js";
import type { PipelineDependencies } from "../review/pipeline.js";
import { runReviewPipeline } from "../review/pipeline.js";
export function runReview(
  args: CliArgs,
  dependencies: PipelineDependencies = {},
) {
  return runReviewPipeline(args, dependencies);
}
