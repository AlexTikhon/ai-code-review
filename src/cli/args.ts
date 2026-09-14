import type { FindingSeverity } from "../review/types.js";
export type OutputFormat = "text" | "json" | "sarif";
export type ContextMode = "diff" | "lexical" | "hybrid";
type CommonArgs = {
  format: OutputFormat;
  dryRun: boolean;
  indexOnly: boolean;
  allowExternal: boolean;
  contextMode: ContextMode;
  severityThreshold: FindingSeverity | "none";
  help: boolean;
};
export type CliArgs = CommonArgs &
  (
    | {
        reviewMode: "pr";
        owner: string;
        repo: string;
        pullNumber: number;
        localRepoPath?: string;
      }
    | { reviewMode: "local"; localBaseRef?: string; localRepoPath?: string }
  );
const valueOptions = new Set([
  "--base",
  "--repo",
  "--format",
  "--context",
  "--severity-threshold",
]);
const booleanOptions = new Set([
  "--local",
  "--dry-run",
  "--index",
  "--allow-external",
  "--help",
  "-h",
]);

export function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (valueOptions.has(arg)) {
      if (values.has(arg)) throw new Error(`Duplicate option: ${arg}`);
      const value = argv[++index];
      if (!value || value.startsWith("-"))
        throw new Error(`${arg} requires a value`);
      values.set(arg, value);
    } else if (booleanOptions.has(arg)) {
      if (flags.has(arg)) throw new Error(`Duplicate option: ${arg}`);
      flags.add(arg);
    } else if (arg.startsWith("-") && !/^-\d/.test(arg))
      throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  const format = values.get("--format") ?? "text";
  if (!["text", "json", "sarif"].includes(format))
    throw new Error("--format must be text, json, or sarif");
  const contextMode = values.get("--context") ?? "lexical";
  if (!["diff", "lexical", "hybrid"].includes(contextMode))
    throw new Error("--context must be diff, lexical, or hybrid");
  const severityThreshold = values.get("--severity-threshold") ?? "high";
  if (!["high", "medium", "low", "none"].includes(severityThreshold))
    throw new Error("--severity-threshold must be high, medium, low, or none");
  const common: CommonArgs = {
    format: format as OutputFormat,
    dryRun: flags.has("--dry-run"),
    indexOnly: flags.has("--index"),
    allowExternal: flags.has("--allow-external"),
    contextMode: contextMode as ContextMode,
    severityThreshold: severityThreshold as FindingSeverity | "none",
    help: flags.has("--help") || flags.has("-h"),
  };
  if (flags.has("--local")) {
    if (positional.length)
      throw new Error("PR positional arguments conflict with --local");
    return {
      ...common,
      reviewMode: "local",
      localBaseRef: values.get("--base"),
      localRepoPath: values.get("--repo"),
    };
  }
  if (values.has("--base")) throw new Error("--base requires --local");
  if (common.help && positional.length === 0)
    return { ...common, reviewMode: "local" };
  if (positional.length !== 3)
    throw new Error("Expected <owner> <repo> <pullNumber>");
  const [owner, repo, raw] = positional;
  const pullNumber = Number(raw);
  if (
    !Number.isFinite(pullNumber) ||
    !Number.isInteger(pullNumber) ||
    pullNumber <= 0
  )
    throw new Error("pullNumber must be a positive finite integer");
  return {
    ...common,
    reviewMode: "pr",
    owner: owner!,
    repo: repo!,
    pullNumber,
    localRepoPath: values.get("--repo"),
  };
}
export const EXIT_SUCCESS = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_OPERATIONAL_FAILURE = 2;
export const EXIT_USAGE = 64;
