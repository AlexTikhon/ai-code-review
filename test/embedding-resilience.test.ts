import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ExternalRequestBudget,
  RequestBudgetError,
} from "../src/model/budget.js";
import { loadConfig } from "../src/config/config.js";
import type { ReviewEvent } from "../src/observability/events.js";
import {
  checkpointPath,
  type EmbeddingCheckpointStore,
  FileEmbeddingCheckpointStore,
} from "../src/retrieval/embedding-checkpoint.js";
import { EmbeddingError } from "../src/retrieval/embedding-errors.js";
import type { EmbeddingExecutionOptions } from "../src/retrieval/embedding-execution.js";
import {
  indexPath,
  refreshRepositoryIndex,
} from "../src/retrieval/index-store.js";
import {
  OpenAIEmbeddingAdapter,
  type EmbeddingAdapter,
} from "../src/retrieval/embeddings.js";
import { prepareRepositoryIndex } from "../src/retrieval/prepared-index.js";
import { retrieveContext } from "../src/retrieval/retrieve.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import {
  attemptTimeout,
  rateLimit,
  scriptedEmbedding,
  unauthorized,
  unavailable,
} from "./embedding-fakes.js";
import {
  cleanResult,
  makeSource,
  request,
  sourceFile,
  testConfig,
} from "./fixtures.js";
import { unitTest } from "./helpers.js";
import { indexOptions, put, repo, sources } from "./index-harness.js";

const BATCH = 10;
const fast: EmbeddingExecutionOptions = {
  policy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
  sleep: async () => undefined,
};
const exists = (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  );
const checkpointed = async (path: string) =>
  Object.keys(
    (JSON.parse(await readFile(path, "utf8")) as { vectors: object }).vectors,
  ).length;

/**
 * 5 files (10 vectors) are indexed canonically; 50 more files then add 100
 * vectors to embed: ten batches of BATCH.
 */
async function scenario() {
  const root = await repo(sources(5));
  const seed = scriptedEmbedding();
  await refreshRepositoryIndex(
    await indexOptions(root, {
      embedding: seed.adapter,
      maxEmbeddingBatchSize: BATCH,
      embeddingExecution: fast,
    }),
  );
  for (const [path, text] of Object.entries(sources(50, 5)))
    await put(root, path, text);
  return {
    root,
    canonical: indexPath(root, ".cache"),
    checkpoint: checkpointPath(root, ".cache"),
  };
}

unitTest(
  "batch 5 failing three times keeps 40 vectors, the old index, and a resume avoids them",
  async () => {
    const { root, canonical, checkpoint } = await scenario();
    const before = await readFile(canonical, "utf8");

    // Run 1: batches 1-4 are attempts 1-4; batch 5 is attempts 5, 6, 7.
    const failing = scriptedEmbedding({
      5: unavailable(),
      6: unavailable(),
      7: unavailable(),
    });
    let reserved = 0;
    await assert.rejects(
      refreshRepositoryIndex(
        await indexOptions(root, {
          embedding: failing.adapter,
          maxEmbeddingBatchSize: BATCH,
          embeddingExecution: fast,
          beforeEmbeddingRequest: () => reserved++,
        }),
      ),
      (error: unknown) =>
        error instanceof EmbeddingError &&
        error.kind === "provider_unavailable",
    );
    assert.equal(
      failing.state.attempts,
      7,
      "4 good batches + 3 attempts on batch 5",
    );
    assert.equal(reserved, 7, "actual attempts == budget consumed");
    assert.equal(
      await readFile(canonical, "utf8"),
      before,
      "canonical unchanged",
    );
    assert.equal(await checkpointed(checkpoint), 40);

    // Run 2: the first 40 come from the checkpoint; batches 5-10 are requested.
    const resumed = scriptedEmbedding();
    let reservedAgain = 0;
    const result = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: resumed.adapter,
        maxEmbeddingBatchSize: BATCH,
        embeddingExecution: fast,
        beforeEmbeddingRequest: () => reservedAgain++,
      }),
    );
    assert.equal(result.stats.vectorsFromCheckpoint, 40);
    assert.equal(
      resumed.state.texts,
      60,
      "the first 40 were not requested again",
    );
    assert.equal(resumed.state.attempts, 6);
    assert.equal(reservedAgain, 6);
    assert.equal(result.index.vectors.count, 110);
    assert.notEqual(
      await readFile(canonical, "utf8"),
      before,
      "new index published",
    );
    assert.equal(await exists(checkpoint), false, "checkpoint cleaned");
  },
);

