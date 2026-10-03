import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ModelIdentity,
  ModelRequest,
  ModelResult,
} from "../model/types.js";
import { reviewResponseSchema } from "../schemas/review.schema.js";
import { z } from "zod";
import { POLICY_VERSION, PROMPT_VERSION } from "../review/types.js";
import { writeFileAtomic } from "./atomic-write.js";

/**
 * Cache identity = exact request + the provider contract that answers it.
 * `request.model` is only a provider-local model name; two providers can share
 * a name, so provider and contract identity are part of the key.
 */
export function reviewCacheKey(
  request: ModelRequest,
  model: ModelIdentity,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        request,
        provider: model.provider,
        providerIdentity: model.identity ?? null,
        promptVersion: PROMPT_VERSION,
        schemaVersion: "review-v3",
        policyVersion: POLICY_VERSION,
      }),
    )
    .digest("hex");
}
export async function readReviewCache(
  root: string,
  cacheDir: string,
  key: string,
): Promise<ModelResult | undefined> {
  try {
    const parsed = z
      .object({
        response: reviewResponseSchema,
        usage: z.object({
          inputTokens: z.number().nonnegative().finite(),
          outputTokens: z.number().nonnegative().finite(),
          actual: z.boolean(),
        }),
      })
      .safeParse(
        JSON.parse(
          await readFile(
            join(root, cacheDir, "reviews", `${key}.json`),
            "utf8",
          ),
        ),
      );
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Missing, unreadable, or malformed entries are plain cache misses.
    return undefined;
  }
}
export async function writeReviewCache(
  root: string,
  cacheDir: string,
  key: string,
  value: ModelResult,
): Promise<void> {
  await writeFileAtomic(
    join(root, cacheDir, "reviews", `${key}.json`),
    JSON.stringify(value),
  );
}
