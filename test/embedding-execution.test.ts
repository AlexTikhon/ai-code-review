import assert from "node:assert/strict";
import {
  ExternalRequestBudget,
  RequestBudgetError,
} from "../src/model/budget.js";
import { EmbeddingError } from "../src/retrieval/embedding-errors.js";
import {
  DEFAULT_EMBEDDING_RETRY_POLICY,
  executeEmbeddingRequest,
  retryDelayMs,
  validateEmbeddingRetryPolicy,
  type EmbeddingExecutionEvent,
  type EmbeddingExecutionOptions,
} from "../src/retrieval/embedding-execution.js";
import { OpenAIEmbeddingAdapter } from "../src/retrieval/embeddings.js";
import {
  attemptTimeout,
  networkReset,
  rateLimit,
  scriptedEmbedding,
  unauthorized,
  unavailable,
} from "./embedding-fakes.js";
import { unitTest } from "./helpers.js";

const TEXTS = ["alpha", "beta"];
const policy = (maxAttempts = 3) => ({
  maxAttempts,
  baseDelayMs: 100,
  maxDelayMs: 1000,
});

/** Harness: real ExternalRequestBudget, recorded sleeps, no timers. */
function harness(
  options: {
    limit?: number;
    signal?: AbortSignal;
    maxAttempts?: number;
    sleep?: EmbeddingExecutionOptions["sleep"];
    remainingMs?: () => number;
    random?: () => number;
    attemptTimeoutMs?: number;
  } = {},
) {
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const budget = new ExternalRequestBudget(options.limit ?? 100, signal);
  const sleeps: number[] = [];
  const events: EmbeddingExecutionEvent[] = [];
  const run = (
    adapter: Parameters<typeof executeEmbeddingRequest>[0]["adapter"],
  ) =>
    executeEmbeddingRequest({
      adapter,
      texts: TEXTS,
      signal,
      beforeAttempt: () => budget.reserve("embedding"),
      budgetRemaining: () => budget.remaining,
      policy: policy(options.maxAttempts),
      attemptTimeoutMs: options.attemptTimeoutMs,
      remainingMs: options.remainingMs,
      onEvent: (event) => events.push(event),
      random: options.random ?? (() => 1),
      sleep:
        options.sleep ??
        (async (ms) => {
          sleeps.push(ms);
        }),
    });
  return { run, budget, sleeps, events, controller };
}
const expectError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the request to fail");
};

unitTest("a first-attempt success costs exactly one budget unit", async () => {
  const { adapter, state } = scriptedEmbedding();
  const h = harness();
  const result = await h.run(adapter);
  assert.equal(result.attempts, 1);
  assert.equal(result.vectors.length, 2);
  assert.equal(result.dimensions, 64);
  assert.equal(state.attempts, 1);
  assert.equal(h.budget.consumed, 1);
  assert.deepEqual(h.sleeps, []);
});

unitTest("a transient failure then success consumes two units", async () => {
  const { adapter, state } = scriptedEmbedding({ 1: unavailable() });
  const h = harness();
  const result = await h.run(adapter);
  assert.equal(result.attempts, 2);
  assert.equal(state.attempts, 2);
  assert.equal(h.budget.consumed, 2, "a retry is never free");
  assert.equal(h.budget.consumedBy("embedding"), 2);
  assert.equal(h.sleeps.length, 1);
});

unitTest(
  "repeated transient failures stop at maxAttempts with the last error",
  async () => {
    const { adapter, state } = scriptedEmbedding({
      1: unavailable(503),
      2: unavailable(503),
      3: unavailable(502),
      4: unavailable(500),
    });
    const h = harness({ maxAttempts: 3 });
    const error = await expectError(h.run(adapter));
    assert.ok(error instanceof EmbeddingError);
    assert.equal(error.kind, "provider_unavailable");
    assert.equal(error.statusCode, 502, "the last attempt's error is reported");
    assert.equal(state.attempts, 3);
    assert.equal(h.budget.consumed, 3);
    assert.equal(h.sleeps.length, 2, "no wait after the final attempt");
  },
);

