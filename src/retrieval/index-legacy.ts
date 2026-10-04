import { z } from "zod";
import { embeddingInputHash } from "./embedding-keys.js";
import {
  chunkSchema,
  fileSchema,
  indexStructureIssues,
  vectorSchema,
  type ParseResult,
} from "./index-schema.js";
import {
  INDEX_SCHEMA_VERSION,
  type RepositoryIndex,
  type StoredVector,
} from "./types.js";
import { VectorStoreBuilder } from "./vector-store.js";

/**
 * Schema 1 -> 2 is deliberately NOT a whole-index migration.
 *
 * Schema 2 added `policyVersion` (the privacy policy the files were admitted
 * under) and a per-file table (whole-file content hash, size, blob id). A
 * schema-1 index records neither, and neither can be derived from what it does
 * hold: the policy under which its files were admitted is unknown, and chunks
 * are fragments that cannot reproduce a whole-file hash. Inventing them would
 * make an old, possibly differently-filtered index look validated under the
 * current privacy policy. So a schema-1 index is never reused as an index.
 *
 * Its vectors, however, are self-describing: each carries the hash of the exact
 * embedding input plus provider, model, version, dimensions and chunker
 * identity, and the cache-key derivation is unchanged. Whether one may be
 * reused is decided later, per chunk of the freshly built index, by the same
 * checks as for any stored vector. Salvaging them therefore preserves paid
 * work without trusting anything about the old index's structure or policy.
 */
export function salvageSchemaV1Vectors(raw: unknown): StoredVector[] {
  const vectors = (raw as { vectors?: unknown } | null)?.vectors;
  if (!vectors || typeof vectors !== "object" || Array.isArray(vectors))
    return [];
  const kept: StoredVector[] = [];
  for (const [key, candidate] of Object.entries(vectors)) {
    const parsed = vectorSchema.safeParse(candidate);
    if (parsed.success && parsed.data.cacheKey === key) kept.push(parsed.data);
  }
  return kept;
}

/**
 * Schema 2 -> 3 IS a whole-index migration, because nothing is missing: schema 2
 * already holds the policy version, the file table, the chunks and every vector
 * with its identity. Only the representation changes (JSON number arrays ->
 * packed binary), and the one derived field schema 3 adds, the per-chunk
 * embedding input hash, is recomputed from the chunk text it describes. No
 * provider is involved and no vector value is altered: JSON.parse yields the
 * exact doubles the file was written from, and they are copied bit-for-bit.
 *
 * The migrated index is held in memory only. refreshRepositoryIndex writes it
 * out as a schema-3 generation and replaces the manifest last, so the schema-2
 * file stays the canonical index until the new generation is complete.
 */
export const legacyIndexSchema = z
  .object({
    schemaVersion: z.literal(2),
    chunkerVersion: z.string().min(1),
    policyVersion: z.string().min(1),
    repositoryId: z.string().min(1),
    revision: z.string().min(1),
    maxChunkTokens: z.number().int().positive(),
    createdAt: z.string(),
    files: z.array(fileSchema),
    chunks: z.array(chunkSchema),
    vectors: z.record(vectorSchema),
  })
  .superRefine((index, context) => {
    for (const issue of indexStructureIssues(index))
      context.addIssue({ code: z.ZodIssueCode.custom, ...issue });
    for (const [key, vector] of Object.entries(index.vectors))
      if (vector.cacheKey !== key)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["vectors", key],
          message: "vector key differs from its cacheKey",
        });
  });

export function migrateSchemaV2(raw: unknown): ParseResult<RepositoryIndex> {
  const parsed = legacyIndexSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: issue
        ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
        : "invalid repository index",
    };
  }
  const legacy = parsed.data;
  const builder = new VectorStoreBuilder();
  for (const vector of Object.values(legacy.vectors))
    // A vector made under another chunker or chunk budget is never found by
    // any lookup (its cache key encodes both), so it is not carried over.
    if (
      vector.chunkerVersion === legacy.chunkerVersion &&
      vector.maxChunkTokens === legacy.maxChunkTokens
    )
      builder.addStored(vector);
  let vectors;
  try {
    vectors = builder.build();
  } catch (error) {
    // e.g. a norm that overflows: the file is unusable, not an empty index.
    return { ok: false, reason: (error as Error).message };
  }
  return {
    ok: true,
    value: {
      schemaVersion: INDEX_SCHEMA_VERSION,
      chunkerVersion: legacy.chunkerVersion,
      policyVersion: legacy.policyVersion,
      repositoryId: legacy.repositoryId,
      revision: legacy.revision,
      maxChunkTokens: legacy.maxChunkTokens,
      createdAt: legacy.createdAt,
      files: legacy.files,
      chunks: legacy.chunks,
      inputHashes: legacy.chunks.map(embeddingInputHash),
      vectors,
    },
  };
}
