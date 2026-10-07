import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FileEmbeddingCheckpointStore,
  checkpointPath,
  type CheckpointEvent,
  type EmbeddingCheckpointStore,
} from "../src/retrieval/embedding-checkpoint.js";
import {
  indexPath,
  refreshRepositoryIndex,
} from "../src/retrieval/index-store.js";
import type { StoredVector } from "../src/retrieval/types.js";
import type { ReviewEvent } from "../src/observability/events.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import {
  cleanResult,
  makeSource,
  request,
  sourceFile,
  testConfig,
} from "./fixtures.js";
import { unitTest } from "./helpers.js";
import { storedVector, storedVectors } from "./index-fixtures.js";
import {
  indexOptions,
  probedEmbedding,
  put,
  repo,
  sources,
} from "./index-harness.js";

const BATCH = 4;
const exists = (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  );

/**
 * A repository whose canonical index holds 8 files (16 chunks), plus 40 files
 * not yet indexed. Each file yields two chunks, so a resumed run needs 80 new
 * vectors: 20 batches of BATCH.
 */
async function scenario() {
  const root = await repo(sources(8));
  const first = probedEmbedding();
  await refreshRepositoryIndex(
    await indexOptions(root, {
      embedding: first.adapter,
      maxEmbeddingBatchSize: BATCH,
    }),
  );
  for (const [path, text] of Object.entries(sources(40, 8)))
    await put(root, path, text);
  return {
    root,
    canonical: indexPath(root, ".cache"),
    checkpoint: checkpointPath(root, ".cache"),
  };
}
const readCheckpoint = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as {
    schemaVersion: number;
    vectors: Record<string, StoredVector>;
  };

unitTest(
  "a provider failure keeps the old index and checkpoints the paid vectors",
  async () => {
    const { root, canonical, checkpoint } = await scenario();
    const before = await readFile(canonical, "utf8");
    const failing = probedEmbedding();
    failing.state.failAt = 7;
    await assert.rejects(
      refreshRepositoryIndex(
        await indexOptions(root, {
          embedding: failing.adapter,
          maxEmbeddingBatchSize: BATCH,
        }),
      ),
      /unclassified error/,
    );
    assert.equal(failing.state.requests, 7);
    assert.equal(
      await readFile(canonical, "utf8"),
      before,
      "the last complete index is untouched",
    );
    const saved = await readCheckpoint(checkpoint);
    assert.equal(Object.keys(saved.vectors).length, 6 * BATCH);
  },
);

unitTest(
  "a resumed run reuses checkpointed vectors and requests only the rest",
  async () => {
    const { root, canonical, checkpoint } = await scenario();
    const failing = probedEmbedding();
    failing.state.failAt = 7;
    await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: failing.adapter,
        maxEmbeddingBatchSize: BATCH,
      }),
    ).catch(() => undefined);

    const resumed = probedEmbedding();
    let reserved = 0;
    const result = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: resumed.adapter,
        maxEmbeddingBatchSize: BATCH,
        beforeEmbeddingRequest: () => reserved++,
      }),
    );
    // 80 new vectors: 24 from the checkpoint, 56 requested in 14 calls.
    assert.equal(result.stats.vectorsFromCheckpoint, 24);
    assert.equal(result.stats.vectorsCreated, 56);
    assert.equal(resumed.state.texts, 56);
    assert.equal(resumed.state.requests, 14);
    assert.equal(reserved, 14, "checkpointed vectors consume no budget");
    assert.equal(result.stats.embeddingRequestsAvoided, 6);
    assert.equal(result.index.vectors.count, 96);
    assert.equal(
      await exists(checkpoint),
      false,
      "obsolete checkpoint removed after publication",
    );
    assert.equal(await exists(canonical), true);

    // The outcome is identical to an uninterrupted build.
    const fresh = await repo(sources(48));
    const direct = await refreshRepositoryIndex(
      await indexOptions(fresh, {
        embedding: probedEmbedding().adapter,
        maxEmbeddingBatchSize: BATCH,
      }),
    );
    assert.deepEqual(
      result.index.vectors.keys().sort(),
      direct.index.vectors.keys().sort(),
    );
    for (const vector of storedVectors(direct.index))
      assert.deepEqual(
        storedVector(result.index, vector.cacheKey).values,
        vector.values,
      );
  },
);

