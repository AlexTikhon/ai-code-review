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
  "multibyte oversized additions preserve mapping but are honestly non-citable",
  () => {
    const segments = splitPatchForReview(
      `@@ -1 +7 @@\n+${"😀".repeat(10_000)}`,
      300,
      2,
    );
    assert.ok(segments.every((segment) => estimateTokens(segment.text) <= 300));
    const mapped = segments.filter((segment) => segment.lineMappings.length);
    assert.ok(mapped.length > 0);
    assert.ok(
      mapped.every((segment) =>
        segment.lineMappings.some(
          (line) => line.newLine === 7 && !line.complete,
        ),
      ),
    );
    assert.ok(mapped.every((segment) => segment.lineRanges.length === 0));
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

unitTest("segmentation preserves original coordinates across hunks", () => {
  const patch =
    "@@ -50,2 +100,12 @@\n" +
    Array.from(
      { length: 12 },
      (_, index) => `+value_${100 + index}=${"x".repeat(30)}`,
    ).join("\n") +
    "\n@@ -200,1 +300,2 @@\n-old\n+new\n+next";
  const segments = splitPatchForReview(patch, 256, 20);
  assert.ok(segments.length > 2);
  const mapped = segments.flatMap((segment) =>
    segment.lineMappings
      .filter((line) => line.kind === "addition" && line.complete)
      .map((line) => line.newLine),
  );
  assert.deepEqual(mapped, [
    ...Array.from({ length: 12 }, (_, index) => 100 + index),
    300,
    301,
  ]);
  assert.equal(mapped.includes(0), false);
  assert.ok(
    segments.some((segment) =>
      segment.lineMappings.some(
        (line) =>
          line.kind === "deletion" &&
          line.oldLine === 200 &&
          line.newLine === undefined,
      ),
    ),
  );
  assert.ok(segments.every((segment) => !segment.truncated));
});

unitTest("synthetic new-file line zero is never citable", () => {
  const [segment] = splitPatchForReview("@@ -0,0 +0,1 @@\n+value", 256, 2);
  assert.deepEqual(segment?.lineRanges, []);
});
