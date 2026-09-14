import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { assertContainedRegularFile } from "../../privacy/policy.js";
import type { ReviewSource, SourceFile } from "../../review/types.js";

const execFileAsync = promisify(execFile);
type NameStatusEntry = {
  status: string;
  filename: string;
  previousFilename?: string;
};
export type LocalCollectionOptions = {
  pathAllowed?: (filename: string) => boolean;
};

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    encoding: "utf8",
    env: { ...process.env, GIT_EXTERNAL_DIFF: "", GIT_DIFF_OPTS: "" },
  });
  return stdout;
}
export async function resolveRepositoryRoot(
  repoPath = process.cwd(),
): Promise<string> {
  try {
    return await realpath(
      (
        await runGit(["rev-parse", "--show-toplevel"], resolve(repoPath))
      ).trim(),
    );
  } catch (error) {
    throw new Error(
      `Not a readable Git repository: ${resolve(repoPath)} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
function mapStatus(raw: string): string {
  return (
    (
      {
        A: "added",
        M: "modified",
        D: "removed",
        T: "changed",
        C: "copied",
      } as Record<string, string>
    )[raw[0] ?? ""] ?? "modified"
  );
}
export function parseNameStatusZ(output: string): NameStatusEntry[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries: NameStatusEntry[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousFilename = fields[index++] ?? "";
      const filename = fields[index++] ?? "";
      if (filename)
        entries.push({
          status: status.startsWith("R") ? "renamed" : "copied",
          previousFilename,
          filename,
        });
    } else {
      const filename = fields[index++] ?? "";
      if (filename) entries.push({ status: mapStatus(status), filename });
    }
  }
  return entries;
}
/** Legacy test helper for line-formatted samples; collection itself is always NUL-delimited. */
export function parseNameStatus(output: string): NameStatusEntry[] {
  if (output.includes("\0")) return parseNameStatusZ(output);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .map((parts) =>
      parts[0]?.startsWith("R")
        ? {
            status: "renamed",
            previousFilename: parts[1],
            filename: parts[2] ?? "",
          }
        : { status: mapStatus(parts[0] ?? ""), filename: parts[1] ?? "" },
    )
    .filter((entry) => entry.filename);
}
export function countLines(value: string): number {
  if (!value) return 0;
  const normalized = value.replace(/\r\n/g, "\n");
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n").length
    : normalized.split("\n").length;
}
export function countPatchStats(patch: string): {
  additions: number;
  deletions: number;
  changes: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions, changes: additions + deletions };
}
export function isProbablyBinary(buffer: Buffer): boolean {
  if (!buffer.length) return false;
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if (byte < 32 && ![9, 10, 12, 13].includes(byte)) suspicious++;
  }
  return suspicious / buffer.length > 0.1;
}

async function buildUntrackedFilePatch(
  root: string,
  filename: string,
  allowed: boolean,
): Promise<SourceFile> {
  if (!allowed)
    return {
      filename,
      status: "added",
      additions: 0,
      deletions: 0,
      changes: 0,
    };
  try {
    const size = await assertContainedRegularFile(root, filename);
    if (size > 2 * 1024 * 1024)
      return {
        filename,
        status: "added",
        additions: 0,
        deletions: 0,
        changes: 0,
      };
    const buffer = await readFile(resolve(root, filename));
    if (isProbablyBinary(buffer))
      return {
        filename,
        status: "added",
        additions: 0,
        deletions: 0,
        changes: 0,
      };
    const normalized = buffer.toString("utf8").replace(/\r\n/g, "\n");
    const lineCount = countLines(normalized);
    const content = normalized.endsWith("\n")
      ? normalized.slice(0, -1)
      : normalized;
    const patchLines = [
      `diff --git a/${filename} b/${filename}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${filename}`,
      `@@ -0,0 +1,${lineCount} @@`,
      ...(content ? content.split("\n").map((line) => `+${line}`) : []),
    ];
    return {
      filename,
      status: "added",
      additions: lineCount,
      deletions: 0,
      changes: lineCount,
      patch: patchLines.join("\n"),
    };
  } catch {
    return {
      filename,
      status: "added",
      additions: 0,
      deletions: 0,
      changes: 0,
    };
  }
}
async function tracked(
  root: string,
  ref: string,
  allowed: (path: string) => boolean,
): Promise<SourceFile[]> {
  const entries = parseNameStatusZ(
    await runGit(
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-status",
        "-z",
        "--find-renames",
        ref,
      ],
      root,
    ),
  );
  return Promise.all(
    entries.map(async (entry) => {
      if (!allowed(entry.filename))
        return { ...entry, additions: 0, deletions: 0, changes: 0 };
      const patch = await runGit(
        [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--find-renames",
          ref,
          "--",
          entry.filename,
        ],
        root,
      );
      const stats = countPatchStats(patch);
      return { ...entry, ...stats, patch: patch || undefined };
    }),
  );
}
async function untracked(
  root: string,
  allowed: (path: string) => boolean,
): Promise<SourceFile[]> {
  const names = (
    await runGit(["ls-files", "-z", "--others", "--exclude-standard"], root)
  )
    .split("\0")
    .filter(Boolean);
  return Promise.all(
    names.map((name) => buildUntrackedFilePatch(root, name, allowed(name))),
  );
}
async function baseRevision(root: string, base?: string): Promise<string> {
  if (!base) return "HEAD";
  const mergeBase = (await runGit(["merge-base", base, "HEAD"], root)).trim();
  if (!mergeBase) throw new Error(`Could not resolve merge-base for ${base}`);
  return mergeBase;
}

export async function getLocalDiff(
  base?: string,
  repoPath = process.cwd(),
  options: LocalCollectionOptions = {},
): Promise<ReviewSource> {
  const root = await resolveRepositoryRoot(repoPath);
  const compare = await baseRevision(root, base);
  const allowed = options.pathAllowed ?? (() => true);
  const [head, immutableBase, trackedFiles, untrackedFiles] = await Promise.all(
    [
      runGit(["rev-parse", "HEAD"], root),
      runGit(["rev-parse", compare], root),
      tracked(root, compare, allowed),
      untracked(root, allowed),
    ],
  );
  const files = [...trackedFiles, ...untrackedFiles];
  const snapshotId = createHash("sha256")
    .update(head.trim())
    .update(
      JSON.stringify(
        files.map((f) => [
          f.filename,
          f.status,
          f.patch ? createHash("sha256").update(f.patch).digest("hex") : null,
        ]),
      ),
    )
    .digest("hex");
  return {
    mode: "local",
    title: base
      ? `Local diff review against ${base}`
      : "Local diff review against HEAD",
    description: base
      ? `Working tree changes relative to merge-base(${base}, HEAD).`
      : "Tracked and untracked working tree changes relative to HEAD.",
    repositoryId: createHash("sha256").update(root.toLowerCase()).digest("hex"),
    repositoryRoot: root,
    baseRevision: immutableBase.trim(),
    headRevision: head.trim(),
    snapshotId,
    files,
    coverageComplete: true,
  };
}
