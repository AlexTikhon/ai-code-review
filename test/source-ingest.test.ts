import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestFailure } from "../src/review/pipeline/ingest-errors.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import type { ReviewRunRequest } from "../src/review/pipeline/types.js";
import type { ReviewEvent } from "../src/observability/events.js";
import type { ReviewResult } from "../src/review/types.js";
import {
  SourceError,
  sourceAbortedError,
  sourceErrorCode,
} from "../src/review-sources/errors.js";
import { routedFetch, NOW, TOKEN, type Reply } from "./github-fakes.js";
import { testConfig } from "./fixtures.js";
import { unitTest } from "./helpers.js";

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const pull = (extra: Record<string, unknown> = {}) => ({
  title: "Title",
  body: "",
  changed_files: 1,
  base: { sha: BASE },
  head: { sha: HEAD },
  ...extra,
});
const changed = {
  filename: "a.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  patch: "@@ -0,0 +1 @@\n+safe()",
};
const prRequest: ReviewRunRequest = {
  target: { kind: "pull-request", owner: "o", repo: "r", pullNumber: 5 },
  contextMode: "diff",
  dryRun: true,
  indexOnly: false,
};

type Route = (url: URL, seen: number) => Reply | undefined;
async function reviewPr(
  route: Route,
  overrides: Partial<typeof testConfig> = {},
) {
  const { fetch, urls } = routedFetch(
    (url, seen) =>
      route(url, seen) ??
      (url.pathname.includes("/contents/")
        ? { status: 404, json: {} }
        : url.pathname.endsWith("/files")
          ? { json: [changed] }
          : { json: pull() }),
  );
  const sleeps: number[] = [];
  const events: ReviewEvent[] = [];
  const result = await executeReviewPipeline(
    prRequest,
    { ...testConfig, ...overrides },
    {
      events: (event) => events.push(event),
      github: {
        token: TOKEN,
        fetch,
        now: () => NOW,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    },
  );
  return { result, urls, sleeps, events };
}
const ingestError = (result: ReviewResult) => {
  assert.equal(result.status, "failed");
  assert.equal(result.errors.length, 1);
  return result.errors[0]!;
};

unitTest(
  "source failures reach the result with stable codes and retryability",
  async () => {
    const cases: Array<[string, Route, string, boolean]> = [
      [
        "authentication",
        (url) =>
          url.pathname.endsWith("/pulls/5")
            ? { status: 401, json: {} }
            : undefined,
        "GITHUB_AUTHENTICATION_FAILED",
        false,
      ],
      [
        "authorization",
        (url) =>
          url.pathname.endsWith("/pulls/5")
            ? { status: 403, json: {} }
            : undefined,
        "GITHUB_AUTHORIZATION_FAILED",
        false,
      ],
      [
        "not found",
        (url) =>
          url.pathname.endsWith("/pulls/5")
            ? { status: 404, json: {} }
            : undefined,
        "GITHUB_NOT_FOUND",
        false,
      ],
      [
        "rate limit",
        (url) =>
          url.pathname.endsWith("/pulls/5")
            ? { status: 429, headers: { "retry-after": "600" }, json: {} }
            : undefined,
        "GITHUB_RATE_LIMIT",
        true,
      ],
      [
        "outage",
        (url) =>
          url.pathname.endsWith("/pulls/5")
            ? { status: 503, json: {} }
            : undefined,
        "GITHUB_PROVIDER_UNAVAILABLE",
        true,
      ],
      [
        "invalid response",
        (url) =>
          url.pathname.endsWith("/pulls/5")
            ? { json: { title: 1 } }
            : undefined,
        "GITHUB_INVALID_RESPONSE",
        false,
      ],
      [
        "revision changed",
        (url, seen) =>
          url.pathname.endsWith("/pulls/5") && seen > 0
            ? { json: pull({ head: { sha: "c".repeat(40) } }) }
            : undefined,
        "GITHUB_REVISION_CHANGED",
        true,
      ],
      [
        "coverage",
        (url) =>
          url.pathname.endsWith("/pulls/5")
            ? { json: pull({ changed_files: 3001 }) }
            : undefined,
        "GITHUB_COVERAGE_INCOMPLETE",
        false,
      ],
    ];
    for (const [name, route, code, retryable] of cases) {
      const { result } = await reviewPr(route);
      const error = ingestError(result);
      assert.equal(error.stage, "ingest", name);
      assert.equal(error.fatal, true, name);
      assert.equal(error.code, code, name);
      assert.equal(error.retryable, retryable, name);
      assert.equal(error.source, "github", name);
      assert.doesNotMatch(error.message, new RegExp(TOKEN), name);
    }
  },
);

unitTest(
  "a missing token is a non-retryable configuration failure",
  async () => {
    const saved = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const result = await executeReviewPipeline(prRequest, testConfig, {
        github: { token: undefined },
      });
      const error = ingestError(result);
      assert.equal(error.code, "SOURCE_CONFIGURATION");
      assert.equal(error.retryable, false);
    } finally {
      if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
    }
  },
);

