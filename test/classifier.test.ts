import assert from "node:assert/strict";
import {
  classifyFile,
  isReviewableFileType,
} from "../src/review/file-classifier.js";
import { unitTest } from "./helpers.js";

unitTest("classifyFile detects main categories", () => {
  assert.equal(classifyFile("src/index.ts"), "source");
  assert.equal(classifyFile("src/user.test.ts"), "test");
  assert.equal(classifyFile("package.json"), "config");
  assert.equal(classifyFile("README.md"), "docs");
  assert.equal(classifyFile("dist/app.js"), "generated");
  assert.equal(classifyFile("assets/logo.png"), "binary");
  assert.equal(classifyFile("package-lock.json"), "lockfile");
  assert.equal(classifyFile("notes/customfile"), "unknown");
});

unitTest("isReviewableFileType allows only source test and config", () => {
  assert.equal(isReviewableFileType("source"), true);
  assert.equal(isReviewableFileType("test"), true);
  assert.equal(isReviewableFileType("config"), true);
  assert.equal(isReviewableFileType("docs"), false);
  assert.equal(isReviewableFileType("generated"), false);
});
