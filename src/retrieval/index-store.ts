import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { writeFileAtomic } from "../cache/atomic-write.js";
import {
  inspectContainedRegularFile,
  inspectSensitiveContent,
  isMandatorySensitivePath,
} from "../privacy/policy.js";
import { isIgnoredPath, type LoadedIgnore } from "../review/ignore.js";
import { POLICY_VERSION } from "../review/types.js";
import {
  INDEX_SCHEMA_VERSION,
  CHUNKER_VERSION,
  type RepositoryIndex,
  type StoredVector,
} from "./types.js";
import type { chunkSource } from "./chunker.js";
import type { EmbeddingAdapter } from "./embeddings.js";
import {
  FileEmbeddingCheckpointStore,
  checkpointPath,
  type CheckpointEvent,
  type EmbeddingCheckpointStore,
} from "./embedding-checkpoint.js";
import { assessIndexCompatibility } from "./index-compat.js";
import { salvageSchemaV1Vectors } from "./index-legacy.js";
import { parseRepositoryIndex } from "./index-schema.js";
import {
  updateRepositoryIndex,
  type IndexUpdateStats,
  type SourceFileRef,
} from "./index-update.js";

export {
  embeddingCacheKey,
  embeddingInputHash,
  normalizedEmbeddingInput,
} from "./embedding-keys.js";

const execFileAsync = promisify(execFile);
const INDEXABLE =
  /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|cs|cpp|cc|c|h|hpp|php)$/i;
const MAX_FILE_BYTES = 1024 * 1024;

export function indexPath(root: string, cacheDirName: string): string {
  return join(root, cacheDirName, "repository-index.json");
}

/**
 * Outcome of reading the persisted index. Nothing here is trusted until it has
 * passed the runtime schema:
 * - missing:      no file; build from scratch.
 * - corrupt:      unreadable, not JSON, or a schema/consistency violation.
 * - incompatible: well-formed but made by a different schema, chunker, chunk
 *                 budget, privacy policy or repository, so none of it is reused.
 * - stale:        compatible, but built for a different revision than the
 *                 caller required. Index refresh does not require one: a moved
 *                 revision is the normal case and is reconciled file by file.
 * - valid:        reusable.
 * Derived data is never repaired; callers rebuild from source and report the
 * reason instead.
 */
export type IndexLoadResult =
  | { status: "missing" }
  | { status: "valid"; index: RepositoryIndex }
  | { status: "corrupt"; reason: string }
  | {
      status: "incompatible";
      reason: string;
      /** Reusable vectors of a schema-1 index; see index-legacy.ts. */
      salvagedVectors?: StoredVector[];
    }
  | { status: "stale"; reason: string };

export type IndexExpectation = {
  chunkerVersion?: string;
  maxChunkTokens?: number;
  policyVersion?: string;
  repositoryId?: string;
  revision?: string;
};