unitTest(
  "cancellation after partial progress leaves the old index and reusable work",
  async () => {
    const { root, canonical, checkpoint } = await scenario();
    const before = await readFile(canonical, "utf8");
    const controller = new AbortController();
    const cancelled = probedEmbedding();
    cancelled.state.afterRequest = (n) => {
      if (n === 3) controller.abort();
    };
    await assert.rejects(
      refreshRepositoryIndex(
        await indexOptions(root, {
          embedding: cancelled.adapter,
          maxEmbeddingBatchSize: BATCH,
          signal: controller.signal,
        }),
      ),
    );
    assert.equal(cancelled.state.requests, 3, "no request starts after abort");
    assert.equal(await readFile(canonical, "utf8"), before);
    assert.equal(
      Object.keys((await readCheckpoint(checkpoint)).vectors).length,
      3 * BATCH,
    );
    const resumed = probedEmbedding();
    const result = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: resumed.adapter,
        maxEmbeddingBatchSize: BATCH,
      }),
    );
    assert.equal(result.stats.vectorsFromCheckpoint, 12);
    assert.equal(resumed.state.texts, 68);
  },
);

unitTest(
  "a failed final write keeps every paid vector, and a retry costs nothing",
  async () => {
    const { root, canonical, checkpoint } = await scenario();
    // A directory where the index file belongs makes the atomic rename fail.
    await rm(canonical);
    await mkdir(canonical);
    const writing = probedEmbedding();
    await assert.rejects(
      refreshRepositoryIndex(
        await indexOptions(root, {
          embedding: writing.adapter,
          maxEmbeddingBatchSize: BATCH,
        }),
      ),
    );
    assert.equal(writing.state.texts, 96, "everything was embedded once");
    assert.equal(
      Object.keys((await readCheckpoint(checkpoint)).vectors).length,
      96,
    );
    await rm(canonical, { recursive: true });
    const retry = probedEmbedding();
    let reserved = 0;
    const result = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: retry.adapter,
        maxEmbeddingBatchSize: BATCH,
        beforeEmbeddingRequest: () => reserved++,
      }),
    );
    assert.equal(retry.state.requests, 0);
    assert.equal(reserved, 0);
    assert.equal(result.stats.vectorsFromCheckpoint, 96);
    assert.equal(await exists(checkpoint), false);
    assert.equal(result.index.vectors.count, 96);
  },
);

unitTest(
  "checkpoints are written in batches of work, not after every vector",
  async () => {
    const { root } = await scenario();
    const real = new FileEmbeddingCheckpointStore(
      checkpointPath(root, ".cache"),
    );
    const sizes: number[] = [];
    const store: EmbeddingCheckpointStore = {
      load: () => real.load(),
      clear: () => real.clear(),
      async save(vectors) {
        sizes.push(vectors.length);
        await real.save(vectors);
      },
    };
    const result = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: probedEmbedding().adapter,
        maxEmbeddingBatchSize: BATCH,
        checkpointStore: store,
        checkpointEveryBatches: 4,
      }),
    );
    // 20 batches -> saved after every 4th (5 writes), not after each of 20.
    assert.deepEqual(sizes, [16, 32, 48, 64, 80]);
    assert.equal(result.stats.checkpointSaves, 5);
  },
);

unitTest(
  "interrupted flushes still leave the last periodic checkpoint",
  async () => {
    const { root, checkpoint } = await scenario();
    const real = new FileEmbeddingCheckpointStore(
      checkpointPath(root, ".cache"),
    );
    let saves = 0;
    const store: EmbeddingCheckpointStore = {
      load: () => real.load(),
      clear: () => real.clear(),
      async save(vectors) {
        // The failure-time flush never lands, as if the process were killed.
        if (++saves === 2) throw new Error("killed during flush");
        await real.save(vectors);
      },
    };
    const failing = probedEmbedding();
    failing.state.failAt = 7;
    await assert.rejects(
      refreshRepositoryIndex(
        await indexOptions(root, {
          embedding: failing.adapter,
          maxEmbeddingBatchSize: BATCH,
          checkpointStore: store,
          checkpointEveryBatches: 4,
        }),
      ),
      /unclassified error/,
      "the provider error is reported, not the checkpoint error",
    );
    assert.equal(
      Object.keys((await readCheckpoint(checkpoint)).vectors).length,
      16,
    );
  },
);

