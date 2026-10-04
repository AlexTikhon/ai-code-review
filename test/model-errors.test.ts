import assert from "node:assert/strict";
import { AnthropicReviewModel } from "../src/model/anthropic.js";
import {
  MODEL_ERROR_KINDS,
  ReviewModelError,
  modelErrorCode,
  type ModelErrorKind,
} from "../src/model/errors.js";
import { OpenAIReviewModel } from "../src/model/openai.js";
import type { ReviewModel } from "../src/model/types.js";
import { unitTest } from "./helpers.js";

const KEY = "sk-test-secret-key-0123456789";
const request = {
  system: "SYS",
  user: "USER",
  model: "m",
  maxOutputTokens: 50,
};
const review = {
  findings: [],
  summary: "s",
  abstained: false,
  abstentionReason: null,
};
const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

type Transport = () => Response | Promise<Response>;
type Provider = {
  name: "openai" | "anthropic";
  /** A model whose only link to the outside world is `transport`. */
  build(transport: Transport, apiKey?: string): ReviewModel;
  ok(
    payload: unknown,
    extra?: { truncated?: boolean; refused?: boolean },
  ): Response;
  error(status: number, headers?: HeadersInit): Response;
};
const asFetch = (transport: Transport) =>
  (async () => transport()) as unknown as typeof fetch;
const anthropicMessage = (text: string, stop = "end_turn") => ({
  id: "m",
  type: "message",
  role: "assistant",
  model: "m",
  content: [{ type: "text", text }],
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});
const asText = (payload: unknown) =>
  typeof payload === "string" ? payload : JSON.stringify(payload);