export async function readIndex(
  path: string,
  expected: IndexExpectation = {},
): Promise<IndexLoadResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "missing" };
    return {
      status: "corrupt",
      reason: `index file is unreadable (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: "corrupt", reason: "index file is not valid JSON" };
  }
  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (Number.isInteger(version) && version !== INDEX_SCHEMA_VERSION)
    return {
      status: "incompatible",
      reason: `schema version ${String(version)} != ${INDEX_SCHEMA_VERSION}`,
      ...(version === 1
        ? { salvagedVectors: salvageSchemaV1Vectors(raw) }
        : {}),
    };
  const parsed = parseRepositoryIndex(raw);
  if (!parsed.ok) return { status: "corrupt", reason: parsed.reason };
  const { index } = parsed;
  const compatibility = assessIndexCompatibility(index, expected);
  if (compatibility.kind === "incompatible")
    return { status: "incompatible", reason: compatibility.reason };
  return expected.revision !== undefined && index.revision !== expected.revision
    ? { status: "stale", reason: "revision differs" }
    : { status: "valid", index };
}

async function runGit(
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    signal,
    env: { ...process.env, GIT_EXTERNAL_DIFF: "", GIT_DIFF_OPTS: "" },
  });
  return stdout;
}

async function workingTreeNames(
  root: string,
  signal?: AbortSignal,
): Promise<string[]> {
  return (
    await runGit(
      root,
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      signal,
    )
  )
    .split("\0")
    .filter(Boolean);
}

type TreeEntry = {
  name: string;
  size?: number;
  symlink?: boolean;
  blobId?: string;
};

async function revisionEntries(
  root: string,
  revision: string,
  signal?: AbortSignal,
): Promise<TreeEntry[]> {
  const output = await runGit(
    root,
    ["ls-tree", "-r", "-z", "--long", revision],
    signal,
  );
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d+)\s+\w+\s+([a-f0-9]+)\s+(-|\d+)\t([\s\S]+)$/.exec(
        record,
      );
      if (!match) throw new Error("Unable to parse git tree entry");
      return {
        name: match[4]!,
        blobId: match[2]!,
        size: match[3] === "-" ? undefined : Number(match[3]),
        symlink: match[1] === "120000",
      };
    });
}

export type RepositoryIndexInput = {
  root: string;
  repositoryId: string;
  revision: string;
  /** If supplied, all names and bytes are read from this immutable Git tree. */
  gitRevision?: string;
  cacheDirName: string;
  maxChunkTokens: number;
  ignorePolicy: LoadedIgnore;
  embedding?: EmbeddingAdapter;
  signal?: AbortSignal;
  beforeEmbeddingRequest?: () => void;
  onEmbeddingRequest?: () => void;
  /** Receives a safe, value-free reason when a persisted index is discarded. */
  onDiagnostic?: (message: string) => void;
  maxEmbeddingBatchSize?: number;
  /**
   * Where paid embedding work is kept if this run cannot finish. Defaults to a
   * file next to the index; a test seam otherwise.
   */
  checkpointStore?: EmbeddingCheckpointStore;
  /** Embedding batches between periodic checkpoint writes. */
  checkpointEveryBatches?: number;
  /** Counters and reasons about checkpoint use; never vectors or text. */
  onCheckpoint?: (event: CheckpointEvent) => void;
  /**
   * Working-tree files whose size and mtime match the previous index are
   * assumed unchanged without being read (Git's own model, with recent mtimes
   * excluded). Set false to read and hash every file: slower, but then identity
   * never depends on timestamps. Revision (PR) indexes use Git blob ids instead.
   */
  trustFileStat?: boolean;
  /** Test seam: replaces the chunker. */
  chunk?: typeof chunkSource;
};

export type RepositoryIndexRefresh = {
  index: RepositoryIndex;
  /** Counters only; never source text, paths or vectors. */
  stats: IndexUpdateStats;
  /** What was found on disk before this refresh. */
  loaded: IndexLoadResult["status"];
};

/** Current eligible source files, each with the cheapest identity available. */
async function scanSourceFiles(
  input: RepositoryIndexInput,
): Promise<SourceFileRef[]> {
  const { root, signal } = input;
  const entries: TreeEntry[] = input.gitRevision
    ? await revisionEntries(root, input.gitRevision, signal)
    : (await workingTreeNames(root, signal)).map((name) => ({ name }));
  const refs: SourceFileRef[] = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    const name = entry.name.replaceAll("\\", "/");
    if (
      !INDEXABLE.test(name) ||
      entry.symlink ||
      (entry.size !== undefined && entry.size > MAX_FILE_BYTES) ||
      isMandatorySensitivePath(name) ||
      isIgnoredPath(name, input.ignorePolicy)
    )
      continue;
    if (input.gitRevision) {
      const revision = input.gitRevision;
      refs.push({
        path: name,
        size: entry.size,
        blobId: entry.blobId,
        read: async () => {
          const content = await runGit(
            root,
            ["show", `--no-textconv`, `${revision}:${name}`],
            signal,
          );
          if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES)
            return undefined;
          return inspectSensitiveContent(content) ? undefined : content;
        },
      });
      continue;
    }
    let stat: { size: number; mtimeMs: number };
    try {
      stat = await inspectContainedRegularFile(root, name);
    } catch {
      continue; // Unreadable, symlinked and absent entries are unavailable.
    }
    if (stat.size > MAX_FILE_BYTES) continue;
    refs.push({
      path: name,
      ...(input.trustFileStat === false
        ? {}
        : { size: stat.size, mtimeMs: stat.mtimeMs }),
      read: async () => {
        // Containment is re-checked at the moment of reading, not only at scan.
        const current = await inspectContainedRegularFile(root, name);
        if (current.size > MAX_FILE_BYTES) return undefined;
        const content = await readFile(resolve(root, name), "utf8");
        return inspectSensitiveContent(content) ? undefined : content;
      },
    });
  }
  return refs;
}

/**
 * Load, reconcile and atomically persist the repository index. The next index
 * is built and validated entirely in memory; the file is replaced only after
 * that succeeds, so a failure (provider error, cancellation, exhausted request
 * budget) leaves the previous complete index untouched.
 */
export async function refreshRepositoryIndex(
  input: RepositoryIndexInput,
): Promise<RepositoryIndexRefresh> {
  input.signal?.throwIfAborted();
  const path = indexPath(input.root, input.cacheDirName);
  const loaded = await readIndex(path, {
    chunkerVersion: CHUNKER_VERSION,
    maxChunkTokens: input.maxChunkTokens,
    policyVersion: POLICY_VERSION,
    repositoryId: input.repositoryId,
  });
  if (loaded.status === "corrupt")
    input.onDiagnostic?.(
      `Persisted repository index was unusable (${loaded.reason}); rebuilt from source.`,
    );
  else if (loaded.status === "incompatible") {
    const salvaged = loaded.salvagedVectors?.length ?? 0;
    input.onDiagnostic?.(
      `Persisted repository index was incompatible (${loaded.reason}); rebuilt from source.${
        salvaged > 0 && input.embedding
          ? ` ${salvaged} stored vectors were salvaged for reuse where their content still matches.`
          : ""
      }`,
    );
  }
  const files = await scanSourceFiles(input);
  // Checkpoints are only read when this run may embed: an unauthorized or dry
  // run touches neither the provider nor the stored progress.
  const checkpoint = input.embedding
    ? (input.checkpointStore ??
      new FileEmbeddingCheckpointStore(
        checkpointPath(input.root, input.cacheDirName),
      ))
    : undefined;
  let seedVectors: StoredVector[] =
    checkpoint && loaded.status === "incompatible"
      ? (loaded.salvagedVectors ?? [])
      : [];
  if (checkpoint) {
    const stored = await checkpoint.load();
    if (stored.status === "valid") {
      seedVectors = [...seedVectors, ...stored.vectors];
      input.onCheckpoint?.({ type: "loaded", vectors: stored.vectors.length });
    } else if (stored.status !== "missing") {
      input.onDiagnostic?.(
        `Embedding checkpoint was ${stored.status} (${stored.reason}); ignored.`,
      );
      input.onCheckpoint?.({ type: "discarded", reason: stored.reason });
    }
  }
  const { index, stats } = await updateRepositoryIndex({
    previous: loaded.status === "valid" ? loaded.index : undefined,
    repositoryId: input.repositoryId,
    revision: input.revision,
    maxChunkTokens: input.maxChunkTokens,
    files,
    embedding: input.embedding,
    signal: input.signal,
    beforeEmbeddingRequest: input.beforeEmbeddingRequest,
    onEmbeddingRequest: input.onEmbeddingRequest,
    maxEmbeddingBatchSize: input.maxEmbeddingBatchSize,
    seedVectors,
    checkpoint,
    checkpointEveryBatches: input.checkpointEveryBatches,
    onCheckpoint: input.onCheckpoint,
    chunk: input.chunk,
  });
  try {
    await writeFileAtomic(path, JSON.stringify(index));
  } catch (error) {
    // Everything was embedded but could not be published: keep the paid vectors.
    if (checkpoint) {
      const known = new Set(
        loaded.status === "valid" ? Object.keys(loaded.index.vectors) : [],
      );
      const fresh = Object.values(index.vectors).filter(
        (vector) => !known.has(vector.cacheKey),
      );
      if (fresh.length > 0)
        await checkpoint.save(fresh).then(
          () => input.onCheckpoint?.({ type: "saved", vectors: fresh.length }),
          () => input.onCheckpoint?.({ type: "save_failed" }),
        );
    }
    throw error;
  }
  // The canonical index now contains every vector the checkpoint held that
  // is still wanted; what remains in it is obsolete.
  if (checkpoint)
    await checkpoint.clear().then(
      () => input.onCheckpoint?.({ type: "cleared" }),
      () => undefined,
    );
  return { index, stats, loaded: loaded.status };
}

export async function buildRepositoryIndex(
  input: RepositoryIndexInput,
): Promise<RepositoryIndex> {
  return (await refreshRepositoryIndex(input)).index;
}