unitTest(
  "a checkpoint write failure never fails an otherwise good run",
  async () => {
    const { root, canonical, checkpoint } = await scenario();
    await mkdir(checkpoint, { recursive: true });
    const events: CheckpointEvent[] = [];
    const result = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: probedEmbedding().adapter,
        maxEmbeddingBatchSize: BATCH,
        checkpointEveryBatches: 2,
        onCheckpoint: (event) => events.push(event),
      }),
    );
    assert.equal(result.index.vectors.count, 96);
    assert.ok(result.stats.checkpointSaveFailures > 0);
    assert.ok(events.some((event) => event.type === "save_failed"));
    assert.equal(await exists(canonical), true);
  },
);

unitTest(
  "a corrupt or incompatible checkpoint is ignored and rebuilt",
  async () => {
    for (const contents of [
      "not json {",
      JSON.stringify({ schemaVersion: 99, vectors: {} }),
      JSON.stringify({ schemaVersion: 1, vectors: { k: { cacheKey: "z" } } }),
      JSON.stringify(["unexpected"]),
    ]) {
      const { root, checkpoint } = await scenario();
      await writeFile(checkpoint, contents);
      const diagnostics: string[] = [];
      const events: CheckpointEvent[] = [];
      const embedding = probedEmbedding();
      const result = await refreshRepositoryIndex(
        await indexOptions(root, {
          embedding: embedding.adapter,
          maxEmbeddingBatchSize: BATCH,
          onDiagnostic: (message) => diagnostics.push(message),
          onCheckpoint: (event) => events.push(event),
        }),
      );
      assert.equal(result.stats.vectorsFromCheckpoint, 0, contents);
      assert.equal(embedding.state.texts, 80);
      assert.ok(diagnostics.some((message) => /checkpoint/i.test(message)));
      assert.ok(events.some((event) => event.type === "discarded"));
      assert.ok(!diagnostics.join(" ").includes("cacheKey"));
      assert.equal(await exists(checkpoint), false, "replaced after success");
    }
  },
);

unitTest(
  "stale checkpoint entries for removed chunks are ignored, not published",
  async () => {
    const { root, checkpoint } = await scenario();
    const failing = probedEmbedding();
    failing.state.failAt = 7;
    await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: failing.adapter,
        maxEmbeddingBatchSize: BATCH,
      }),
    ).catch(() => undefined);
    const saved = Object.values((await readCheckpoint(checkpoint)).vectors);
    assert.equal(saved.length, 24);
    // Delete every new file: all 24 checkpointed chunks no longer exist.
    for (const path of Object.keys(sources(40, 8))) await rm(join(root, path));
    const embedding = probedEmbedding();
    const result = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: embedding.adapter,
        maxEmbeddingBatchSize: BATCH,
      }),
    );
    assert.equal(embedding.state.requests, 0);
    assert.equal(result.stats.vectorsFromCheckpoint, 0);
    const published = new Set(result.index.vectors.keys());
    for (const vector of saved)
      assert.ok(!published.has(vector.cacheKey), "stale vector leaked");
    assert.equal(published.size, 16);
  },
);

unitTest(
  "a changed chunk is re-embedded, unchanged ones are reused",
  async () => {
    const { root } = await scenario();
    const failing = probedEmbedding();
    failing.state.failAt = 7;
    await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: failing.adapter,
        maxEmbeddingBatchSize: BATCH,
      }),
    ).catch(() => undefined);
    // m10 is in the first (checkpointed) batch; edit it after the failure.
    await put(
      root,
      "src/m10.ts",
      "export function work10() { return 'edited'; }\n",
    );
    const embedding = probedEmbedding();
    const result = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: embedding.adapter,
        maxEmbeddingBatchSize: BATCH,
      }),
    );
    // Only the symbol chunk of m10 changed; its empty residual file chunk is identical.
    assert.equal(result.stats.vectorsFromCheckpoint, 23);
    assert.equal(embedding.state.texts, 57, "56 remaining + 1 edited chunk");
  },
);

unitTest(
  "a renamed file is embedded under its new path, never reusing the old vector",
  async () => {
    const { root, checkpoint } = await scenario();
    const failing = probedEmbedding();
    failing.state.failAt = 7;
    await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: failing.adapter,
        maxEmbeddingBatchSize: BATCH,
      }),
    ).catch(() => undefined);
    const before = Object.keys((await readCheckpoint(checkpoint)).vectors);
    // The embedding input includes the path, so identical text elsewhere is a
    // different input and its checkpointed vector must not be reused.
    await rm(join(root, "src/m10.ts"));
    await put(
      root,
      "src/renamed.ts",
      "export function work10() { return 10; }\n",
    );
    const embedding = probedEmbedding();
    const result = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: embedding.adapter,
        maxEmbeddingBatchSize: BATCH,
      }),
    );
    assert.equal(result.stats.vectorsFromCheckpoint, before.length - 2);
    assert.equal(embedding.state.texts, 80 - (before.length - 2));
  },
);

