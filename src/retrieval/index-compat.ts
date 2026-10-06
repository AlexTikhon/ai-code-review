import { rebindChunkRepository } from "./chunker.js";
import type { RepositoryIndex } from "./types.js";

/** What the current run needs from a persisted index before it may reuse it. */
export type IndexRequirements = {
  repositoryId?: string;
  chunkerVersion?: string;
  maxChunkTokens?: number;
  policyVersion?: string;
};

export type IndexCompatibility =
  { kind: "reusable" } | { kind: "incompatible"; reason: string };

/**
 * A structurally valid index is reusable only if it was produced by the same
 * chunking algorithm, chunk budget, privacy policy and repository. Anything
 * else would carry chunks the current code would not have made. A different
 * revision or embedding identity is deliberately not here: files are reconciled
 * individually, and vectors are matched by their own embedding identity.
 */
export function assessIndexCompatibility(
  index: Pick<
    RepositoryIndex,
    "chunkerVersion" | "maxChunkTokens" | "policyVersion" | "repositoryId"
  >,
  required: IndexRequirements,
): IndexCompatibility {
  if (
    required.chunkerVersion !== undefined &&
    index.chunkerVersion !== required.chunkerVersion
  )
    return {
      kind: "incompatible",
      reason: `chunker version ${index.chunkerVersion} != ${required.chunkerVersion}`,
    };
  if (
    required.maxChunkTokens !== undefined &&
    index.maxChunkTokens !== required.maxChunkTokens
  )
    return {
      kind: "incompatible",
      reason: `max chunk tokens ${index.maxChunkTokens} != ${required.maxChunkTokens}`,
    };
  if (
    required.policyVersion !== undefined &&
    index.policyVersion !== required.policyVersion
  )
    return {
      kind: "incompatible",
      reason: `privacy policy version ${index.policyVersion} != ${required.policyVersion}`,
    };
  if (
    required.repositoryId !== undefined &&
    index.repositoryId !== required.repositoryId
  )
    return { kind: "incompatible", reason: "repository identity differs" };
  return { kind: "reusable" };
}

/**
 * Before the context index had its own identity, a pull-request review stored
 * the review source's `owner/repo` (lowercased) as the index's repository id,
 * while a local review stored a SHA-256 of the checkout path. Only the former
 * shape was ever a source-scoped identity: GitHub owner and repository names
 * cannot contain "/" and are never 64 hex digits, so the shapes cannot collide.
 */
export function isSourceScopedRepositoryId(id: string): boolean {
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(id);
}

/**
 * Re-label an index that was built from this checkout's own bytes under a
 * source-scoped identity. Nothing but the identity changes: file entries,
 * content hashes, input hashes and vectors carry over untouched (the vector
 * store is the same object, so its persisted blob is reused), and only the
 * identity-derived chunk ids are recomputed. No provider is involved.
 *
 * The caller is responsible for knowing the index belongs to this checkout:
 * the persisted index lives in a cache namespace derived from the checkout path.
 */
export function adoptRepositoryIdentity(
  index: RepositoryIndex,
  repositoryId: string,
): RepositoryIndex {
  const ids = new Map<string, string>();
  const chunks = index.chunks.map((chunk) => {
    const adopted = rebindChunkRepository(chunk, repositoryId);
    ids.set(chunk.id, adopted.id);
    return adopted;
  });
  return {
    ...index,
    repositoryId,
    chunks,
    files: index.files.map((file) => ({
      ...file,
      chunkIds: file.chunkIds.map((id) => ids.get(id) ?? id),
    })),
  };
}
