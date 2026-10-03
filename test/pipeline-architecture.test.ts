import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviders } from "../src/cli/providers.js";
import { runReview } from "../src/cli/run-review.js";
import { requestFromCliArgs } from "../src/cli/request.js";
import { reviewCacheKey, writeReviewCache } from "../src/cache/review-cache.js";
import { ExternalRequestBudget } from "../src/model/budget.js";
import { OpenAIReviewModel } from "../src/model/openai.js";
import { ModelError, type ReviewModel } from "../src/model/types.js";
import type { ReviewEvent } from "../src/observability/events.js";
import { runReviewPipeline } from "../src/review/pipeline.js";
import {
  aggregateOutcomes,
  compareFindings,
} from "../src/review/pipeline/aggregate.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import type { FileReviewOutcome } from "../src/review/pipeline/types.js";
import type { ReviewerFinding } from "../src/review/types.js";
import {
  cleanResult,
  cliArgs,
  deferred,
  filenameOf,
  findingResult,
  makeSource,
  nextTick,
  request,
  sourceFile,
  testConfig,
  until,
} from "./fixtures.js";
import { unitTest } from "./helpers.js";

const finding = (
  filename: string,
  line: number,
  id: string,
): ReviewerFinding => ({
  id,
  severity: "high",
  category: "correctness",
  confidence: "high",
  filename,
  title: id,
  explanation: "x",
  evidence: [{ path: filename, startLine: line, endLine: line }],
});
const outcome = (
  order: number,
  filename: string,
  overrides: Partial<FileReviewOutcome> = {},
): FileReviewOutcome => ({
  order,
  filename,
  started: true,
  failed: false,
  completedSegments: 1,
  totalSegments: 1,
  findings: [],
  abstentions: [],
  errors: [],
  selectedContext: [],
  usage: {
    requests: 1,
    attempts: 1,
    inputTokens: 10,
    outputTokens: 2,
    estimatedInputTokens: 20,
    estimated: false,
    cacheHits: 0,
  },
  ...overrides,
});

// ---------------------------------------------------------------- aggregation

unitTest("aggregation is independent of job completion order", () => {
  const outcomes = [
    outcome(0, "a.ts", {
      findings: [finding("a.ts", 9, "f-a9"), finding("a.ts", 2, "f-a2")],
      selectedContext: [
        {
          id: "c1",
          path: "z.ts",
          score: 1,
          reasons: [],
          startLine: 1,
          endLine: 2,
        },
      ],
    }),
    outcome(1, "b.ts", {
      findings: [finding("b.ts", 1, "f-b1")],
      selectedContext: [
        {
          id: "c2",
          path: "m.ts",
          score: 1,
          reasons: [],
          startLine: 1,
          endLine: 2,
        },
      ],
      failed: true,
      errors: [
        { stage: "analyze", filename: "b.ts", message: "x", fatal: false },
      ],
    }),
    outcome(2, "c.ts", { started: false, failed: true }),
  ];
  const forward = aggregateOutcomes(outcomes);
  const shuffled = aggregateOutcomes([
    outcomes[2]!,
    outcomes[0]!,
    outcomes[1]!,
  ]);
  assert.deepEqual(forward, shuffled);
  assert.deepEqual(
    forward.findings.map((item) => item.id),
    ["f-a2", "f-a9", "f-b1"],
  );
  // Context order keeps file/segment/rank order (eval ranks depend on it).
  assert.deepEqual(
    forward.selectedContext.map((item) => item.path),
    ["z.ts", "m.ts"],
  );
  assert.deepEqual(forward.coverage, { attempted: 2, reviewed: 1, failed: 2 });
  assert.equal(forward.usage.requests, 3);
  assert.equal(forward.usage.inputTokens, 30);
});

unitTest("finding order is path, first line, then stable id", () => {
  const sorted = [
    finding("b.ts", 1, "x"),
    finding("a.ts", 5, "b"),
    finding("a.ts", 5, "a"),
    finding("a.ts", 1, "z"),
  ].sort(compareFindings);
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["z", "a", "b", "x"],
  );
});