unitTest(
  "vectors from another provider, model, version or dimension setting are never reused",
  async () => {
    const identities = [
      { provider: "other-provider" },
      { model: "other-model" },
      { version: "v2" },
      { dimensions: undefined },
    ];
    for (const identity of identities) {
      const { root } = await scenario();
      const failing = probedEmbedding();
      failing.state.failAt = 7;
      await refreshRepositoryIndex(
        await indexOptions(root, {
          embedding: failing.adapter,
          maxEmbeddingBatchSize: BATCH,
        }),
      ).catch(() => undefined);
      const other = probedEmbedding(identity);
      const result = await refreshRepositoryIndex(
        await indexOptions(root, {
          embedding: other.adapter,
          maxEmbeddingBatchSize: BATCH,
        }),
      );
      const label = JSON.stringify(identity);
      assert.equal(result.stats.vectorsFromCheckpoint, 0, label);
      assert.equal(other.state.texts, 96, label);
    }
  },
);

unitTest(
  "a changed chunk budget does not reuse checkpointed vectors",
  async () => {
    const { root } = await scenario();
    const failing = probedEmbedding();
    failing.state.failAt = 7;
    await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: failing.adapter,
        maxEmbeddingBatchSize: BATCH,
      }),
    ).catch(() => undefined);
    const result = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: probedEmbedding().adapter,
        maxEmbeddingBatchSize: BATCH,
        maxChunkTokens: 60,
      }),
    );
    assert.equal(result.stats.vectorsFromCheckpoint, 0);
  },
);

unitTest(
  "without embedding authorization nothing is requested, loaded or removed",
  async () => {
    const { root, checkpoint } = await scenario();
    const failing = probedEmbedding();
    failing.state.failAt = 7;
    await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: failing.adapter,
        maxEmbeddingBatchSize: BATCH,
      }),
    ).catch(() => undefined);
    const before = await readFile(checkpoint, "utf8");
    const result = await refreshRepositoryIndex(await indexOptions(root));
    assert.equal(result.stats.embeddingRequests, 0);
    assert.equal(result.stats.vectorsFromCheckpoint, 0);
    assert.equal(await readFile(checkpoint, "utf8"), before);
  },
);

unitTest(
  "the checkpoint holds hashes and vectors only: no source text, no secrets",
  async () => {
    const root = await repo({
      "a.ts": "export const CANARY_SOURCE_TEXT = 'sk-canary-secret';\n",
      "b.ts": "export const b = 2;\n",
    });
    const failing = probedEmbedding();
    failing.state.failAt = 2;
    await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: failing.adapter,
        maxEmbeddingBatchSize: 1,
      }),
    ).catch(() => undefined);
    const text = await readFile(checkpointPath(root, ".cache"), "utf8");
    assert.ok(!text.includes("CANARY_SOURCE_TEXT"));
    assert.ok(!text.includes("sk-canary-secret"));
    const parsed = JSON.parse(text) as {
      vectors: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(Object.keys(parsed).sort(), ["schemaVersion", "vectors"]);
    for (const vector of Object.values(parsed.vectors))
      assert.deepEqual(Object.keys(vector).sort(), [
        "cacheKey",
        "chunkerVersion",
        "dimensionIdentity",
        "dimensions",
        "inputHash",
        "maxChunkTokens",
        "model",
        "provider",
        "values",
        "version",
      ]);
  },
);

unitTest(
  "a successful run with nothing to resume leaves no checkpoint",
  async () => {
    const root = await repo(sources(10));
    await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: probedEmbedding().adapter,
        maxEmbeddingBatchSize: 2,
        checkpointEveryBatches: 2,
      }),
    );
    assert.equal(await exists(checkpointPath(root, ".cache")), false);
  },
);

