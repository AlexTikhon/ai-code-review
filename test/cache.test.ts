import assert from "node:assert/strict";
import { readReviewCache, reviewCacheKey } from "../src/cache/review-cache.js";
import { unitTest } from "./helpers.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const identity = { provider: "test", identity: "contract-v1" };
unitTest(
  "review cache keys vary with patch, context, metadata and model configuration",
  () => {
    const base = {
      system: "prompt-v2",
      user: "metadata\npatch-a\ncontext-a",
      model: "gpt-4o-mini",
      maxOutputTokens: 100,
    };
    const key = reviewCacheKey(base, identity);
    assert.notEqual(
      reviewCacheKey(
        { ...base, user: "metadata\npatch-b\ncontext-a" },
        identity,
      ),
      key,
    );
    assert.notEqual(
      reviewCacheKey(
        { ...base, user: "other metadata\npatch-a\ncontext-a" },
        identity,
      ),
      key,
    );
    assert.notEqual(
      reviewCacheKey(
        { ...base, user: "metadata\npatch-a\ncontext-b" },
        identity,
      ),
      key,
    );
    assert.notEqual(
      reviewCacheKey({ ...base, model: "another-model" }, identity),
      key,
    );
    assert.notEqual(
      reviewCacheKey({ ...base, maxOutputTokens: 101 }, identity),
      key,
    );
  },
);

unitTest("malformed cached model responses are ignored", async () => {
  const root = await mkdtemp(join(tmpdir(), "acr-review-cache-"));
  const key = "malformed";
  const directory = join(root, ".cache", "reviews");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${key}.json`),
    JSON.stringify({
      response: { findings: "not-an-array" },
      usage: { inputTokens: -1, outputTokens: 0, actual: true },
    }),
  );
  assert.equal(await readReviewCache(root, ".cache", key), undefined);
});
