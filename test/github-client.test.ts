import assert from "node:assert/strict";
import { SourceError } from "../src/review-sources/errors.js";
import type { SourceErrorKind } from "../src/review-sources/errors.js";
import { fakeGithub, NOW, TOKEN } from "./github-fakes.js";
import { unitTest } from "./helpers.js";

const ONE_ATTEMPT = { maxAttempts: 1, baseDelayMs: 250, maxDelayMs: 10_000 };
const META = { operation: "pull" } as const;

async function failure(promise: Promise<unknown>): Promise<SourceError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SourceError, `not a SourceError: ${error}`);
    return error;
  }
  throw new Error("expected the request to fail");
}

unitTest(
  "a missing GITHUB_TOKEN is a configuration error before any call",
  async () => {
    const saved = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const { request, calls } = fakeGithub([{ json: {} }], {
        token: undefined,
      });
      const error = await failure(request("/x", undefined, META));
      assert.equal(error.kind, "configuration");
      assert.equal(error.source, "github");
      assert.equal(error.retryable, false);
      assert.equal(calls.length, 0);
    } finally {
      if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
    }
  },
);

unitTest(
  "HTTP statuses are classified into the compact source taxonomy",
  async () => {
    const table: Array<[number, SourceErrorKind, boolean]> = [
      [401, "authentication", false],
      [403, "authorization", false],
      [404, "not_found", false],
      [408, "timeout", true],
      [429, "rate_limit", true],
      [500, "provider_unavailable", true],
      [502, "provider_unavailable", true],
      [503, "provider_unavailable", true],
      [504, "provider_unavailable", true],
      [418, "unknown", false],
    ];
    for (const [status, kind, retryable] of table) {
      const { request, calls } = fakeGithub([{ status, json: {} }], {
        policy: ONE_ATTEMPT,
      });
      const error = await failure(request("/x", undefined, META));
      assert.equal(error.kind, kind, `status ${status}`);
      assert.equal(error.retryable, retryable, `status ${status}`);
      assert.equal(error.statusCode, status);
      assert.equal(calls.length, 1);
    }
  },
);

unitTest("a 403 is rate limiting only when GitHub says so", async () => {
  const primary = fakeGithub(
    [
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String((NOW + 4000) / 1000),
        },
        json: { message: "API rate limit exceeded for user ID 1." },
      },
    ],
    { policy: ONE_ATTEMPT },
  );
  const exhausted = await failure(primary.request("/x", undefined, META));
  assert.equal(exhausted.kind, "rate_limit");
  assert.equal(exhausted.retryable, true);
  assert.equal(exhausted.retryAfterMs, 4000);

  const secondary = fakeGithub(
    [{ status: 403, headers: { "retry-after": "7" }, json: {} }],
    { policy: ONE_ATTEMPT },
  );
  const limited = await failure(secondary.request("/x", undefined, META));
  assert.equal(limited.kind, "rate_limit");
  assert.equal(limited.retryAfterMs, 7000);

  // A documented secondary limit without any header: GitHub asks for a minute.
  const bare = fakeGithub(
    [
      {
        status: 403,
        json: { message: "You have exceeded a secondary rate limit." },
      },
    ],
    { policy: ONE_ATTEMPT },
  );
  const secondaryBare = await failure(bare.request("/x", undefined, META));
  assert.equal(secondaryBare.kind, "rate_limit");
  assert.equal(secondaryBare.retryAfterMs, 60_000);

  // remaining > 0 and no rate-limit wording: a permission failure.
  const denied = fakeGithub(
    [
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "4999" },
        json: { message: "Resource not accessible by integration" },
      },
    ],
    { policy: ONE_ATTEMPT },
  );
  const permission = await failure(denied.request("/x", undefined, META));
  assert.equal(permission.kind, "authorization");
  assert.equal(permission.retryable, false);
});

unitTest(
  "Retry-After may be seconds or an HTTP date, and bad values are ignored",
  async () => {
    const date = new Date(NOW + 5000).toUTCString();
    for (const [value, expected] of [
      ["3", 3000],
      [date, 5000],
      ["-4", undefined],
      ["soon", undefined],
    ] as const) {
      const { request } = fakeGithub(
        [{ status: 429, headers: { "retry-after": value }, json: {} }],
        { policy: ONE_ATTEMPT },
      );
      const error = await failure(request("/x", undefined, META));
      assert.equal(error.retryAfterMs, expected, value);
    }
  },
);

