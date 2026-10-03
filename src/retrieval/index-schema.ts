import { z } from "zod";
import type { RepositoryIndex } from "./types.js";

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

const vectorSchema = z
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

/**
 * Runtime contract for the persisted JSON. Unknown shapes are rejected rather
 * than trusted, so a damaged cache file can never reach retrieval code.
 */
export const repositoryIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    chunkerVersion: nonEmpty,
    repositoryId: nonEmpty,
    revision: nonEmpty,
    maxChunkTokens: z.number().int().positive(),
    createdAt: z.string(),
    chunks: z.array(chunkSchema),
    vectors: z.record(vectorSchema),
  })
  .superRefine((index, context) => {
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