unitTest(
  "a retried batch does not re-run completed batches and is checkpointed on success",
  async () => {
    const { root, checkpoint } = await scenario();
    const real = new FileEmbeddingCheckpointStore(checkpoint);
    const sizes: number[] = [];
    const store: EmbeddingCheckpointStore = {
      load: () => real.load(),
      clear: () => real.clear(),
      async save(vectors) {
        sizes.push(vectors.length);
        await real.save(vectors);
      },
    };
    // Batch 3 (attempt 3) fails once, then succeeds on attempt 4.
    const flaky = scriptedEmbedding({ 3: rateLimit() });
    const result = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: flaky.adapter,
        maxEmbeddingBatchSize: BATCH,
        embeddingExecution: fast,
        checkpointStore: store,
        checkpointEveryBatches: 1,
      }),
    );
    assert.equal(flaky.state.attempts, 11, "10 batches + 1 retry");
    assert.equal(flaky.state.texts, 100, "every text embedded exactly once");
    assert.equal(result.stats.embeddingRequests, 11);
    assert.equal(result.stats.embeddingRetries, 1);
    // Saved after every successful batch, in order, including the retried one.
    assert.deepEqual(sizes, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  },
);

unitTest(
  "a permanent batch failure stops the run: later batches never start",
  async () => {
    const { root, canonical, checkpoint } = await scenario();
    const before = await readFile(canonical, "utf8");
    const failing = scriptedEmbedding({ 3: unauthorized() });
    await assert.rejects(
      refreshRepositoryIndex(
        await indexOptions(root, {
          embedding: failing.adapter,
          maxEmbeddingBatchSize: BATCH,
          embeddingExecution: fast,
        }),
      ),
      (error: unknown) =>
        error instanceof EmbeddingError && error.kind === "authentication",
    );
    assert.equal(
      failing.state.attempts,
      3,
      "no retry, and batches 4-10 never start",
    );
    assert.equal(await readFile(canonical, "utf8"), before);
    assert.equal(await checkpointed(checkpoint), 20, "batches 1-2 survive");
  },
);

unitTest(
  "an exhausted request budget stops retries after exactly the allowed requests",
  async () => {
    const { root, canonical, checkpoint } = await scenario();
    const before = await readFile(canonical, "utf8");
    // Batches 1-2 succeed; every later attempt is a transient failure.
    const failing = scriptedEmbedding(
      Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [i + 3, unavailable()]),
      ),
    );
    const budget = new ExternalRequestBudget(5, new AbortController().signal);
    await assert.rejects(
      refreshRepositoryIndex(
        await indexOptions(root, {
          embedding: failing.adapter,
          maxEmbeddingBatchSize: BATCH,
          embeddingExecution: {
            ...fast,
            policy: { maxAttempts: 10, baseDelayMs: 0, maxDelayMs: 0 },
          },
          beforeEmbeddingRequest: () => budget.reserve("embedding"),
        }),
      ),
      (error: unknown) =>
        error instanceof RequestBudgetError &&
        error.code === "REQUEST_BUDGET_EXHAUSTED",
    );
    assert.equal(failing.state.attempts, 5, "no sixth request starts");
    assert.equal(budget.consumed, 5);
    assert.equal(await readFile(canonical, "utf8"), before);
    assert.equal(await checkpointed(checkpoint), 20);
  },
);

