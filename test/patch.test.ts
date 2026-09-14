import assert from "node:assert/strict";
import {
  changedLineNumbers,
  estimateTokens,
  getMaxPatchLength,
  splitPatchForReview,
  splitPatchIntoSections,
  truncatePatch,
} from "../src/review/patch.js";
import { unitTest } from "./helpers.js";
unitTest("splitPatchIntoSections separates preamble and hunks", () => {
  const patch =
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n@@ -3 +3 @@\n-before\n+after";
  assert.equal(splitPatchIntoSections(patch).hunks.length, 2);
});
unitTest("oversized first hunk and line cannot bypass segment budget", () => {
  const patch = `@@ -1 +1 @@\n+${"x".repeat(100_000)}`;
  const segments = splitPatchForReview(patch, 500, 2);
  assert.equal(segments.length, 2);
  assert.ok(segments.every((segment) => estimateTokens(segment.text) <= 500));
  assert.ok(segments.some((segment) => segment.truncated));
});
unitTest(
  "multibyte oversized additions keep valid mapped lines within budget",
  () => {
    const segments = splitPatchForReview(
      `@@ -1 +7 @@\n+${"😀".repeat(10_000)}`,
      300,
      2,
    );
    assert.ok(segments.every((segment) => estimateTokens(segment.text) <= 300));
    assert.ok(
      segments.every((segment) =>
        segment.lineRanges.some((range) => range.start === 7),
      ),
    );
  },
);
unitTest("truncatePatch applies an absolute character cap", () => {
  const value = truncatePatch("x".repeat(100_000));
  assert.ok(value.length <= getMaxPatchLength());
  assert.match(value, /TRUNCATED/);
});
unitTest("changedLineNumbers maps additions", () => {
  assert.deepEqual(
    [...changedLineNumbers("@@ -4,2 +10,3 @@\n old\n+new\n-old2\n+next")],
    [11, 12],
  );
});
