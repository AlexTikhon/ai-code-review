import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewCacheKey } from "../src/cache/review-cache.js";
import { createProviders } from "../src/cli/providers.js";
import { runReview } from "../src/cli/run-review.js";
import { loadConfig, selectedModelName } from "../src/config/config.js";
import { AnthropicReviewModel } from "../src/model/anthropic.js";
import { OpenAIReviewModel } from "../src/model/openai.js";
import type { ReviewModel } from "../src/model/types.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import {
  cleanResult,
  cliArgs,
  makeSource,
  request,
  sourceFile,
  testConfig,
} from "./fixtures.js";
import { unitTest } from "./helpers.js";

const ENV_KEYS = [
  "AI_REVIEW_PROVIDER",
  "AI_REVIEW_MODEL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_API_KEY",
  "AI_REVIEW_ALLOW_EXTERNAL",
] as const;
async function withEnv<T>(
  vars: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  run: () => T | Promise<T>,
): Promise<T> {
  const saved = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, vars);
  try {
    return await run();
  } finally {
    for (const key of ENV_KEYS)
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  }
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const cleanMessage = () =>
  json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "m",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          findings: [],
          summary: "ok",
          abstained: false,
          abstentionReason: null,
        }),
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 9, output_tokens: 3 },
  });
const failing = (status: number, headers: HeadersInit = {}) =>
  json(
    { type: "error", error: { type: "api_error", message: "x" } },
    status,
    headers,
  );

function fakeApi(respond: (call: number) => Response) {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return respond(bodies.length);
  }) as typeof fetch;
  return {
    bodies,
    model: new AnthropicReviewModel({
      apiKey: "sk-ant-test",
      fetch: fetchImpl,
    }),
  };
}

// ------------------------------------------------------------- configuration

unitTest(
  "the default review provider is the pre-existing OpenAI behavior",
  () =>
    withEnv({}, () => {
      const config = loadConfig({ allowExternal: false });
      assert.equal(config.reviewProvider, "openai");
      assert.equal(config.model, "gpt-4o-mini");
      assert.equal(selectedModelName(), "gpt-4o-mini");
    }),
);

unitTest(
  "review provider and model are chosen explicitly and independently",
  async () => {
    await withEnv(
      { AI_REVIEW_PROVIDER: "openai", AI_REVIEW_MODEL: "gpt-x" },
      () => {
        const config = loadConfig({ allowExternal: false });
        assert.deepEqual(
          [config.reviewProvider, config.model],
          ["openai", "gpt-x"],
        );
      },
    );
    await withEnv({ AI_REVIEW_PROVIDER: "anthropic" }, () => {
      const config = loadConfig({ allowExternal: false });
      assert.equal(config.reviewProvider, "anthropic");
      assert.match(config.model, /^claude-/);
    });
    await withEnv(
      {
        AI_REVIEW_PROVIDER: "anthropic",
        ANTHROPIC_MODEL: "claude-custom",
        AI_REVIEW_MODEL: "gpt-4o-mini",
      },
      () => {
        const config = loadConfig({ allowExternal: false });
        assert.equal(
          config.model,
          "claude-custom",
          "an OpenAI model name is never sent to Anthropic",
        );
      },
    );
  },
);

unitTest("an unknown review provider is a configuration error", async () => {
  await withEnv({ AI_REVIEW_PROVIDER: "foo" }, () => {
    assert.throws(
      () => loadConfig({ allowExternal: false }),
      /AI_REVIEW_PROVIDER must be one of openai, anthropic/,
    );
    assert.equal(selectedModelName(), "gpt-4o-mini", "reporting never throws");
  });
  await withEnv(
    { AI_REVIEW_PROVIDER: "foo", AI_REVIEW_ALLOW_EXTERNAL: "true" },
    async () => {
      const result = await runReview(
        { ...cliArgs, allowExternal: true },
        { source: makeSource([sourceFile("a.ts")]) },
      );
      assert.equal(result.status, "failed");
      assert.match(result.errors[0]?.message ?? "", /AI_REVIEW_PROVIDER/);
      assert.equal(result.usage.actualRequests, 0);
    },
  );
});

