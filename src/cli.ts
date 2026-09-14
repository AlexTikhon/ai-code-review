#!/usr/bin/env node
import "dotenv/config";
import { parseArgs, EXIT_SUCCESS, EXIT_USAGE } from "./cli/args.js";
import {
  printReviewResult,
  printUsage,
  resultExitCode,
  stderrEvent,
} from "./cli/output.js";
import { runReview } from "./cli/run-review.js";
async function main(): Promise<void> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[error] ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    process.exitCode = EXIT_USAGE;
    return;
  }
  if (args.help) {
    printUsage();
    process.exitCode = EXIT_SUCCESS;
    return;
  }
  const result = await runReview(args, { events: stderrEvent });
  printReviewResult(result, args.format);
  process.exitCode =
    args.dryRun || args.indexOnly
      ? result.status === "failed"
        ? 2
        : 0
      : resultExitCode(result, args.severityThreshold);
}
main().catch((error) => {
  console.error(
    `[fatal] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 2;
});
