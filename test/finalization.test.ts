import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cacheDirectory } from "../src/cache/paths.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import type { ReviewResult } from "../src/review/types.js";
import { cleanResult, makeSource, request, testConfig } from "./fixtures.js";
import { unitTest } from "./helpers.js";
import { put, repo } from "./index-harness.js";

for (const [contextMode, coverageComplete, status] of [
  ["diff", true, "complete"],
  ["diff", false, "partial"],
  ["lexical", true, "partial"],
  ["hybrid", true, "partial"],
] as const)
  unitTest(
    `empty ${contextMode} source with coverageComplete=${coverageComplete} preserves ${status}`,
    async () => {
      let calls = 0;
      const result = await executeReviewPipeline(
        { ...request, contextMode },
        testConfig,
        {
          source: makeSource([], { coverageComplete }),
          model: {
            provider: "test",
            async review() {
              calls++;
              return cleanResult();
            },
          },
        },
      );
      assert.equal(result.status, status);
      assert.equal(result.coverage.discovered, 0);
      assert.equal(result.coverage.reviewed, 0);
      assert.equal(calls, 0);
      assert.match(result.summary, /no clean-code claim/);
      if (!coverageComplete) assert.equal(result.errors[0]?.stage, "ingest");
      if (status === "partial") assert.match(result.summary, /incomplete/);
    },
  );

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

for (const format of ["json", "sarif"] as const)
  unitTest(
    `CLI ${format} exit codes preserve partial index results and dry-run success`,
    async () => {
      const root = await repo({ "app.ts": "export const app = 1;\n" });
      // A different size ensures Git notices this tracked edit even on coarse clocks.
      await exec("git", ["add", "."], { cwd: root });
      await exec("git", ["commit", "-m", "base"], { cwd: root });
      await put(root, "app.ts", "export const app = 200;\n");
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !/^(AI_REVIEW_|OPENAI_|ANTHROPIC_|GITHUB_TOKEN$|LANGCHAIN_|LANGSMITH_)/.test(
              key,
            ),
        ),
      );
      try {
        for (const [flags, context, status, expectedExit] of [
          [["--index"], "lexical", "complete", 0],
          [["--index"], "hybrid", "partial", 2],
          [["--dry-run"], "hybrid", "partial", 0],
          [["--index", "--dry-run"], "hybrid", "partial", 2],
        ] as const) {
          let stdout: string;
          let exitCode = 0;
          try {
            ({ stdout } = await exec(
              process.execPath,
              [
                cli,
                "--local",
                "--repo",
                root,
                ...flags,
                "--context",
                context,
                "--format",
                format,
              ],
              { cwd: root, env },
            ));
          } catch (error) {
            const failure = error as { code: number; stdout: string };
            exitCode = failure.code;
            stdout = failure.stdout;
          }
          assert.equal(exitCode, expectedExit, `${flags} ${context}`);
          const report = JSON.parse(stdout);
          if (format === "json") {
            assert.equal((report as ReviewResult).status, status);
            assert.equal((report as ReviewResult).usage.actualRequests, 0);
          } else {
            const invocation = report.runs[0].invocations[0];
            assert.equal(invocation.properties.status, status);
            assert.equal(invocation.executionSuccessful, status === "complete");
            assert.equal(invocation.properties.usage.actualRequests, 0);
          }
        }
      } finally {
        await rm(cacheDirectory(root, ".ai-reviewer/cache"), {
          recursive: true,
          force: true,
        });
        await rm(root, { recursive: true, force: true });
      }
    },
  );