unitTest(
  "cancelling during a retry wait keeps paid work, the old index and the budget",
  async () => {
    const { root, canonical, checkpoint } = await scenario();
    const before = await readFile(canonical, "utf8");
    const controller = new AbortController();
    const flaky = scriptedEmbedding({ 4: rateLimit(1000) });
    let reserved = 0;
    await assert.rejects(
      refreshRepositoryIndex(
        await indexOptions(root, {
          embedding: flaky.adapter,
          maxEmbeddingBatchSize: BATCH,
          signal: controller.signal,
          beforeEmbeddingRequest: () => reserved++,
          embeddingExecution: {
            policy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 5000 },
            // The wait begins, and the caller cancels while it is pending.
            sleep: (_ms, signal) =>
              new Promise<void>((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(signal.reason));
                controller.abort();
              }),
          },
        }),
      ),
      (error: unknown) =>
        error instanceof EmbeddingError && error.kind === "aborted",
    );
    assert.equal(
      flaky.state.attempts,
      4,
      "no request after the cancelled wait",
    );
    assert.equal(reserved, 4);
    assert.equal(await readFile(canonical, "utf8"), before);
    assert.equal(await checkpointed(checkpoint), 30);
  },
);

unitTest(
  "an attempt timeout is retried while the deadline allows",
  async () => {
    const root = await repo(sources(3));
    const flaky = scriptedEmbedding({ 1: attemptTimeout() });
    const result = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: flaky.adapter,
        embeddingExecution: fast,
      }),
    );
    assert.equal(result.stats.embeddingRequests, 2);
    assert.equal(result.stats.embeddingRetries, 1);
  },
);

unitTest(
  "a failed first run and a clean second run publish the same vectors as one clean run",
  async () => {
    const flakyRoot = await repo(sources(20));
    const failing = scriptedEmbedding({
      2: unavailable(),
      3: unavailable(),
      4: unavailable(),
    });
    await refreshRepositoryIndex(
      await indexOptions(flakyRoot, {
        embedding: failing.adapter,
        maxEmbeddingBatchSize: BATCH,
        embeddingExecution: fast,
      }),
    ).catch(() => undefined);
    const resumed = await refreshRepositoryIndex(
      await indexOptions(flakyRoot, {
        embedding: scriptedEmbedding().adapter,
        maxEmbeddingBatchSize: BATCH,
        embeddingExecution: fast,
      }),
    );
    const cleanRoot = await repo(sources(20));
    const clean = await refreshRepositoryIndex(
      await indexOptions(cleanRoot, {
        embedding: scriptedEmbedding().adapter,
        maxEmbeddingBatchSize: BATCH,
        embeddingExecution: fast,
      }),
    );
    assert.deepEqual(
      resumed.index.vectors.keys().sort(),
      clean.index.vectors.keys().sort(),
    );
  },
);

/* ---- query embedding (retrieval) ---- */

unitTest(
  "a transient query-embedding failure is retried by retrieval",
  async () => {
    const root = await repo(sources(3));
    const { index } = await refreshRepositoryIndex(await indexOptions(root));
    const prepared = prepareRepositoryIndex(index);
    const flaky = scriptedEmbedding({ 1: unavailable(), 2: rateLimit(250) });
    let reserved = 0;
    const hits = await retrieveContext({
      index: prepared,
      repositoryId: "repo",
      revision: "rev-1",
      query: "work1",
      changedPath: "other.ts",
      mode: "hybrid",
      candidates: 5,
      topK: 3,
      threshold: 0,
      embedding: flaky.adapter,
      beforeEmbeddingRequest: () => reserved++,
      embeddingExecution: fast,
    });
    assert.ok(hits.length >= 0);
    assert.equal(flaky.state.attempts, 3);
    assert.equal(reserved, 3, "every query attempt is budgeted");
  },
);

/* ---- pipeline ---- */

const hybridConfig = {
  ...testConfig,
  maxRequests: 50,
  embeddingRetry: { maxAttempts: 3, baseDelayMs: 0 },
};
const hybridRun = (
  root: string,
  embedding: EmbeddingAdapter,
  events: ReviewEvent[] = [],
  config = hybridConfig,
) =>
  executeReviewPipeline({ ...request, contextMode: "hybrid" }, config, {
    model: { provider: "test", review: async () => cleanResult() },
    embedding,
    source: makeSource([sourceFile("app.ts", "@@ -0,0 +1 @@\n+work1()")], {
      repositoryRoot: root,
    }),
    events: (event) => events.push(event),
    embeddingExecution: { sleep: async () => undefined },
  });

