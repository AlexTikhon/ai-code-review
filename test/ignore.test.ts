import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isIgnoredPath,
  loadIgnoreRules,
  parseIgnoreFile,
} from "../src/review/ignore.js";
import { unitTest } from "./helpers.js";

unitTest("parseIgnoreFile skips comments and parses negation", () => {
  assert.deepEqual(parseIgnoreFile("# comment\n\n dist/\n!src/keep.ts\n"), [
    { pattern: "dist/", negated: false },
    { pattern: "src/keep.ts", negated: true },
  ]);
});

unitTest("isIgnoredPath matches glob, directories and negations", () => {
  const rules = parseIgnoreFile(
    "dist/\n**/*.snap\n!src/critical.snap\nnode_modules\n",
  );

  assert.equal(isIgnoredPath("dist/app.js", rules), true);
  assert.equal(isIgnoredPath("src/foo.snap", rules), true);
  assert.equal(isIgnoredPath("src/critical.snap", rules), false);
  assert.equal(isIgnoredPath("packages/a/node_modules", rules), true);
  assert.equal(isIgnoredPath("src/app.ts", rules), false);
});

unitTest(
  "loadIgnoreRules reads .ai-reviewer-ignore from a base path",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-reviewer-ignore-"));
    await writeFile(join(dir, ".ai-reviewer-ignore"), "coverage/\n");

    const rules = await loadIgnoreRules(dir);

    assert.deepEqual(rules, [{ pattern: "coverage/", negated: false }]);
  },
);
