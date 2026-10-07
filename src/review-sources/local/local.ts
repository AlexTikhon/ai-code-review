import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { assertContainedRegularFile } from "../../privacy/policy.js";
import {
  localContextIdentity,
  localRepositoryId,
} from "../../review/context-identity.js";
import type { ReviewSource, SourceFile } from "../../review/types.js";
import { SourceError, sourceAbortedError } from "../errors.js";

const execFileAsync = promisify(execFile);
type NameStatusEntry = {
  status: string;
  filename: string;
  previousFilename?: string;
};
export type LocalCollectionOptions = {
  pathAllowed?: (filename: string) => boolean;
  signal?: AbortSignal;
};

/**
 * Translate an execFile failure into a SourceError with a short, fixed message.
 * Git's stderr can name paths and file contents, so it is never kept.
 */
export function classifyGitFailure(
  error: unknown,
  command: string,
  signal?: AbortSignal,
): SourceError {
  if (error instanceof SourceError) return error;
  const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
  if (signal?.aborted || name === "AbortError" || code === "ABORT_ERR")
    return sourceAbortedError("git", "Git command was cancelled");
  if (code === "ENOENT" || code === "EACCES")
    return new SourceError({
      kind: "configuration",
      source: "git",
      message: "Git could not be started; is it installed and on PATH?",
      code: "git_unavailable",
    });
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return new SourceError({
      kind: "unknown",
      source: "git",
      message: `git ${command} produced more output than the limit`,
      code: "git_output_too_large",
    });
  return new SourceError({
    kind: "unknown",
    source: "git",
    message: `git ${command} failed${typeof code === "number" ? ` (exit ${code})` : ""}`,
    code: "git_command_failed",
  });
}
async function runGitRaw(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    encoding: "utf8",
    env: { ...process.env, GIT_EXTERNAL_DIFF: "", GIT_DIFF_OPTS: "" },
    signal,
  });
  return stdout;
}
async function runGit(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await runGitRaw(args, cwd, signal);
  } catch (error) {
    throw classifyGitFailure(error, args[0] ?? "command", signal);
  }
}
const notARepository = (path: string) =>
  new SourceError({
    kind: "configuration",
    source: "git",
    message: `Not a readable Git repository: ${path}`,
    code: "not_a_repository",
  });
export async function resolveRepositoryRoot(
  repoPath = process.cwd(),
  signal?: AbortSignal,
): Promise<string> {
  const directory = resolve(repoPath);
  try {
    if (!(await stat(directory)).isDirectory())
      throw new Error("not a directory");
  } catch {
    throw notARepository(directory);
  }
  try {
    return await realpath(
      (
        await runGitRaw(["rev-parse", "--show-toplevel"], directory, signal)
      ).trim(),
    );
  } catch (error) {
    const failure = classifyGitFailure(error, "rev-parse", signal);
    // A plain non-zero exit of `rev-parse --show-toplevel` means no work tree here.
    throw failure.code === "git_command_failed"
      ? notARepository(directory)
      : failure;
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
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) inHunk = true;
    if (!inHunk) continue;
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
  signal?: AbortSignal,
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
      signal,
    ),
  );
  const results: SourceFile[] = [];
  for (let offset = 0; offset < entries.length; offset += 8) {
    const batch = await Promise.all(
      entries.slice(offset, offset + 8).map(async (entry) => {
        // Both ends of a rename or copy: the destination carries the origin's bytes.
        if (
          !allowed(entry.filename) ||
          (entry.previousFilename !== undefined &&
            !allowed(entry.previousFilename))
        )
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
          signal,
        );
        const stats = countPatchStats(patch);
        return { ...entry, ...stats, patch: patch || undefined };
      }),
    );
    results.push(...batch);
  }
  return results;
}
async function untracked(
  root: string,
  allowed: (path: string) => boolean,
  signal?: AbortSignal,
): Promise<SourceFile[]> {
  const names = (
    await runGit(
      ["ls-files", "-z", "--others", "--exclude-standard"],
      root,
      signal,
    )
  )
    .split("\0")
    .filter(Boolean);
  const results: SourceFile[] = [];
  for (let offset = 0; offset < names.length; offset += 8)
    results.push(
      ...(await Promise.all(
        names
          .slice(offset, offset + 8)
          .map((name) => buildUntrackedFilePatch(root, name, allowed(name))),
      )),
    );
  return results;
}
async function baseRevision(
  root: string,
  base?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!base) return "HEAD";
  const shown = JSON.stringify(base.slice(0, 80));
  const invalid = () =>
    new SourceError({
      kind: "configuration",
      source: "git",
      message: `Base ref ${shown} does not name a commit`,
      code: "invalid_ref",
    });
  const noMergeBase = () =>
    new SourceError({
      kind: "configuration",
      source: "git",
      message: `Base ref ${shown} has no merge-base with HEAD`,
      code: "no_merge_base",
    });
  // A ref that looks like an option must never reach Git's argument parser.
  if (base.startsWith("-") || !base.trim()) throw invalid();
  try {
    await runGitRaw(
      ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
      root,
      signal,
    );
  } catch (error) {
    const failure = classifyGitFailure(error, "rev-parse", signal);
    throw failure.code === "git_command_failed" ? invalid() : failure;
  }
  let mergeBase: string;
  try {
    mergeBase = (
      await runGitRaw(["merge-base", base, "HEAD"], root, signal)
    ).trim();
  } catch (error) {
    const failure = classifyGitFailure(error, "merge-base", signal);
    throw failure.code === "git_command_failed" ? noMergeBase() : failure;
  }
  if (!mergeBase) throw noMergeBase();
  return mergeBase;
}

export async function getLocalDiff(
  base?: string,
  repoPath = process.cwd(),
  options: LocalCollectionOptions = {},
): Promise<ReviewSource> {
  const root = await resolveRepositoryRoot(repoPath, options.signal);
  const compare = await baseRevision(root, base, options.signal);
  const allowed = options.pathAllowed ?? (() => true);
  const [head, immutableBase, trackedFiles, untrackedFiles] = await Promise.all(
    [
      runGit(["rev-parse", "HEAD"], root, options.signal),
      runGit(["rev-parse", compare], root, options.signal),
      tracked(root, compare, allowed, options.signal),
      untracked(root, allowed, options.signal),
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
    repositoryId: localRepositoryId(root),
    repositoryRoot: root,
    contextIdentity: localContextIdentity(root),
    baseRevision: immutableBase.trim(),
    headRevision: head.trim(),
    snapshotId,
    files,
    coverageComplete: true,
  };
}
