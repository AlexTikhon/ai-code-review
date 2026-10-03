import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { writeFileAtomic } from "../cache/atomic-write.js";
import {
  assertContainedRegularFile,
  inspectSensitiveContent,
  isMandatorySensitivePath,
} from "../privacy/policy.js";
import { isIgnoredPath, type LoadedIgnore } from "../review/ignore.js";
import {
  CHUNKER_VERSION,
  type ContextChunk,
  type RepositoryIndex,
  type StoredVector,
} from "./types.js";
import { chunkSource } from "./chunker.js";
import { parseRepositoryIndex } from "./index-schema.js";
import { validateEmbeddingBatch, type EmbeddingAdapter } from "./embeddings.js";

const execFileAsync = promisify(execFile);
const INDEXABLE =
  /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|cs|cpp|cc|c|h|hpp|php)$/i;

export function indexPath(root: string, cacheDirName: string): string {
  return join(root, cacheDirName, "repository-index.json");
}

/**
 * Outcome of reading the persisted index. Nothing here is trusted until it has
 * passed the runtime schema:
 * - missing: no file; build from scratch.
 * - corrupt: unreadable, not JSON, or schema/consistency violation.
 * - stale:   structurally valid but built by an incompatible chunker/budget
 *            (or for a different repository/revision when the caller requires
 *            an exact match).
 * Corrupt and stale files are derived data, so callers rebuild from source and
 * report the reason instead of reusing anything from them.
 */
export type IndexLoadResult =
  | { status: "missing" }
  | { status: "valid"; index: RepositoryIndex }
  | { status: "corrupt"; reason: string }
  | { status: "stale"; reason: string };

export type IndexExpectation = {
  chunkerVersion?: string;
  maxChunkTokens?: number;
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
  const parsed = parseRepositoryIndex(raw);
  if (!parsed.ok) return { status: "corrupt", reason: parsed.reason };
  const { index } = parsed;
  const mismatch =
    expected.chunkerVersion !== undefined &&
    index.chunkerVersion !== expected.chunkerVersion
      ? `chunker version ${index.chunkerVersion} != ${expected.chunkerVersion}`
      : expected.maxChunkTokens !== undefined &&
          index.maxChunkTokens !== expected.maxChunkTokens
        ? `max chunk tokens ${index.maxChunkTokens} != ${expected.maxChunkTokens}`
        : expected.repositoryId !== undefined &&
            index.repositoryId !== expected.repositoryId
          ? "repository identity differs"
          : expected.revision !== undefined &&
              index.revision !== expected.revision
            ? "revision differs"
            : undefined;
  return mismatch
    ? { status: "stale", reason: mismatch }
    : { status: "valid", index };
}

export function normalizedEmbeddingInput(chunk: ContextChunk): string {
  return `${chunk.path.replaceAll("\\", "/")}\n${chunk.signature ?? ""}\n${chunk.content.replace(/\r\n/g, "\n")}`;
}

export function embeddingInputHash(chunk: ContextChunk): string {
  return createHash("sha256")
    .update(normalizedEmbeddingInput(chunk))
    .digest("hex");
}

export function embeddingCacheKey(
  chunk: ContextChunk,
  embedding: EmbeddingAdapter,
  maxChunkTokens: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        inputHash: embeddingInputHash(chunk),
        provider: embedding.provider,
        model: embedding.model,
        version: embedding.version,
        dimensions: embedding.dimensions ?? "provider-default",
        chunkerVersion: CHUNKER_VERSION,
        maxChunkTokens,
      }),
    )
    .digest("hex");
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

type IndexEntry = { name: string; size?: number; symlink?: boolean };

async function revisionEntries(
  root: string,
  revision: string,
  signal?: AbortSignal,
): Promise<IndexEntry[]> {
  const output = await runGit(
    root,
    ["ls-tree", "-r", "-z", "--long", revision],
    signal,
  );
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d+)\s+\w+\s+[a-f0-9]+\s+(-|\d+)\t([\s\S]+)$/.exec(
        record,
      );
      if (!match) throw new Error("Unable to parse git tree entry");
      return {
        name: match[3]!,
        size: match[2] === "-" ? undefined : Number(match[2]),
        symlink: match[1] === "120000",
      };
    });
}

function validStoredVector(
  vector: StoredVector,
  inputHashes: Set<string>,
  maxChunkTokens: number,
): boolean {
  return (
    typeof vector.cacheKey === "string" &&
    typeof vector.inputHash === "string" &&
    inputHashes.has(vector.inputHash) &&
    vector.chunkerVersion === CHUNKER_VERSION &&
    vector.maxChunkTokens === maxChunkTokens &&
    Number.isInteger(vector.dimensions) &&
    vector.dimensions > 0 &&
    vector.values.length === vector.dimensions &&
    vector.values.every(Number.isFinite)
  );
}

