import { z } from "zod";
import { SourceError } from "../errors.js";

/**
 * Only the GitHub fields this application depends on. A 2xx status says nothing
 * about the body, so every response is validated before the pipeline sees it.
 */
// A revision is passed to Git later, so it must never look like an option.
const revision = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/);

export const pullRequestSchema = z.object({
  title: z.string(),
  body: z.string().nullish(),
  changed_files: z.number().int().nonnegative(),
  base: z.object({ sha: revision }),
  head: z.object({ sha: revision }),
});
export type PullRequestResponse = z.infer<typeof pullRequestSchema>;

const count = z.number().int().nonnegative();
export const pullRequestFileSchema = z.object({
  filename: z.string().min(1),
  status: z.string().min(1),
  additions: count,
  deletions: count,
  changes: count,
  patch: z.string().optional(),
  previous_filename: z.string().min(1).optional(),
});
export type PullRequestFile = z.infer<typeof pullRequestFileSchema>;

export const contentsSchema = z.object({
  encoding: z.string(),
  content: z.string(),
});

export function invalidGithubResponse(
  label: string,
  detail?: string,
): SourceError {
  return new SourceError({
    kind: "invalid_response",
    source: "github",
    message: `GitHub ${label} response was not in the expected format`,
    ...(detail ? { code: detail } : {}),
  });
}

/** Validate a provider payload; a mismatch is `invalid_response`, never a later TypeError. */
export function parseGithubResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // Schema paths are fixed names and indexes: safe to expose, unlike the values.
  throw invalidGithubResponse(
    label,
    result.error.issues[0]?.path.join(".") || undefined,
  );
}
