import assert from "node:assert/strict";
import {
  EMBEDDING_ERROR_KINDS,
  EmbeddingError,
  embeddingErrorCode,
} from "../src/retrieval/embedding-errors.js";
import {
  OpenAIEmbeddingAdapter,
  validateEmbeddingBatch,
} from "../src/retrieval/embeddings.js";
import { unitTest } from "./helpers.js";

const KEY = "sk-test-embedding-secret-0123456789";
const CANARY = "CANARY_SOURCE_TEXT_DO_NOT_LEAK";

type Transport = (
  call: number,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

/** An adapter whose only link to the network is `transport`; counts calls. */
function adapterWith(transport: Transport, model = "text-embedding-3-small") {
  const calls: Array<RequestInit | undefined> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    calls.push(init);
    return transport(calls.length, init);
  }) as unknown as typeof fetch;
  const adapter = new OpenAIEmbeddingAdapter(
    model,
    KEY,
    "https://example.test/v1/embeddings",
    fetchImpl,
  );
  return { adapter, calls };
}
const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const errorBody = (status: number, headers: HeadersInit = {}, code?: string) =>
  json(
    { error: { message: `bad ${CANARY} ${KEY}`, type: "x", code } },
    status,
    headers,
  );
const live = () => new AbortController().signal;
const vec = (dimensions: number, fill = 0.5) =>
  Array.from({ length: dimensions }, () => fill);
const ok = (vectors: unknown[], indexes?: number[]) =>
  json({
    data: vectors.map((embedding, i) => ({
      embedding,
      index: indexes ? indexes[i] : i,
    })),
  });
const failure = async (promise: Promise<unknown>): Promise<EmbeddingError> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof EmbeddingError, String(error));
    return error;
  }
  assert.fail("expected the call to fail");
};

unitTest("embedding error taxonomy is small and carries stable codes", () => {
  assert.deepEqual([...EMBEDDING_ERROR_KINDS].sort(), [
    "aborted",
    "authentication",
    "dimension_mismatch",
    "invalid_request",
    "malformed_response",
    "network",
    "provider_unavailable",
    "rate_limit",
    "timeout",
    "unknown",
    "unsupported_model",
  ]);
  assert.equal(embeddingErrorCode("rate_limit"), "EMBEDDING_RATE_LIMIT");
  assert.equal(
    embeddingErrorCode("authentication"),
    "EMBEDDING_AUTHENTICATION",
  );
});

unitTest("embedding retryability follows the documented defaults", () => {
  const retryable = (kind: (typeof EMBEDDING_ERROR_KINDS)[number]) =>
    new EmbeddingError({ kind, provider: "p", message: "m" }).retryable;
  for (const kind of [
    "rate_limit",
    "timeout",
    "network",
    "provider_unavailable",
  ] as const)
    assert.equal(retryable(kind), true, kind);
  for (const kind of [
    "authentication",
    "invalid_request",
    "unsupported_model",
    "malformed_response",
    "dimension_mismatch",
    "aborted",
    "unknown",
  ] as const)
    assert.equal(retryable(kind), false, kind);
});

unitTest(
  "HTTP statuses are translated into kind and retryability",
  async () => {
    const cases: Array<[number, string, boolean]> = [
      [429, "rate_limit", true],
      [408, "timeout", true],
      [500, "provider_unavailable", true],
      [502, "provider_unavailable", true],
      [503, "provider_unavailable", true],
      [504, "provider_unavailable", true],
      [401, "authentication", false],
      [403, "authentication", false],
      [400, "invalid_request", false],
      [404, "unsupported_model", false],
      [422, "invalid_request", false],
    ];
    for (const [status, kind, retryable] of cases) {
      const { adapter, calls } = adapterWith(() => errorBody(status));
      const error = await failure(adapter.embed(["a"], live()));
      assert.equal(error.kind, kind, String(status));
      assert.equal(error.retryable, retryable, String(status));
      assert.equal(error.statusCode, status);
      assert.equal(error.provider, "openai");
      assert.equal(calls.length, 1, "one attempt makes exactly one request");
    }
  },
);

unitTest(
  "an unknown embedding model is permanent, by code or status",
  async () => {
    const byCode = adapterWith(() => errorBody(400, {}, "model_not_found"));
    const error = await failure(byCode.adapter.embed(["a"], live()));
    assert.equal(error.kind, "unsupported_model");
    assert.equal(error.retryable, false);
    assert.equal(error.code, "model_not_found");
  },
);