unitTest(
  "concurrent completion order does not change the reported result",
  async () => {
    const files = ["a.ts", "b.ts", "c.ts"];
    const run = async (completeInOrder: string[]) => {
      const gates = new Map(files.map((name) => [name, deferred()]));
      const started = new Set<string>();
      const model: ReviewModel = {
        provider: "test",
        async review(req) {
          const name = filenameOf(req.user);
          started.add(name);
          await gates.get(name)!.promise;
          return findingResult(name);
        },
      };
      const pending = executeReviewPipeline(
        request,
        { ...testConfig, concurrency: 3 },
        { model, source: makeSource(files.map((name) => sourceFile(name))) },
      );
      // Every file is in flight before any completes.
      await until(() => started.size === 3);
      for (const name of completeInOrder) {
        gates.get(name)!.resolve();
        await nextTick();
      }
      return pending;
    };
    const ordered = await run(["a.ts", "b.ts", "c.ts"]);
    const reversed = await run(["c.ts", "b.ts", "a.ts"]);
    const view = (r: typeof ordered) => ({
      findings: r.findings.map((item) => item.id),
      files: r.findings.map((item) => item.filename),
      coverage: r.coverage,
      errors: r.errors,
      status: r.status,
    });
    assert.deepEqual(view(reversed), view(ordered));
    assert.deepEqual(view(ordered).files, ["a.ts", "b.ts", "c.ts"]);
  },
);

// -------------------------------------------------------------- orchestration

unitTest(
  "core pipeline runs from an application request without CLI arguments",
  async () => {
    let calls = 0;
    const model: ReviewModel = {
      provider: "test",
      async review() {
        calls++;
        return cleanResult();
      },
    };
    const result = await executeReviewPipeline(request, testConfig, {
      model,
      source: makeSource([sourceFile("a.ts")]),
    });
    assert.equal(result.status, "complete");
    assert.equal(result.coverage.reviewed, 1);
    assert.equal(calls, 1);
    assert.equal(result.model.provider, "test");
  },
);

unitTest("stages run in order and report safe timing events", async () => {
  const events: ReviewEvent[] = [];
  let clock = 0;
  const marker = "SECRET_SOURCE_MARKER_8f3a";
  const model: ReviewModel = {
    provider: "test",
    async review() {
      return cleanResult();
    },
  };
  const result = await executeReviewPipeline(request, testConfig, {
    model,
    events: (event) => events.push(event),
    now: () => (clock += 5),
    source: makeSource(
      [sourceFile("a.ts", `@@ -0,0 +1 @@\n+const ${marker} = 1;`)],
      {
        description: `PR body ${marker}`,
      },
    ),
  });
  assert.equal(result.status, "complete");
  const stages: string[] = [];
  for (const event of events)
    if (stages.at(-1) !== event.stage) stages.push(event.stage);
  assert.deepEqual(
    stages.filter((stage) => stage !== "retrieve"),
    ["ingest", "filter", "analyze", "finalize"],
  );
  for (const stage of ["ingest", "filter", "analyze"]) {
    const complete = events.find(
      (event) => event.stage === stage && event.type === "complete",
    );
    assert.ok(
      complete && Number.isInteger(complete.durationMs),
      `${stage} reports a duration`,
    );
  }
  const finalize = events.find((event) => event.stage === "finalize")!;
  assert.equal(typeof finalize.data?.finalizeMs, "number");
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, new RegExp(marker));
  assert.doesNotMatch(serialized, /UNTRUSTED/);
});

unitTest("a missing model fails closed before any stage runs", async () => {
  const events: ReviewEvent[] = [];
  const result = await executeReviewPipeline(request, testConfig, {
    events: (event) => events.push(event),
    source: makeSource([sourceFile("a.ts")]),
  });
  assert.equal(result.status, "failed");
  assert.match(
    result.errors[0]?.message ?? "",
    /External model transmission is disabled/,
  );
  assert.equal(result.usage.actualRequests, 0);
  assert.ok(!events.some((event) => event.stage === "ingest"));
});

