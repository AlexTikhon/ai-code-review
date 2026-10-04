import assert from "node:assert/strict";
import { AnthropicReviewModel } from "../src/model/anthropic.js";
import { executeModel } from "../src/model/execution.js";
import { OpenAIReviewModel } from "../src/model/openai.js";
import { ReviewModelError } from "../src/model/errors.js";
import { unitTest } from "./helpers.js";

const KEY = "sk-ant-test-secret-key";
const request = {
  system: "SYS",
  user: "USER",
  model: "m-1",
  maxOutputTokens: 77,
};

const finding = {
  severity: "high",
  category: "correctness",
  confidence: "high",
  title: "Null dereference",
  explanation: "profile may be undefined",
  evidence: [{ path: "src/a.ts", startLine: 5, endLine: 5, contextId: null }],
  suggestion: null,
};
const review = (findings: unknown[] = []) => ({
  findings,
  summary: "s",
  abstained: false,
  abstentionReason: null,
});

type Usage = Record<string, number | null>;
const message = (
  content: unknown[],
  extra: { stop_reason?: string; usage?: Usage | null } = {},
) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "m-1",
  content,
  stop_reason: extra.stop_reason ?? "end_turn",
  stop_sequence: null,
  usage:
    extra.usage === null
      ? undefined
      : (extra.usage ?? {
          input_tokens: 11,
          output_tokens: 7,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        }),
});
const textMessage = (payload: unknown, extra = {}) =>
  message(
    [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
    ],
    extra,
  );

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const apiError = (
  status: number,
  type = "api_error",
  headers: HeadersInit = {},
) =>
  json(
    { type: "error", error: { type, message: `boom ${KEY}` } },
    status,
    headers,
  );

type Captured = { body: Record<string, any>; headers: Headers };
function fakeApi(respond: (call: number) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    calls.push({
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    });
    return respond(calls.length);
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const model = (
  api: { fetchImpl: typeof fetch },
  apiKey: string | undefined = KEY,
) => new AnthropicReviewModel({ apiKey, fetch: api.fetchImpl });
const live = () => new AbortController().signal;
async function failure(promise: Promise<unknown>): Promise<ReviewModelError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(
    error instanceof ReviewModelError,
    `expected ReviewModelError, got ${error}`,
  );
  return error;
}

unitTest(
  "anthropic: a structured response becomes the domain result",
  async () => {
    const api = fakeApi(() => json(textMessage(review([finding]))));
    const result = await model(api).review(request, live());
    assert.equal(result.response.findings.length, 1);
    assert.equal(result.response.findings[0]?.evidence[0]?.startLine, 5);
    assert.deepEqual(result.usage, {
      inputTokens: 11,
      outputTokens: 7,
      actual: true,
    });
    const sent = api.calls[0]!;
    assert.equal(sent.body.model, "m-1");
    assert.equal(sent.body.max_tokens, 77);
    assert.equal(sent.body.system, "SYS");
    assert.deepEqual(sent.body.messages, [{ role: "user", content: "USER" }]);
    assert.equal(sent.body.output_config.format.type, "json_schema");
    for (const unsupported of [
      "temperature",
      "tool_choice",
      "thinking",
      "tools",
    ])
      assert.ok(!(unsupported in sent.body), `must not send ${unsupported}`);
    assert.equal(sent.headers.get("x-api-key"), KEY);
    assert.ok(
      !JSON.stringify(sent.body).includes(KEY),
      "key must not be in the body",
    );
  },
);

