import assert from "node:assert/strict";
import { printReviewResult, stderrEvent } from "../src/cli/output.js";
import { AnthropicReviewModel } from "../src/model/anthropic.js";
import { ReviewModelError } from "../src/model/errors.js";
import { OpenAIReviewModel } from "../src/model/openai.js";
import type { ReviewModel } from "../src/model/types.js";
import type { ReviewEvent } from "../src/observability/events.js";
import { EmbeddingError } from "../src/retrieval/embedding-errors.js";
import { executeEmbeddingRequest } from "../src/retrieval/embedding-execution.js";
import { OpenAIEmbeddingAdapter } from "../src/retrieval/embeddings.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import {
  cleanResult,
  makeSource,
  request,
  sourceFile,
  testConfig,
} from "./fixtures.js";
import { unitTest } from "./helpers.js";

const KEY = "sk-test-secret-key-0123456789";
/** Synthetic private text a provider might echo back from the request. */
const ECHO = "INTERNAL_CLIENT_ACME = 42";
const URL_ECHO = "https://internal.acme.example/billing?token=abc123";
const CREDENTIAL = "ghp_0123456789abcdefghij0123";
const HOSTILE = `${ECHO} ${URL_ECHO} ${CREDENTIAL}`;
const FORBIDDEN = [
  "INTERNAL_CLIENT",
  "ACME",
  "acme.example",
  "abc123",
  CREDENTIAL,
  KEY,
];
const clean = (value: unknown, label: string) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const fragment of FORBIDDEN)
    assert.ok(!text.includes(fragment), `${label} leaked ${fragment}`);
};

const json = (body: unknown, status: number, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const asFetch = (transport: () => Response | Promise<Response>) =>
  (async () => transport()) as unknown as typeof fetch;
const live = () => new AbortController().signal;
const call = {
  system: "SYS",
  user: "USER",
  model: "m",
  maxOutputTokens: 50,
};

type Maker = {
  name: string;
  build(transport: () => Response | Promise<Response>): ReviewModel;
  /** An HTTP error whose every free-text field echoes private data. */
  http(status: number, code: string, headers?: HeadersInit): Response;
};
const makers: Maker[] = [
  {
    name: "openai",
    build: (transport) =>
      new OpenAIReviewModel(KEY, undefined, asFetch(transport)),
    http: (status, code, headers) =>
      json(
        { error: { message: `echo: ${HOSTILE}`, type: HOSTILE, code } },
        status,
        headers,
      ),
  },
  {
    name: "anthropic",
    build: (transport) =>
      new AnthropicReviewModel({ apiKey: KEY, fetch: asFetch(transport) }),
    http: (status, code, headers) =>
      json(
        { type: "error", error: { type: code, message: `echo: ${HOSTILE}` } },
        status,
        headers,
      ),
  },
];
async function failure(promise: Promise<unknown>): Promise<ReviewModelError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(error instanceof ReviewModelError, String(error));
  return error;
}
const everything = (error: ReviewModelError | EmbeddingError) => ({
  message: error.message,
  code: error.code,
  stack: error.stack,
  own: Object.fromEntries(Object.entries(error)),
});

unitTest(
  "provider free text, codes and types never reach a model error",
  async () => {
    const table: Array<[number, string, ReviewModelError["kind"], boolean]> = [
      [400, HOSTILE, "invalid_request", false],
      [401, HOSTILE, "authentication", false],
      [404, HOSTILE, "unsupported_model", false],
      [429, HOSTILE, "rate_limit", true],
      [500, HOSTILE, "provider_unavailable", true],
    ];
    for (const maker of makers)
      for (const [status, code, kind, retryable] of table) {
        const error = await failure(
          maker
            .build(() => maker.http(status, code, { "retry-after": "7" }))
            .review(call, live()),
        );
        const label = `${maker.name} ${status}`;
        clean(everything(error), label);
        assert.equal(error.kind, kind, label);
        assert.equal(error.retryable, retryable, label);
        assert.equal(error.statusCode, status, label);
        assert.equal(error.provider, maker.name, label);
        assert.equal(error.code, undefined, `${label}: unknown code dropped`);
        assert.equal(
          error.retryAfterMs,
          retryable ? 7000 : undefined,
          `${label}: retry timing`,
        );
        assert.match(error.message, new RegExp(`error ${status}`), label);
      }
  },
);

unitTest("only allowlisted provider codes are kept", async () => {
  const known: Record<string, string> = {
    openai: "model_not_found",
    anthropic: "not_found_error",
  };
  for (const maker of makers) {
    const error = await failure(
      maker
        .build(() => maker.http(404, known[maker.name]!))
        .review(call, live()),
    );
    assert.equal(error.code, known[maker.name]);
    assert.match(error.message, new RegExp(known[maker.name]!));
    const injected = await failure(
      maker
        .build(() => maker.http(400, `model_not_found ${ECHO}`))
        .review(call, live()),
    );
    assert.equal(injected.code, undefined, maker.name);
    clean(everything(injected), maker.name);
  }
});

unitTest("a typed error's own code is allowlisted at construction", () => {
  const error = new ReviewModelError({
    kind: "unknown",
    provider: "p",
    message: "fixed",
    code: HOSTILE,
  });
  assert.equal(error.code, undefined);
  const embedding = new EmbeddingError({
    kind: "unknown",
    provider: "p",
    message: "fixed",
    code: HOSTILE,
  });
  assert.equal(embedding.code, undefined);
});

