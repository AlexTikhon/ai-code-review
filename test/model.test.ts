import assert from "node:assert/strict";
import { ExternalRequestBudget } from "../src/model/budget.js";
import { ReviewModelError } from "../src/model/errors.js";
import { executeModel } from "../src/model/execution.js";
import type { ReviewEvent } from "../src/observability/events.js";
import type { ReviewModel } from "../src/model/types.js";
import { modelError } from "./model-fixtures.js";
import { unitTest } from "./helpers.js";

const request = { system: "s", user: "u", model: "m", maxOutputTokens: 10 };
const okResult = {
  response: {
    findings: [],
    summary: "ok",
    abstained: false,
    abstentionReason: null,
  },
  usage: { inputTokens: 1, outputTokens: 1, actual: true },
};
const run = (
  model: ReviewModel,
  extra: Partial<Parameters<typeof executeModel>[0]> = {},
) =>
  executeModel({
    model,
    request,
    runId: "r",
    filename: "a.ts",
    maxAttempts: 3,
    requestTimeoutMs: 1000,
    totalSignal: new AbortController().signal,
    events: () => undefined,
    ...extra,
  });

unitTest("model retries are bounded in one layer", async () => {
  let calls = 0;
  const model: ReviewModel = {
    provider: "test",
    async review() {
      calls++;
      if (calls < 3) throw modelError("temporary", true, 1);
      return okResult;
    },
  };
  const value = await run(model);
  assert.equal(value.ok, true);
  assert.equal(value.attempts, 3);
  assert.equal(calls, 3);
});

unitTest("a permanent typed error is attempted exactly once", async () => {
  let calls = 0;
  const model: ReviewModel = {
    provider: "test",
    async review() {
      calls++;
      throw modelError("auth", false, undefined, "authentication");
    },
  };
  const value = await run(model, { maxAttempts: 5 });
  assert.equal(calls, 1);
  assert.equal(value.ok, false);
  if (value.ok) return;
  assert.equal(value.attempts, 1);
  assert.ok(value.error instanceof ReviewModelError);
  assert.equal(value.error.kind, "authentication");
});

unitTest("a retryable typed error retries until attempts run out", async () => {
  let calls = 0;
  const model: ReviewModel = {
    provider: "test",
    async review() {
      calls++;
      throw modelError("limited", true, 1, "rate_limit");
    },
  };
  const value = await run(model, { maxAttempts: 3 });
  assert.equal(calls, 3);
  assert.equal(value.ok, false);
  if (value.ok) return;
  assert.equal(value.attempts, 3);
  assert.ok(value.error instanceof ReviewModelError);
  assert.equal(value.error.kind, "rate_limit");
});

unitTest("retry-after is honored but capped", async () => {
  const waits: number[] = [];
  const events: ReviewEvent[] = [];
  let calls = 0;
  const model: ReviewModel = {
    provider: "test",
    async review() {
      calls++;
      if (calls === 1) throw modelError("limited", true, 5, "rate_limit");
      return okResult;
    },
  };
  const started = Date.now();
  const value = await run(model, { events: (event) => events.push(event) });
  waits.push(Date.now() - started);
  assert.equal(value.ok, true);
  const retry = events.find((event) => event.type === "warning");
  assert.equal(retry?.data?.waitMs, 5, "waits exactly the provider's value");
  assert.equal(retry?.data?.kind, "rate_limit");
  assert.ok(waits[0]! < 1000);
});

unitTest(
  "an untyped error from an adapter is unknown and not retried",
  async () => {
    let calls = 0;
    const model: ReviewModel = {
      provider: "test",
      async review() {
        calls++;
        throw new TypeError("raw fetch failure");
      },
    };
    const value = await run(model);
    assert.equal(calls, 1, "classification belongs to the adapter");
    assert.equal(value.ok, false);
    if (value.ok) return;
    assert.ok(value.error instanceof ReviewModelError);
    assert.equal(value.error.kind, "unknown");
    assert.ok(!value.error.message.includes("raw fetch failure"));
  },
);

unitTest("request cancellation aborts without multiplied retries", async () => {
  let calls = 0;
  const model: ReviewModel = {
    provider: "test",
    review(_request, signal) {
      calls++;
      return new Promise((_resolve, reject) => {
        const hold = setTimeout(() => reject(new Error("test hung")), 1000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(hold);
            reject(modelError("timed out", true, undefined, "timeout"));
          },
          { once: true },
        );
      });
    },
  };
  const value = await run(model, { requestTimeoutMs: 10 });
  assert.equal(calls, 1, "a timed-out attempt is never duplicated");
  assert.equal(value.ok, false);
  if (value.ok) return;
  assert.ok(value.error instanceof ReviewModelError);
  assert.equal(value.error.kind, "timeout");
});

unitTest(
  "a fired deadline prevents any retry and reports aborted",
  async () => {
    const controller = new AbortController();
    let calls = 0;
    const model: ReviewModel = {
      provider: "test",
      async review() {
        calls++;
        controller.abort();
        throw modelError("limited", true, 1, "rate_limit");
      },
    };
    const value = await run(model, { totalSignal: controller.signal });
    assert.equal(calls, 1);
    assert.equal(value.ok, false);
    if (value.ok) return;
    assert.ok(value.error instanceof ReviewModelError);
    assert.equal(value.error.kind, "aborted");
    assert.equal(value.error.retryable, false);
  },
);

unitTest("an already-aborted deadline starts no attempt", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const model: ReviewModel = {
    provider: "test",
    async review() {
      calls++;
      return okResult;
    },
  };
  const value = await run(model, { totalSignal: controller.signal });
  assert.equal(calls, 0);
  assert.equal(value.ok, false);
  assert.equal(value.attempts, 0);
});

unitTest(
  "every retry consumes budget and exhaustion stops retries",
  async () => {
    const budget = new ExternalRequestBudget(2, new AbortController().signal);
    let calls = 0;
    const model: ReviewModel = {
      provider: "test",
      async review() {
        calls++;
        throw modelError("limited", true, 1, "rate_limit");
      },
    };
    const value = await run(model, {
      maxAttempts: 5,
      beforeAttempt: () => budget.reserve("model"),
    });
    assert.equal(calls, 2, "the third attempt never starts");
    assert.equal(budget.consumed, 2);
    assert.equal(value.ok, false);
    if (value.ok) return;
    assert.equal(value.attempts, 2, "only attempts actually made are reported");
    assert.equal(
      (value.error as { code?: string }).code,
      "REQUEST_BUDGET_EXHAUSTED",
    );
  },
);
