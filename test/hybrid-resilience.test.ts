import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ReviewModelError } from "../src/model/errors.js";
import type { ModelRequest, ReviewModel } from "../src/model/types.js";
import type { ReviewEvent } from "../src/observability/events.js";
import { checkpointPath } from "../src/retrieval/embedding-checkpoint.js";
import type { EmbeddingAdapter } from "../src/retrieval/embeddings.js";
import { indexPath, readIndex } from "../src/retrieval/index-store.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import type { ReviewResult } from "../src/review/types.js";
import {
  networkReset,
  scriptedEmbedding,
  unauthorized,
} from "./embedding-fakes.js";
import {
  cleanResult,
  findingResult,
  makeSource,
  request,
  sourceFile,
  testConfig,
} from "./fixtures.js";
import { unitTest } from "./helpers.js";
import { put, repo, sources } from "./index-harness.js";

const hybridConfig = (maxRequests: number, extra = {}) => ({
  ...testConfig,
  maxRequests,
  embeddingRetry: { maxAttempts: 3, baseDelayMs: 0 },
  ...extra,
});

/** A review model that records every attempt and the prompts it was shown. */
function countingModel(
  respond: (call: number) => ReturnType<ReviewModel["review"]> = async () =>
    cleanResult(),
) {
  const state = { calls: 0, users: [] as string[] };
  const model: ReviewModel = {
    provider: "test",
    async review(request: ModelRequest) {
      state.calls++;
      state.users.push(request.user);
      return respond(state.calls);
    },
  };
  return { model, state };
}

const WORK1_BODY = "return 1;"; // only in the indexed chunk, never in the diff

const run = (
  root: string,
  input: {
    embedding?: EmbeddingAdapter;
    model?: ReviewModel;
    config?: ReturnType<typeof hybridConfig>;
    dryRun?: boolean;
    snapshotId?: string;
    files?: string[];
    events?: ReviewEvent[];
  },
) =>
  executeReviewPipeline(
    { ...request, contextMode: "hybrid", dryRun: input.dryRun ?? false },
    input.config ?? hybridConfig(10),
    {
      model: input.model,
      embedding: input.embedding,
      events: (event) => input.events?.push(event),
      embeddingExecution: { sleep: async () => undefined },
      source: makeSource(
        (input.files ?? ["app.ts"]).map((name) =>
          sourceFile(name, "@@ -0,0 +1 @@\n+work1()"),
        ),
        { repositoryRoot: root, snapshotId: input.snapshotId ?? "snap" },
      ),
    },
  );

const degradedReasons = (result: ReviewResult) =>
  (result.context.degradations ?? []).map((d) => `${d.stage}:${d.reason}`);

/* ---- 1. protect the baseline model request ---- */

unitTest(
  "cold hybrid with maxRequests=1 makes zero embedding calls and one model call",
  async () => {
    const root = await repo(sources(4));
    const embedding = scriptedEmbedding();
    const { model, state } = countingModel();
    const result = await run(root, {
      embedding: embedding.adapter,
      model,
      config: hybridConfig(1),
    });
    assert.equal(embedding.state.attempts, 0, "no embedding call is started");
    assert.equal(state.calls, 1, "the model review is not starved");
    assert.equal(result.usage.embeddingRequests, 0);
    assert.equal(result.usage.actualRequests, 1);
    assert.equal(result.coverage.reviewed, 1);
    assert.equal(result.context.state, "degraded");
    assert.equal(result.status, "partial", "never a full hybrid success");
    assert.deepEqual(degradedReasons(result), ["index:embedding_withheld"]);
    assert.ok(
      state.users[0]!.includes(WORK1_BODY),
      "lexical evidence reaches the model",
    );
    const index = await readIndex(indexPath(root, ".cache"));
    assert.equal(index.status, "valid", "the lexical index is reusable");
  },
);

unitTest(
  "maxRequests=2 for one segment spends at most the one spare request on embeddings",
  async () => {
    const root = await repo(sources(4));
    const embedding = scriptedEmbedding();
    const { model, state } = countingModel();
    const result = await run(root, {
      embedding: embedding.adapter,
      model,
      config: hybridConfig(2),
    });
    assert.equal(state.calls, 1);
    assert.equal(embedding.state.attempts, 1, "the index batch only");
    assert.equal(result.usage.actualRequests, 2);
    assert.equal(result.context.state, "degraded");
    assert.deepEqual(degradedReasons(result), ["retrieve:embedding_withheld"]);
    assert.ok(state.users[0]!.includes(WORK1_BODY));
  },
);

