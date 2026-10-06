import { redactSensitiveText } from "../../privacy/policy.js";
import {
  POLICY_VERSION,
  PROMPT_VERSION,
  RESULT_SCHEMA_VERSION,
  type Coverage,
  type ReviewError,
  type ReviewResult,
  type ReviewSource,
  type Usage,
} from "../types.js";
import type { ReviewRunRequest } from "./types.js";

export const emptyCoverage = (): Coverage => ({
  discovered: 0,
  eligible: 0,
  attempted: 0,
  reviewed: 0,
  failed: 0,
  skipped: 0,
  omitted: 0,
  truncated: 0,
});
export const emptyUsage = (): Usage => ({
  requests: 0,
  attempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  actualRequests: 0,
  embeddingRequests: 0,
  estimatedInputTokens: 0,
  estimated: false,
  cacheHits: 0,
  latencyMs: 0,
});

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A "failed before anything was reviewed" result; stages refine it. */
export function createBaseResult(
  runId: string,
  request: Pick<ReviewRunRequest, "contextMode">,
  model: { provider: string; name: string },
): ReviewResult {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    runId,
    status: "failed",
    summary: "Review failed before any file was reviewed.",
    coverage: emptyCoverage(),
    findings: [],
    abstentions: [],
    skippedFiles: [],
    errors: [],
    usage: emptyUsage(),
    context: {
      mode: request.contextMode,
      state: request.contextMode === "diff" ? "disabled" : "unavailable",
      selected: [],
    },
    model: { ...model, promptVersion: PROMPT_VERSION },
    policyVersion: POLICY_VERSION,
  };
}

/** A fatal early exit: nothing was reviewed and `error` explains why. */
export function failedResult(
  base: ReviewResult,
  error: ReviewError,
  summary: string,
): ReviewResult {
  return { ...base, errors: [...base.errors, error], summary };
}

export function configFailureResult(
  runId: string,
  request: Pick<ReviewRunRequest, "contextMode">,
  error: unknown,
  model: { provider: string; name: string },
): ReviewResult {
  return failedResult(
    createBaseResult(runId, request, model),
    { stage: "config", message: errorMessage(error), fatal: true },
    `Configuration failed: ${errorMessage(error)}`,
  );
}

export function sourceSummary(
  source: ReviewSource,
): NonNullable<ReviewResult["source"]> {
  const {
    files: _files,
    trustedIgnoreContents: _policy,
    // Internal: a hash of the local checkout path has no place in a report.
    contextIdentity: _context,
    ...summary
  } = source;
  return {
    ...summary,
    title: redactSensitiveText(summary.title),
    description: redactSensitiveText(summary.description),
  };
}
