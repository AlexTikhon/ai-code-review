import { z } from "zod";
import { INDEX_SCHEMA_VERSION, type RepositoryIndex } from "./types.js";

const nonEmpty = z.string().min(1);
const finiteNumberArray = z.custom<number[]>(
  (value) =>
    Array.isArray(value) &&
    value.every((item) => typeof item === "number" && Number.isFinite(item)),
  "vector values must be finite numbers",
);

const chunkSchema = z
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

const fileSchema = z.object({
  path: nonEmpty,
  contentHash: nonEmpty,
  size: z.number().int().nonnegative(),
  blobId: nonEmpty.optional(),
  mtimeMs: z.number().finite().optional(),
  chunkIds: z.array(nonEmpty),
});

/**
 * Runtime contract for the persisted JSON. Unknown shapes are rejected rather
 * than trusted, so a damaged cache file can never reach retrieval code.
 */
export const repositoryIndexSchema = z
  .object({
    schemaVersion: z.literal(INDEX_SCHEMA_VERSION),
    chunkerVersion: nonEmpty,
    policyVersion: nonEmpty,
    repositoryId: nonEmpty,
    revision: nonEmpty,
    maxChunkTokens: z.number().int().positive(),
    createdAt: z.string(),
    files: z.array(fileSchema),
    chunks: z.array(chunkSchema),
    vectors: z.record(vectorSchema),
  })
  .superRefine((index, context) => {
    // Every chunk must belong to exactly one file entry, so a reused file can
    // never resurrect chunks of another path or leave ownerless chunks behind.
    const chunksById = new Map(index.chunks.map((chunk) => [chunk.id, chunk]));
    const seenPaths = new Set<string>();
    let owned = 0;
    index.files.forEach((file, position) => {
      if (seenPaths.has(file.path))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", position, "path"],
          message: "duplicate file path",
        });
      seenPaths.add(file.path);
      owned += file.chunkIds.length;
      for (const id of file.chunkIds)
        if (chunksById.get(id)?.path !== file.path)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["files", position, "chunkIds"],
            message:
              "file references a chunk that is missing or has another path",
          });
    });
    if (owned !== index.chunks.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files"],
        message: "chunks and file entries disagree",
      });
    const mismatched = index.chunks.findIndex(
      (chunk) =>
        chunk.repositoryId !== index.repositoryId ||
        chunk.revision !== index.revision,
    );
    if (mismatched >= 0)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chunks", mismatched],
        message: "chunk identity differs from index repository/revision",
      });
    for (const [key, vector] of Object.entries(index.vectors))
      if (vector.cacheKey !== key)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["vectors", key],
          message: "vector key differs from its cacheKey",
        });
  });

export type IndexParseResult =
  { ok: true; index: RepositoryIndex } | { ok: false; reason: string };

/** Parse unknown data into a RepositoryIndex; the reason never echoes values. */
export function parseRepositoryIndex(raw: unknown): IndexParseResult {
  const parsed = repositoryIndexSchema.safeParse(raw);
  if (parsed.success) return { ok: true, index: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    reason: issue
      ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
      : "invalid repository index",
  };
}