unitTest(
  "the pipeline retries a transient embedding failure and counts every attempt",
  async () => {
    const root = await repo(sources(40));
    const events: ReviewEvent[] = [];
    const flaky = scriptedEmbedding({ 1: unavailable() });
    const result = await hybridRun(root, flaky.adapter, events);
    assert.equal(result.context.state, "used");
    // 3 index batches + 1 retry + 1 query embedding.
    assert.equal(result.usage.embeddingRequests, 5);
    assert.equal(flaky.state.attempts, 5);
    const notes = events.filter((e) =>
      e.message?.startsWith("embedding.request_"),
    );
    assert.deepEqual(
      notes.slice(0, 3).map((e) => e.message),
      [
        "embedding.request_started",
        "embedding.request_retry",
        "embedding.request_started",
      ],
    );
    const retry = notes.find((e) => e.message === "embedding.request_retry");
    assert.equal(retry?.stage, "embedding");
    assert.equal(retry?.data?.errorKind, "provider_unavailable");
    assert.equal(retry?.data?.provider, "fake");
    assert.equal(retry?.attempt, 1);
    assert.equal(retry?.data?.batchSize, 32);
    const started = notes.find(
      (e) => e.message === "embedding.request_started",
    );
    assert.equal(started?.data?.budgetRemaining, 49);
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes('"values"'));
    assert.ok(!serialized.includes("work1"), "no embedded text in events");
    const index = events.find(
      (e) => e.stage === "index" && e.type === "complete",
    );
    assert.equal(index?.data?.embeddingRetries, 1);
  },
);

unitTest(
  "a permanent embedding failure is reported with a stable embedding code",
  async () => {
    const root = await repo(sources(40));
    const result = await hybridRun(
      root,
      scriptedEmbedding({ 1: unauthorized() }).adapter,
    );
    assert.equal(result.context.state, "unavailable");
    const error = result.errors[0];
    assert.equal(error?.stage, "index");
    assert.equal(error?.code, "EMBEDDING_AUTHENTICATION");
    assert.equal(error?.provider, "fake");
    assert.equal(error?.retryable, false);
    assert.equal(error?.fatal, false);
    assert.equal(result.usage.embeddingRequests, 1);
  },
);

unitTest(
  "a transient failure that outlasts the retries is retryable, with the embedding code",
  async () => {
    const root = await repo(sources(40));
    const failing = scriptedEmbedding({
      1: rateLimit(),
      2: rateLimit(),
      3: rateLimit(),
    });
    const result = await hybridRun(root, failing.adapter);
    const error = result.errors[0];
    assert.equal(error?.code, "EMBEDDING_RATE_LIMIT");
    assert.equal(error?.retryable, true);
    assert.equal(result.usage.embeddingRequests, 3);
  },
);

unitTest(
  "budget exhaustion during embedding retries is not reported as a provider error",
  async () => {
    const root = await repo(sources(40));
    const failing = scriptedEmbedding(
      Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [i + 1, unavailable()]),
      ),
    );
    const result = await hybridRun(root, failing.adapter, [], {
      ...hybridConfig,
      maxRequests: 2,
    });
    assert.equal(result.errors[0]?.code, "REQUEST_BUDGET_EXHAUSTED");
    assert.equal(result.errors[0]?.retryable, false);
    assert.equal(failing.state.attempts, 2);
    assert.equal(result.usage.embeddingRequests, 2);
  },
);