unitTest(
  "an adequate allowance indexes, embeds the query and reviews without degradation",
  async () => {
    const root = await repo(sources(4));
    const embedding = scriptedEmbedding();
    const { model, state } = countingModel();
    const result = await run(root, {
      embedding: embedding.adapter,
      model,
      config: hybridConfig(3),
    });
    assert.equal(embedding.state.attempts, 2, "one index batch + one query");
    assert.equal(state.calls, 1);
    assert.equal(result.usage.actualRequests, 3);
    assert.equal(result.context.state, "used");
    assert.equal(result.status, "complete");
    assert.deepEqual(result.context.degradations ?? [], []);
    assert.deepEqual(result.errors, []);
  },
);

/* ---- 2. provider failures degrade instead of blocking the review ---- */

for (const [label, failure, code] of [
  ["authentication", unauthorized, "EMBEDDING_AUTHENTICATION"],
  ["network", networkReset, "EMBEDDING_NETWORK"],
] as const)
  unitTest(
    `a query-embedding ${label} failure still sends lexical evidence to the model and reports degradation`,
    async () => {
      const root = await repo(sources(4));
      // Attempt 1 is the index batch; attempt 2 onwards is the query.
      const embedding = scriptedEmbedding({
        2: failure(),
        3: failure(),
        4: failure(),
      });
      const { model, state } = countingModel();
      const result = await run(root, {
        embedding: embedding.adapter,
        model,
        config: hybridConfig(10),
      });
      assert.equal(state.calls, 1, "the model reviews with lexical context");
      assert.ok(state.users[0]!.includes(WORK1_BODY));
      assert.equal(result.coverage.reviewed, 1);
      assert.equal(result.context.state, "degraded");
      assert.equal(result.status, "partial");
      assert.ok(result.context.selected.length > 0);
      assert.ok(
        result.context.selected.every((c) =>
          c.reasons.every((r) => !r.startsWith("semantic")),
        ),
        "no semantic score is claimed",
      );
      const error = result.errors.find((e) => e.code === code);
      assert.ok(error, JSON.stringify(result.errors));
      assert.equal(error.stage, "retrieve");
      assert.equal(error.fatal, false);
      assert.equal(error.provider, "fake");
      assert.deepEqual(degradedReasons(result), ["retrieve:embedding_failed"]);
      assert.equal(
        result.usage.embeddingRequests,
        embedding.state.attempts,
        "every attempt, retries included, is counted",
      );
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes('"values"'));
    },
  );

unitTest(
  "a mid-index failure reviews with lexical context and leaves a valid canonical index",
  async () => {
    const root = await repo(sources(5));
    const canonical = indexPath(root, ".cache");
    const seed = await run(root, {
      embedding: scriptedEmbedding().adapter,
      model: countingModel().model,
      config: hybridConfig(50),
    });
    assert.equal(seed.context.state, "used");
    const seeded = await readIndex(canonical);
    assert.equal(seeded.status === "valid" && seeded.index.vectors.count, 10);
    for (const [path, text] of Object.entries(sources(50, 5)))
      await put(root, path, text);

    // The pipeline embeds in batches of 32: attempt 1 succeeds, 2 fails for good.
    const failing = scriptedEmbedding({ 2: unauthorized() });
    const { model, state } = countingModel();
    const result = await run(root, {
      embedding: failing.adapter,
      model,
      config: hybridConfig(50),
      snapshotId: "snap-2",
    });
    assert.equal(failing.state.attempts, 2, "no further batch starts");
    assert.equal(state.calls, 1, "the review continues");
    assert.ok(state.users[0]!.includes(WORK1_BODY));
    assert.equal(result.context.state, "degraded");
    assert.equal(result.status, "partial");
    const error = result.errors.find(
      (e) => e.code === "EMBEDDING_AUTHENTICATION",
    );
    assert.equal(error?.stage, "index");
    assert.deepEqual(degradedReasons(result), ["index:embedding_failed"]);

    const after = await readIndex(canonical);
    assert.equal(after.status, "valid");
    if (after.status !== "valid") return;
    assert.equal(after.index.vectors.count, 10, "earlier vectors survive");
    assert.ok(after.index.chunks.length >= 55, "new files are indexed");

    const checkpoint = JSON.parse(
      await readFile(checkpointPath(root, ".cache"), "utf8"),
    ) as { vectors: Record<string, unknown> };
    assert.equal(
      Object.keys(checkpoint.vectors).length,
      32,
      "the paid-for batch is kept for the next run",
    );
    const events: ReviewEvent[] = [];
    const resumed = await run(root, {
      embedding: scriptedEmbedding().adapter,
      model: countingModel().model,
      config: hybridConfig(50),
      snapshotId: "snap-3",
      events,
    });
    assert.equal(resumed.context.state, "used");
    const indexed = events.find(
      (e) => e.stage === "index" && e.type === "complete",
    );
    assert.equal(indexed?.data?.vectorsFromCheckpoint, 32);
  },
);

