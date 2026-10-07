import assert from "node:assert/strict";
import { ReviewModelError } from "../src/model/errors.js";
import type { ReviewModel } from "../src/model/types.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import type { ReviewResult } from "../src/review/types.js";
import {
  cleanResult,
  findingResult,
  makeSource,
  request,
  sourceFile,
  testConfig,
} from "./fixtures.js";
import { unitTest } from "./helpers.js";

const source = () => makeSource([sourceFile("a.ts")]);
const typed = (
  kind: ConstructorParameters<typeof ReviewModelError>[0]["kind"],
  extra: Partial<ConstructorParameters<typeof ReviewModelError>[0]> = {},
) =>
  new ReviewModelError({
    kind,
    provider: "anthropic",
    message: `${kind} happened`,
    ...extra,
  });
const review = (model: ReviewModel, config = testConfig) =>
  executeReviewPipeline(request, config, { model, source: source() });
const failing = (error: ReviewModelError): ReviewModel => ({
  provider: "anthropic",
  async review() {
    throw error;
  },
});

/** No failure mode may be mistaken for a reviewed-and-clean result. */
function assertNeverClean(result: ReviewResult) {
  assert.notEqual(result.status, "complete");
  assert.equal(result.coverage.reviewed, 0);
  assert.equal(result.coverage.failed, 1);
  assert.equal(result.findings.length, 0);
  assert.ok(result.errors.length > 0);
  assert.match(result.summary, /not clean|unreviewed/);
}

unitTest(
  "a provider failure carries a stable code, provider and retryability",
  async () => {
    const result = await review(
      failing(typed("rate_limit", { statusCode: 429 })),
    );
    assertNeverClean(result);
    const error = result.errors[0]!;
    assert.equal(error.stage, "analyze");
    assert.equal(error.code, "MODEL_RATE_LIMIT");
    assert.equal(error.provider, "anthropic");
    assert.equal(error.retryable, true);
    assert.equal(error.filename, "a.ts");
  },
);

unitTest("every model failure kind maps to its own code", async () => {
  const expected: Array<[Parameters<typeof typed>[0], string]> = [
    ["authentication", "MODEL_AUTHENTICATION"],
    ["timeout", "MODEL_TIMEOUT"],
    ["network", "MODEL_NETWORK"],
    ["provider_unavailable", "MODEL_PROVIDER_UNAVAILABLE"],
    ["invalid_request", "MODEL_INVALID_REQUEST"],
    ["unsupported_model", "MODEL_UNSUPPORTED_MODEL"],
    ["malformed_response", "MODEL_MALFORMED_RESPONSE"],
    ["response_truncated", "MODEL_RESPONSE_TRUNCATED"],
    ["refused", "MODEL_REFUSED"],
    ["unknown", "MODEL_UNKNOWN"],
  ];
  for (const [kind, code] of expected) {
    const result = await review(failing(typed(kind, { retryable: false })));
    assertNeverClean(result);
    assert.equal(result.errors[0]?.code, code);
    assert.equal(result.errors[0]?.retryable, false);
  }
});

unitTest(
  "provider failure, bad evidence and a clean review are three different results",
  async () => {
    const provider = await review(failing(typed("authentication")));
    const invented = await review({
      provider: "test",
      async review() {
        return findingResult("a.ts", 999);
      },
    });
    const clean = await review({
      provider: "test",
      async review() {
        return cleanResult();
      },
    });
    assert.equal(provider.errors[0]?.code, "MODEL_AUTHENTICATION");
    assert.equal(invented.errors[0]?.code, "MODEL_INVALID_EVIDENCE");
    assert.deepEqual(clean.errors, []);
    assert.equal(clean.status, "complete");
    assert.equal(clean.coverage.reviewed, 1);
    assertNeverClean(provider);
    assertNeverClean(invented);
  },
);