unitTest(
  "anthropic: the output schema uses only supported constructs",
  async () => {
    const api = fakeApi(() => json(textMessage(review())));
    await model(api).review(request, live());
    const schema = JSON.stringify(
      api.calls[0]!.body.output_config.format.schema,
    );
    assert.ok(!/minItems|maxItems/.test(schema));
    assert.ok(!/"type":\[/.test(schema), "type unions become anyOf");
    assert.match(schema, /anyOf/);
    assert.match(schema, /"additionalProperties":false/);
    assert.match(schema, /"abstentionReason"/);
  },
);

unitTest(
  "anthropic: multiple findings and clean responses normalize",
  async () => {
    const two = fakeApi(() =>
      json(textMessage(review([finding, { ...finding, title: "Second" }]))),
    );
    const many = await model(two).review(request, live());
    assert.deepEqual(
      many.response.findings.map((f) => f.title),
      ["Null dereference", "Second"],
    );
    const clean = fakeApi(() => json(textMessage(review())));
    const none = await model(clean).review(request, live());
    assert.deepEqual(none.response.findings, []);
    assert.equal(none.response.abstained, false);
  },
);

unitTest(
  "anthropic: non-text blocks are ignored when reading the answer",
  async () => {
    const api = fakeApi(() =>
      json(
        message([
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: JSON.stringify(review([finding])) },
        ]),
      ),
    );
    const result = await model(api).review(request, live());
    assert.equal(result.response.findings.length, 1);
  },
);

unitTest(
  "anthropic: malformed or invalid model output is a retryable failure",
  async () => {
    const malformed = await failure(
      model(fakeApi(() => json(textMessage("not json {")))).review(
        request,
        live(),
      ),
    );
    assert.match(malformed.message, /malformed JSON/);
    assert.equal(malformed.retryable, true);
    const invalid = await failure(
      model(
        fakeApi(() => json(textMessage({ findings: "nope", summary: 1 }))),
      ).review(request, live()),
    );
    assert.match(invalid.message, /schema validation/);
    assert.equal(invalid.retryable, true);
    const noText = await failure(
      model(fakeApi(() => json(message([])))).review(request, live()),
    );
    assert.match(noText.message, /structured content/);
    const abstainWithFinding = await failure(
      model(
        fakeApi(() =>
          json(textMessage({ ...review([finding]), abstained: true })),
        ),
      ).review(request, live()),
    );
    assert.match(abstainWithFinding.message, /schema validation/);
  },
);

unitTest("anthropic: refusals and truncation are not retried", async () => {
  const refused = await failure(
    model(
      fakeApi(() => json(textMessage("", { stop_reason: "refusal" }))),
    ).review(request, live()),
  );
  assert.equal(refused.retryable, false);
  const truncated = await failure(
    model(
      fakeApi(() =>
        json(textMessage('{"findings":[', { stop_reason: "max_tokens" })),
      ),
    ).review(request, live()),
  );
  assert.equal(truncated.retryable, false);
  assert.match(truncated.message, /AI_REVIEW_MAX_OUTPUT_TOKENS/);
});

unitTest(
  "anthropic: provider errors are classified, with retry-after",
  async () => {
    const cases: Array<[number, string, boolean]> = [
      [429, "rate_limit_error", true],
      [500, "api_error", true],
      [529, "overloaded_error", true],
      [408, "api_error", true],
      [400, "invalid_request_error", false],
      [401, "authentication_error", false],
      [403, "permission_error", false],
      [404, "not_found_error", false],
    ];
    for (const [status, type, retryable] of cases) {
      const error = await failure(
        model(fakeApi(() => apiError(status, type))).review(request, live()),
      );
      assert.equal(error.retryable, retryable, `status ${status}`);
      assert.match(error.message, new RegExp(String(status)));
      assert.ok(
        !error.message.includes(KEY),
        "provider text must not leak the key",
      );
    }
    const seconds = await failure(
      model(
        fakeApi(() =>
          apiError(429, "rate_limit_error", { "retry-after": "3" }),
        ),
      ).review(request, live()),
    );
    assert.equal(seconds.retryAfterMs, 3000);
    const millis = await failure(
      model(
        fakeApi(() =>
          apiError(429, "rate_limit_error", { "retry-after-ms": "40" }),
        ),
      ).review(request, live()),
    );
    assert.equal(millis.retryAfterMs, 40);
    const permanent = await failure(
      model(
        fakeApi(() =>
          apiError(401, "authentication_error", { "retry-after": "3" }),
        ),
      ).review(request, live()),
    );
    assert.equal(permanent.retryAfterMs, undefined);
  },
);

unitTest("anthropic: network failures are retryable", async () => {
  const api = fakeApi(() => {
    throw new TypeError("fetch failed");
  });
  const error = await failure(model(api).review(request, live()));
  assert.equal(error.retryable, true);
});

