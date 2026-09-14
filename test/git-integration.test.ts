import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getLocalDiff } from "../src/review-sources/local/local.js";
import { assertContainedRegularFile } from "../src/privacy/policy.js";
import { unitTest } from "./helpers.js";
const exec = promisify(execFile);
async function git(root: string, args: string[]) {
  await exec("git", args, { cwd: root });
}
unitTest(
  "real Git collection handles renames, Unicode, spaces and untracked terminal newline",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "acr-git-"));
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "old.ts"), "export const old = 1;\n");
    await writeFile(join(root, "remove.ts"), "export const remove = 1;\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "base"]);
    await git(root, ["mv", "old.ts", "renamed ü file.ts"]);
    await unlink(join(root, "remove.ts"));
    await writeFile(join(root, "new file.ts"), "one\ntwo\n");
    const result = await getLocalDiff(undefined, root);
    const renamed = result.files.find(
      (file) => file.filename === "renamed ü file.ts",
    );
    const added = result.files.find((file) => file.filename === "new file.ts");
    assert.equal(renamed?.status, "renamed");
    assert.equal(
      result.files.find((file) => file.filename === "remove.ts")?.status,
      "removed",
    );
    assert.equal(added?.additions, 2);
    assert.doesNotMatch(added?.patch ?? "", /\+\n$/);
    assert.match(result.headRevision, /^[a-f0-9]{40}$/);
  },
);
unitTest(
  "untracked mandatory exclusions are applied before content reads",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "acr-private-"));
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "base.ts"), "x\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "base"]);
    await writeFile(join(root, ".env"), "SECRET=value\n");
    const result = await getLocalDiff(undefined, root, {
      pathAllowed: (name) => name !== ".env",
    });

    unitTest(
      "symlink containment policy rejects links where the platform supports them",
      async () => {
        const root = await mkdtemp(join(tmpdir(), "acr-link-"));
        const outside = join(
          await mkdtemp(join(tmpdir(), "acr-outside-")),
          "secret.ts",
        );
        await writeFile(outside, "secret\n");
        try {
          await symlink(outside, join(root, "link.ts"));
        } catch (error) {
          if (
            ["EPERM", "EACCES"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            return;
          throw error;
        }
        await assert.rejects(
          assertContainedRegularFile(root, "link.ts"),
          /Symlink/,
        );
      },
    );
    assert.equal(
      result.files.find((file) => file.filename === ".env")?.patch,
      undefined,
    );
  },
);
