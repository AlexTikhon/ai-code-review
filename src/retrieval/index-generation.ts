import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { EMBEDDING_INPUT_HASH_VERSION } from "./embedding-keys.js";
import {
  parseManifest,
  parsePersistedMetadata,
  persistedMetadataSchema,
  type Manifest,
  type PersistedMetadata,
} from "./index-schema.js";
import { INDEX_SCHEMA_VERSION, type RepositoryIndex } from "./types.js";
import {
  BYTES_PER_VALUE,
  ENCODING_F64LE,
  VECTOR_FORMAT_VERSION,
  VECTOR_HEADER_BYTES,
  decodeVectorHeader,
  encodeVectorHeader,
  float64LittleEndianBytes,
  float64View,
  hostIsLittleEndian,
} from "./vector-format.js";
import {
  VectorStore,
  createSegment,
  type VectorSegment,
} from "./vector-store.js";

/**
 * Generation-based persistence of a RepositoryIndex.
 *
 *   <cache>/repository-index.json                      manifest: the ONLY mutable file
 *   <cache>/repository-index.generations/
 *       index-<generation>.json                        metadata of one generation
 *       vectors-<blobId>.bin                           vector blob (see vector-format.ts)
 *
 * Invariant: the manifest always names one complete, validated generation, and
 * every file a generation names is written under a fresh unique name and is
 * never modified afterwards. Publication writes and fsyncs every generation file
 * under temporary names, renames them into place, and replaces the manifest
 * LAST with one atomic rename. A crash at any earlier point leaves the previous
 * manifest, and so the previous generation, untouched; the new files are
 * unreferenced garbage that no reader looks at. There is no point at which the
 * manifest can name a file that is not fully written, so a reader can never see
 * metadata of one generation with vectors of another. A vector blob is shared by
 * consecutive generations when the vectors did not change (it is immutable, so
 * sharing is safe) and is then not rewritten at all.
 *
 * Obsolete files are removed only after the new manifest is in place, and a
 * cleanup failure never fails the publication.
 */

/** Bytes written per call and per read; keeps single I/O requests bounded. */
const IO_SLICE_BYTES = 64 * 1024 * 1024;
/** Unreferenced files younger than this may belong to a concurrent publisher. */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