unitTest(
  "Retry-After seconds and milliseconds are exposed on retryable errors",
  async () => {
    const seconds = adapterWith(() => errorBody(429, { "retry-after": "2" }));
    assert.equal(
      (await failure(seconds.adapter.embed(["a"], live()))).retryAfterMs,
      2000,
    );
    const millis = adapterWith(() =>
      errorBody(503, { "retry-after-ms": "750" }),
    );
    assert.equal(
      (await failure(millis.adapter.embed(["a"], live()))).retryAfterMs,
      750,
    );
    const permanent = adapterWith(() => errorBody(401, { "retry-after": "2" }));
    assert.equal(
      (await failure(permanent.adapter.embed(["a"], live()))).retryAfterMs,
      undefined,
    );
  },
);

unitTest(
  "normalized errors never carry the key, the input or the body",
  async () => {
    for (const status of [400, 401, 429, 500]) {
      const { adapter } = adapterWith(() => errorBody(status));
      const error = await failure(adapter.embed([CANARY], live()));
      const text = JSON.stringify({ ...error, message: error.message });
      assert.ok(!text.includes(KEY), "api key leaked");
      assert.ok(!text.includes(CANARY), "provider body or input leaked");
    }
  },
);

unitTest(
  "network failures and unknown thrown values are classified safely",
  async () => {
    const reset = adapterWith(() => {
      throw new TypeError(`fetch failed ${KEY}`);
    });
    const network = await failure(reset.adapter.embed(["a"], live()));
    assert.equal(network.kind, "network");
    assert.equal(network.retryable, true);
    assert.ok(!network.message.includes(KEY));

    const weird = adapterWith(() => {
      throw new RangeError(`boom ${KEY}`);
    });
    const unknown = await failure(weird.adapter.embed(["a"], live()));
    assert.equal(unknown.kind, "unknown");
    assert.equal(unknown.retryable, false);
    assert.ok(!unknown.message.includes(KEY));

    const notAnError = adapterWith(() => {
      throw "a string";
    });
    assert.equal(
      (await failure(notAnError.adapter.embed(["a"], live()))).kind,
      "unknown",
    );
  },
);

unitTest(
  "an attempt timeout is a retryable timeout; a caller abort is not",
  async () => {
    const timedOut = AbortSignal.abort(new DOMException("t", "TimeoutError"));
    const stuck = adapterWith(
      (_call, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
        }),
    );
    // A signal aborted before the call never reaches the wire.
    const early = await failure(stuck.adapter.embed(["a"], timedOut));
    assert.equal(early.kind, "timeout");
    assert.equal(early.retryable, true);
    assert.equal(stuck.calls.length, 0);

    const controller = new AbortController();
    const pending = stuck.adapter.embed(["a"], controller.signal);
    controller.abort();
    const aborted = await failure(pending);
    assert.equal(aborted.kind, "aborted");
    assert.equal(aborted.retryable, false);

    const midFlight = adapterWith(() => {
      throw new DOMException("x", "AbortError");
    });
    assert.equal(
      (await failure(midFlight.adapter.embed(["a"], live()))).kind,
      "aborted",
    );
  },
);

unitTest("missing credentials fail before any request", async () => {
  let calls = 0;
  const adapter = new OpenAIEmbeddingAdapter(
    "text-embedding-3-small",
    "",
    "https://example.test/v1/embeddings",
    (async () => {
      calls++;
      return json({});
    }) as unknown as typeof fetch,
  );
  assert.throws(
    () => adapter.assertReady(),
    (error: unknown) =>
      error instanceof EmbeddingError &&
      error.kind === "authentication" &&
      !error.retryable,
  );
  const error = await failure(adapter.embed(["a"], live()));
  assert.equal(error.kind, "authentication");
  assert.equal(calls, 0);
});

unitTest("a non-JSON success body is malformed and permanent", async () => {
  const { adapter } = adapterWith(
    () => new Response("<html>gateway</html>", { status: 200 }),
  );
  const error = await failure(adapter.embed(["a"], live()));
  assert.equal(error.kind, "malformed_response");
  assert.equal(error.retryable, false);
});

