import assert from "node:assert/strict";
import { reviewCacheKey } from "../src/cache/review-cache.js";
import { unitTest } from "./helpers.js";
unitTest(
  "review cache keys vary with patch, context, metadata and model configuration",
  () => {
    const base = {
      system: "prompt-v2",
      user: "metadata\npatch-a\ncontext-a",
      model: "gpt-4o-mini",
      maxOutputTokens: 100,
    };
    const key = reviewCacheKey(base);
    assert.notEqual(
      reviewCacheKey({ ...base, user: "metadata\npatch-b\ncontext-a" }),
      key,
    );
    assert.notEqual(
      reviewCacheKey({ ...base, user: "other metadata\npatch-a\ncontext-a" }),
      key,
    );
    assert.notEqual(
      reviewCacheKey({ ...base, user: "metadata\npatch-a\ncontext-b" }),
      key,
    );
    assert.notEqual(reviewCacheKey({ ...base, model: "another-model" }), key);
    assert.notEqual(reviewCacheKey({ ...base, maxOutputTokens: 101 }), key);
  },
);
