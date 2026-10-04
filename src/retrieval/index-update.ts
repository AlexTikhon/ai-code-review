import { createHash } from "node:crypto";
import { POLICY_VERSION } from "../review/types.js";
import { chunkSource, rebindChunk } from "./chunker.js";
import {
  embeddingCacheKeyForHash,
  embeddingDimensionIdentity,
  embeddingInputHash,
  normalizedEmbeddingInput,
} from "./embedding-keys.js";
import type { CheckpointEvent } from "./embedding-checkpoint.js";
import { validateEmbeddingBatch, type EmbeddingAdapter } from "./embeddings.js";
import { assessIndexCompatibility } from "./index-compat.js";
import { parseRepositoryIndex } from "./index-schema.js";
import {
  CHUNKER_VERSION,
  INDEX_SCHEMA_VERSION,
  type ContextChunk,
  type IndexedFile,
  type RepositoryIndex,
  type StoredVector,
} from "./types.js";

/**
 * A file mtime this close to "now" could still be rewritten within the same
 * timestamp tick after we read it, so it is never recorded as a reuse hint
 * (the same reasoning as Git's "racily clean" entries).
 */
const RACY_WINDOW_MS = 2000;

/** One eligible source file as the current repository presents it. */
export type SourceFileRef = {
  path: string;
  /** Cheap identity hints, known without reading the file. */
  size?: number;
  blobId?: string;
  mtimeMs?: number;
  /** The file text, or undefined when it is ineligible or unreadable. */
  read(): Promise<string | undefined>;
};

export type IndexUpdateStats = {
  /** How the supplied previous index was treated. */
  previous: "none" | "reused" | "incompatible";
  /** Files in the next index. */
  filesTotal: number;
  /** Files whose chunks were carried over (including re-read but identical). */
  filesReused: number;
  /** Files chunked this run: added plus modified. */
  filesIndexed: number;
  filesAdded: number;
  filesModified: number;
  /** Previously indexed files absent from the next index. */
  filesDeleted: number;
  /** Eligible by name but unreadable, oversized or sensitive. */
  filesSkipped: number;
  /** Files whose text was actually read. */
  filesRead: number;
  chunksReused: number;
  chunksCreated: number;
  vectorsReused: number;
  vectorsCreated: number;
  /** Previous vectors not carried into the next index. */
  vectorsPruned: number;
  /** Real embedding API calls made. */
  embeddingRequests: number;
  /** Vectors taken from the embedding checkpoint instead of the provider. */
  vectorsFromCheckpoint: number;
  /** Provider calls the checkpoint made unnecessary. */
  embeddingRequestsAvoided: number;
  /** Checkpoint writes during this run, and those that failed. */
  checkpointSaves: number;
  checkpointSaveFailures: number;
};

/** Where completed vectors are persisted while a run is still in progress. */
export type CheckpointSink = {
  save(vectors: readonly StoredVector[]): Promise<void>;
};

/** Embedding batches between periodic checkpoint writes. */
export const DEFAULT_CHECKPOINT_EVERY_BATCHES = 8;