unitTest(
  "thrown transport and SDK errors keep their kind but not their message",
  async () => {
    for (const maker of makers) {
      const network = await failure(
        maker
          .build(() => {
            throw new TypeError(`connect failed: ${HOSTILE}`);
          })
          .review(call, live()),
      );
      assert.equal(network.kind, "network", maker.name);
      assert.equal(network.retryable, true, maker.name);
      clean(everything(network), maker.name);
    }
    const unknown = await failure(
      makers[0]!
        .build(() => {
          throw new Error(`weird: ${HOSTILE}`);
        })
        .review(call, live()),
    );
    assert.equal(unknown.kind, "unknown");
    assert.equal(unknown.retryable, false);
    clean(everything(unknown), "openai unknown");
  },
);

unitTest(
  "embedding failures keep kind and retry data but drop codes and thrown text",
  async () => {
    const adapter = (transport: () => Response | Promise<Response>) =>
      new OpenAIEmbeddingAdapter(
        "text-embedding-3-small",
        KEY,
        "https://example.test/v1/embeddings",
        asFetch(transport),
      );
    const http = await adapter(() =>
      json({ error: { message: HOSTILE, code: HOSTILE } }, 429, {
        "retry-after": "3",
      }),
    )
      .embed(["x"], live())
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    assert.ok(http instanceof EmbeddingError);
    assert.equal(http.kind, "rate_limit");
    assert.equal(http.retryable, true);
    assert.equal(http.retryAfterMs, 3000);
    assert.equal(http.statusCode, 429);
    assert.equal(http.code, undefined);
    clean(everything(http), "embedding http");

    for (const thrown of [new TypeError(HOSTILE), new Error(HOSTILE)]) {
      const error = await adapter(() => {
        throw thrown;
      })
        .embed(["x"], live())
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      assert.ok(error instanceof EmbeddingError);
      assert.equal(
        error.kind,
        thrown instanceof TypeError ? "network" : "unknown",
      );
      clean(everything(error), "embedding thrown");
    }

    // An adapter that leaks a raw error through the executor is wrapped safely.
    const wrapped = await executeEmbeddingRequest({
      adapter: {
        provider: "leaky",
        model: "m",
        version: "v1",
        dimensions: 2,
        async embed() {
          throw new Error(HOSTILE);
        },
      },
      texts: ["x"],
      policy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      sleep: async () => undefined,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(wrapped instanceof EmbeddingError);
    assert.equal(wrapped.kind, "unknown");
    clean(everything(wrapped), "executor-wrapped");
  },
);

/** Results, events and the CLI's own diagnostics for one end-to-end failure. */
async function observe(model: ReviewModel, maxAttempts = 1) {
  const events: ReviewEvent[] = [];
  const result = await executeReviewPipeline(
    request,
    { ...testConfig, maxAttempts },
    {
      model,
      events: (event) => events.push(event),
      source: makeSource([sourceFile("a.ts")]),
    },
  );
  const lines: string[] = [];
  const { log, error } = console;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    for (const event of events) stderrEvent(event);
    for (const format of ["text", "json", "sarif"] as const)
      printReviewResult(result, format);
  } finally {
    console.log = log;
    console.error = error;
  }
  return { result, events, cli: lines.join("\n") };
}

unitTest(
  "provider echoes stay out of results, events and CLI output; permanent errors are not retried",
  async () => {
    for (const maker of makers) {
      let sent = 0;
      const { result, events, cli } = await observe(
        maker.build(() => {
          sent++;
          return maker.http(400, HOSTILE);
        }),
        3,
      );
      clean(result, `${maker.name} result`);
      clean(events, `${maker.name} events`);
      clean(cli, `${maker.name} cli`);
      assert.equal(sent, 1, `${maker.name}: a 400 is not retried`);
      assert.equal(result.status, "failed");
      const failed = result.errors[0];
      assert.equal(failed?.code, "MODEL_INVALID_REQUEST");
      assert.equal(failed?.provider, maker.name);
      assert.equal(failed?.retryable, false);
      assert.match(failed?.message ?? "", /error 400/);
    }
  },
);

unitTest(
  "a transient provider error is still retried once and then succeeds",
  async () => {
    for (const maker of makers) {
      let sent = 0;
      const ok =
        maker.name === "openai"
          ? json(
              {
                choices: [
                  {
                    finish_reason: "stop",
                    message: {
                      content: JSON.stringify(cleanResult().response),
                    },
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              },
              200,
            )
          : json(
              {
                id: "m",
                type: "message",
                role: "assistant",
                model: "m",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(cleanResult().response),
                  },
                ],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              },
              200,
            );
      const { result, events, cli } = await observe(
        maker.build(() => {
          sent++;
          return sent === 1
            ? maker.http(503, HOSTILE, { "retry-after-ms": "1" })
            : ok;
        }),
        2,
      );
      assert.equal(sent, 2, maker.name);
      assert.equal(result.status, "complete", maker.name);
      clean(events, `${maker.name} events`);
      clean(cli, `${maker.name} cli`);
    }
  },
);