export async function buildRepositoryIndex(input: {
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
}): Promise<RepositoryIndex> {
  input.signal?.throwIfAborted();
  const path = indexPath(input.root, input.cacheDirName);
  // Chunks are always regenerated from source; only compatible vectors carry
  // over. A corrupt or stale file therefore costs a re-embed, never correctness.
  const loaded = await readIndex(path, {
    chunkerVersion: CHUNKER_VERSION,
    maxChunkTokens: input.maxChunkTokens,
  });
  if (loaded.status === "corrupt")
    input.onDiagnostic?.(
      `Persisted repository index was unusable (${loaded.reason}); rebuilt from source.`,
    );
  else if (loaded.status === "stale")
    input.onDiagnostic?.(
      `Persisted repository index was stale (${loaded.reason}); rebuilt from source.`,
    );
  const old = loaded.status === "valid" ? loaded.index : undefined;
  const entries: IndexEntry[] = input.gitRevision
    ? await revisionEntries(input.root, input.gitRevision, input.signal)
    : (await workingTreeNames(input.root, input.signal)).map((name) => ({
        name,
      }));
  const chunks: ContextChunk[] = [];
  for (const entry of entries) {
    input.signal?.throwIfAborted();
    const name = entry.name.replaceAll("\\", "/");
    if (
      !INDEXABLE.test(name) ||
      entry.symlink ||
      (entry.size !== undefined && entry.size > 1024 * 1024) ||
      isMandatorySensitivePath(name) ||
      isIgnoredPath(name, input.ignorePolicy)
    )
      continue;
    try {
      let content: string;
      if (input.gitRevision) {
        content = await runGit(
          input.root,
          ["show", `--no-textconv`, `${input.gitRevision}:${name}`],
          input.signal,
        );
        if (Buffer.byteLength(content, "utf8") > 1024 * 1024) continue;
      } else {
        const size = await assertContainedRegularFile(input.root, name);
        if (size > 1024 * 1024) continue;
        content = await readFile(resolve(input.root, name), "utf8");
      }
      if (inspectSensitiveContent(content)) continue;
      chunks.push(
        ...chunkSource({
          repositoryId: input.repositoryId,
          revision: input.revision,
          path: name,
          content,
          maxTokens: input.maxChunkTokens,
        }),
      );
    } catch (error) {
      if (input.signal?.aborted) throw error;
      /* Unreadable, binary, symlink, and absent revision entries are unavailable. */
    }
  }

  const vectors: Record<string, StoredVector> = {};
  const currentInputHashes = new Set(chunks.map(embeddingInputHash));
  for (const [key, vector] of Object.entries(old?.vectors ?? {}))
    if (validStoredVector(vector, currentInputHashes, input.maxChunkTokens))
      vectors[key] = vector;

  if (input.embedding) {
    const missing = [];
    for (const chunk of chunks) {
      const cacheKey = embeddingCacheKey(
        chunk,
        input.embedding,
        input.maxChunkTokens,
      );
      const cached = vectors[cacheKey];
      if (
        cached &&
        cached.provider === input.embedding.provider &&
        cached.model === input.embedding.model &&
        cached.version === input.embedding.version &&
        cached.dimensionIdentity ===
          String(input.embedding.dimensions ?? "provider-default")
      )
        continue;
      delete vectors[cacheKey];
      missing.push({ chunk, cacheKey });
    }
    const batchSize = Math.max(1, input.maxEmbeddingBatchSize ?? 32);
    for (let offset = 0; offset < missing.length; offset += batchSize) {
      input.signal?.throwIfAborted();
      const batch = missing.slice(offset, offset + batchSize);
      input.beforeEmbeddingRequest?.();
      const embedded = await input.embedding.embed(
        batch.map(({ chunk }) => normalizedEmbeddingInput(chunk)),
        input.signal,
      );
      input.onEmbeddingRequest?.();
      const dimensions = validateEmbeddingBatch(
        embedded,
        batch.length,
        input.embedding.dimensions,
      );
      batch.forEach((item, index) => {
        vectors[item.cacheKey] = {
          cacheKey: item.cacheKey,
          values: embedded[index]!,
          inputHash: embeddingInputHash(item.chunk),
          dimensions,
          provider: input.embedding!.provider,
          model: input.embedding!.model,
          version: input.embedding!.version,
          dimensionIdentity: String(
            input.embedding!.dimensions ?? "provider-default",
          ),
          chunkerVersion: CHUNKER_VERSION,
          maxChunkTokens: input.maxChunkTokens,
        };
      });
    }
  }
  const index: RepositoryIndex = {
    schemaVersion: 1,
    chunkerVersion: CHUNKER_VERSION,
    repositoryId: input.repositoryId,
    revision: input.revision,
    maxChunkTokens: input.maxChunkTokens,
    createdAt: new Date().toISOString(),
    chunks,
    vectors,
  };
  await writeFileAtomic(path, JSON.stringify(index));
  return index;
}
