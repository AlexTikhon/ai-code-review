import assert from "node:assert/strict";
import {
  deduplicateFindings,
  validateFindings,
} from "../src/review/findings.js";
import { reviewResponseSchema } from "../src/schemas/review.schema.js";
import { unitTest } from "./helpers.js";
const segment = {
  id: "s",
  text: "@@ -1 +10 @@\n+bug()",
  lineRanges: [{ start: 10, end: 10 }],
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
