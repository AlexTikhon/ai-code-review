import type { ReviewRunRequest } from "../review/pipeline/types.js";
import type { CliArgs } from "./args.js";

/**
 * The CLI-to-application boundary: parsed arguments in, a request the review
 * engine understands out. Output format, help and severity threshold are CLI
 * concerns and deliberately do not cross it.
 */
export function requestFromCliArgs(args: CliArgs): ReviewRunRequest {
  return {
    target:
      args.reviewMode === "pr"
        ? {
            kind: "pull-request",
            owner: args.owner,
            repo: args.repo,
            pullNumber: args.pullNumber,
            localRepoPath: args.localRepoPath,
          }
        : {
            kind: "local",
            baseRef: args.localBaseRef,
            localRepoPath: args.localRepoPath,
          },
    contextMode: args.contextMode,
    dryRun: args.dryRun,
    indexOnly: args.indexOnly,
  };
}
