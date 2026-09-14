import assert from "node:assert/strict";
import { executeModel } from "../src/model/execution.js";
import { ModelError, type ReviewModel } from "../src/model/types.js";
import { unitTest } from "./helpers.js";
const request = { system: "s", user: "u", model: "m", maxOutputTokens: 10 };
unitTest("model retries are bounded in one layer", async () => {
  let calls = 0;
  const model: ReviewModel = {
    provider: "test",
    async review() {
      calls++;
      if (calls < 3) throw new ModelError("temporary", true);
      return {
        response: {
          findings: [],
          summary: "ok",
          abstained: false,
          abstentionReason: null,
        },
        usage: { inputTokens: 1, outputTokens: 1, actual: true },
      };
    },
  };
  const value = await executeModel({
    model,
    request,
    runId: "r",
    filename: "a.ts",
    maxAttempts: 3,
    requestTimeoutMs: 1000,
    totalSignal: new AbortController().signal,
    events: () => undefined,
  });
  assert.equal(value.attempts, 3);
  assert.equal(calls, 3);
});
unitTest("permanent model errors are not retried", async () => {
  let calls = 0;
  const model: ReviewModel = {
    provider: "test",
    async review() {
      calls++;
      throw new ModelError("auth", false);
    },
  };
  await assert.rejects(
    executeModel({
      model,
      request,
      runId: "r",
      filename: "a.ts",
      maxAttempts: 5,
      requestTimeoutMs: 1000,
      totalSignal: new AbortController().signal,
      events: () => undefined,
    }),
    /auth/,
  );
  assert.equal(calls, 1);
});
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
            reject(new ModelError("aborted", true));
          },
          { once: true },
        );
      });
    },
  };
  await assert.rejects(
    executeModel({
      model,
      request,
      runId: "r",
      filename: "a.ts",
      maxAttempts: 3,
      requestTimeoutMs: 10,
      totalSignal: new AbortController().signal,
      events: () => undefined,
    }),
    /aborted/,
  );
  assert.equal(calls, 1);
});
