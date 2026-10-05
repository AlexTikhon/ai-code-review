import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../cache/atomic-write.js";
import { assertSafeCachePath, cacheDirectory } from "../cache/paths.js";
import { vectorSchema } from "./index-schema.js";
import type { StoredVector } from "./types.js";

/** Version of the checkpoint file layout, independent of the index schema. */
export const CHECKPOINT_SCHEMA_VERSION = 1;

export function checkpointPath(root: string, cacheDirName: string): string {
  return join(cacheDirectory(root, cacheDirName), "embedding-checkpoint.json");
}

/**
 * Auxiliary store of completed, paid-for embedding vectors from a run that did
 * not finish. It is never a RepositoryIndex and is never read by retrieval:
 * the canonical index stays atomic and complete, and a checkpoint only lets the
 * next run skip provider calls it would otherwise repeat.
 *
 * Entries are self-describing StoredVectors (content hash, provider, model,
 * version, dimensions, chunker identity). Reuse is decided by the same
 * cache-key and identity checks as vectors from the index, so a checkpoint
 * cannot make an incompatible vector look valid. It holds hashes and numbers,
 * never source text and never credentials.
 */
export interface EmbeddingCheckpointStore {
  load(): Promise<CheckpointLoad>;
  /** Replace the checkpoint atomically with exactly these vectors. */
  save(vectors: readonly StoredVector[]): Promise<void>;
  clear(): Promise<void>;
}

export type CheckpointLoad =
  | { status: "missing" }
  | { status: "valid"; vectors: StoredVector[] }
  | { status: "corrupt"; reason: string }
  | { status: "incompatible"; reason: string };

/** Value-free progress notes: counts and reasons only, never vectors or text. */
export type CheckpointEvent =
  | { type: "loaded"; vectors: number }
  | { type: "hit"; vectors: number; requestsAvoided: number }
  | { type: "miss"; vectors: number }
  | { type: "saved"; vectors: number }
  | { type: "save_failed" }
  | { type: "discarded"; reason: string }
  | { type: "cleared" };

const checkpointSchema = z
  .object({
    schemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
    vectors: z.record(vectorSchema),
  })
  .superRefine((checkpoint, context) => {
    for (const [key, vector] of Object.entries(checkpoint.vectors))
      if (vector.cacheKey !== key)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["vectors", key],
          message: "vector key differs from its cacheKey",
        });
  });

export class FileEmbeddingCheckpointStore implements EmbeddingCheckpointStore {
  constructor(private readonly path: string) {}

  async load(): Promise<CheckpointLoad> {
    let text: string;
    try {
      await assertSafeCachePath(this.path);
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { status: "missing" };
      return {
        status: "corrupt",
        reason: `checkpoint file is unreadable (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
      };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { status: "corrupt", reason: "checkpoint file is not valid JSON" };
    }
    const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (Number.isInteger(version) && version !== CHECKPOINT_SCHEMA_VERSION)
      return {
        status: "incompatible",
        reason: `checkpoint schema version ${String(version)} != ${CHECKPOINT_SCHEMA_VERSION}`,
      };
    const parsed = checkpointSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        status: "corrupt",
        reason: issue
          ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
          : "invalid checkpoint",
      };
    }
    return { status: "valid", vectors: Object.values(parsed.data.vectors) };
  }

  async save(vectors: readonly StoredVector[]): Promise<void> {
    await writeFileAtomic(
      this.path,
      JSON.stringify({
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        vectors: Object.fromEntries(
          vectors.map((vector) => [vector.cacheKey, vector]),
        ),
      }),
    );
  }

  async clear(): Promise<void> {
    await assertSafeCachePath(this.path);
    await rm(this.path, { force: true });
  }
}