unitTest("permanent failures are not retried", async () => {
  for (const failure of [
    unauthorized(),
    new EmbeddingError({
      kind: "invalid_request",
      provider: "fake",
      message: "m",
    }),
    new EmbeddingError({
      kind: "unsupported_model",
      provider: "fake",
      message: "m",
    }),
  ]) {
    const { adapter, state } = scriptedEmbedding({ 1: failure });
    const h = harness();
    const error = await expectError(h.run(adapter));
    assert.equal(error, failure, "the typed error is passed through intact");
    assert.equal(state.attempts, 1);
    assert.equal(h.budget.consumed, 1);
    assert.deepEqual(h.sleeps, []);
  }
});

unitTest("network, timeout and rate-limit failures are retried", async () => {
  for (const failure of [networkReset(), attemptTimeout(), rateLimit()]) {
    const { adapter, state } = scriptedEmbedding({ 1: failure });
    const h = harness();
    const result = await h.run(adapter);
    assert.equal(result.attempts, 2, failure.kind);
    assert.equal(state.attempts, 2);
  }
});

unitTest(
  "an unclassified error from an adapter is wrapped, never retried",
  async () => {
    const { adapter, state } = scriptedEmbedding({ 1: new RangeError("odd") });
    const h = harness();
    const error = await expectError(h.run(adapter));
    assert.ok(error instanceof EmbeddingError);
    assert.equal(error.kind, "unknown");
    assert.equal(error.retryable, false);
    assert.equal(state.attempts, 1);
  },
);

unitTest(
  "Retry-After is honored and clamped to the maximum delay",
  async () => {
    const honored = scriptedEmbedding({ 1: rateLimit(700) });
    const a = harness();
    await a.run(honored.adapter);
    assert.deepEqual(a.sleeps, [700], "exactly the provider's wait, no jitter");

    const hostile = scriptedEmbedding({ 1: rateLimit(3_600_000) });
    const b = harness();
    await b.run(hostile.adapter);
    assert.deepEqual(
      b.sleeps,
      [1000],
      "an hour-long header waits at most maxDelayMs",
    );
  },
);

unitTest(
  "without Retry-After the delay is bounded exponential backoff with jitter",
  () => {
    const p = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };
    const at = (attempt: number, random: number) =>
      retryDelayMs({ attempt, policy: p, random: () => random });
    // random=1 -> the full backoff step; random=0 -> half of it.
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((n) => at(n, 1)),
      [100, 200, 400, 800, 1000],
    );
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((n) => at(n, 0)),
      [50, 100, 200, 400, 500],
    );
    for (let attempt = 1; attempt <= 30; attempt++)
      for (const random of [0, 0.25, 0.5, 0.999, 1]) {
        const wait = at(attempt, random);
        assert.ok(wait >= 0 && wait <= p.maxDelayMs, `${attempt}/${random}`);
        assert.ok(Number.isInteger(wait));
      }
    // Invalid Retry-After values fall back to backoff.
    for (const retryAfterMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY])
      assert.equal(
        retryDelayMs({ attempt: 1, policy: p, random: () => 1, retryAfterMs }),
        100,
      );
    assert.equal(
      retryDelayMs({
        attempt: 1,
        policy: { ...p, baseDelayMs: 0 },
        random: () => 1,
      }),
      0,
    );
  },
);

unitTest("the default policy is conservative", () => {
  assert.deepEqual(DEFAULT_EMBEDDING_RETRY_POLICY, {
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 10_000,
  });
});

unitTest("retry policy validation rejects nonsensical values", () => {
  const good = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 10 };
  assert.deepEqual(validateEmbeddingRetryPolicy(good), good);
  for (const bad of [
    { ...good, maxAttempts: 0 },
    { ...good, maxAttempts: 1.5 },
    { ...good, maxAttempts: Number.NaN },
    { ...good, maxAttempts: Number.POSITIVE_INFINITY },
    { ...good, baseDelayMs: -1 },
    { ...good, baseDelayMs: Number.NaN },
    { ...good, baseDelayMs: Number.POSITIVE_INFINITY },
    { ...good, maxDelayMs: -1 },
    { ...good, baseDelayMs: 20, maxDelayMs: 10 },
  ])
    assert.throws(
      () => validateEmbeddingRetryPolicy(bad),
      /retry/i,
      JSON.stringify(bad),
    );
});

unitTest(
  "an already-aborted signal makes zero attempts and consumes nothing",
  async () => {
    const { adapter, state } = scriptedEmbedding();
    const h = harness();
    h.controller.abort();
    const error = await expectError(h.run(adapter));
    assert.ok(error instanceof EmbeddingError);
    assert.equal(error.kind, "aborted");
    assert.equal(state.attempts, 0);
    assert.equal(h.budget.consumed, 0);
  },
);

