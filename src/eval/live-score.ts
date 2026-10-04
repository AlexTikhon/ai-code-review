/**
 * Deterministic scoring for the opt-in live evaluation. Everything here is a
 * pure function of (expected findings, observed findings); once model output
 * exists, scoring involves no model, no network and no randomness.
 *
 * Matching semantics
 * - An observed finding matches an expected one when any of its evidence
 *   ranges is on the expected file and overlaps the expected line range
 *   (inclusive), AND, if the expected entry lists categories, the finding's
 *   category is one of them. Wording is never compared.
 * - Matching is one-to-one and greedy in input order: each expected finding
 *   takes the first still-unmatched observed finding that fits. Observed
 *   findings arrive in the pipeline's deterministic order (path, line, id).
 * - Unmatched observed findings are false positives; unmatched expected
 *   findings are misses. Every observed finding on a case labeled clean is a
 *   false positive.
 */

export type ExpectedFinding = {
  path: string;
  startLine: number;
  endLine: number;
  /** Acceptable categories. Empty or absent means the category is not scored. */
  categories?: string[];
};

export type ObservedFinding = {
  category: string;
  severity: string;
  evidence: Array<{ path: string; startLine: number; endLine: number }>;
};

export function findingMatches(
  expected: ExpectedFinding,
  observed: ObservedFinding,
): boolean {
  if (
    expected.categories?.length &&
    !expected.categories.includes(observed.category)
  )
    return false;
  return observed.evidence.some(
    (item) =>
      item.path === expected.path &&
      item.startLine <= expected.endLine &&
      expected.startLine <= item.endLine,
  );
}

export function matchFindings(
  expected: ExpectedFinding[],
  observed: ObservedFinding[],
): { matched: number; falsePositives: number; missed: ExpectedFinding[] } {
  const taken = new Set<number>();
  const missed: ExpectedFinding[] = [];
  for (const want of expected) {
    const index = observed.findIndex(
      (got, i) => !taken.has(i) && findingMatches(want, got),
    );
    if (index === -1) missed.push(want);
    else taken.add(index);
  }
  return {
    matched: taken.size,
    falsePositives: observed.length - taken.size,
    missed,
  };
}

export type LiveCaseInput = {
  id: string;
  mode: string;
  clean: boolean;
  expected: ExpectedFinding[];
  /** Findings that survived the pipeline's evidence validation. */
  observed: ObservedFinding[];
  /** Findings in the raw model response(s), before validation. */
  rawFindingCount: number;
  /** The pipeline rejected a response for citing evidence it was not given. */
  invalidEvidence: boolean;
  /** Provider/budget/configuration failure: says nothing about model quality. */
  providerFailed: boolean;
  abstained: boolean;
  inputTokens: number;
  outputTokens: number;
  tokensEstimated: boolean;
  requests: number;
  latencyMs: number;
};

export type LiveCaseResult = {
  id: string;
  mode: string;
  clean: boolean;
  outcome: "scored" | "invalid-evidence" | "provider-failed";
  expectedCount: number;
  truePositives: number;
  falsePositives: number;
  missed: ExpectedFinding[];
  /** Sanitized: categories, severities and locations only, never text. */
  observed: Array<{
    category: string;
    severity: string;
    locations: string[];
  }>;
  abstained: boolean;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  latencyMs: number;
};

