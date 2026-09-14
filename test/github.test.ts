import assert from "node:assert/strict";
import { getPullRequestFiles } from "../src/review-sources/github/pulls.js";
import type { GithubRequester } from "../src/review-sources/github/client.js";
import { unitTest } from "./helpers.js";
const file = (index: number) => ({
  filename: `f${index}.ts`,
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  patch: "@@ -0,0 +1 @@\n+x",
});
unitTest(
  "GitHub pagination collects all pages and verifies changed_files",
  async () => {
    let calls = 0;
    const request: GithubRequester = async <T>() => {
      calls++;
      return (
        calls === 1
          ? Array.from({ length: 100 }, (_, i) => file(i))
          : [file(100)]
      ) as T;
    };
    const files = await getPullRequestFiles("o", "r", 1, 101, request);
    assert.equal(files.length, 101);
    assert.equal(calls, 2);
  },
);
unitTest("GitHub pagination detects incomplete API coverage", async () => {
  const request: GithubRequester = async <T>() => [] as T;
  await assert.rejects(
    getPullRequestFiles("o", "r", 1, 3, request),
    /Incomplete GitHub file coverage/,
  );
});
unitTest("GitHub rate-limit failures remain operational errors", async () => {
  const request: GithubRequester = async <T>() => {
    throw new Error("GitHub API error 403 (rate limited until 123)");
  };
  await assert.rejects(
    getPullRequestFiles("o", "r", 1, 1, request),
    /rate limited/,
  );
});