unitTest(
  "composition selects the review model and keeps embeddings independent",
  () => {
    const external = { ...testConfig, allowExternal: true };
    const hybrid = { contextMode: "hybrid" as const };
    const pick = (config: typeof external) => createProviders(config, hybrid);
    assert.equal(
      pick({ ...external, reviewProvider: "openai" }).model?.provider,
      "openai",
    );
    assert.equal(
      pick({ ...external, reviewProvider: "anthropic" }).model?.provider,
      "anthropic",
    );
    const anthropicOnly = pick({ ...external, reviewProvider: "anthropic" });
    assert.ok(anthropicOnly.model instanceof AnthropicReviewModel);
    assert.equal(
      anthropicOnly.embedding,
      undefined,
      "Anthropic review needs no embeddings",
    );
    const hybridAnthropic = pick({
      ...external,
      reviewProvider: "anthropic",
      allowEmbeddings: true,
    });
    assert.equal(hybridAnthropic.model?.provider, "anthropic");
    assert.equal(
      hybridAnthropic.embedding?.provider,
      "openai",
      "Anthropic review + OpenAI embeddings",
    );
    const unauthorized = createProviders(
      { ...testConfig, reviewProvider: "anthropic" },
      hybrid,
    );
    assert.deepEqual(unauthorized, { model: undefined, embedding: undefined });
  },
);

// ------------------------------------------------------------------- privacy

unitTest(
  "an unauthorized Anthropic run never reaches the network",
  async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return cleanMessage();
    }) as typeof fetch;
    try {
      await withEnv(
        { AI_REVIEW_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test" },
        async () => {
          const result = await runReview(
            { ...cliArgs, allowExternal: false },
            { source: makeSource([sourceFile("a.ts")]) },
          );
          assert.equal(result.status, "failed");
          assert.match(
            result.errors[0]?.message ?? "",
            /External model transmission is disabled/,
          );
          assert.equal(result.usage.actualRequests, 0);
        },
      );
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(calls, 0);
  },
);

unitTest(
  "an Anthropic dry run needs no credentials and makes zero requests",
  async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return cleanMessage();
    }) as typeof fetch;
    try {
      await withEnv(
        { AI_REVIEW_PROVIDER: "anthropic", AI_REVIEW_ALLOW_EXTERNAL: "true" },
        async () => {
          for (const allowExternal of [false, true]) {
            const result = await runReview(
              { ...cliArgs, dryRun: true, allowExternal },
              { source: makeSource([sourceFile("a.ts")]) },
            );
            assert.equal(result.status, "partial");
            assert.equal(result.usage.actualRequests, 0);
            assert.equal(
              result.errors.length,
              0,
              "no credential error without a provider call",
            );
          }
        },
      );
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(calls, 0);
  },
);

unitTest(
  "a missing Anthropic key is a non-retried, secret-free file error",
  async () => {
    let calls = 0;
    const model = new AnthropicReviewModel({
      fetch: (async () => {
        calls++;
        return cleanMessage();
      }) as typeof fetch,
    });
    await withEnv({}, async () => {
      const result = await executeReviewPipeline(
        request,
        { ...testConfig, maxAttempts: 3 },
        { model, source: makeSource([sourceFile("a.ts")]) },
      );
      assert.equal(result.status, "failed");
      assert.match(
        result.errors[0]?.message ?? "",
        /Missing ANTHROPIC_API_KEY/,
      );
      assert.equal(result.usage.attempts, 1);
    });
    assert.equal(calls, 0, "no request was sent without credentials");
  },
);

unitTest(
  "sensitive files and their contents never reach the Anthropic request",
  async () => {
    const api = fakeApi(() => cleanMessage());
    const result = await executeReviewPipeline(request, testConfig, {
      model: api.model,
      source: makeSource([
        sourceFile(".env", "@@ -0,0 +1 @@\n+DB_PASSWORD=hunter2-live-secret"),
        sourceFile("a.ts"),
      ]),
    });
    assert.equal(result.status === "failed", false);
    assert.ok(api.bodies.length >= 1);
    for (const body of api.bodies) {
      assert.ok(
        !body.includes("hunter2-live-secret"),
        "secret contents leaked",
      );
      assert.ok(!body.includes(".env"), "sensitive path leaked");
      assert.ok(!body.includes("sk-ant-test"), "API key leaked into the body");
    }
  },
);

