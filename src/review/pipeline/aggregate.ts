import { deduplicateFindings } from "../findings.js";
import type {
  Coverage,
  ContextUse,
  ReviewError,
  ReviewerFinding,
} from "../types.js";
import type { Abstention, FileReviewOutcome, UsageDelta } from "./types.js";

export const emptyUsageDelta = (): UsageDelta => ({
  requests: 0,
  attempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedInputTokens: 0,
  estimated: false,
  cacheHits: 0,
});

export function addUsage(a: UsageDelta, b: UsageDelta): UsageDelta {
  return {
    requests: a.requests + b.requests,
    attempts: a.attempts + b.attempts,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    estimatedInputTokens: a.estimatedInputTokens + b.estimatedInputTokens,
    estimated: a.estimated || b.estimated,
    cacheHits: a.cacheHits + b.cacheHits,
  };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Stable report order: path, then first evidence line, then stable id. */
export function compareFindings(
  a: ReviewerFinding,
  b: ReviewerFinding,
): number {
  return (
    compare(a.filename, b.filename) ||
    (a.evidence[0]?.startLine ?? 0) - (b.evidence[0]?.startLine ?? 0) ||
    (a.evidence[0]?.endLine ?? 0) - (b.evidence[0]?.endLine ?? 0) ||
    compare(a.id, b.id)
  );
}

export type AnalysisSummary = {
  findings: ReviewerFinding[];
  abstentions: Abstention[];
  errors: ReviewError[];
  /** File, then segment, then retrieval-rank order (rank is meaningful). */
  selectedContext: ContextUse[];
  usage: UsageDelta;
  coverage: Pick<Coverage, "attempted" | "reviewed" | "failed">;
};

/**
 * Fold per-file outcomes into one summary. Pure and order-independent: input
 * is first put in eligible-file order, so the result does not depend on which
 * concurrent job happened to finish first.
 */
export function aggregateOutcomes(
  outcomes: readonly FileReviewOutcome[],
): AnalysisSummary {
  const ordered = [...outcomes].sort((a, b) => a.order - b.order);
  let usage = emptyUsageDelta();
  let attempted = 0;
  let reviewed = 0;
  let failed = 0;
  for (const outcome of ordered) {
    usage = addUsage(usage, outcome.usage);
    if (outcome.started) attempted++;
    if (outcome.failed) failed++;
    else reviewed++;
  }
  return {
    findings: deduplicateFindings(
      ordered.flatMap((outcome) => outcome.findings),
    ).sort(compareFindings),
    abstentions: ordered.flatMap((outcome) => outcome.abstentions),
    errors: ordered.flatMap((outcome) => outcome.errors),
    selectedContext: ordered.flatMap((outcome) => outcome.selectedContext),
    usage,
    coverage: { attempted, reviewed, failed },
  };
}