unitTest(
  "a truncated response is surfaced once, never retried, never partial",
  async () => {
    let calls = 0;
    const result = await review(
      {
        provider: "anthropic",
        async review() {
          calls++;
          throw typed("response_truncated");
        },
      },
      { ...testConfig, maxAttempts: 3 },
    );
    assert.equal(calls, 1);
    assert.equal(result.usage.attempts, 1);
    assert.equal(result.errors[0]?.code, "MODEL_RESPONSE_TRUNCATED");
    assertNeverClean(result);
  },
);

unitTest(
  "malformed output is retried within the attempt limit, then reported",
  async () => {
    let calls = 0;
    const result = await review(
      {
        provider: "anthropic",
        async review() {
          calls++;
          throw typed("malformed_response", { retryAfterMs: 1 });
        },
      },
      { ...testConfig, maxAttempts: 2 },
    );
    assert.equal(calls, 2);
    assert.equal(result.usage.actualRequests, 2);
    assert.equal(result.errors[0]?.code, "MODEL_MALFORMED_RESPONSE");
    assertNeverClean(result);
  },
);

unitTest(
  "invalid evidence is not retried and its tokens are still accounted",
  async () => {
    let calls = 0;
    const result = await review(
      {
        provider: "test",
        async review() {
          calls++;
          return findingResult("a.ts", 999);
        },
      },
      { ...testConfig, maxAttempts: 3 },
    );
    assert.equal(calls, 1);
    assert.equal(result.errors[0]?.code, "MODEL_INVALID_EVIDENCE");
    assert.equal(result.usage.inputTokens, 5, "paid tokens stay visible");
    assert.equal(result.usage.outputTokens, 2);
    assertNeverClean(result);
  },
);

unitTest("an exhausted request budget has its own code", async () => {
  const result = await review(
    failing(typed("rate_limit", { retryAfterMs: 1 })),
    { ...testConfig, maxAttempts: 5, maxRequests: 2 },
  );
  assert.equal(result.usage.actualRequests, 2);
  assert.equal(result.errors[0]?.code, "REQUEST_BUDGET_EXHAUSTED");
  assertNeverClean(result);
});

unitTest(
  "a deadline abort is REVIEW_ABORTED, not a provider fault",
  async () => {
    const result = await review(
      {
        provider: "anthropic",
        review(_request, signal) {
          const keepAlive = setInterval(() => undefined, 1000);
          return new Promise((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => {
                clearInterval(keepAlive);
                reject(typed("aborted"));
              },
              { once: true },
            ),
          );
        },
      },
      { ...testConfig, totalTimeoutMs: 30 },
    );
    assert.equal(result.errors[0]?.code, "REVIEW_ABORTED");
    assertNeverClean(result);
  },
);

unitTest(
  "an impossible request budget fails before any call or source work",
  async () => {
    let calls = 0;
    const events: string[] = [];
    const result = await executeReviewPipeline(
      request,
      { ...testConfig, maxInputTokens: 300, maxOutputTokens: 200 },
      {
        model: {
          provider: "test",
          async review() {
            calls++;
            return cleanResult();
          },
        },
        events: (event) => events.push(event.stage),
        source: source(),
      },
    );
    assert.equal(calls, 0);
    assert.equal(result.status, "failed");
    assert.equal(result.errors[0]?.stage, "config");
    assert.equal(result.errors[0]?.fatal, true);
    assert.match(result.errors[0]?.message ?? "", /AI_REVIEW_MAX_INPUT_TOKENS/);
    assert.ok(!events.includes("ingest"), "no source work before the check");
    assert.equal(result.coverage.reviewed, 0);
    assert.equal(result.findings.length, 0);
  },
);

unitTest(
  "typed failures never put secrets or source into results",
  async () => {
    const secret = "sk-secret-value";
    const result = await review(
      failing(
        typed("authentication", {
          message: "Anthropic error 401: invalid x-api-key",
        }),
      ),
    );
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes("safe()"), "source must not be echoed");
  },
);
