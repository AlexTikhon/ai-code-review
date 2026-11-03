import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { cacheDirectory } from "../src/cache/paths.js";
import { DeterministicTestEmbedding } from "../src/retrieval/embeddings.js";
import { indexPath, readIndex } from "../src/retrieval/index-store.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import {
  cleanResult,
  filenameOf,
  makeSource,
  request,
  sourceFile,
  testConfig,
} from "./fixtures.js";
import { unitTest } from "./helpers.js";
import { put, repo } from "./index-harness.js";

const exec = promisify(execFile);
const ordinary = ["src/rebuild/app.ts", "src/app.snap.ts"];
const excluded = [
  "dist/app.js",
  "build/app.ts",
  "coverage/report.ts",
  ".next/server/app.js",
  "node_modules/dep/index.js",
  "packages/ui/node_modules/dep/index.ts",
  "bower_components/dep/index.js",
  "vendor/lib.ts",
  "src/bundle.min.js",
  "src/bundle.min.mjs",
  "src/bundle.min.cjs",
  "src/app.test.ts.snap",
];
const marker = "GENERATED_FIXTURE_CONTENT";

for (const contextMode of ["diff", "lexical", "hybrid"] as const)
  unitTest(
    `${contextMode} review admits ordinary lookalikes and withholds generated/vendor diffs`,
    async () => {
      const paths = [...ordinary, ...excluded];
      const root = await repo(
        Object.fromEntries(
          paths.map((path) => [path, "export const before = 1;\n"]),
        ),
      );
      const config = {
        ...testConfig,
        maxFiles: 30,
        maxRequests: 30,
        maxContextTokens: 1000,
        totalTimeoutMs: 30_000,
      };
      const cache = cacheDirectory(root, config.cacheDirName);
      try {
        // All artifacts are tracked: neither Git ignore nor provider behavior
        // can hide an admission error. User negation must not re-admit them.
        await put(
          root,
          ".ai-reviewer-ignore",
          excluded.map((p) => `!${p}`).join("\n"),
        );
        await exec("git", ["add", "."], { cwd: root });
        await exec("git", ["commit", "-m", "base"], { cwd: root });
        for (const path of paths)
          await put(
            root,
            path,
            ordinary.includes(path)
              ? "export const ordinaryFixture = 200;\n"
              : `export const ${marker} = 200;\n`,
          );

        const reviewed: string[] = [];
        const prompts: string[] = [];
        const embedded: string[] = [];
        const delegate = new DeterministicTestEmbedding();
        const result = await executeReviewPipeline(
          {
            ...request,
            target: { kind: "local", localRepoPath: root },
            contextMode,
          },
          config,
          {
            model: {
              provider: "test",
              async review(input) {
                reviewed.push(filenameOf(input.user));
                prompts.push(input.system, input.user);
                return cleanResult();
              },
            },
            ...(contextMode === "hybrid"
              ? {
                  embedding: {
                    provider: delegate.provider,
                    model: delegate.model,
                    version: delegate.version,
                    dimensions: delegate.dimensions,
                    async embed(texts: string[]) {
                      embedded.push(...texts);
                      return delegate.embed(texts);
                    },
                  },
                }
              : {}),
          },
        );
        assert.equal(result.status, "complete");
        assert.equal(result.coverage.discovered, paths.length);
        assert.equal(result.coverage.eligible, ordinary.length);
        assert.equal(result.coverage.reviewed, ordinary.length);
        assert.equal(result.coverage.skipped, excluded.length);
        assert.equal(result.coverage.omitted, 0);
        assert.equal(result.coverage.failed, 0);
        assert.deepEqual(reviewed.sort(), [...ordinary].sort());
        for (const path of excluded)
          assert.equal(
            result.skippedFiles.find((file) => file.filename === path)?.reason,
            "generated_file",
            path,
          );
        assert.ok(
          prompts.length > 0,
          "positive control: source reached the model",
        );
        assert.ok(!prompts.join("\n").includes(marker));
        assert.ok(!embedded.join("\n").includes(marker));
        if (contextMode !== "diff") {
          const stored = await readIndex(indexPath(root, config.cacheDirName));
          assert.equal(stored.status, "valid");
          if (stored.status !== "valid")
            throw new Error("Index was not persisted");
          assert.deepEqual(
            stored.index.files.map((file) => file.path).sort(),
            [...ordinary].sort(),
          );
          assert.ok(
            stored.index.chunks.every(
              (chunk) => !chunk.content.includes(marker),
            ),
          );
        }
        if (contextMode === "hybrid") assert.ok(embedded.length > 0);
        else assert.equal(embedded.length, 0);
      } finally {
        await rm(cache, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
      }
    },
  );

unitTest(
  "generated-only changes are excluded without a clean-code claim",
  async () => {
    let calls = 0;
    const result = await executeReviewPipeline(request, testConfig, {
      source: makeSource(excluded.map((path) => sourceFile(path))),
      model: {
        provider: "test",
        async review() {
          calls++;
          return cleanResult();
        },
      },
    });
    assert.equal(result.status, "complete");
    assert.equal(result.coverage.eligible, 0);
    assert.equal(result.coverage.reviewed, 0);
    assert.equal(result.coverage.skipped, excluded.length);
    assert.equal(calls, 0);
    assert.equal(result.usage.actualRequests, 0);
    assert.match(result.summary, /no clean-code claim/);
  },
);

unitTest(
  "dry-run proposes lookalike source and excludes generated/vendor paths",
  async () => {
    const result = await executeReviewPipeline(
      { ...request, dryRun: true },
      testConfig,
      {
        source: makeSource(
          [...ordinary, ...excluded].map((path) => sourceFile(path)),
        ),
      },
    );
    assert.deepEqual(
      result.dryRun?.proposedFiles.map((file) => file.filename),
      ordinary,
    );
    assert.equal(result.coverage.eligible, ordinary.length);
    assert.equal(result.coverage.skipped, excluded.length);
    assert.equal(result.usage.actualRequests, 0);
  },
);