unitTest(
  "a malformed embedding response mid-run keeps the earlier paid batches",
  async () => {
    const { root, canonical, checkpoint } = await scenario();
    const before = await readFile(canonical, "utf8");
    const good = probedEmbedding();
    let call = 0;
    const adapter = {
      ...good.adapter,
      async embed(texts: string[], signal?: AbortSignal) {
        const vectors = await good.adapter.embed(texts, signal);
        return ++call === 5 ? vectors.slice(1) : vectors; // wrong count
      },
    };
    await assert.rejects(
      refreshRepositoryIndex(
        await indexOptions(root, {
          embedding: adapter,
          maxEmbeddingBatchSize: BATCH,
        }),
      ),
      /does not match request count/,
    );
    assert.equal(await readFile(canonical, "utf8"), before);
    assert.equal(
      Object.keys((await readCheckpoint(checkpoint)).vectors).length,
      4 * BATCH,
    );
  },
);

unitTest(
  "an exhausted request budget mid-index checkpoints and then resumes",
  async () => {
    const { root, checkpoint } = await scenario();
    let reserved = 0;
    await assert.rejects(
      refreshRepositoryIndex(
        await indexOptions(root, {
          embedding: probedEmbedding().adapter,
          maxEmbeddingBatchSize: BATCH,
          beforeEmbeddingRequest: () => {
            if (++reserved > 5) throw new Error("budget exhausted");
          },
        }),
      ),
      /budget exhausted/,
    );
    assert.equal(
      Object.keys((await readCheckpoint(checkpoint)).vectors).length,
      5 * BATCH,
    );
  },
);

const hybridRun = (
  root: string,
  embedding: ReturnType<typeof probedEmbedding>["adapter"],
  events: ReviewEvent[],
  dryRun = false,
) =>
  executeReviewPipeline(
    { ...request, contextMode: "hybrid", dryRun },
    testConfig,
    {
      model: { provider: "test", review: async () => cleanResult() },
      embedding,
      source: makeSource([sourceFile("app.ts", "@@ -0,0 +1 @@\n+work1()")], {
        repositoryRoot: root,
      }),
      events: (event) => events.push(event),
    },
  );

unitTest(
  "the pipeline reports checkpoint progress and resumes with fewer requests",
  async () => {
    const root = await repo(sources(40));
    const checkpoint = checkpointPath(root, ".cache");
    const events: ReviewEvent[] = [];
    const failing = probedEmbedding();
    failing.state.failAt = 3;
    const first = await hybridRun(root, failing.adapter, events);
    // 80 vectors in batches of 32: two paid batches, the third fails.
    assert.equal(first.usage.embeddingRequests, 3);
    assert.equal(first.context.state, "unavailable");
    assert.equal(first.errors[0]?.stage, "index");
    assert.equal(
      Object.keys((await readCheckpoint(checkpoint)).vectors).length,
      64,
    );
    assert.equal(
      events.find((e) => e.message === "checkpoint_saved")?.data?.vectors,
      64,
    );

    events.length = 0;
    const resumed = probedEmbedding();
    const second = await hybridRun(root, resumed.adapter, events);
    assert.equal(second.context.state, "used");
    assert.equal(resumed.state.texts > 16, true, "16 chunk vectors + query");
    const index = events.find(
      (e) => e.stage === "index" && e.type === "complete",
    );
    assert.equal(index?.data?.vectorsFromCheckpoint, 64);
    assert.equal(index?.data?.vectorsCreated, 16);
    assert.equal(index?.data?.embeddingRequestsAvoided, 2);
    assert.ok(events.some((e) => e.message === "checkpoint_loaded"));
    assert.ok(events.some((e) => e.message === "checkpoint_hit"));
    assert.ok(events.some((e) => e.message === "checkpoint_cleared"));
    // One index request for the 16 missing vectors, plus the query embedding.
    assert.equal(second.usage.embeddingRequests, 2);
    assert.equal(await exists(checkpoint), false);
    const text = JSON.stringify(events);
    assert.ok(!text.includes('"values"'), "vectors are never logged");
  },
);

unitTest("a dry run neither embeds nor disturbs a checkpoint", async () => {
  const root = await repo(sources(40));
  const checkpoint = checkpointPath(root, ".cache");
  const failing = probedEmbedding();
  failing.state.failAt = 3;
  await hybridRun(root, failing.adapter, []);
  const before = await readFile(checkpoint, "utf8");
  const probe = probedEmbedding();
  const result = await hybridRun(root, probe.adapter, [], true);
  assert.equal(probe.state.requests, 0);
  assert.equal(result.usage.embeddingRequests, 0);
  assert.equal(await readFile(checkpoint, "utf8"), before);
});