export function scoreCase(input: LiveCaseInput): LiveCaseResult {
  const base = {
    id: input.id,
    mode: input.mode,
    clean: input.clean,
    expectedCount: input.expected.length,
    abstained: input.abstained,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    requests: input.requests,
    latencyMs: input.latencyMs,
  };
  if (input.providerFailed)
    return {
      ...base,
      outcome: "provider-failed",
      truePositives: 0,
      falsePositives: 0,
      missed: [],
      observed: [],
    };
  // Rejected findings are not delivered, so they are misses, not false
  // positives: the user would see nothing for this case.
  const delivered = input.invalidEvidence ? [] : input.observed;
  const { matched, falsePositives, missed } = matchFindings(
    input.expected,
    delivered,
  );
  return {
    ...base,
    outcome: input.invalidEvidence ? "invalid-evidence" : "scored",
    truePositives: matched,
    falsePositives,
    missed,
    observed: delivered.map((finding) => ({
      category: finding.category,
      severity: finding.severity,
      locations: finding.evidence.map(
        (item) => `${item.path}:${item.startLine}-${item.endLine}`,
      ),
    })),
  };
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

export type LiveMetrics = {
  cases: number;
  scoredCases: number;
  providerFailedCases: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** null when undefined (no findings delivered / nothing expected). */
  precision: number | null;
  recall: number | null;
  f1: number | null;
  cleanCaseFalsePositives: number;
  /** Raw findings that were rejected for invalid evidence / all raw findings. */
  invalidEvidenceRate: number | null;
  /** Cases where the model abstained / cases that got an answer. */
  abstentionRate: number | null;
  inputTokens: number;
  outputTokens: number;
  tokensEstimated: boolean;
  requests: number;
  latencyMs: { total: number; mean: number | null };
};

export function aggregate(
  inputs: LiveCaseInput[],
  results: LiveCaseResult[],
): LiveMetrics {
  const answered = results.filter((r) => r.outcome !== "provider-failed");
  const tp = results.reduce((sum, r) => sum + r.truePositives, 0);
  const fp = results.reduce((sum, r) => sum + r.falsePositives, 0);
  const fn = results.reduce((sum, r) => sum + r.missed.length, 0);
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const rawTotal = inputs
    .filter((i) => !i.providerFailed)
    .reduce((sum, i) => sum + i.rawFindingCount, 0);
  const rawInvalid = inputs
    .filter((i) => !i.providerFailed && i.invalidEvidence)
    .reduce((sum, i) => sum + i.rawFindingCount, 0);
  const latency = results.reduce((sum, r) => sum + r.latencyMs, 0);
  return {
    cases: results.length,
    scoredCases: answered.length,
    providerFailedCases: results.length - answered.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision,
    recall,
    f1:
      precision === null || recall === null || precision + recall === 0
        ? null
        : (2 * precision * recall) / (precision + recall),
    cleanCaseFalsePositives: results
      .filter((r) => r.clean)
      .reduce((sum, r) => sum + r.falsePositives, 0),
    invalidEvidenceRate: ratio(rawInvalid, rawTotal),
    abstentionRate: ratio(
      answered.filter((r) => r.abstained).length,
      answered.length,
    ),
    inputTokens: inputs.reduce((sum, i) => sum + i.inputTokens, 0),
    outputTokens: inputs.reduce((sum, i) => sum + i.outputTokens, 0),
    tokensEstimated: inputs.some((i) => i.tokensEstimated),
    requests: inputs.reduce((sum, i) => sum + i.requests, 0),
    latencyMs: {
      total: latency,
      mean: ratio(latency, results.length),
    },
  };
}

/**
 * Optional cost from prices the operator supplied for this run. No pricing is
 * built in, so a stale table can never produce a confident wrong number.
 */
export function estimateCost(
  metrics: Pick<
    LiveMetrics,
    "inputTokens" | "outputTokens" | "tokensEstimated"
  >,
  prices: { inputPerMTok?: number; outputPerMTok?: number },
): { amount: number; basis: string } | undefined {
  if (
    prices.inputPerMTok === undefined ||
    prices.outputPerMTok === undefined ||
    metrics.tokensEstimated
  )
    return undefined;
  return {
    amount:
      (metrics.inputTokens * prices.inputPerMTok +
        metrics.outputTokens * prices.outputPerMTok) /
      1_000_000,
    basis: "operator-supplied prices; provider-reported tokens",
  };
}