unitTest(
  "a body that fails while being read is a network failure",
  async () => {
    const { adapter } = adapterWith(
      () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => {
            throw new TypeError("terminated");
          },
        }) as unknown as Response,
    );
    const error = await failure(adapter.embed(["a"], live()));
    assert.equal(error.kind, "network");
    assert.equal(error.retryable, true);
  },
);

unitTest(
  "response validation rejects malformed embedding payloads",
  async () => {
    const D = 1536;
    const cases: Array<[string, () => Response, string]> = [
      ["no data array", () => json({ data: "x" }), "malformed_response"],
      ["missing data", () => json({}), "malformed_response"],
      [
        "missing vector",
        () => ok([vec(D)]),
        "malformed_response", // two requested, one returned
      ],
      [
        "extra vector",
        () => ok([vec(D), vec(D), vec(D)]),
        "malformed_response",
      ],
      ["wrong dimension", () => ok([vec(D), vec(D - 1)]), "dimension_mismatch"],
      [
        "duplicate index",
        () => ok([vec(D), vec(D)], [0, 0]),
        "malformed_response",
      ],
      [
        "out-of-range index",
        () => ok([vec(D), vec(D)], [0, 2]),
        "malformed_response",
      ],
      [
        "negative index",
        () => ok([vec(D), vec(D)], [0, -1]),
        "malformed_response",
      ],
      [
        "missing index",
        () => ok([vec(D), vec(D)], [0, undefined as never]),
        "malformed_response",
      ],
      ["non-array embedding", () => ok([vec(D), "oops"]), "malformed_response"],
      [
        "non-numeric value",
        () => ok([vec(D), [...vec(D - 1), null]]),
        "malformed_response",
      ],
      [
        "non-finite value",
        () =>
          new Response(
            `{"data":[{"index":0,"embedding":[${vec(D - 1).join(",")},1e999]},{"index":1,"embedding":[${vec(D).join(",")}]}]}`,
          ),
        "malformed_response",
      ],
    ];
    for (const [label, response, kind] of cases) {
      const { adapter, calls } = adapterWith(response);
      const error = await failure(adapter.embed(["a", "b"], live()));
      assert.equal(error.kind, kind, label);
      assert.equal(error.retryable, false, label);
      assert.equal(calls.length, 1, `${label}: no automatic extra request`);
    }
  },
);

unitTest(
  "provider results are mapped by their explicit index, not by position",
  async () => {
    const first = vec(1536, 0.1);
    const second = vec(1536, 0.2);
    const third = vec(1536, 0.3);
    const { adapter } = adapterWith(() =>
      ok([third, first, second], [2, 0, 1]),
    );
    const vectors = await adapter.embed(["a", "b", "c"], live());
    assert.deepEqual(vectors, [first, second, third]);
  },
);

unitTest(
  "a model of unknown dimensionality accepts a consistent batch only",
  async () => {
    const ok2 = adapterWith(
      () =>
        ok([
          [1, 2, 3],
          [4, 5, 6],
        ]),
      "custom-model",
    );
    assert.deepEqual(await ok2.adapter.embed(["a", "b"], live()), [
      [1, 2, 3],
      [4, 5, 6],
    ]);
    const ragged = adapterWith(
      () =>
        ok([
          [1, 2, 3],
          [4, 5],
        ]),
      "custom-model",
    );
    assert.equal(
      (await failure(ragged.adapter.embed(["a", "b"], live()))).kind,
      "dimension_mismatch",
    );
  },
);

unitTest("batch validation reports typed, non-retryable failures", () => {
  const kindOf = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      assert.ok(error instanceof EmbeddingError);
      assert.equal(error.retryable, false);
      return error.kind;
    }
    return "none";
  };
  assert.equal(
    kindOf(() => validateEmbeddingBatch([[1]], 2, 1, "p")),
    "malformed_response",
  );
  assert.equal(
    kindOf(() => validateEmbeddingBatch([[1, 2]], 1, 3, "p")),
    "dimension_mismatch",
  );
  assert.equal(
    kindOf(() => validateEmbeddingBatch([[Number.NaN]], 1, 1, "p")),
    "malformed_response",
  );
  assert.equal(
    kindOf(() => validateEmbeddingBatch([[]], 1, undefined, "p")),
    "malformed_response",
  );
  assert.equal(validateEmbeddingBatch([[1, 2]], 1, undefined, "p"), 2);
  assert.throws(
    () => validateEmbeddingBatch([[1]], 2),
    /does not match request count/,
  );
});