unitTest("dry-run and index-only never need or call a model", async () => {
  const dry = await executeReviewPipeline(
    { ...request, dryRun: true },
    testConfig,
    { source: makeSource([sourceFile("a.ts")]) },
  );
  assert.equal(dry.status, "partial");
  assert.equal(dry.dryRun?.proposedFiles.length, 1);
  assert.equal(dry.usage.actualRequests, 0);
  const indexed = await executeReviewPipeline(
    { ...request, indexOnly: true },
    testConfig,
    { source: makeSource([sourceFile("a.ts")]) },
  );
  assert.equal(indexed.status, "complete");
  assert.equal(indexed.usage.actualRequests, 0);
});

unitTest("no changed files completes without a clean-code claim", async () => {
  const result = await executeReviewPipeline(request, testConfig, {
    model: { provider: "test", review: async () => cleanResult() },
    source: makeSource([]),
  });
  assert.equal(result.status, "complete");
  assert.match(result.summary, /no clean-code claim/);
});

// --------------------------------------------- cancellation and request budget

unitTest(
  "deadline cancellation starts no new file and never reports a clean review",
  async () => {
    let calls = 0;
    const model: ReviewModel = {
      provider: "test",
      review(_req, signal) {
        calls++;
        // A real socket keeps the event loop alive while a request hangs.
        const keepAlive = setInterval(() => undefined, 1000);
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              clearInterval(keepAlive);
              reject(new ModelError("aborted", false));
            },
            { once: true },
          );
        });
      },
    };
    const result = await executeReviewPipeline(
      request,
      {
        ...testConfig,
        concurrency: 1,
        totalTimeoutMs: 40,
        requestTimeoutMs: 60_000,
      },
      {
        model,
        source: makeSource(["a.ts", "b.ts", "c.ts"].map((n) => sourceFile(n))),
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.status, "failed");
    assert.equal(result.coverage.eligible, 3);
    assert.equal(result.coverage.attempted, 1);
    assert.equal(result.coverage.reviewed, 0);
    assert.equal(result.coverage.failed, 3);
    assert.equal(result.usage.actualRequests, 1);
    assert.equal(
      result.errors.filter((e) =>
        /cancelled before this file started/.test(e.message),
      ).length,
      2,
    );
  },
);

unitTest(
  "concurrency cannot bypass the request budget and exhaustion is reported",
  async () => {
    let calls = 0;
    const model: ReviewModel = {
      provider: "test",
      async review() {
        calls++;
        return cleanResult();
      },
    };
    const names = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    const result = await executeReviewPipeline(
      request,
      { ...testConfig, concurrency: 5, maxRequests: 3 },
      { model, source: makeSource(names.map((n) => sourceFile(n))) },
    );
    assert.equal(calls, 3);
    assert.equal(result.usage.actualRequests, 3);
    assert.equal(result.coverage.reviewed, 3);
    assert.equal(result.coverage.failed, 2);
    assert.equal(result.status, "partial");
    assert.ok(result.errors.some((e) => /budget 3 exhausted/.test(e.message)));
  },
);

unitTest("every retry attempt consumes one request", async () => {
  let calls = 0;
  const model: ReviewModel = {
    provider: "test",
    async review() {
      calls++;
      throw new ModelError("temporary", true, 1);
    },
  };
  const result = await executeReviewPipeline(
    request,
    { ...testConfig, maxAttempts: 3, maxRequests: 10 },
    { model, source: makeSource([sourceFile("a.ts")]) },
  );
  assert.equal(calls, 3);
  assert.equal(result.usage.actualRequests, 3);
  assert.equal(result.usage.attempts, 3);
  assert.equal(result.status, "failed");
});

unitTest("budget counts by kind and refuses once cancelled", () => {
  const controller = new AbortController();
  const budget = new ExternalRequestBudget(3, controller.signal);
  budget.reserve("model");
  budget.reserve("embedding");
  assert.equal(budget.consumed, 2);
  assert.equal(budget.consumedBy("embedding"), 1);
  controller.abort();
  assert.throws(() => budget.reserve("model"));
  assert.equal(budget.consumed, 2);
  const exhausted = new ExternalRequestBudget(1, new AbortController().signal);
  exhausted.reserve("model");
  assert.throws(() => exhausted.reserve("embedding"), /exhausted/);
  assert.equal(exhausted.consumedBy("embedding"), 0);
});

