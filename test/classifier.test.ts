import assert from "node:assert/strict";
import {
  classifyFile,
  isGeneratedOrVendorPath,
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

for (const path of [
  "dist/app.js",
  "packages/ui/dist/app.ts",
  "build/app.ts",
  "packages/ui/build/app.ts",
  ".next/server/app.js",
  "coverage/report.ts",
  "node_modules/dep/index.js",
  "packages/ui/node_modules/dep/index.ts",
  "bower_components/dep/index.js",
  "vendor/lib.go",
  "lib/vendor/helper.ts",
  "src/app.min.js",
  "src/app.min.mjs",
  "src/app.min.cjs",
  "src/APP.MIN.JS",
  "packages\\ui\\BUILD\\app.ts",
])
  unitTest(`generated/vendor path is excluded consistently: ${path}`, () => {
    assert.equal(isGeneratedOrVendorPath(path), true);
    assert.equal(classifyFile(path), "generated");
  });

for (const path of [
  "src/rebuild/app.ts",
  "src/outdist/app.ts",
  "src/mycoverage/app.ts",
  "src/.next-generation/app.ts",
  "src/node_modules-helper.ts",
  "src/bower_components-helper.ts",
  "src/vendorize/app.ts",
  "src/dist.ts",
  "src/build.ts",
  "src/coverage.ts",
  "src/app.snap.ts",
  "src/app.snapshot.ts",
  "src/app.min.js.ts",
  "src\\rebuild\\app.ts",
])
  unitTest(`ordinary source stays reviewable and indexable: ${path}`, () => {
    assert.equal(isGeneratedOrVendorPath(path), false);
    assert.equal(classifyFile(path), "source");
  });

unitTest("snapshot exclusion uses the filename suffix only", () => {
  assert.equal(classifyFile("src/__snapshots__/app.test.ts.snap"), "generated");
  assert.equal(classifyFile("src/APP.SNAP"), "generated");
  assert.equal(classifyFile("src/.snapshots/app.ts"), "source");
  assert.equal(classifyFile("src/app.snap.test.ts"), "test");
  assert.equal(classifyFile("src/rebuild/app.test.ts"), "test");
  assert.equal(classifyFile("src/rebuild/settings.json"), "config");
});
