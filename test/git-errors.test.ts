import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SourceError } from "../src/review-sources/errors.js";
import {
  classifyGitFailure,
  getLocalDiff,
  resolveRepositoryRoot,
} from "../src/review-sources/local/local.js";
import { unitTest } from "./helpers.js";

const exec = promisify(execFile);
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acr-git-errors-"));
  const git = (args: string[]) => exec("git", args, { cwd: root });
  await git(["init"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await writeFile(join(root, "a.ts"), "export const a = 1;\n");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  return root;
}
async function failure(promise: Promise<unknown>): Promise<SourceError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SourceError, `not a SourceError: ${error}`);
    return error;
  }
  throw new Error("expected a failure");
}

unitTest(
  "a directory that is not a Git repository is a typed configuration error",
  async () => {
    const empty = await mkdtemp(join(tmpdir(), "acr-not-git-"));
    const error = await failure(resolveRepositoryRoot(empty));
    assert.equal(error.source, "git");
    assert.equal(error.kind, "configuration");
    assert.equal(error.code, "not_a_repository");
    assert.equal(error.retryable, false);
  },
);

unitTest(
  "a path that does not exist is reported as not a repository",
  async () => {
    const error = await failure(
      resolveRepositoryRoot(join(tmpdir(), "acr-definitely-missing-dir")),
    );
    assert.equal(error.code, "not_a_repository");
  },
);

unitTest(
  "an unknown or option-like base ref is an invalid_ref error",
  async () => {
    const root = await repository();
    for (const base of ["no-such-ref", "--upload-pack=x", ""]) {
      const error = await failure(getLocalDiff(base || " ", root));
      assert.equal(error.source, "git", base);
      assert.equal(error.kind, "configuration", base);
      assert.equal(error.code, "invalid_ref", base);
      assert.ok(error.message.length < 200);
    }
  },
);

unitTest(
  "cancelling a Git command is aborted, not a command failure",
  async () => {
    const root = await repository();
    const error = await failure(
      resolveRepositoryRoot(root, AbortSignal.abort()),
    );
    assert.equal(error.kind, "aborted");
  },
);

unitTest("Git failures are classified without leaking stderr", () => {
  const spawnFailure = Object.assign(new Error("spawn git ENOENT"), {
    code: "ENOENT",
  });
  const missing = classifyGitFailure(spawnFailure, "diff");
  assert.equal(missing.kind, "configuration");
  assert.equal(missing.code, "git_unavailable");

  const failed = classifyGitFailure(
    Object.assign(new Error("Command failed"), {
      code: 128,
      stderr: `fatal: ${"secret path ".repeat(500)}`,
    }),
    "diff",
  );
  assert.equal(failed.kind, "unknown");
  assert.equal(failed.code, "git_command_failed");
  assert.equal(failed.retryable, false);
  assert.doesNotMatch(failed.message, /secret path/);
  assert.ok(failed.message.length < 120);

  const large = classifyGitFailure(
    Object.assign(new RangeError("maxBuffer"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    }),
    "diff",
  );
  assert.equal(large.code, "git_output_too_large");
});
