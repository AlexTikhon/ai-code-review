import { z } from "zod";
import { BYTES_PER_VALUE, VECTOR_HEADER_BYTES } from "./vector-format.js";
import { INDEX_SCHEMA_VERSION, type RepositoryIndex } from "./types.js";

const nonEmpty = z.string().min(1);
const hex32 = z.string().regex(/^[0-9a-f]{32}$/, "expected 32 hex digits");
const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 hex digits");
const nonNegativeInt = z.number().int().nonnegative();
const finiteNumberArray = z.custom<number[]>(
  (value) =>
    Array.isArray(value) &&
    value.every((item) => typeof item === "number" && Number.isFinite(item)),
  "vector values must be finite numbers",
);

export const chunkSchema = z
  .object({
    id: nonEmpty,
    repositoryId: nonEmpty,
    revision: nonEmpty,
    path: nonEmpty,
    language: z.enum(["typescript", "javascript", "fallback"]),
    kind: z.enum(["symbol", "file"]),
    name: z.string().optional(),
    signature: z.string().optional(),
    imports: z.array(z.string()),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    content: z.string(),
    contentHash: nonEmpty,
    contentComplete: z.boolean(),
    omissionReason: z.string().optional(),
  })
  .refine((chunk) => chunk.endLine >= chunk.startLine, "endLine < startLine");

/** One vector as JSON: the checkpoint file and schema-1/2 index files. */
export const vectorSchema = z
  .object({
    cacheKey: nonEmpty,
    values: finiteNumberArray,
    inputHash: nonEmpty,
    dimensions: z.number().int().positive(),
    provider: nonEmpty,
    model: nonEmpty,
    version: nonEmpty,
    dimensionIdentity: nonEmpty,
    chunkerVersion: nonEmpty,
    maxChunkTokens: z.number().int().positive(),
  })
  .refine(
    (vector) => vector.values.length === vector.dimensions,
    "vector length does not match declared dimensions",
  );

export const fileSchema = z.object({
  path: nonEmpty,
  contentHash: nonEmpty,
  size: z.number().int().nonnegative(),
  blobId: nonEmpty.optional(),
  mtimeMs: z.number().finite().optional(),
  chunkIds: z.array(nonEmpty),
});

type Issue = { path: (string | number)[]; message: string };

/**
 * The cross-field rules shared by every index layout: each chunk belongs to
 * exactly one file entry, so a reused file can never resurrect chunks of another
 * path or leave ownerless chunks behind, and every chunk carries the index's own
 * repository and revision.
 */
export function indexStructureIssues(index: {
  repositoryId: string;
  revision: string;
  files: ReadonlyArray<{ path: string; chunkIds: readonly string[] }>;
  chunks: ReadonlyArray<{
    id: string;
    path: string;
    repositoryId: string;
    revision: string;
  }>;
}): Issue[] {
  const issues: Issue[] = [];
  const chunksById = new Map(index.chunks.map((chunk) => [chunk.id, chunk]));
  const seenPaths = new Set<string>();
  let owned = 0;
  index.files.forEach((file, position) => {
    if (seenPaths.has(file.path))
      issues.push({
        path: ["files", position, "path"],
        message: "duplicate file path",
      });
    seenPaths.add(file.path);
    owned += file.chunkIds.length;
    for (const id of file.chunkIds)
      if (chunksById.get(id)?.path !== file.path)
        issues.push({
          path: ["files", position, "chunkIds"],
          message:
            "file references a chunk that is missing or has another path",
        });
  });
  if (owned !== index.chunks.length)
    issues.push({
      path: ["files"],
      message: "chunks and file entries disagree",
    });
  const mismatched = index.chunks.findIndex(
    (chunk) =>
      chunk.repositoryId !== index.repositoryId ||
      chunk.revision !== index.revision,
  );
  if (mismatched >= 0)
    issues.push({
      path: ["chunks", mismatched],
      message: "chunk identity differs from index repository/revision",
    });
  return issues;
}

const addIssues = (context: z.RefinementCtx, issues: Issue[]) => {
  for (const issue of issues)
    context.addIssue({ code: z.ZodIssueCode.custom, ...issue });
};

/** Layout of one embedding space inside the vector blob. */
const spaceSchema = z
  .object({
    provider: nonEmpty,
    model: nonEmpty,
    version: nonEmpty,
    dimensionIdentity: nonEmpty,
    dimensions: z.number().int().positive(),
    /** First byte of this space, relative to the start of the payload. */
    offsetBytes: nonNegativeInt,
    count: z.number().int().positive(),
    /** Row `r` of this space is the vector with cacheKeys[r] / inputHashes[r]. */
    cacheKeys: z.array(nonEmpty),
    inputHashes: z.array(nonEmpty),
  })
  .refine(
    (space) =>
      space.cacheKeys.length === space.count &&
      space.inputHashes.length === space.count,
    "space vector count disagrees with its keys and hashes",
  );