unitTest(
  "a connection failure is a retryable network error without raw details",
  async () => {
    const cause = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    const { request } = fakeGithub(
      [{ fail: new TypeError(`fetch failed for ${TOKEN}`, { cause }) }],
      { policy: ONE_ATTEMPT },
    );
    const error = await failure(request("/x", undefined, META));
    assert.equal(error.kind, "network");
    assert.equal(error.retryable, true);
    assert.equal(error.code, "ECONNRESET");
    assert.doesNotMatch(error.message, new RegExp(TOKEN));
  },
);

unitTest(
  "a 2xx with a body that is not JSON is an invalid response",
  async () => {
    const { request, calls } = fakeGithub([{ text: "<html>nope</html>" }]);
    const error = await failure(request("/x", undefined, META));
    assert.equal(error.kind, "invalid_response");
    assert.equal(error.retryable, false);
    assert.equal(calls.length, 1);
  },
);

unitTest(
  "error messages never carry response bodies or credentials",
  async () => {
    const body = `${TOKEN} ${"x".repeat(5000)} private source`;
    const { request } = fakeGithub(
      [{ status: 422, text: JSON.stringify({ message: body }) }],
      { policy: ONE_ATTEMPT },
    );
    const error = await failure(request("/x", undefined, META));
    assert.doesNotMatch(error.message, new RegExp(TOKEN));
    assert.doesNotMatch(error.message, /private source/);
    assert.ok(error.message.length < 400, `${error.message.length} characters`);
    assert.doesNotMatch(error.message, /Bearer|Authorization/i);
  },
);

