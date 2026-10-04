import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  aggregate,
  estimateCost,
  findingMatches,
  matchFindings,
  scoreCase,
  type ExpectedFinding,
  type LiveCaseInput,
  type ObservedFinding,
} from "../src/eval/live-score.js";
import { unitTest } from "./helpers.js";

const expected = (
  overrides: Partial<ExpectedFinding> = {},
): ExpectedFinding => ({
  path: "src/a.ts",
  startLine: 5,
  endLine: 7,
  categories: ["correctness"],
  ...overrides,
});
const observed = (
  startLine: number,
  endLine = startLine,
  overrides: Partial<ObservedFinding> = {},
): ObservedFinding => ({
  category: "correctness",
  severity: "high",
  evidence: [{ path: "src/a.ts", startLine, endLine }],
  ...overrides,
});
const input = (overrides: Partial<LiveCaseInput> = {}): LiveCaseInput => ({
  id: "c",
  mode: "diff",
  clean: false,
  expected: [expected()],
  observed: [],
  rawFindingCount: 0,
  invalidEvidence: false,
  providerFailed: false,
  abstained: false,
  inputTokens: 10,
  outputTokens: 2,
  tokensEstimated: false,
  requests: 1,
  latencyMs: 100,
  ...overrides,
});

unitTest(
  "finding matching uses file, line overlap and category, not wording",
  () => {
    assert.ok(
      findingMatches(expected(), observed(7, 9)),
      "touching the range counts",
    );
    assert.ok(findingMatches(expected(), observed(1, 5)));
    assert.ok(!findingMatches(expected(), observed(8, 9)));
    assert.ok(
      !findingMatches(expected(), observed(5, 5, { category: "security" })),
    );
    assert.ok(
      !findingMatches(
        expected(),
        observed(5, 5, {
          evidence: [{ path: "src/b.ts", startLine: 5, endLine: 5 }],
        }),
      ),
    );
    assert.ok(
      findingMatches(
        expected({ categories: undefined }),
        observed(5, 5, { category: "security" }),
      ),
      "no listed categories means category is not scored",
    );
    assert.ok(
      findingMatches(expected(), {
        ...observed(1),
        evidence: [
          { path: "src/z.ts", startLine: 1, endLine: 1 },
          { path: "src/a.ts", startLine: 6, endLine: 6 },
        ],
      }),
      "any evidence range may match",
    );
  },
);

unitTest(
  "matching is one-to-one: duplicates are false positives, not extra hits",
  () => {
    const result = matchFindings([expected()], [observed(5), observed(6)]);
    assert.deepEqual(
      {
        matched: result.matched,
        falsePositives: result.falsePositives,
        missed: result.missed.length,
      },
      { matched: 1, falsePositives: 1, missed: 0 },
    );
    const missed = matchFindings(
      [expected(), expected({ startLine: 20, endLine: 20 })],
      [observed(5)],
    );
    assert.equal(missed.matched, 1);
    assert.equal(missed.missed[0]?.startLine, 20);
  },
);

unitTest(
  "case scoring separates hits, misses, false positives and failures",
  () => {
    assert.equal(
      scoreCase(input({ observed: [observed(5)] })).truePositives,
      1,
    );
    const clean = scoreCase(
      input({ clean: true, expected: [], observed: [observed(5)] }),
    );
    assert.equal(clean.falsePositives, 1);
    const rejected = scoreCase(
      input({
        observed: [observed(5)],
        invalidEvidence: true,
        rawFindingCount: 1,
      }),
    );
    assert.deepEqual(
      [
        rejected.outcome,
        rejected.truePositives,
        rejected.falsePositives,
        rejected.missed.length,
      ],
      ["invalid-evidence", 0, 0, 1],
      "rejected findings are never delivered, so they are misses",
    );
    const failed = scoreCase(input({ providerFailed: true }));
    assert.deepEqual(
      [
        failed.outcome,
        failed.truePositives,
        failed.falsePositives,
        failed.missed.length,
      ],
      ["provider-failed", 0, 0, 0],
      "an outage says nothing about model quality",
    );
  },
);

unitTest(
  "scored cases never carry finding text or source, only locations",
  () => {
    const result = scoreCase(
      input({
        observed: [
          {
            ...observed(5),
            title: "contains const secret = 'x'",
            explanation: "code text",
          } as ObservedFinding,
        ],
      }),
    );
    const text = JSON.stringify(result);
    assert.ok(!text.includes("secret") && !text.includes("code text"));
    assert.deepEqual(result.observed[0]?.locations, ["src/a.ts:5-5"]);
  },
);