/* ---- 3. the global cap ---- */

unitTest(
  "concurrent files, embedding retries and model retries never exceed the global allowance",
  async () => {
    const root = await repo(sources(6));
    const embedding = scriptedEmbedding({
      2: networkReset(),
      4: networkReset(),
    });
    const { model, state } = countingModel(async (call) => {
      if (call === 1)
        throw new ReviewModelError({
          kind: "provider_unavailable",
          provider: "test",
          message: "unavailable",
          retryable: true,
        });
      return cleanResult();
    });
    const cap = 6;
    const result = await run(root, {
      embedding: embedding.adapter,
      model,
      config: hybridConfig(cap, { concurrency: 2, maxAttempts: 3 }),
      files: ["a.ts", "b.ts", "c.ts", "d.ts"],
    });
    const providerCalls = embedding.state.attempts + state.calls;
    assert.ok(providerCalls <= cap, `${providerCalls} calls > cap ${cap}`);
    assert.equal(result.usage.actualRequests, providerCalls);
    assert.ok(
      embedding.state.attempts <= cap - 4,
      "embeddings leave one request per planned segment",
    );
    assert.equal(result.usage.embeddingRequests, embedding.state.attempts);
  },
);

/* ---- 4. cancellation never triggers continued review ---- */

for (const [label, hang] of [
  ["index", 1],
  ["query", 2],
] as const)
  unitTest(
    `cancellation during ${label} embedding starts no fallback provider call`,
    async () => {
      const root = await repo(sources(4));
      const embedding = scriptedEmbedding();
      embedding.state.hang.add(hang);
      const { model, state } = countingModel();
      // The deadline timer is unref'd; keep the loop alive while a call hangs.
      const keepAlive = setInterval(() => undefined, 10);
      const result = await run(root, {
        embedding: embedding.adapter,
        model,
        // Long enough for git to scan the repository and index before the
        // chosen call hangs; the per-attempt timeout must not fire first.
        config: hybridConfig(10, {
          totalTimeoutMs: 1500,
          requestTimeoutMs: 10_000,
        }),
      }).finally(() => clearInterval(keepAlive));
      assert.equal(
        state.calls,
        0,
        "the model is never asked after the deadline",
      );
      assert.equal(embedding.state.attempts, hang, "no retry or fallback call");
      assert.equal(result.coverage.reviewed, 0);
      assert.notEqual(result.status, "complete");
      assert.ok(
        result.errors.some((e) => e.code === "REVIEW_ABORTED"),
        JSON.stringify(result.errors),
      );
    },
  );

/* ---- 5. non-regressions ---- */

unitTest(
  "dry-run makes zero provider calls and unauthorized runs stay blocked",
  async () => {
    const root = await repo(sources(4));
    const embedding = scriptedEmbedding();
    const { model, state } = countingModel();
    const dry = await run(root, {
      embedding: embedding.adapter,
      model,
      dryRun: true,
    });
    assert.equal(dry.status, "partial");
    assert.ok(dry.dryRun);
    assert.equal(embedding.state.attempts, 0);
    assert.equal(state.calls, 0);

    const blocked = await run(root, { embedding: embedding.adapter });
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.errors[0]?.stage, "config");
    assert.equal(blocked.errors[0]?.fatal, true);
    assert.equal(embedding.state.attempts, 0);
  },
);

unitTest(
  "a cache hit consumes no model call, even with embeddings withheld, and is validated",
  async () => {
    const root = await repo(sources(4));
    const { model, state } = countingModel(async () =>
      findingResult("app.ts", 1),
    );
    const first = await run(root, { model, config: hybridConfig(1) });
    assert.equal(state.calls, 1);
    assert.equal(first.findings.length, 1);

    const second = await run(root, {
      model,
      embedding: scriptedEmbedding().adapter,
      config: hybridConfig(1),
    });
    assert.equal(state.calls, 1, "served from the cache");
    assert.equal(second.usage.cacheHits, 1);
    assert.equal(second.usage.attempts, 0);
    assert.equal(second.usage.actualRequests, 0);
    assert.deepEqual(
      second.findings.map((f) => f.id),
      first.findings.map((f) => f.id),
    );
  },
);