export const VECTOR_FILE_PATTERN = /^vectors-[0-9a-f]{32}\.bin$/;
export const METADATA_FILE_PATTERN = /^index-[0-9a-f]{32}\.json$/;

const vectorStoreSchema = z
  .object({
    format: z.literal("f64le"),
    version: z.literal(1),
    /** Bare file name inside the generations directory; never a path. */
    file: z.string().regex(VECTOR_FILE_PATTERN, "invalid vector file name"),
    /** Must equal the id in the blob's own header. */
    blobId: hex32,
    /** Whole file: header plus payload. */
    bytes: nonNegativeInt,
    /** SHA-256 of the whole file; an integrity check, not authentication. */
    sha256: hex64,
    count: z.number().int().positive(),
    spaces: z.array(spaceSchema).min(1),
  })
  .superRefine((store, context) => {
    let expected = 0;
    let total = 0;
    const seen = new Set<string>();
    store.spaces.forEach((space, position) => {
      const at = ["vectorStore", "spaces", position];
      if (space.offsetBytes < expected)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...at, "offsetBytes"],
          message: "vector spans overlap",
        });
      else if (space.offsetBytes > expected)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...at, "offsetBytes"],
          message: "vector spans leave a gap",
        });
      expected =
        Math.max(expected, space.offsetBytes) +
        space.count * space.dimensions * BYTES_PER_VALUE;
      total += space.count;
      const identity = JSON.stringify([
        space.provider,
        space.model,
        space.version,
        space.dimensionIdentity,
        space.dimensions,
      ]);
      if (seen.has(identity))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: at,
          message: "duplicate embedding space",
        });
      seen.add(identity);
    });
    if (total !== store.count)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["vectorStore", "count"],
        message: "vector count differs from the sum over spaces",
      });
    if (store.bytes !== VECTOR_HEADER_BYTES + expected)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["vectorStore", "bytes"],
        message: "vector file size does not match its spans",
      });
  });

/**
 * Runtime contract for the metadata JSON of one generation: everything about
 * the index except the numbers. Unknown shapes are rejected rather than
 * trusted, so a damaged cache file can never reach retrieval code.
 */
export const persistedMetadataSchema = z
  .object({
    schemaVersion: z.literal(INDEX_SCHEMA_VERSION),
    generation: hex32,
    chunkerVersion: nonEmpty,
    policyVersion: nonEmpty,
    repositoryId: nonEmpty,
    revision: nonEmpty,
    maxChunkTokens: z.number().int().positive(),
    createdAt: z.string(),
    /** How chunkInputHashes were derived; see EMBEDDING_INPUT_HASH_VERSION. */
    inputHashVersion: nonEmpty,
    files: z.array(fileSchema),
    chunks: z.array(chunkSchema),
    /** chunkInputHashes[i] is the embedding input hash of chunks[i]. */
    chunkInputHashes: z.array(hex64),
    vectorStore: vectorStoreSchema.optional(),
  })
  .superRefine((index, context) => {
    addIssues(context, indexStructureIssues(index));
    if (index.chunkInputHashes.length !== index.chunks.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chunkInputHashes"],
        message: "one input hash per chunk is required",
      });
  });

export type PersistedMetadata = z.infer<typeof persistedMetadataSchema>;

/**
 * The only mutable file of an index. It names one complete generation; readers
 * follow it and never look for newer files by themselves.
 */
export const manifestSchema = z.object({
  schemaVersion: z.literal(INDEX_SCHEMA_VERSION),
  kind: z.literal("repository-index-manifest"),
  generation: hex32,
  metadataFile: z
    .string()
    .regex(METADATA_FILE_PATTERN, "invalid metadata file name"),
  metadataBytes: nonNegativeInt,
  metadataSha256: hex64,
});

export type Manifest = z.infer<typeof manifestSchema>;

export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; reason: string };

function parseWith<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  raw: unknown,
): ParseResult<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    reason: issue
      ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
      : "invalid repository index",
  };
}

/** The reason never echoes values. */
export const parsePersistedMetadata = (raw: unknown) =>
  parseWith(persistedMetadataSchema, raw);
export const parseManifest = (raw: unknown) => parseWith(manifestSchema, raw);

const fileChunkShape = z.object({
  files: z.array(fileSchema),
  chunks: z.array(chunkSchema),
});

/**
 * Check a freshly built runtime index before it is used or persisted: chunk and
 * file shapes, their cross-links, and one input hash per chunk. Returns the
 * first problem, or undefined. Vector contents were validated when the store
 * was packed.
 */
export function validateRepositoryIndex(
  index: RepositoryIndex,
): string | undefined {
  const shape = fileChunkShape.safeParse(index);
  if (!shape.success) {
    const issue = shape.error.issues[0]!;
    return `${issue.path.join(".") || "(root)"}: ${issue.message}`;
  }
  const [issue] = indexStructureIssues(index);
  if (issue) return `${issue.path.join(".")}: ${issue.message}`;
  if (index.inputHashes.length !== index.chunks.length)
    return "inputHashes: one input hash per chunk is required";
  return undefined;
}