export type IndexUpdateInput = {
  /** Previously persisted, schema-valid index; ignored unless compatible. */
  previous?: RepositoryIndex;
  repositoryId: string;
  revision: string;
  maxChunkTokens: number;
  files: readonly SourceFileRef[];
  embedding?: EmbeddingAdapter;
  signal?: AbortSignal;
  beforeEmbeddingRequest?: () => void;
  onEmbeddingRequest?: () => void;
  maxEmbeddingBatchSize?: number;
  /**
   * Completed vectors from an earlier unfinished run. They are reused only
   * under exactly the rules that govern vectors of the previous index.
   */
  seedVectors?: readonly StoredVector[];
  /**
   * Receives the vectors this run has paid for: periodically, and once more
   * if the run fails or is cancelled. A sink failure never fails the run.
   */
  checkpoint?: CheckpointSink;
  checkpointEveryBatches?: number;
  onCheckpoint?: (event: CheckpointEvent) => void;
  /** Test seams. */
  chunk?: typeof chunkSource;
  now?: () => number;
};

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function validStoredVector(
  vector: StoredVector,
  inputHashes: ReadonlySet<string>,
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

/** True when the previous entry provably describes the file as it is now. */
function sameIdentity(previous: IndexedFile, ref: SourceFileRef): boolean {
  if (ref.blobId !== undefined && previous.blobId === ref.blobId) return true;
  return (
    ref.mtimeMs !== undefined &&
    ref.size !== undefined &&
    previous.mtimeMs === ref.mtimeMs &&
    previous.size === ref.size
  );
}

/**
 * Reconcile a previous index with the repository as it is now and return the
 * next complete index. The previous index is never modified.
 *
 *   unchanged -> chunks reused (rebound to the new revision), no read
 *   modified  -> re-read and re-chunked
 *   added     -> chunked
 *   deleted   -> dropped, with its chunks and vectors
 *
 * Identity is content-based: a Git blob id, or a content hash after a read. A
 * size+mtime pair only avoids that read when it provably matches. The result is
 * validated before it is returned, and the function throws instead of returning
 * anything partial (cancellation, budget exhaustion, provider failure), so the
 * caller can safely persist whatever it gets back.
 */
export async function updateRepositoryIndex(
  input: IndexUpdateInput,
): Promise<{ index: RepositoryIndex; stats: IndexUpdateStats }> {
  const { signal, embedding, maxChunkTokens, revision } = input;
  const chunker = input.chunk ?? chunkSource;
  const now = input.now ?? Date.now;
  const compatibility = input.previous
    ? assessIndexCompatibility(input.previous, {
        repositoryId: input.repositoryId,
        chunkerVersion: CHUNKER_VERSION,
        maxChunkTokens,
        policyVersion: POLICY_VERSION,
      })
    : undefined;
  const previous =
    compatibility?.kind === "reusable" ? input.previous : undefined;
  const previousFiles = new Map(previous?.files.map((f) => [f.path, f]));
  const previousChunks = new Map(previous?.chunks.map((c) => [c.id, c]));
  const stats: IndexUpdateStats = {
    previous: !input.previous ? "none" : previous ? "reused" : "incompatible",
    filesTotal: 0,
    filesReused: 0,
    filesIndexed: 0,
    filesAdded: 0,
    filesModified: 0,
    filesDeleted: 0,
    filesSkipped: 0,
    filesRead: 0,
    chunksReused: 0,
    chunksCreated: 0,
    vectorsReused: 0,
    vectorsCreated: 0,
    vectorsPruned: 0,
    embeddingRequests: 0,
    vectorsFromCheckpoint: 0,
    embeddingRequestsAvoided: 0,
    checkpointSaves: 0,
    checkpointSaveFailures: 0,
  };

  const files: IndexedFile[] = [];
  const chunks: ContextChunk[] = [];
  const seen = new Set<string>();
  const recordableMtime = (ref: SourceFileRef) =>
    ref.mtimeMs !== undefined && ref.mtimeMs < now() - RACY_WINDOW_MS
      ? ref.mtimeMs
      : undefined;
  const entry = (
    path: string,
    fields: Omit<IndexedFile, "path" | "blobId" | "mtimeMs"> & {
      blobId?: string;
      mtimeMs?: number;
    },
  ): IndexedFile => ({
    path,
    contentHash: fields.contentHash,
    size: fields.size,
    ...(fields.blobId !== undefined ? { blobId: fields.blobId } : {}),
    ...(fields.mtimeMs !== undefined ? { mtimeMs: fields.mtimeMs } : {}),
    chunkIds: fields.chunkIds,
  });
  /** Previous chunks of a file under the new revision, or undefined if any is missing. */
  const reusableChunks = (file: IndexedFile): ContextChunk[] | undefined => {
    const found: ContextChunk[] = [];
    for (const id of file.chunkIds) {
      const chunk = previousChunks.get(id);
      if (!chunk) return undefined;
      found.push(rebindChunk(chunk, revision));
    }
    return found;
  };
  const carryOver = (
    file: IndexedFile,
    reused: ContextChunk[],
    extra: { blobId?: string; mtimeMs?: number; size?: number },
  ) => {
    chunks.push(...reused);
    files.push(
      entry(file.path, {
        contentHash: file.contentHash,
        size: extra.size ?? file.size,
        blobId: extra.blobId ?? file.blobId,
        mtimeMs: extra.mtimeMs ?? file.mtimeMs,
        chunkIds: reused.map((chunk) => chunk.id),
      }),
    );
    stats.filesReused++;
    stats.chunksReused += reused.length;
  };

  for (const ref of input.files) {
    signal?.throwIfAborted();
    if (seen.has(ref.path)) continue;
    seen.add(ref.path);
    const prior = previousFiles.get(ref.path);
    if (prior && sameIdentity(prior, ref)) {
      const reused = reusableChunks(prior);
      if (reused) {
        carryOver(prior, reused, {});
        continue;
      }
    }
    let content: string | undefined;
    let created: ContextChunk[] = [];
    try {
      content = await ref.read();
      stats.filesRead++;
      signal?.throwIfAborted();
      if (content !== undefined) {
        const contentHash = sha256(content);
        const reused =
          prior?.contentHash === contentHash
            ? reusableChunks(prior)
            : undefined;
        if (prior && reused) {
          carryOver(prior, reused, {
            blobId: ref.blobId,
            mtimeMs: recordableMtime(ref),
            size: Buffer.byteLength(content, "utf8"),
          });
          continue;
        }
        created = chunker({
          repositoryId: input.repositoryId,
          revision,
          path: ref.path,
          content,
          maxTokens: maxChunkTokens,
        });
        files.push(
          entry(ref.path, {
            contentHash,
            size: Buffer.byteLength(content, "utf8"),
            blobId: ref.blobId,
            mtimeMs: recordableMtime(ref),
            chunkIds: created.map((chunk) => chunk.id),
          }),
        );
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // Unreadable, binary and absent entries are unavailable, not fatal.
      content = undefined;
    }
    if (content === undefined) {
      stats.filesSkipped++;
      continue;
    }
    chunks.push(...created);
    stats.chunksCreated += created.length;
    stats.filesIndexed++;
    if (prior) stats.filesModified++;
    else stats.filesAdded++;
  }
  stats.filesTotal = files.length;
  const kept = new Set(files.map((file) => file.path));
  for (const path of previousFiles.keys())
    if (!kept.has(path)) stats.filesDeleted++;

  const inputHashes = chunks.map(embeddingInputHash);
  const wanted = new Set(inputHashes);
  const retained: Record<string, StoredVector> = {};
  for (const [key, vector] of Object.entries(previous?.vectors ?? {}))
    if (validStoredVector(vector, wanted, maxChunkTokens))
      retained[key] = vector;

  const vectors: Record<string, StoredVector> = {};
  if (embedding) {
    const identity = embeddingDimensionIdentity(embedding);
    const sameSpace = (vector: StoredVector) =>
      vector.provider === embedding.provider &&
      vector.model === embedding.model &&
      vector.version === embedding.version &&
      vector.dimensionIdentity === identity;
    const seeded = new Map<string, StoredVector>();
    for (const vector of input.seedVectors ?? [])
      if (validStoredVector(vector, wanted, maxChunkTokens))
        seeded.set(vector.cacheKey, vector);
    const seenKeys = new Set<string>();
    const missing = new Map<
      string,
      { chunk: ContextChunk; inputHash: string }
    >();
    const fromCheckpoint = new Map<string, StoredVector>();
    chunks.forEach((chunk, position) => {
      const inputHash = inputHashes[position]!;
      const cacheKey = embeddingCacheKeyForHash(
        inputHash,
        embedding,
        maxChunkTokens,
      );
      if (seenKeys.has(cacheKey)) return;
      seenKeys.add(cacheKey);
      const cached = retained[cacheKey];
      const checkpointed = seeded.get(cacheKey);
      if (cached && sameSpace(cached)) {
        stats.vectorsReused++;
      } else if (checkpointed && sameSpace(checkpointed)) {
        delete retained[cacheKey];
        fromCheckpoint.set(cacheKey, checkpointed);
      } else {
        delete retained[cacheKey];
        missing.set(cacheKey, { chunk, inputHash });
      }
    });
    const pending = [...missing.entries()];
    const batchSize = Math.max(1, input.maxEmbeddingBatchSize ?? 32);
    stats.vectorsFromCheckpoint = fromCheckpoint.size;
    stats.embeddingRequestsAvoided =
      Math.ceil((pending.length + fromCheckpoint.size) / batchSize) -
      Math.ceil(pending.length / batchSize);
    if (seeded.size > 0)
      input.onCheckpoint?.(
        fromCheckpoint.size > 0
          ? {
              type: "hit",
              vectors: fromCheckpoint.size,
              requestsAvoided: stats.embeddingRequestsAvoided,
            }
          : { type: "miss", vectors: pending.length },
      );
    const created = new Map<string, StoredVector>();
    const everyBatches = Math.max(
      1,
      input.checkpointEveryBatches ?? DEFAULT_CHECKPOINT_EVERY_BATCHES,
    );
    let unsaved = 0;
    /** Persist all paid work; a failing sink is reported, never thrown. */
    const saveCheckpoint = async () => {
      if (!input.checkpoint || unsaved === 0) return;
      const all = [...fromCheckpoint.values(), ...created.values()];
      try {
        await input.checkpoint.save(all);
        stats.checkpointSaves++;
        unsaved = 0;
        input.onCheckpoint?.({ type: "saved", vectors: all.length });
      } catch {
        stats.checkpointSaveFailures++;
        input.onCheckpoint?.({ type: "save_failed" });
      }
    };
    let batches = 0;
    try {
      for (let offset = 0; offset < pending.length; offset += batchSize) {
        signal?.throwIfAborted();
        const batch = pending.slice(offset, offset + batchSize);
        input.beforeEmbeddingRequest?.();
        // Reservation may itself have observed cancellation; never start a request after it.
        signal?.throwIfAborted();
        const embedded = await embedding.embed(
          batch.map(([, { chunk }]) => normalizedEmbeddingInput(chunk)),
          signal,
        );
        stats.embeddingRequests++;
        input.onEmbeddingRequest?.();
        const dimensions = validateEmbeddingBatch(
          embedded,
          batch.length,
          embedding.dimensions,
        );
        batch.forEach(([cacheKey, { inputHash }], position) => {
          created.set(cacheKey, {
            cacheKey,
            values: embedded[position]!,
            inputHash,
            dimensions,
            provider: embedding.provider,
            model: embedding.model,
            version: embedding.version,
            dimensionIdentity: identity,
            chunkerVersion: CHUNKER_VERSION,
            maxChunkTokens,
          });
        });
        unsaved += batch.length;
        if (++batches % everyBatches === 0) await saveCheckpoint();
      }
    } catch (error) {
      // Provider failure, exhausted budget or cancellation: keep what was paid for.
      await saveCheckpoint();
      throw error;
    }
    stats.vectorsCreated = created.size;
    // Chunk order first, so the persisted record is independent of history.
    for (const position of chunks.keys()) {
      const cacheKey = embeddingCacheKeyForHash(
        inputHashes[position]!,
        embedding,
        maxChunkTokens,
      );
      const vector =
        created.get(cacheKey) ??
        fromCheckpoint.get(cacheKey) ??
        retained[cacheKey];
      if (vector) vectors[cacheKey] = vector;
    }
  }
  // Vectors of other embedding spaces for chunks that still exist stay put.
  for (const [key, vector] of Object.entries(retained))
    if (!(key in vectors)) vectors[key] = vector;
  stats.vectorsPruned = Object.keys(previous?.vectors ?? {}).filter(
    (key) => !(key in vectors),
  ).length;

  const next: RepositoryIndex = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    chunkerVersion: CHUNKER_VERSION,
    policyVersion: POLICY_VERSION,
    repositoryId: input.repositoryId,
    revision,
    maxChunkTokens,
    createdAt: new Date().toISOString(),
    files,
    chunks,
    vectors,
  };
  const validated = parseRepositoryIndex(next);
  if (!validated.ok)
    throw new Error(
      `Refusing to use an invalid repository index (${validated.reason})`,
    );
  return { index: next, stats };
}
