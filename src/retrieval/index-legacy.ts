import { vectorSchema } from "./index-schema.js";
import type { StoredVector } from "./types.js";

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