unitTest(
  "anthropic: the SDK never retries behind the pipeline's back",
  async () => {
    const api = fakeApi(() => apiError(500));
    await failure(model(api).review(request, live()));
    assert.equal(
      api.calls.length,
      1,
      "one review() is exactly one HTTP request",
    );
  },
);

unitTest("anthropic: a missing key fails before any request", async () => {
  const api = fakeApi(() => json(textMessage(review())));
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const error = await failure(
      new AnthropicReviewModel({ fetch: api.fetchImpl }).review(
        request,
        live(),
      ),
    );
    assert.match(error.message, /Missing ANTHROPIC_API_KEY/);
    assert.equal(error.retryable, false);
    assert.equal(api.calls.length, 0);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

unitTest(
  "anthropic: cancellation reaches the request and stops retries",
  async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl = ((_url: unknown, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        queueMicrotask(() => controller.abort());
      });
    }) as typeof fetch;
    const anthropic = new AnthropicReviewModel({
      apiKey: KEY,
      fetch: fetchImpl,
    });
    const outcome = await executeModel({
      model: anthropic,
      request,
      runId: "r",
      filename: "a.ts",
      maxAttempts: 3,
      requestTimeoutMs: 5000,
      totalSignal: controller.signal,
      events: () => undefined,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.error instanceof ReviewModelError);
    assert.equal(outcome.error.kind, "aborted");
    assert.equal(outcome.error.retryable, false);
    assert.equal(calls, 1, "no retry after cancellation");
  },
);

unitTest("anthropic: a pre-cancelled request is never sent", async () => {
  const api = fakeApi(() => json(textMessage(review())));
  const controller = new AbortController();
  controller.abort();
  const error = await failure(model(api).review(request, controller.signal));
  assert.equal(error.retryable, false);
  assert.equal(api.calls.length, 0);
});

unitTest("anthropic: usage is normalized and never fabricated", async () => {
  const cached = fakeApi(() =>
    json(
      textMessage(review(), {
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 20,
        },
      }),
    ),
  );
  assert.deepEqual((await model(cached).review(request, live())).usage, {
    inputTokens: 35,
    outputTokens: 4,
    actual: true,
  });
  const absent = fakeApi(() => json(textMessage(review(), { usage: null })));
  assert.deepEqual((await model(absent).review(request, live())).usage, {
    inputTokens: 0,
    outputTokens: 0,
    actual: false,
  });
  const partial = fakeApi(() =>
    json(textMessage(review(), { usage: { output_tokens: 3 } })),
  );
  assert.equal(
    (await model(partial).review(request, live())).usage.actual,
    false,
    "an incomplete usage block is not reported as measured",
  );
});

unitTest(
  "anthropic: identity is stable, non-secret and distinct from OpenAI",
  () => {
    const dirty = new AnthropicReviewModel({
      apiKey: KEY,
      baseURL: "https://user:hunter2@proxy.example.test/anthropic?token=abc",
    });
    assert.match(
      dirty.identity,
      /anthropic-messages\/json-schema-v1@https:\/\/proxy\.example\.test\/anthropic/,
    );
    for (const secret of [KEY, "hunter2", "user:", "token"])
      assert.ok(!dirty.identity.includes(secret), `leaked ${secret}`);
    assert.equal(
      new AnthropicReviewModel({ apiKey: "other" }).identity,
      new AnthropicReviewModel({ apiKey: KEY }).identity,
    );
    assert.equal(
      new AnthropicReviewModel({ apiKey: KEY }).provider,
      "anthropic",
    );
    assert.notEqual(
      new AnthropicReviewModel({ apiKey: KEY }).identity,
      new OpenAIReviewModel("k").identity,
    );
  },
);

unitTest(
  "OpenAI and Anthropic adapters yield the same domain result shape",
  async () => {
    const payload = review([
      finding,
      { ...finding, title: "Other", suggestion: "fix" },
    ]);
    const anthropic = await model(
      fakeApi(() => json(textMessage(payload))),
    ).review(request, live());
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      json({
        choices: [{ message: { content: JSON.stringify(payload) } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      })) as typeof fetch;
    let openai;
    try {
      openai = await new OpenAIReviewModel("k").review(request, live());
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(anthropic, openai);
  },
);
