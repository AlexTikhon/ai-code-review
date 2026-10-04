import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prng } from "../src/bench/util.js";
import { embeddingInputHash } from "../src/retrieval/embedding-keys.js";
import { POLICY_VERSION } from "../src/review/types.js";
import {
  CHUNKER_VERSION,
  INDEX_SCHEMA_VERSION,
  type ContextChunk,
  type IndexedFile,
  type RepositoryIndex,
  type StoredVector,
} from "../src/retrieval/types.js";
import {
  VectorStore,
  materializeVector,
  vectorStoreFromStored,
} from "../src/retrieval/vector-store.js";

/** File entries consistent with a hand-built chunk list (one per path, in order). */
export function filesForChunks(chunks: readonly ContextChunk[]): IndexedFile[] {
  const files = new Map<string, IndexedFile>();
  for (const chunk of chunks) {
    const file = files.get(chunk.path);
    if (file) file.chunkIds.push(chunk.id);
    else
      files.set(chunk.path, {
        path: chunk.path,
        contentHash: `fixture-${chunk.path}`,
        size: 0,
        chunkIds: [chunk.id],
      });
  }
  return [...files.values()];
}

/** Plain StoredVectors of an index, in persisted order (a copy; for assertions). */
export function storedVectors(index: RepositoryIndex): StoredVector[] {
  return [...index.vectors.refs()].map((ref) => materializeVector(ref, index));
}

/** The vector stored under `cacheKey` as a plain StoredVector. */
export function storedVector(
  index: RepositoryIndex,
  cacheKey: string,
): StoredVector {
  const ref = index.vectors.locate(cacheKey);
  if (!ref) throw new Error(`no vector for ${cacheKey}`);
  return materializeVector(ref, index);
}

/**
 * A RepositoryIndex from hand-built parts: vectors may be given as plain
 * StoredVectors, and input hashes are derived from the chunks.
 */
export function fixtureIndex(
  parts: Omit<RepositoryIndex, "inputHashes" | "vectors" | "schemaVersion"> & {
    schemaVersion?: number;
    vectors?:
      Iterable<StoredVector> | Record<string, StoredVector> | VectorStore;
  },
): RepositoryIndex {
  const { vectors, schemaVersion: _ignored, ...rest } = parts;
  const stored: Iterable<StoredVector> =
    vectors &&
    !(vectors instanceof VectorStore) &&
    !(Symbol.iterator in vectors)
      ? Object.values(vectors)
      : ((vectors as Iterable<StoredVector> | undefined) ?? []);
  return {
    ...rest,
    schemaVersion: INDEX_SCHEMA_VERSION,
    inputHashes: parts.chunks.map(embeddingInputHash),
    vectors:
      vectors instanceof VectorStore ? vectors : vectorStoreFromStored(stored),
  };
}

/** A schema-2 file as the previous release wrote it: vectors as JSON arrays. */
export function schema2Document(index: RepositoryIndex) {
  return {
    schemaVersion: 2,
    chunkerVersion: index.chunkerVersion,
    policyVersion: index.policyVersion,
    repositoryId: index.repositoryId,
    revision: index.revision,
    maxChunkTokens: index.maxChunkTokens,
    createdAt: index.createdAt,
    files: index.files,
    chunks: index.chunks,
    vectors: Object.fromEntries(
      storedVectors(index).map((vector) => [vector.cacheKey, vector]),
    ),
  };
}

const generationsOf = (manifestPath: string) =>
  `${manifestPath.replace(/\.json$/, "")}.generations`;

/**
 * Edit the metadata JSON of the active generation in place and re-seal the
 * manifest around it, so a test can exercise the metadata schema without also
 * tripping the (separately tested) checksum.
 */
async function rewriteMetadata(
  manifestPath: string,
  mutate: (draft: any) => void,
): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const file = join(generationsOf(manifestPath), manifest.metadataFile);
  const metadata = JSON.parse(await readFile(file, "utf8"));
  mutate(metadata);
  const bytes = Buffer.from(JSON.stringify(metadata));
  await writeFile(file, bytes);
  manifest.metadataBytes = bytes.length;
  manifest.metadataSha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(manifestPath, JSON.stringify(manifest));
}

export { generationsOf, rewriteMetadata };

/** Path of the metadata file the manifest currently names. */
export async function activeMetadataPath(
  manifestPath: string,
): Promise<string> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return join(generationsOf(manifestPath), manifest.metadataFile);
}

/** Every file under `directory` (relative path -> content hash), recursively. */
export async function snapshotFiles(
  directory: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (current: string, prefix: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path, `${prefix}${entry.name}/`);
      else
        result[`${prefix}${entry.name}`] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
    }
  };
  await walk(directory, "").catch(() => undefined);
  return result;
}

export type SyntheticSpace = { provider: string; dimensions: number };

/**
 * A repository index of `count` distinct one-line chunks with deterministic,
 * full-precision vectors: every chunk gets a vector in each space in `spaces`
 * (default: one 8-dimensional space).
 */
export function syntheticIndex(
  options: {
    count?: number;
    revision?: string;
    spaces?: SyntheticSpace[];
    seed?: number;
    salt?: string;
  } = {},
): RepositoryIndex {
  const count = options.count ?? 12;
  const revision = options.revision ?? "rev";
  const spaces = options.spaces ?? [{ provider: "synthetic", dimensions: 8 }];
  const random = prng(options.seed ?? 7);
  const chunks: ContextChunk[] = Array.from({ length: count }, (_, i) => ({
    id: `${revision}-c${i}`,
    repositoryId: "repo",
    revision,
    path: `src/f${i}.ts`,
    language: "typescript",
    kind: "file",
    imports: [],
    startLine: 1,
    endLine: 1,
    content: `export const v${i} = ${i}; // ${options.salt ?? ""}`,
    contentHash: `h${i}`,
    contentComplete: true,
  }));
  const vectors: StoredVector[] = [];
  for (const space of spaces)
    for (const chunk of chunks) {
      const inputHash = embeddingInputHash(chunk);
      vectors.push({
        cacheKey: `${space.provider}-${space.dimensions}-${inputHash}`,
        values: Array.from(
          { length: space.dimensions },
          () => random() * 2 - 1,
        ),
        inputHash,
        dimensions: space.dimensions,
        provider: space.provider,
        model: "m",
        version: "v1",
        dimensionIdentity: String(space.dimensions),
        chunkerVersion: CHUNKER_VERSION,
        maxChunkTokens: 100,
      });
    }
  return fixtureIndex({
    policyVersion: POLICY_VERSION,
    chunkerVersion: CHUNKER_VERSION,
    repositoryId: "repo",
    revision,
    maxChunkTokens: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
    files: filesForChunks(chunks),
    chunks,
    vectors,
  });
}

/** Everything observable about an index, for "is it exactly that one" checks. */
export function indexSignature(index: RepositoryIndex): string {
  return JSON.stringify({
    revision: index.revision,
    chunks: index.chunks.map((chunk) => chunk.id),
    hashes: index.inputHashes,
    vectors: storedVectors(index),
  });
}
