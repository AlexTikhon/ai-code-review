import type { CliArgs } from "../cli/args.js";
import {
  runReviewPipeline,
  type PipelineDependencies,
} from "../review/pipeline.js";
/**
 * Compatibility facade. LangGraph added no branching/checkpoint value to this bounded CLI,
 * so orchestration is an explicit four-stage pipeline with injected dependencies.
 */
export function createReviewerGraph(dependencies: PipelineDependencies = {}) {
  return { invoke: (args: CliArgs) => runReviewPipeline(args, dependencies) };
}