unitTest("the credential is sent on the request and nowhere else", async () => {
  const { request, calls } = fakeGithub([{ json: { ok: true } }]);
  assert.deepEqual(await request("/repos/o/r", undefined, META), { ok: true });
  assert.equal(calls[0]!.url, "https://api.github.com/repos/o/r");
  assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${TOKEN}`);
});

unitTest("503 then success retries once after the base delay", async () => {
  const { request, calls, sleeps } = fakeGithub([
    { status: 503, json: {} },
    { json: { ok: 1 } },
  ]);
  assert.deepEqual(await request("/x", undefined, META), { ok: 1 });
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [250]);
});

unitTest(
  "429 with Retry-After waits exactly that long, then succeeds",
  async () => {
    const { request, calls, sleeps } = fakeGithub([
      { status: 429, headers: { "retry-after": "2" }, json: {} },
      { json: { ok: 1 } },
    ]);
    await request("/x", undefined, META);
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [2000]);
  },
);

unitTest("a primary rate limit waits until the reset time", async () => {
  const { request, sleeps } = fakeGithub([
    {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String((NOW + 3500) / 1000),
      },
      json: {},
    },
    { json: {} },
  ]);
  await request("/x", undefined, META);
  assert.deepEqual(sleeps, [3500]);
});

unitTest("network failures back off exponentially and recover", async () => {
  const { request, calls, sleeps } = fakeGithub([
    { fail: new TypeError("fetch failed") },
    { fail: new TypeError("fetch failed") },
    { json: { ok: 1 } },
  ]);
  await request("/x", undefined, META);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [250, 500]);
});

unitTest("permanent failures are attempted exactly once", async () => {
  for (const status of [401, 403, 404, 422]) {
    const { request, calls, sleeps } = fakeGithub([{ status, json: {} }]);
    await failure(request("/x", undefined, META));
    assert.equal(calls.length, 1, `status ${status}`);
    assert.equal(sleeps.length, 0);
  }
});

unitTest(
  "the attempt limit is respected and the last error is reported",
  async () => {
    const { request, calls, sleeps } = fakeGithub([{ status: 502, json: {} }]);
    const error = await failure(request("/x", undefined, META));
    assert.equal(error.kind, "provider_unavailable");
    assert.equal(error.statusCode, 502);
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [250, 500]);
  },
);

unitTest(
  "a provider delay longer than the maximum fails instead of sleeping",
  async () => {
    const { request, calls, sleeps } = fakeGithub([
      { status: 429, headers: { "retry-after": "120" }, json: {} },
    ]);
    const error = await failure(request("/x", undefined, META));
    assert.equal(error.kind, "rate_limit");
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 120_000);
    assert.equal(calls.length, 1);
    assert.equal(sleeps.length, 0);
  },
);

unitTest(
  "a wait that cannot fit before the total deadline is not started",
  async () => {
    const { request, calls, sleeps } = fakeGithub(
      [{ status: 429, headers: { "retry-after": "5" }, json: {} }],
      { remainingMs: () => 4000 },
    );
    const error = await failure(request("/x", undefined, META));
    assert.equal(error.kind, "rate_limit");
    assert.equal(calls.length, 1);
    assert.equal(sleeps.length, 0);
  },
);

unitTest("an already aborted caller makes zero HTTP calls", async () => {
  const { request, calls } = fakeGithub([{ json: {} }]);
  const error = await failure(request("/x", AbortSignal.abort(), META));
  assert.equal(error.kind, "aborted");
  assert.equal(calls.length, 0);
});

unitTest(
  "aborting during an active request stops without a retry",
  async () => {
    const controller = new AbortController();
    const { request, calls, sleeps } = fakeGithub([{ hang: true }]);
    const pending = failure(request("/x", controller.signal, META));
    await Promise.resolve();
    controller.abort();
    const error = await pending;
    assert.equal(error.kind, "aborted");
    assert.equal(error.retryable, false);
    assert.equal(calls.length, 1);
    assert.equal(sleeps.length, 0);
  },
);

unitTest(
  "aborting during a retry wait stops the wait and starts no attempt",
  async () => {
    const controller = new AbortController();
    let waiting!: () => void;
    const started = new Promise<void>((resolve) => (waiting = resolve));
    const { request, calls } = fakeGithub([{ status: 503, json: {} }], {
      sleep: (_ms, signal) =>
        new Promise<void>((_, reject) => {
          waiting();
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    const pending = failure(request("/x", controller.signal, META));
    await started;
    controller.abort();
    const error = await pending;
    assert.equal(error.kind, "aborted");
    assert.equal(calls.length, 1);
  },
);

unitTest(
  "a caller signal does not disable the per-attempt timeout",
  async () => {
    const caller = new AbortController();
    const { request, calls, timeouts } = fakeGithub(
      [{ hang: true }, { json: { ok: 1 } }],
      { requestTimeoutMs: 1234 },
    );
    const pending = request("/x", caller.signal, META);
    await Promise.resolve();
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0]!.ms, 1234);
    timeouts[0]!.fire();
    assert.deepEqual(await pending, { ok: 1 });
    assert.equal(calls.length, 2);
    // Each attempt gets a fresh timer; the caller's signal never fired.
    assert.equal(timeouts.length, 2);
    assert.equal(caller.signal.aborted, false);
  },
);

unitTest(
  "a timed-out attempt is retryable and distinct from cancellation",
  async () => {
    const { request, calls, timeouts } = fakeGithub([{ hang: true }]);
    const pending = failure(request("/x", undefined, META));
    for (let attempt = 1; attempt <= 3; attempt++) {
      while (timeouts.length < attempt) await Promise.resolve();
      timeouts[attempt - 1]!.fire();
    }
    const error = await pending;
    assert.equal(error.kind, "timeout");
    assert.equal(error.retryable, true);
    assert.equal(calls.length, 3);
  },
);

unitTest(
  "diagnostics carry operation facts and never paths, bodies or tokens",
  async () => {
    const { request, events } = fakeGithub([
      { status: 503, text: "private body" },
      { json: { secret: "payload" } },
    ]);
    await request("/repos/o/r/pulls/1", undefined, {
      operation: "files",
      page: 2,
    });
    assert.deepEqual(
      events.map((event) => [event.type, event.attempt]),
      [
        ["request_started", 1],
        ["request_retry", 1],
        ["request_started", 2],
        ["request_succeeded", 2],
      ],
    );
    const retry = events.find((event) => event.type === "request_retry")!;
    assert.equal(retry.operation, "files");
    assert.equal(retry.page, 2);
    assert.equal(retry.statusCode, 503);
    assert.equal(retry.kind, "provider_unavailable");
    assert.equal(retry.retryable, true);
    assert.equal(retry.waitMs, 250);
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, /private body|payload|repos|Bearer/);
    assert.doesNotMatch(serialized, new RegExp(TOKEN));
  },
);