const providers: Provider[] = [
  {
    name: "openai",
    build: (transport, apiKey = KEY) =>
      new OpenAIReviewModel(apiKey, undefined, asFetch(transport)),
    ok: (payload, extra = {}) =>
      json({
        choices: [
          {
            finish_reason: extra.truncated
              ? "length"
              : extra.refused
                ? "content_filter"
                : "stop",
            message: { content: asText(payload) },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    error: (status, headers) =>
      json(
        {
          error: {
            message: `bad thing for ${KEY}`,
            type: "t",
            code: status === 404 ? "model_not_found" : "c",
          },
        },
        status,
        headers,
      ),
  },
  {
    name: "anthropic",
    build: (transport, apiKey = KEY) =>
      new AnthropicReviewModel({ apiKey, fetch: asFetch(transport) }),
    ok: (payload, extra = {}) =>
      json(
        anthropicMessage(
          asText(payload),
          extra.truncated
            ? "max_tokens"
            : extra.refused
              ? "refusal"
              : "end_turn",
        ),
      ),
    error: (status, headers) =>
      json(
        {
          type: "error",
          error: {
            type: status === 404 ? "not_found_error" : "api_error",
            message: `bad thing for ${KEY}`,
          },
        },
        status,
        headers,
      ),
  },
];

const live = () => new AbortController().signal;
async function failure(promise: Promise<unknown>): Promise<ReviewModelError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(
    error instanceof ReviewModelError,
    `expected ReviewModelError, got ${String(error)}`,
  );
  return error;
}

unitTest("model error kinds are a small closed set with stable codes", () => {
  assert.deepEqual([...MODEL_ERROR_KINDS].sort(), [
    "aborted",
    "authentication",
    "invalid_request",
    "malformed_response",
    "network",
    "provider_unavailable",
    "rate_limit",
    "refused",
    "response_truncated",
    "timeout",
    "unknown",
    "unsupported_model",
  ]);
  assert.equal(modelErrorCode("rate_limit"), "MODEL_RATE_LIMIT");
  assert.equal(
    modelErrorCode("response_truncated"),
    "MODEL_RESPONSE_TRUNCATED",
  );
});

unitTest(
  "both providers map the same HTTP status to the same domain kind",
  async () => {
    const table: Array<[number, ModelErrorKind, boolean]> = [
      [401, "authentication", false],
      [403, "authentication", false],
      [404, "unsupported_model", false],
      [400, "invalid_request", false],
      [422, "invalid_request", false],
      [408, "timeout", true],
      [429, "rate_limit", true],
      [500, "provider_unavailable", true],
      [503, "provider_unavailable", true],
      [529, "provider_unavailable", true],
    ];
    for (const provider of providers)
      for (const [status, kind, retryable] of table) {
        const error = await failure(
          provider.build(() => provider.error(status)).review(request, live()),
        );
        const label = `${provider.name} ${status}`;
        assert.equal(error.kind, kind, label);
        assert.equal(error.retryable, retryable, label);
        assert.equal(error.provider, provider.name, label);
        assert.equal(error.statusCode, status, label);
      }
  },
);

unitTest(
  "provider error codes and retry-after survive normalization",
  async () => {
    for (const provider of providers) {
      const limited = await failure(
        provider
          .build(() => provider.error(429, { "retry-after": "3" }))
          .review(request, live()),
      );
      assert.equal(limited.retryAfterMs, 3000, provider.name);
      const missing = await failure(
        provider.build(() => provider.error(404)).review(request, live()),
      );
      assert.equal(
        missing.code,
        provider.name === "openai" ? "model_not_found" : "not_found_error",
      );
      const permanent = await failure(
        provider
          .build(() => provider.error(401, { "retry-after": "3" }))
          .review(request, live()),
      );
      assert.equal(permanent.retryAfterMs, undefined, provider.name);
    }
  },
);

unitTest(
  "normalized errors never carry the key, long bodies or the request",
  async () => {
    for (const provider of providers) {
      const error = await failure(
        provider.build(() => provider.error(500)).review(request, live()),
      );
      const everything = JSON.stringify({
        message: error.message,
        code: error.code,
        own: Object.fromEntries(Object.entries(error)),
      });
      assert.ok(!everything.includes(KEY), `${provider.name} leaked the key`);
      assert.ok(!everything.includes("USER"), "prompt text must not leak");
      assert.ok(error.message.length <= 300);
      assert.equal(error.cause, undefined, "no raw SDK object is retained");
    }
  },
);

unitTest("network failures are retryable in both providers", async () => {
  for (const provider of providers) {
    const error = await failure(
      provider
        .build(() => {
          throw new TypeError("fetch failed");
        })
        .review(request, live()),
    );
    assert.equal(error.kind, "network", provider.name);
    assert.equal(error.retryable, true);
  }
});

unitTest(
  "cancellation is aborted and a request timeout is a timeout",
  async () => {
    for (const provider of providers) {
      const sent: string[] = [];
      const model = provider.build(() => {
        sent.push("request");
        return provider.ok(review);
      });
      const cancel = new AbortController();
      cancel.abort();
      const cancelled = await failure(model.review(request, cancel.signal));
      assert.equal(cancelled.kind, "aborted", provider.name);
      assert.equal(cancelled.retryable, false);

      const expired = AbortSignal.timeout(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const timedOut = await failure(model.review(request, expired));
      assert.equal(timedOut.kind, "timeout", provider.name);
      assert.equal(timedOut.retryable, true);
      assert.deepEqual(sent, [], "an expired signal never reaches the wire");
    }
  },
);

unitTest("malformed structured output is a malformed_response", async () => {
  for (const provider of providers) {
    const notJson = await failure(
      provider.build(() => provider.ok("not json {")).review(request, live()),
    );
    assert.equal(notJson.kind, "malformed_response", provider.name);
    const wrongShape = await failure(
      provider
        .build(() => provider.ok({ findings: "nope", summary: 1 }))
        .review(request, live()),
    );
    assert.equal(wrongShape.kind, "malformed_response", provider.name);
    assert.equal(wrongShape.retryable, true);
    assert.equal(wrongShape.provider, provider.name);
  }
});

unitTest(
  "a length-limited response is response_truncated, never a result",
  async () => {
    for (const provider of providers) {
      const error = await failure(
        provider
          .build(() => provider.ok(review, { truncated: true }))
          .review(request, live()),
      );
      assert.equal(error.kind, "response_truncated", provider.name);
      assert.equal(error.retryable, false);
      assert.match(error.message, /AI_REVIEW_MAX_OUTPUT_TOKENS/);
    }
  },
);

unitTest("refusals are their own non-retryable kind", async () => {
  for (const provider of providers) {
    const error = await failure(
      provider
        .build(() => provider.ok(review, { refused: true }))
        .review(request, live()),
    );
    assert.equal(error.kind, "refused", provider.name);
    assert.equal(error.retryable, false);
  }
});

unitTest("an unrecognized failure is unknown and not retried", async () => {
  const error = await failure(
    providers[0]!
      .build(() => {
        throw "a bare string";
      })
      .review(request, live()),
  );
  assert.equal(error.kind, "unknown");
  assert.equal(error.retryable, false);
  // The Anthropic SDK itself reports every transport rejection as a
  // connection error, which the adapter maps to the network kind.
  const sdk = await failure(
    providers[1]!
      .build(() => {
        throw "a bare string";
      })
      .review(request, live()),
  );
  assert.equal(sdk.kind, "network");
});

unitTest(
  "a missing key is an authentication error before any request",
  async () => {
    const saved = {
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      for (const provider of providers) {
        let sent = 0;
        const model = provider.build(() => {
          sent++;
          return provider.ok(review);
        }, "");
        const error = await failure(model.review(request, live()));
        assert.equal(error.kind, "authentication", provider.name);
        assert.equal(error.retryable, false);
        assert.equal(sent, 0, provider.name);
      }
    } finally {
      if (saved.openai !== undefined) process.env.OPENAI_API_KEY = saved.openai;
      if (saved.anthropic !== undefined)
        process.env.ANTHROPIC_API_KEY = saved.anthropic;
    }
  },
);