unitTest(
  "a query-embedding failure fails the segment with a retrieve-stage embedding code",
  async () => {
    const root = await repo(sources(4));
    // 8 vectors fit one index batch (attempt 1); the query is attempt 2.
    const failing = scriptedEmbedding({ 2: unauthorized() });
    let modelCalls = 0;
    const result = await executeReviewPipeline(
      { ...request, contextMode: "hybrid" },
      hybridConfig,
      {
        model: {
          provider: "test",
          review: async () => {
            modelCalls++;
            return cleanResult();
          },
        },
        embedding: failing.adapter,
        source: makeSource([sourceFile("app.ts", "@@ -0,0 +1 @@\n+work1()")], {
          repositoryRoot: root,
        }),
      },
    );
    const error = result.errors.find(
      (e) => e.code === "EMBEDDING_AUTHENTICATION",
    );
    assert.ok(error, JSON.stringify(result.errors));
    assert.equal(error.stage, "retrieve");
    assert.equal(error.provider, "fake");
    assert.equal(modelCalls, 0, "the model is not asked with missing evidence");
    assert.notEqual(result.status, "complete");
  },
);

unitTest(
  "a transient query-embedding failure is retried inside the pipeline",
  async () => {
    const root = await repo(sources(4));
    const flaky = scriptedEmbedding({ 2: unavailable() });
    const result = await hybridRun(root, flaky.adapter);
    assert.equal(result.errors.length, 0);
    assert.equal(result.usage.embeddingRequests, 3);
  },
);

/* ---- configuration ---- */

const withEnv = (env: Record<string, string | undefined>, run: () => void) => {
  const saved = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  for (const [k, v] of Object.entries(env))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  try {
    run();
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
};

unitTest(
  "embedding retry configuration has conservative defaults and validates input",
  () => {
    withEnv(
      {
        AI_REVIEW_EMBEDDING_MAX_ATTEMPTS: undefined,
        AI_REVIEW_EMBEDDING_RETRY_BASE_MS: undefined,
      },
      () =>
        assert.deepEqual(loadConfig({ allowExternal: false }).embeddingRetry, {
          maxAttempts: 3,
          baseDelayMs: 250,
        }),
    );
    withEnv(
      {
        AI_REVIEW_EMBEDDING_MAX_ATTEMPTS: "5",
        AI_REVIEW_EMBEDDING_RETRY_BASE_MS: "0",
      },
      () =>
        assert.deepEqual(loadConfig({ allowExternal: false }).embeddingRetry, {
          maxAttempts: 5,
          baseDelayMs: 0,
        }),
    );
    for (const [name, value] of [
      ["AI_REVIEW_EMBEDDING_MAX_ATTEMPTS", "0"],
      ["AI_REVIEW_EMBEDDING_MAX_ATTEMPTS", "NaN"],
      ["AI_REVIEW_EMBEDDING_MAX_ATTEMPTS", "Infinity"],
      ["AI_REVIEW_EMBEDDING_MAX_ATTEMPTS", "2.5"],
      ["AI_REVIEW_EMBEDDING_RETRY_BASE_MS", "-1"],
      ["AI_REVIEW_EMBEDDING_RETRY_BASE_MS", "NaN"],
      ["AI_REVIEW_EMBEDDING_RETRY_BASE_MS", "Infinity"],
      ["AI_REVIEW_EMBEDDING_RETRY_BASE_MS", "abc"],
      ["AI_REVIEW_EMBEDDING_RETRY_BASE_MS", "20000"],
    ] as const)
      withEnv({ [name]: value }, () =>
        assert.throws(
          () => loadConfig({ allowExternal: false }),
          new RegExp(name),
        ),
      );
  },
);

unitTest(
  "a missing embedding credential costs no request and no budget in a real run",
  async () => {
    const root = await repo(sources(10));
    let fetches = 0;
    const adapter = new OpenAIEmbeddingAdapter(
      "text-embedding-3-small",
      "",
      "https://example.test/v1/embeddings",
      (async () => {
        fetches++;
        return new Response("{}");
      }) as unknown as typeof fetch,
    );
    const result = await hybridRun(root, adapter);
    assert.equal(result.context.state, "unavailable");
    assert.equal(result.errors[0]?.code, "EMBEDDING_AUTHENTICATION");
    assert.equal(result.errors[0]?.retryable, false);
    assert.equal(fetches, 0);
    assert.equal(result.usage.embeddingRequests, 0);
  },
);