unitTest("aborting a request in flight ends it without a retry", async () => {
  const { adapter, state } = scriptedEmbedding();
  state.hang.add(1);
  const h = harness();
  const pending = h.run(adapter);
  h.controller.abort();
  const error = await expectError(pending);
  assert.ok(error instanceof EmbeddingError);
  assert.equal(error.kind, "aborted");
  assert.equal(state.attempts, 1);
  assert.equal(h.budget.consumed, 1, "the started attempt was counted");
  assert.deepEqual(h.sleeps, []);
});

unitTest(
  "aborting during the retry wait stops the wait and starts no request",
  async () => {
    const { adapter, state } = scriptedEmbedding({ 1: rateLimit(5000) });
    let waiting = false;
    const h = harness({
      sleep: (_ms, signal) =>
        new Promise<void>((_resolve, reject) => {
          waiting = true;
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    const pending = h.run(adapter);
    while (!waiting) await Promise.resolve();
    assert.equal(
      h.budget.consumed,
      1,
      "the retry is not reserved before it starts",
    );
    h.controller.abort();
    const error = await expectError(pending);
    assert.ok(error instanceof EmbeddingError);
    assert.equal(error.kind, "aborted");
    assert.equal(state.attempts, 1, "no next request");
    assert.equal(
      h.budget.consumed,
      1,
      "cancelling the wait consumed nothing more",
    );
  },
);

unitTest(
  "a retry does not start when the remaining deadline is shorter than the wait",
  async () => {
    const { adapter, state } = scriptedEmbedding({ 1: rateLimit(500) });
    const h = harness({ remainingMs: () => 200 });
    const error = await expectError(h.run(adapter));
    assert.ok(error instanceof EmbeddingError);
    assert.equal(error.kind, "timeout");
    assert.equal(error.retryable, false);
    assert.match(error.message, /deadline/i);
    assert.equal(state.attempts, 1);
    assert.equal(h.budget.consumed, 1);
    assert.deepEqual(h.sleeps, [], "no wait was started just to time out");

    // With enough time left the same failure retries normally.
    const ample = scriptedEmbedding({ 1: rateLimit(500) });
    const b = harness({ remainingMs: () => 5000 });
    assert.equal((await b.run(ample.adapter)).attempts, 2);
    assert.deepEqual(b.sleeps, [500]);
  },
);

unitTest(
  "budget exhaustion stops retrying and is not a provider error",
  async () => {
    const { adapter, state } = scriptedEmbedding(
      Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [i + 1, unavailable()]),
      ),
    );
    const h = harness({ limit: 5, maxAttempts: 20 });
    const error = await expectError(h.run(adapter));
    assert.ok(error instanceof RequestBudgetError, String(error));
    assert.equal(error.code, "REQUEST_BUDGET_EXHAUSTED");
    assert.equal(state.attempts, 5, "no sixth request starts");
    assert.equal(h.budget.consumed, 5);
    const failed = h.events.at(-1);
    assert.equal(failed?.type, "request_failed");
    assert.equal(failed?.errorKind, "budget_exhausted");
  },
);

unitTest("a missing credential costs no budget and no request", async () => {
  let ready = 0;
  const { adapter, state } = scriptedEmbedding(
    {},
    {
      assertReady() {
        ready++;
        throw unauthorized();
      },
    },
  );
  const h = harness();
  const error = await expectError(h.run(adapter));
  assert.ok(error instanceof EmbeddingError);
  assert.equal(error.kind, "authentication");
  assert.equal(ready, 1);
  assert.equal(state.attempts, 0);
  assert.equal(h.budget.consumed, 0);
});

unitTest(
  "a non-budget failure of the reservation hook is not swallowed or retried",
  async () => {
    const { adapter, state } = scriptedEmbedding();
    let reserved = 0;
    const error = await expectError(
      executeEmbeddingRequest({
        adapter,
        texts: TEXTS,
        beforeAttempt: () => {
          reserved++;
          throw new Error("budget exhausted");
        },
        policy: policy(),
      }),
    );
    assert.match(String(error), /budget exhausted/);
    assert.equal(reserved, 1);
    assert.equal(state.attempts, 0);
  },
);

unitTest(
  "malformed provider output is permanent: no second paid request",
  async () => {
    const dropOne = scriptedEmbedding();
    dropOne.state.respond = (_attempt, vectors) => vectors.slice(1);
    const a = harness();
    const error = await expectError(a.run(dropOne.adapter));
    assert.ok(error instanceof EmbeddingError);
    assert.equal(error.kind, "malformed_response");
    assert.match(error.message, /does not match request count/);
    assert.equal(dropOne.state.attempts, 1);
    assert.equal(a.budget.consumed, 1);

    const wrongDims = scriptedEmbedding();
    wrongDims.state.respond = (_attempt, vectors) =>
      vectors.map((v) => v.slice(1));
    const b = harness();
    const mismatch = await expectError(b.run(wrongDims.adapter));
    assert.ok(mismatch instanceof EmbeddingError);
    assert.equal(mismatch.kind, "dimension_mismatch");
    assert.equal(wrongDims.state.attempts, 1);

    const nonFinite = scriptedEmbedding();
    nonFinite.state.respond = (_attempt, vectors) =>
      vectors.map((v) => v.map(() => Number.NaN));
    const c = harness();
    const bad = await expectError(c.run(nonFinite.adapter));
    assert.ok(bad instanceof EmbeddingError);
    assert.equal(bad.kind, "malformed_response");
  },
);

unitTest(
  "each attempt gets its own timeout signal tied to the caller's",
  async () => {
    const { adapter, state } = scriptedEmbedding({ 1: attemptTimeout() });
    const h = harness({ attemptTimeoutMs: 60_000 });
    await h.run(adapter);
    const [first, second] = state.signals;
    assert.ok(first && second);
    assert.notEqual(first, second, "a fresh attempt signal per attempt");
    assert.notEqual(first, h.controller.signal);
    assert.equal(second.aborted, false);
    h.controller.abort();
    assert.equal(
      second.aborted,
      true,
      "the caller's abort reaches the attempt",
    );
  },
);

unitTest(
  "events describe attempts without text, vectors or secrets",
  async () => {
    const { adapter } = scriptedEmbedding({ 1: rateLimit(300) });
    const h = harness({ limit: 10 });
    await h.run(adapter);
    assert.deepEqual(
      h.events.map((event) => event.type),
      [
        "request_started",
        "request_retry",
        "request_started",
        "request_succeeded",
      ],
    );
    const [started, retry, , succeeded] = h.events;
    assert.equal(started?.provider, "fake");
    assert.equal(started?.model, "hash-test");
    assert.equal(started?.attempt, 1);
    assert.equal(started?.batchSize, 2);
    assert.equal(started?.budgetRemaining, 9);
    assert.equal(retry?.errorKind, "rate_limit");
    assert.equal(retry?.retryable, true);
    assert.equal(retry?.retryAfterMs, 300);
    assert.equal(retry?.waitMs, 300);
    assert.equal(succeeded?.attempt, 2);
    assert.equal(typeof succeeded?.durationMs, "number");
    const text = JSON.stringify(h.events);
    for (const forbidden of [...TEXTS, "values", "Bearer"])
      assert.ok(!text.includes(forbidden), forbidden);
  },
);

unitTest(
  "one application attempt is exactly one HTTP request; there is no hidden retry layer",
  async () => {
    let fetches = 0;
    const responses = [503, 503, 200];
    const fetchImpl = (async () => {
      const status = responses[fetches++] ?? 500;
      return status === 200
        ? new Response(
            JSON.stringify({
              data: TEXTS.map((_, index) => ({
                index,
                embedding: Array.from({ length: 1536 }, () => 0.1),
              })),
            }),
          )
        : new Response("{}", { status });
    }) as unknown as typeof fetch;
    const adapter = new OpenAIEmbeddingAdapter(
      "text-embedding-3-small",
      "sk-test",
      "https://example.test/v1/embeddings",
      fetchImpl,
    );
    const h = harness();
    const result = await h.run(adapter);
    assert.equal(result.attempts, 3);
    assert.equal(
      fetches,
      3,
      "3 application attempts, 3 HTTP requests, not 3 x N",
    );
    assert.equal(h.budget.consumed, 3);

    // A permanent failure is a single request.
    fetches = 0;
    responses.splice(0, 3, 401);
    const h2 = harness();
    await expectError(h2.run(adapter));
    assert.equal(fetches, 1);
    assert.equal(h2.budget.consumed, 1);
  },
);