unitTest("cache hits consume zero provider requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "acr-arch-cache-"));
  let calls = 0;
  const model: ReviewModel = {
    provider: "test",
    async review() {
      calls++;
      return cleanResult();
    },
  };
  const source = makeSource([sourceFile("a.ts")], { repositoryRoot: root });
  const first = await executeReviewPipeline(request, testConfig, {
    model,
    source,
  });
  const second = await executeReviewPipeline(
    request,
    { ...testConfig, maxRequests: 0 },
    { model, source },
  );
  assert.equal(first.usage.actualRequests, 1);
  assert.equal(second.status, "complete");
  assert.equal(second.usage.actualRequests, 0);
  assert.equal(second.usage.cacheHits, 1);
  assert.equal(calls, 1);
});

// ------------------------------------------------------------ cache identity

unitTest("provider identity is part of the review cache key", () => {
  const req = { system: "s", user: "u", model: "gpt-x", maxOutputTokens: 10 };
  const base = reviewCacheKey(req, { provider: "alpha", identity: "v1" });
  assert.notEqual(
    reviewCacheKey(req, { provider: "beta", identity: "v1" }),
    base,
  );
  assert.notEqual(
    reviewCacheKey(req, { provider: "alpha", identity: "v2" }),
    base,
  );
  assert.notEqual(reviewCacheKey(req, { provider: "alpha" }), base);
  assert.equal(
    reviewCacheKey(req, { provider: "alpha", identity: "v1" }),
    base,
  );
});

unitTest(
  "providers sharing a model name never reuse each other's cached results",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "acr-arch-identity-"));
    const calls = { alpha: 0, beta: 0 };
    const make = (
      provider: "alpha" | "beta",
      identity?: string,
    ): ReviewModel => ({
      provider,
      identity,
      async review() {
        calls[provider]++;
        return cleanResult();
      },
    });
    const source = makeSource([sourceFile("a.ts")], { repositoryRoot: root });
    const run = (model: ReviewModel) =>
      executeReviewPipeline(request, testConfig, { model, source });
    await run(make("alpha", "v1"));
    await run(make("beta", "v1"));
    assert.deepEqual(calls, { alpha: 1, beta: 1 });
    await run(make("alpha", "v1"));
    assert.deepEqual(
      calls,
      { alpha: 1, beta: 1 },
      "same contract hits the cache",
    );
    await run(make("alpha", "v2"));
    assert.equal(calls.alpha, 2, "a different contract identity misses");
  },
);

unitTest("OpenAI identity excludes secrets, credentials and queries", () => {
  const model = new OpenAIReviewModel(
    "sk-super-secret-key",
    "https://user:hunter2@example.test/v1/chat/completions?api-key=abc",
  );
  assert.match(model.identity, /openai-chat-completions/);
  assert.match(
    model.identity,
    /https:\/\/example\.test\/v1\/chat\/completions/,
  );
  for (const secret of ["sk-super-secret-key", "hunter2", "user:", "api-key"])
    assert.ok(!model.identity.includes(secret), `leaked ${secret}`);
  assert.equal(
    new OpenAIReviewModel("different-key", model["endpoint"]).identity,
    model.identity,
  );
});

unitTest("an invalid cached result is ignored and replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "acr-arch-poison-"));
  let captured: Parameters<ReviewModel["review"]>[0] | undefined;
  let calls = 0;
  const model: ReviewModel = {
    provider: "test",
    async review(req) {
      calls++;
      captured = req;
      return cleanResult();
    },
  };
  const source = makeSource([sourceFile("a.ts")], { repositoryRoot: root });
  await executeReviewPipeline(request, testConfig, { model, source });
  assert.equal(calls, 1);
  // Overwrite the entry with a schema-valid response citing an unsupplied line.
  await writeReviewCache(
    root,
    testConfig.cacheDirName,
    reviewCacheKey(captured!, model),
    findingResult("a.ts", 999),
  );
  const again = await executeReviewPipeline(request, testConfig, {
    model,
    source,
  });
  assert.equal(calls, 2, "invalid evidence must not be served from cache");
  assert.equal(again.usage.cacheHits, 0);
  assert.equal(again.findings.length, 0);
  assert.equal(again.status, "complete");
});

// ------------------------------------------------------------ partial review