unitTest(
  "transient GitHub failures are retried without touching the AI request budget",
  async () => {
    const { result, urls, sleeps } = await reviewPr(
      (url, seen) =>
        url.pathname.endsWith("/files") && seen === 0
          ? { status: 503, json: {} }
          : undefined,
      // One AI request would be exhausted by the five GitHub calls if they counted.
      { maxRequests: 1 },
    );
    // A dry run is a manifest, not a review: the point is that ingestion worked.
    assert.ok(result.dryRun);
    assert.equal(result.source?.headRevision, HEAD);
    assert.equal(result.usage.actualRequests, 0);
    assert.equal(result.errors.length, 0);
    assert.equal(urls.length, 5);
    assert.deepEqual(sleeps, [250]);
  },
);

unitTest("source diagnostics carry operation facts only", async () => {
  const { events } = await reviewPr((url, seen) =>
    url.pathname.endsWith("/files") && seen === 0
      ? { status: 503, text: "private response body" }
      : undefined,
  );
  const source = events.filter((event) => event.stage === "source");
  assert.ok(source.length >= 5);
  const retry = source.find(
    (event) => event.message === "github.request_retry",
  );
  assert.equal(retry?.type, "warning");
  assert.equal(retry?.data?.operation, "files");
  assert.equal(retry?.data?.statusCode, 503);
  assert.equal(retry?.data?.waitMs, 250);
  assert.equal(retry?.data?.source, "github");
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /private response body|Bearer|repos\/o/);
  assert.doesNotMatch(serialized, new RegExp(TOKEN));
});

unitTest(
  "local Git failures reach the result as typed source errors",
  async () => {
    const empty = await mkdtemp(join(tmpdir(), "acr-ingest-git-"));
    const result = await executeReviewPipeline(
      {
        target: { kind: "local", localRepoPath: empty },
        contextMode: "diff",
        dryRun: true,
        indexOnly: false,
      },
      testConfig,
      {},
    );
    const error = ingestError(result);
    assert.equal(error.code, "GIT_NOT_A_REPOSITORY");
    assert.equal(error.source, "git");
    assert.equal(error.retryable, false);
  },
);

unitTest("source error kinds map to stable review codes", () => {
  const github = (kind: SourceError["kind"]) =>
    sourceErrorCode(new SourceError({ kind, source: "github", message: "x" }));
  assert.equal(github("timeout"), "SOURCE_TIMEOUT");
  assert.equal(github("network"), "SOURCE_NETWORK");
  assert.equal(github("unknown"), "SOURCE_FAILED");
  assert.equal(github("aborted"), "REVIEW_ABORTED");
  const git = (code: string, kind: SourceError["kind"] = "configuration") =>
    sourceErrorCode(
      new SourceError({ kind, source: "git", message: "x", code }),
    );
  assert.equal(git("not_a_repository"), "GIT_NOT_A_REPOSITORY");
  assert.equal(git("invalid_ref"), "GIT_INVALID_REF");
  assert.equal(git("git_unavailable"), "SOURCE_CONFIGURATION");
  assert.equal(git("git_command_failed", "unknown"), "GIT_COMMAND_FAILED");
});

unitTest(
  "a cancelled collection is REVIEW_ABORTED and worth re-running",
  () => {
    const aborted = ingestFailure(sourceAbortedError("github"), true);
    assert.equal(aborted.code, "REVIEW_ABORTED");
    assert.equal(aborted.retryable, true);
    assert.equal(aborted.source, "github");
    // A non-source failure keeps the old, uncoded shape unless the run was aborted.
    assert.deepEqual(ingestFailure(new Error("disk"), false), {
      stage: "ingest",
      message: "disk",
      fatal: true,
    });
    assert.equal(ingestFailure(new Error("disk"), true).code, "REVIEW_ABORTED");
  },
);