unitTest(
  "aggregate metrics are exact and honest about undefined values",
  () => {
    const inputs = [
      input({ id: "hit", observed: [observed(5)], rawFindingCount: 1 }),
      input({ id: "miss", observed: [], rawFindingCount: 0, abstained: true }),
      input({
        id: "fp",
        clean: true,
        expected: [],
        observed: [observed(1)],
        rawFindingCount: 1,
      }),
      input({
        id: "bad",
        invalidEvidence: true,
        rawFindingCount: 2,
        observed: [observed(5)],
      }),
      input({
        id: "down",
        providerFailed: true,
        inputTokens: 0,
        outputTokens: 0,
        requests: 1,
      }),
    ];
    const results = inputs.map(scoreCase);
    const m = aggregate(inputs, results);
    assert.deepEqual(
      [m.truePositives, m.falsePositives, m.falseNegatives],
      [1, 1, 2],
    );
    assert.equal(m.precision, 0.5);
    assert.equal(m.recall, 1 / 3);
    assert.ok(Math.abs((m.f1 ?? 0) - 0.4) < 1e-9);
    assert.equal(m.cleanCaseFalsePositives, 1);
    assert.equal(
      m.invalidEvidenceRate,
      2 / 4,
      "2 of 4 raw findings were rejected",
    );
    assert.equal(m.abstentionRate, 1 / 4, "provider-failed cases are excluded");
    assert.equal(m.providerFailedCases, 1);
    assert.equal(m.scoredCases, 4);
    assert.equal(m.requests, 5);
    assert.equal(m.latencyMs.total, 500);
    const empty = aggregate([], []);
    assert.deepEqual(
      [empty.precision, empty.recall, empty.f1, empty.abstentionRate],
      [null, null, null, null],
    );
  },
);

unitTest(
  "cost is reported only from explicit prices and measured tokens",
  () => {
    const base = {
      inputTokens: 2_000_000,
      outputTokens: 500_000,
      tokensEstimated: false,
    };
    assert.equal(estimateCost(base, {}), undefined);
    assert.equal(estimateCost(base, { inputPerMTok: 1 }), undefined);
    assert.equal(
      estimateCost(
        { ...base, tokensEstimated: true },
        { inputPerMTok: 1, outputPerMTok: 1 },
      ),
      undefined,
    );
    assert.equal(
      estimateCost(base, { inputPerMTok: 1, outputPerMTok: 2 })?.amount,
      3,
    );
  },
);

unitTest(
  "the live manifest is internally consistent with its patches",
  async () => {
    const manifest = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../eval/live-cases.json", import.meta.url)),
        "utf8",
      ),
    ) as {
      cases: Array<{
        id: string;
        changedPath: string;
        patch: string;
        clean: boolean;
        expectedFindings: ExpectedFinding[];
      }>;
    };
    assert.ok(
      manifest.cases.length > 0 && manifest.cases.length <= 8,
      "kept small on purpose",
    );
    assert.equal(
      new Set(manifest.cases.map((c) => c.id)).size,
      manifest.cases.length,
    );
    assert.ok(
      manifest.cases.some((c) => c.clean),
      "includes clean cases",
    );
    for (const item of manifest.cases) {
      assert.equal(item.clean, item.expectedFindings.length === 0, item.id);
      const added = new Set<number>();
      let line = 0;
      for (const text of item.patch.split("\n")) {
        const header = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
        if (header) line = Number(header[1]);
        else if (text.startsWith("+")) added.add(line++);
        else if (!text.startsWith("-")) line++;
      }
      for (const want of item.expectedFindings) {
        assert.equal(want.path, item.changedPath, item.id);
        for (let l = want.startLine; l <= want.endLine; l++)
          assert.ok(
            added.has(l),
            `${item.id}: expected line ${l} is not an added line`,
          );
      }
    }
  },
);

unitTest(
  "live evaluation refuses to run, and calls no provider, without opt-in",
  async () => {
    const script = fileURLToPath(
      new URL("../src/eval/live.js", import.meta.url),
    );
    const run = (env: Record<string, string>) =>
      promisify(execFile)(process.execPath, [script], {
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          ...env,
        },
        timeout: 20000,
      }).then(
        () => ({ code: 0, stderr: "" }),
        (error: { code?: number; stderr?: string }) => ({
          code: error.code ?? -1,
          stderr: error.stderr ?? "",
        }),
      );
    const none = await run({});
    assert.equal(none.code, 1);
    assert.match(
      none.stderr,
      /AI_REVIEW_LIVE_EVAL=true and AI_REVIEW_ALLOW_EXTERNAL=true/,
    );
    const optedIn = {
      AI_REVIEW_LIVE_EVAL: "true",
      AI_REVIEW_ALLOW_EXTERNAL: "true",
    };
    const noKey = await run({ ...optedIn, AI_REVIEW_PROVIDER: "anthropic" });
    assert.equal(noKey.code, 1);
    assert.match(noKey.stderr, /ANTHROPIC_API_KEY is required/);
    const badProvider = await run({ ...optedIn, AI_REVIEW_PROVIDER: "foo" });
    assert.equal(badProvider.code, 1);
    assert.match(badProvider.stderr, /AI_REVIEW_PROVIDER must be one of/);
  },
);
