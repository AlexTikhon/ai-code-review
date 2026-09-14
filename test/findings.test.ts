import assert from "node:assert/strict";
import {
  deduplicateFindings,
  validateFindings,
} from "../src/review/findings.js";
import { reviewResponseSchema } from "../src/schemas/review.schema.js";
import { unitTest } from "./helpers.js";
import { splitPatchForReview } from "../src/review/patch.js";
const segment = {
  id: "s",
  text: "@@ -1 +10 @@\n+bug()",
  lineRanges: [{ start: 10, end: 10 }],
  lineMappings: [
    {
      segmentLine: 2,
      kind: "addition" as const,
      newLine: 10,
      complete: true,
    },
  ],
  truncated: false,
};
unitTest("finding validation rejects nonexistent evidence", () => {
  const raw = reviewResponseSchema.parse({
    findings: [
      {
        severity: "high",
        category: "correctness",
        confidence: "high",
        title: "Bug",
        explanation: "Broken",
        evidence: [{ path: "a.ts", startLine: 99, endLine: 99 }],
        suggestion: null,
      },
    ],
    summary: "",
    abstained: false,
    abstentionReason: null,
  });
  assert.deepEqual(validateFindings(raw, "a.ts", segment, []), []);
});
unitTest("finding IDs are stable and equivalent findings deduplicate", () => {
  const raw = reviewResponseSchema.parse({
    findings: [
      {
        severity: "high",
        category: "correctness",
        confidence: "high",
        title: "Bug here",
        explanation: "Broken",
        evidence: [{ path: "a.ts", startLine: 10, endLine: 10 }],
        suggestion: null,
      },
    ],
    summary: "",
    abstained: false,
    abstentionReason: null,
  });
  const findings = validateFindings(raw, "a.ts", segment, []);
  assert.match(findings[0]!.id, /^acr-/);
  assert.equal(deduplicateFindings([...findings, ...findings]).length, 1);
});
unitTest("schema supports abstention and rejects malformed output", () => {
  assert.equal(
    reviewResponseSchema.parse({
      findings: [],
      summary: "insufficient",
      abstained: true,
      abstentionReason: "missing implementation",
    }).abstained,
    true,
  );
  assert.equal(
    reviewResponseSchema.safeParse({ findings: "bad" }).success,
    false,
  );
});

unitTest(
  "later-segment evidence is accepted only for supplied complete lines",
  () => {
    const segments = splitPatchForReview(
      `@@ -0,0 +100,8 @@\n${Array.from({ length: 8 }, (_, index) => `+line_${100 + index}=${"x".repeat(45)}`).join("\n")}`,
      256,
      10,
    );
    const later = segments.find((item) =>
      item.lineMappings.some((line) => line.newLine === 106),
    )!;
    const accepted = reviewResponseSchema.parse({
      findings: [
        {
          severity: "high",
          category: "correctness",
          confidence: "high",
          title: "Later bug",
          explanation: "Present in a later segment",
          evidence: [{ path: "a.ts", startLine: 106, endLine: 106 }],
        },
      ],
      summary: "",
      abstained: false,
      abstentionReason: null,
    });
    assert.equal(validateFindings(accepted, "a.ts", later, []).length, 1);
    const invented = reviewResponseSchema.parse({
      ...accepted,
      findings: [
        {
          ...accepted.findings[0]!,
          evidence: [{ path: "a.ts", startLine: 100, endLine: 106 }],
        },
      ],
    });
    assert.equal(validateFindings(invented, "a.ts", later, []).length, 0);
  },
);