unitTest(
  "a later-segment failure keeps earlier findings but is never clean",
  async () => {
    let calls = 0;
    const model: ReviewModel = {
      provider: "test",
      async review(req) {
        calls++;
        if (calls === 2) throw new ModelError("second segment failed", false);
        return findingResult(filenameOf(req.user), 100);
      },
    };
    const patch = `@@ -0,0 +100,10 @@\n${Array.from({ length: 10 }, (_, i) => `+line_${i}=${"x".repeat(45)}`).join("\n")}`;
    const result = await executeReviewPipeline(
      request,
      {
        ...testConfig,
        maxPatchTokens: 256,
        maxSegmentsPerFile: 10,
        concurrency: 1,
      },
      { model, source: makeSource([sourceFile("a.ts", patch)]) },
    );
    assert.ok(calls >= 2);
    assert.equal(result.findings.length, 1);
    assert.equal(result.coverage.failed, 1);
    assert.equal(result.coverage.reviewed, 0);
    assert.notEqual(result.status, "complete");
    assert.match(result.summary, /not clean/);
  },
);

// --------------------------------------------------- privacy and composition

unitTest(
  "bootstrap composes no provider and makes no network call when not authorized",
  async () => {
    const previous = {
      allow: process.env.AI_REVIEW_ALLOW_EXTERNAL,
      key: process.env.OPENAI_API_KEY,
    };
    delete process.env.AI_REVIEW_ALLOW_EXTERNAL;
    process.env.OPENAI_API_KEY = "sk-must-never-be-sent";
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      throw new Error("network must not be used");
    }) as typeof fetch;
    try {
      const result = await runReview(
        { ...cliArgs, contextMode: "hybrid" },
        { source: makeSource([sourceFile("a.ts")]) },
      );
      assert.equal(result.status, "failed");
      assert.match(result.errors[0]?.message ?? "", /transmission is disabled/);
      const dry = await runReview(
        { ...cliArgs, dryRun: true },
        { source: makeSource([sourceFile("a.ts")]) },
      );
      assert.equal(dry.status, "partial");
      assert.deepEqual(dry.dryRun?.destinations, [
        "local cache",
        "external model disabled",
      ]);
      assert.equal(fetches, 0);
    } finally {
      globalThis.fetch = realFetch;
      if (previous.allow === undefined)
        delete process.env.AI_REVIEW_ALLOW_EXTERNAL;
      else process.env.AI_REVIEW_ALLOW_EXTERNAL = previous.allow;
      if (previous.key === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous.key;
    }
  },
);

unitTest("providers are created only with explicit authorization", () => {
  const hybrid = { contextMode: "hybrid" as const };
  assert.deepEqual(createProviders(testConfig, hybrid), {
    model: undefined,
    embedding: undefined,
  });
  const external = { ...testConfig, allowExternal: true };
  const withModel = createProviders(external, hybrid);
  assert.equal(withModel.model?.provider, "openai");
  assert.equal(
    withModel.embedding,
    undefined,
    "embeddings need their own consent",
  );
  const embeddings = { ...external, allowEmbeddings: true };
  assert.ok(createProviders(embeddings, hybrid).embedding);
  assert.equal(
    createProviders(embeddings, { contextMode: "lexical" }).embedding,
    undefined,
    "embeddings are only composed for hybrid retrieval",
  );
});

unitTest("CLI arguments translate to a transport-neutral request", () => {
  assert.deepEqual(
    requestFromCliArgs({
      ...cliArgs,
      reviewMode: "pr",
      owner: "o",
      repo: "r",
      pullNumber: 7,
      localRepoPath: "/x",
      contextMode: "hybrid",
      dryRun: true,
    }),
    {
      target: {
        kind: "pull-request",
        owner: "o",
        repo: "r",
        pullNumber: 7,
        localRepoPath: "/x",
      },
      contextMode: "hybrid",
      dryRun: true,
      indexOnly: false,
    },
  );
});

unitTest(
  "compatibility entry point still honors injected dependencies",
  async () => {
    const result = await runReviewPipeline(cliArgs, {
      model: { provider: "test", review: async () => cleanResult() },
      config: testConfig,
      source: makeSource([sourceFile("a.ts")]),
    });
    assert.equal(result.status, "complete");
  },
);