// --------------------------------------------------------------------- cache

unitTest(
  "OpenAI and Anthropic never share a cache identity for the same model name",
  () => {
    const req = {
      system: "s",
      user: "u",
      model: "model-x",
      maxOutputTokens: 10,
    };
    const openai = reviewCacheKey(req, new OpenAIReviewModel("k"));
    const anthropic = reviewCacheKey(
      req,
      new AnthropicReviewModel({ apiKey: "k" }),
    );
    assert.notEqual(openai, anthropic);
    assert.equal(
      anthropic,
      reviewCacheKey(
        req,
        new AnthropicReviewModel({ apiKey: "a-different-key" }),
      ),
      "credentials are not part of identity",
    );
  },
);

unitTest(
  "an Anthropic cache hit skips the API; another provider cannot reuse it",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "acr-anthropic-cache-"));
    const api = fakeApi(() => cleanMessage());
    const source = makeSource([sourceFile("a.ts")], { repositoryRoot: root });
    const first = await executeReviewPipeline(request, testConfig, {
      model: api.model,
      source,
    });
    const second = await executeReviewPipeline(
      request,
      { ...testConfig, maxRequests: 0 },
      { model: api.model, source },
    );
    assert.equal(first.usage.actualRequests, 1);
    assert.equal(second.status, "complete");
    assert.equal(second.usage.actualRequests, 0);
    assert.equal(second.usage.cacheHits, 1);
    assert.equal(api.bodies.length, 1, "the cache hit made no HTTP request");

    let openaiCalls = 0;
    const openai: ReviewModel = {
      provider: "openai",
      identity: new OpenAIReviewModel("k").identity,
      async review() {
        openaiCalls++;
        return cleanResult();
      },
    };
    await executeReviewPipeline(request, testConfig, { model: openai, source });
    assert.equal(
      openaiCalls,
      1,
      "OpenAI misses the entry the Anthropic run wrote",
    );
  },
);

// ------------------------------------------------------------ budget / retry

unitTest(
  "each Anthropic attempt, including retries, consumes one request",
  async () => {
    const api = fakeApi((call) =>
      call < 3 ? failing(500, { "retry-after-ms": "1" }) : cleanMessage(),
    );
    const result = await executeReviewPipeline(
      request,
      { ...testConfig, maxAttempts: 3, maxRequests: 10 },
      { model: api.model, source: makeSource([sourceFile("a.ts")]) },
    );
    assert.equal(result.status, "complete");
    assert.equal(api.bodies.length, 3);
    assert.equal(result.usage.actualRequests, 3);
    assert.equal(result.usage.attempts, 3);
    assert.equal(result.usage.inputTokens, 9);
    assert.equal(result.usage.outputTokens, 3);
  },
);

unitTest("budget exhaustion prevents an Anthropic retry", async () => {
  const api = fakeApi(() => failing(429, { "retry-after-ms": "1" }));
  const result = await executeReviewPipeline(
    request,
    { ...testConfig, maxAttempts: 3, maxRequests: 1 },
    { model: api.model, source: makeSource([sourceFile("a.ts")]) },
  );
  assert.equal(result.status, "failed");
  assert.equal(
    api.bodies.length,
    1,
    "the second attempt never reached the SDK",
  );
  assert.equal(result.usage.actualRequests, 1);
  assert.match(result.errors[0]?.message ?? "", /budget/i);
});

unitTest(
  "a non-retryable Anthropic error is attempted exactly once",
  async () => {
    const api = fakeApi(() => failing(401));
    const result = await executeReviewPipeline(
      request,
      { ...testConfig, maxAttempts: 3, maxRequests: 10 },
      { model: api.model, source: makeSource([sourceFile("a.ts")]) },
    );
    assert.equal(result.status, "failed");
    assert.equal(api.bodies.length, 1);
    assert.equal(result.usage.actualRequests, 1);
  },
);