export type DurableWriter = {
  write(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

/**
 * Every filesystem effect publication has. The default is Node's fs; tests
 * inject faults here to prove that a failure or crash at each step leaves a
 * complete index behind.
 */
export interface GenerationFileOps {
  mkdir(path: string): Promise<void>;
  /** Exclusive create (never overwrites), owner-only permissions. */
  create(path: string): Promise<DurableWriter>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Entry names; an absent directory is an empty one. */
  list(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  /** Best effort: not every platform can fsync a directory. */
  syncDir(path: string): Promise<void>;
}

export const nodeFileOps: GenerationFileOps = {
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  async create(path) {
    const handle = await open(path, "wx", 0o600);
    return {
      async write(bytes) {
        let written = 0;
        while (written < bytes.byteLength) {
          const { bytesWritten } = await handle.write(
            bytes,
            written,
            Math.min(bytes.byteLength - written, IO_SLICE_BYTES),
          );
          written += bytesWritten;
        }
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  rename,
  remove: (path) => rm(path, { force: true }),
  async list(path) {
    try {
      return await readdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  },
  async stat(path) {
    const { size, mtimeMs } = await stat(path);
    return { size, mtimeMs };
  },
  async syncDir(path) {
    try {
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Directories cannot be fsynced everywhere (notably Windows).
    }
  },
};

export const generationsDir = (manifestPath: string): string =>
  `${manifestPath.replace(/\.json$/, "")}.generations`;

const newId = (): string => randomUUID().replaceAll("-", "");
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** The persisted vector blob an in-memory VectorStore is known to equal. */
export type BlobDescriptor = {
  file: string;
  blobId: string;
  bytes: number;
  sha256: string;
};

/** Files a loaded or published index lives in; used to retire them later. */
export type PersistedRefs = {
  generation: string;
  metadataFile: string;
  vectorsFile?: string;
};

const blobOrigins = new WeakMap<VectorStore, BlobDescriptor>();
const indexOrigins = new WeakMap<RepositoryIndex, PersistedRefs>();

export const persistedRefsOf = (
  index: RepositoryIndex,
): PersistedRefs | undefined => indexOrigins.get(index);

// ---------------------------------------------------------------- publishing

export type PublishInput = {
  manifestPath: string;
  index: RepositoryIndex;
  /** Files of the generation being replaced; they are removed after commit. */
  previous?: PersistedRefs;
  ops?: GenerationFileOps;
  now?: () => number;
};

export type PublishResult = {
  generation: string;
  metadataBytes: number;
  vectorBytes: number;
  vectorCount: number;
  /** The previous vector blob was kept because the vectors did not change. */
  vectorBlobReused: boolean;
  /** Obsolete files removed after commit, and removals that failed. */
  cleanup: { removed: number; failed: number };
};

async function writeWhole(
  ops: GenerationFileOps,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const writer = await ops.create(path);
  try {
    await writer.write(bytes);
    await writer.sync();
  } finally {
    await writer.close();
  }
}

async function writeVectorBlob(
  ops: GenerationFileOps,
  directory: string,
  store: VectorStore,
  /** Told the temporary path before anything is written, so a failure can clean it. */
  onTemporary: (path: string) => void,
): Promise<{ descriptor: BlobDescriptor; temporary: string }> {
  const blobId = newId();
  const file = `vectors-${blobId}.bin`;
  const temporary = join(directory, `${file}.${process.pid}.${newId()}.tmp`);
  onTemporary(temporary);
  let payloadBytes = 0;
  for (const segment of store.segments)
    payloadBytes += segment.vectors.byteLength;
  const header = encodeVectorHeader({
    formatVersion: VECTOR_FORMAT_VERSION,
    encoding: ENCODING_F64LE,
    blobId,
    vectorCount: store.count,
    payloadBytes,
  });
  const hash = createHash("sha256");
  const littleEndianHost = hostIsLittleEndian();
  const valuesPerSlice = IO_SLICE_BYTES / BYTES_PER_VALUE;
  const writer = await ops.create(temporary);
  try {
    hash.update(header);
    await writer.write(header);
    for (const { vectors } of store.segments)
      for (let at = 0; at < vectors.length; at += valuesPerSlice) {
        const bytes = float64LittleEndianBytes(
          vectors.subarray(at, at + valuesPerSlice),
          littleEndianHost,
        );
        hash.update(bytes);
        await writer.write(bytes);
      }
    await writer.sync();
  } finally {
    await writer.close();
  }
  return {
    temporary,
    descriptor: {
      file,
      blobId,
      bytes: VECTOR_HEADER_BYTES + payloadBytes,
      sha256: hash.digest("hex"),
    },
  };
}

function buildMetadata(
  index: RepositoryIndex,
  generation: string,
  blob: BlobDescriptor | undefined,
): PersistedMetadata {
  let offsetBytes = 0;
  const spaces = index.vectors.segments.map((segment) => {
    const described = {
      provider: segment.space.provider,
      model: segment.space.model,
      version: segment.space.version,
      dimensionIdentity: segment.space.dimensionIdentity,
      dimensions: segment.space.dimensions,
      offsetBytes,
      count: segment.count,
      cacheKeys: [...segment.cacheKeys],
      inputHashes: [...segment.inputHashes],
    };
    offsetBytes += segment.vectors.byteLength;
    return described;
  });
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    generation,
    chunkerVersion: index.chunkerVersion,
    policyVersion: index.policyVersion,
    repositoryId: index.repositoryId,
    revision: index.revision,
    maxChunkTokens: index.maxChunkTokens,
    createdAt: index.createdAt,
    inputHashVersion: EMBEDDING_INPUT_HASH_VERSION,
    files: index.files,
    chunks: index.chunks,
    chunkInputHashes: index.inputHashes,
    ...(blob
      ? {
          vectorStore: {
            format: "f64le" as const,
            version: 1 as const,
            file: blob.file,
            blobId: blob.blobId,
            bytes: blob.bytes,
            sha256: blob.sha256,
            count: index.vectors.count,
            spaces,
          },
        }
      : {}),
  };
}

/**
 * Persist `index` as a new generation and make it canonical. Resolves only
 * after the manifest names the new generation; rejects, with the previous
 * generation still canonical, on any earlier failure.
 */
export async function publishIndex(
  input: PublishInput,
): Promise<PublishResult> {
  const { manifestPath, index } = input;
  const ops = input.ops ?? nodeFileOps;
  const now = input.now ?? Date.now;
  const directory = generationsDir(manifestPath);
  const generation = newId();
  const metadataFile = `index-${generation}.json`;
  /** Files this call created; removed again if it does not reach the commit. */
  const created: string[] = [];
  let committed = false;
  try {
    await ops.mkdir(directory);
    await ops.mkdir(dirname(manifestPath));

    // 1. Vector blob: kept when the vectors are unchanged, else written fresh.
    let blob =
      index.vectors.count > 0 ? blobOrigins.get(index.vectors) : undefined;
    let vectorBlobReused = false;
    let pendingBlob:
      { descriptor: BlobDescriptor; temporary: string } | undefined;
    if (blob) {
      const present = await ops.stat(join(directory, blob.file)).then(
        (info) => info.size === blob!.bytes,
        () => false,
      );
      if (present) vectorBlobReused = true;
      else blob = undefined;
    }
    if (!blob && index.vectors.count > 0) {
      pendingBlob = await writeVectorBlob(
        ops,
        directory,
        index.vectors,
        (path) => created.push(path),
      );
      blob = pendingBlob.descriptor;
    }

    // 2. Metadata, validated against the schema readers will apply.
    const metadata = buildMetadata(index, generation, blob);
    const checked = persistedMetadataSchema.safeParse(metadata);
    if (!checked.success)
      throw new Error(
        `Refusing to persist an invalid repository index (${checked.error.issues[0]?.message ?? "unknown"})`,
      );
    const metadataBytes = Buffer.from(JSON.stringify(metadata), "utf8");
    const metadataTemporary = join(
      directory,
      `${metadataFile}.${process.pid}.${newId()}.tmp`,
    );
    created.push(metadataTemporary);
    await writeWhole(ops, metadataTemporary, metadataBytes);

    // 3. Move both into place under their final, unique names.
    if (pendingBlob) {
      const finalBlob = join(directory, pendingBlob.descriptor.file);
      await ops.rename(pendingBlob.temporary, finalBlob);
      created.push(finalBlob);
    }
    const finalMetadata = join(directory, metadataFile);
    await ops.rename(metadataTemporary, finalMetadata);
    created.push(finalMetadata);
    await ops.syncDir(directory);

    // 4. Commit: replace the manifest, atomically and last.
    const manifest: Manifest = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      kind: "repository-index-manifest",
      generation,
      metadataFile,
      metadataBytes: metadataBytes.byteLength,
      metadataSha256: sha256(metadataBytes),
    };
    const manifestTemporary = `${manifestPath}.${process.pid}.${newId()}.tmp`;
    created.push(manifestTemporary);
    await writeWhole(
      ops,
      manifestTemporary,
      Buffer.from(JSON.stringify(manifest)),
    );
    await ops.rename(manifestTemporary, manifestPath);
    committed = true;
    // From here on the new generation is canonical: nothing below may fail the call.
    await ops.syncDir(dirname(manifestPath)).catch(() => undefined);

    if (blob) blobOrigins.set(index.vectors, blob);
    const refs: PersistedRefs = {
      generation,
      metadataFile,
      ...(blob ? { vectorsFile: blob.file } : {}),
    };
    indexOrigins.set(index, refs);

    // 5. Retire what the new manifest no longer names; failures are counted.
    const cleanup = await cleanupGenerations({
      manifestPath,
      ops,
      keep: new Set([metadataFile, ...(blob ? [blob.file] : [])]),
      obsolete: new Set(
        [input.previous?.metadataFile, input.previous?.vectorsFile].filter(
          (name): name is string => name !== undefined,
        ),
      ),
      now: now(),
    });
    return {
      generation,
      metadataBytes: metadataBytes.byteLength,
      vectorBytes: blob?.bytes ?? 0,
      vectorCount: index.vectors.count,
      vectorBlobReused,
      cleanup,
    };
  } catch (error) {
    if (!committed)
      for (const path of created) await ops.remove(path).catch(() => undefined);
    throw error;
  }
}

const GENERATION_FILE =
  /^(?:index-[0-9a-f]{32}\.json|vectors-[0-9a-f]{32}\.bin)$/;

/**
 * Best-effort removal of files the manifest no longer reaches: files of the
 * generation just replaced, and unreferenced leftovers (a crashed publisher's
 * files) once old enough that no live publisher can still own them. Never
 * touches `keep`, and never throws.
 */
export async function cleanupGenerations(input: {
  manifestPath: string;
  ops: GenerationFileOps;
  keep: ReadonlySet<string>;
  obsolete: ReadonlySet<string>;
  now: number;
}): Promise<{ removed: number; failed: number }> {
  const { ops, manifestPath, keep, obsolete, now } = input;
  const result = { removed: 0, failed: 0 };
  const sweep = async (
    directory: string,
    eligible: (name: string) => boolean,
  ) => {
    let names: string[];
    try {
      names = await ops.list(directory);
    } catch {
      result.failed++;
      return;
    }
    for (const name of names) {
      if (keep.has(name) || !eligible(name)) continue;
      const path = join(directory, name);
      try {
        if (!obsolete.has(name)) {
          const { mtimeMs } = await ops.stat(path);
          if (now - mtimeMs < ORPHAN_GRACE_MS) continue;
        }
        await ops.remove(path);
        result.removed++;
      } catch {
        result.failed++;
      }
    }
  };
  await sweep(
    generationsDir(manifestPath),
    (name) => GENERATION_FILE.test(name) || name.endsWith(".tmp"),
  );
  const manifestName = basename(manifestPath);
  await sweep(
    dirname(manifestPath),
    (name) => name.startsWith(`${manifestName}.`) && name.endsWith(".tmp"),
  );
  return result;
}

// ------------------------------------------------------------------- reading

export type LoadInfo = {
  generation: string;
  metadataBytes: number;
  vectorBytes: number;
  vectorCount: number;
  /** Every vector segment is a view of the buffer the file was read into. */
  zeroCopy: boolean;
};

export type GenerationRead =
  | { status: "valid"; index: RepositoryIndex; info: LoadInfo }
  | { status: "corrupt"; reason: string; fileMissing?: boolean }
  | { status: "incompatible"; reason: string }
  | { status: "stale"; reason: string };

const errorCode = (error: unknown) =>
  (error as NodeJS.ErrnoException).code ?? "unknown error";

async function readWholeFile(
  path: string,
  expectedBytes: number,
): Promise<
  | { ok: true; buffer: Buffer }
  | { ok: false; reason: string; fileMissing?: boolean }
> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { ok: false, reason: "file is missing", fileMissing: true }
      : { ok: false, reason: `file is unreadable (${errorCode(error)})` };
  }
  try {
    const { size } = await handle.stat();
    if (size !== expectedBytes)
      return {
        ok: false,
        reason: `file is ${size} bytes, expected ${expectedBytes}`,
      };
    // One allocation that the vector views will alias; 8-aligned by construction.
    const buffer = Buffer.allocUnsafeSlow(size);
    for (let read = 0; read < size;) {
      const { bytesRead } = await handle.read(
        buffer,
        read,
        Math.min(size - read, IO_SLICE_BYTES),
        read,
      );
      if (bytesRead === 0)
        return { ok: false, reason: "file ended before its recorded size" };
      read += bytesRead;
    }
    return { ok: true, buffer };
  } catch (error) {
    return { ok: false, reason: `file is unreadable (${errorCode(error)})` };
  } finally {
    await handle.close();
  }
}

function hashInSlices(buffer: Buffer): string {
  const hash = createHash("sha256");
  for (let at = 0; at < buffer.length; at += IO_SLICE_BYTES)
    hash.update(buffer.subarray(at, at + IO_SLICE_BYTES));
  return hash.digest("hex");
}

type BlobLoad =
  | { ok: true; store: VectorStore; zeroCopy: boolean }
  | { ok: false; reason: string; fileMissing?: boolean };

/**
 * Read a vector blob into one buffer and expose each embedding space as a
 * Float64Array over that same memory. Everything is validated before any vector
 * is accepted: size, header, checksum, span layout, and finiteness (the norm
 * pass inside createSegment).
 */
async function loadVectorBlob(
  directory: string,
  descriptor: NonNullable<PersistedMetadata["vectorStore"]>,
  littleEndianHost: boolean,
): Promise<BlobLoad> {
  const read = await readWholeFile(
    join(directory, descriptor.file),
    descriptor.bytes,
  );
  if (!read.ok)
    return {
      ok: false,
      reason: `vector ${read.reason}`,
      ...(read.fileMissing ? { fileMissing: true } : {}),
    };
  const { buffer } = read;
  const header = decodeVectorHeader(buffer);
  if (!header.ok) return { ok: false, reason: header.reason };
  if (header.header.blobId !== descriptor.blobId)
    return { ok: false, reason: "vector file belongs to another generation" };
  if (
    header.header.vectorCount !== descriptor.count ||
    header.header.payloadBytes !== descriptor.bytes - VECTOR_HEADER_BYTES
  )
    return { ok: false, reason: "vector file header disagrees with metadata" };
  if (hashInSlices(buffer) !== descriptor.sha256)
    return { ok: false, reason: "vector file checksum mismatch" };
  try {
    let zeroCopy = true;
    const segments: VectorSegment[] = descriptor.spaces.map((space) => {
      const { view, zeroCopy: aliased } = float64View(
        buffer,
        VECTOR_HEADER_BYTES + space.offsetBytes,
        space.count * space.dimensions,
        littleEndianHost,
      );
      zeroCopy &&= aliased;
      return createSegment(
        {
          provider: space.provider,
          model: space.model,
          version: space.version,
          dimensionIdentity: space.dimensionIdentity,
          dimensions: space.dimensions,
        },
        space.cacheKeys,
        space.inputHashes,
        view,
      );
    });
    const store = new VectorStore(segments);
    blobOrigins.set(store, {
      file: descriptor.file,
      blobId: descriptor.blobId,
      bytes: descriptor.bytes,
      sha256: descriptor.sha256,
    });
    return { ok: true, store, zeroCopy };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/**
 * Load the generation `manifest` names. `accept` may veto the generation from
 * its metadata alone, so an index that cannot be reused never costs a read of
 * its vectors.
 */
export async function readGeneration(
  manifestPath: string,
  manifest: Manifest,
  options: {
    accept?: (
      metadata: PersistedMetadata,
    ) => { status: "incompatible" | "stale"; reason: string } | undefined;
  } = {},
): Promise<GenerationRead> {
  const directory = generationsDir(manifestPath);
  const metadataFile = await readWholeFile(
    join(directory, manifest.metadataFile),
    manifest.metadataBytes,
  );
  if (!metadataFile.ok)
    return {
      status: "corrupt",
      reason: `metadata ${metadataFile.reason}`,
      ...(metadataFile.fileMissing ? { fileMissing: true } : {}),
    };
  if (sha256(metadataFile.buffer) !== manifest.metadataSha256)
    return { status: "corrupt", reason: "metadata checksum mismatch" };
  let raw: unknown;
  try {
    raw = JSON.parse(metadataFile.buffer.toString("utf8"));
  } catch {
    return { status: "corrupt", reason: "metadata is not valid JSON" };
  }
  const parsed = parsePersistedMetadata(raw);
  if (!parsed.ok) return { status: "corrupt", reason: parsed.reason };
  const metadata = parsed.value;
  if (
    metadata.generation !== manifest.generation ||
    manifest.metadataFile !== `index-${metadata.generation}.json`
  )
    return {
      status: "corrupt",
      reason: "metadata belongs to a different generation than the manifest",
    };
  if (metadata.inputHashVersion !== EMBEDDING_INPUT_HASH_VERSION)
    return {
      status: "incompatible",
      reason: `embedding input hash version ${metadata.inputHashVersion} != ${EMBEDDING_INPUT_HASH_VERSION}`,
    };
  const veto = options.accept?.(metadata);
  if (veto) return veto;

  let vectors = VectorStore.empty();
  let zeroCopy = true;
  if (metadata.vectorStore) {
    const blob = await loadVectorBlob(
      directory,
      metadata.vectorStore,
      hostIsLittleEndian(),
    );
    if (!blob.ok)
      return {
        status: "corrupt",
        reason: blob.reason,
        ...(blob.fileMissing ? { fileMissing: true } : {}),
      };
    vectors = blob.store;
    zeroCopy = blob.zeroCopy;
  }
  const index: RepositoryIndex = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    chunkerVersion: metadata.chunkerVersion,
    policyVersion: metadata.policyVersion,
    repositoryId: metadata.repositoryId,
    revision: metadata.revision,
    maxChunkTokens: metadata.maxChunkTokens,
    createdAt: metadata.createdAt,
    files: metadata.files,
    chunks: metadata.chunks,
    inputHashes: metadata.chunkInputHashes,
    vectors,
  };
  indexOrigins.set(index, {
    generation: metadata.generation,
    metadataFile: manifest.metadataFile,
    ...(metadata.vectorStore ? { vectorsFile: metadata.vectorStore.file } : {}),
  });
  return {
    status: "valid",
    index,
    info: {
      generation: metadata.generation,
      metadataBytes: manifest.metadataBytes,
      vectorBytes: metadata.vectorStore?.bytes ?? 0,
      vectorCount: vectors.count,
      zeroCopy,
    },
  };
}

export { parseManifest };
