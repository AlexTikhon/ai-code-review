import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelResult, ModelRequest } from "../model/types.js";
import { POLICY_VERSION, PROMPT_VERSION } from "../review/types.js";
export function reviewCacheKey(request: ModelRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        request,
        promptVersion: PROMPT_VERSION,
        schemaVersion: "review-v2",
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
    return JSON.parse(
      await readFile(join(root, cacheDir, "reviews", `${key}.json`), "utf8"),
    ) as ModelResult;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}
export async function writeReviewCache(
  root: string,
  cacheDir: string,
  key: string,
  value: ModelResult,
): Promise<void> {
  const path = join(root, cacheDir, "reviews", `${key}.json`);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}
