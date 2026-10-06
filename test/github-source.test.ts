import assert from "node:assert/strict";
import { SourceError } from "../src/review-sources/errors.js";
import type { GithubRequester } from "../src/review-sources/github/client.js";
import {
  getGithubReviewSource,
  getPullRequestFiles,
} from "../src/review-sources/github/pulls.js";
import { fakeGithubRouted, type Reply } from "./github-fakes.js";
import { unitTest } from "./helpers.js";

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const file = (name: string, extra: Record<string, unknown> = {}) => ({
  filename: name,
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  patch: "@@ -0,0 +1 @@\n+x",
  ...extra,
});
const pull = (extra: Record<string, unknown> = {}) => ({
  title: "Title",
  body: "Body",
  changed_files: 2,
  base: { sha: BASE },
  head: { sha: HEAD },
  ...extra,
});
const b64 = (text: string) => ({
  encoding: "base64",
  content: Buffer.from(text).toString("base64"),
});

type Routes = {
  /** The n-th PR metadata response (0-based). */
  pull?: (n: number) => Reply;
  /** A `page` of changed files. */
  files?: (page: number, seen: number) => Reply;
  contents?: (seen: number) => Reply;
};
function routes(spec: Routes) {
  return (url: URL, seen: number): Reply => {
    if (url.pathname.includes("/contents/"))
      return spec.contents?.(seen) ?? { status: 404, json: {} };
    if (url.pathname.endsWith("/files"))
      return (
        spec.files?.(Number(url.searchParams.get("page")), seen) ?? {
          json: [file("a.ts"), file("b.ts")],
        }
      );
    return spec.pull?.(seen) ?? { json: pull() };
  };
}
async function failure(promise: Promise<unknown>): Promise<SourceError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SourceError, `not a SourceError: ${error}`);
    return error;
  }
  throw new Error("expected collection to fail");
}
const collect = (request: GithubRequester, signal?: AbortSignal) =>
  getGithubReviewSource("Owner", "Repo", 7, request, signal);

unitTest(
  "a stable pull request becomes a complete immutable source",
  async () => {
    const { request } = fakeGithubRouted(
      routes({ contents: () => ({ json: b64("secret/\n") }) }),
    );
    const source = await collect(request);
    assert.equal(source.mode, "pr");
    assert.equal(source.repositoryId, "owner/repo");
    assert.equal(source.baseRevision, BASE);
    assert.equal(source.headRevision, HEAD);
    assert.equal(source.coverageComplete, true);
    assert.equal(source.trustedIgnoreContents, "secret/\n");
    assert.deepEqual(
      source.files.map((f) => f.filename),
      ["a.ts", "b.ts"],
    );
  },
);

unitTest(
  "only a real 404 means the optional ignore file is absent",
  async () => {
    const { request } = fakeGithubRouted(routes({}));
    const source = await collect(request);
    assert.equal(source.trustedIgnoreContents, undefined);
  },
);

unitTest(
  "authentication, limits and outages while reading the ignore file stay failures",
  async () => {
    const cases: Array<[Reply, string]> = [
      [{ status: 401, json: {} }, "authentication"],
      [{ status: 403, json: { message: "Forbidden" } }, "authorization"],
      [{ status: 500, json: {} }, "provider_unavailable"],
      [
        { status: 429, headers: { "retry-after": "1" }, json: {} },
        "rate_limit",
      ],
    ];
    for (const [reply, kind] of cases) {
      const { request } = fakeGithubRouted(routes({ contents: () => reply }), {
        policy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 10 },
      });
      const error = await failure(collect(request));
      assert.equal(error.kind, kind);
    }
  },
);

unitTest(
  "text that merely contains 404 is never read as a missing file",
  async () => {
    const typed: GithubRequester = async <T>(path: string) => {
      if (path.includes("/contents/"))
        throw new SourceError({
          kind: "provider_unavailable",
          source: "github",
          message: "upstream said 404 somewhere in a proxy page",
        });
      return (
        path.includes("/files?") ? [file("a.ts"), file("b.ts")] : pull()
      ) as T;
    };
    const error = await failure(collect(typed));
    assert.equal(error.kind, "provider_unavailable");

    const plain: GithubRequester = async <T>(path: string) => {
      if (path.includes("/contents/"))
        throw new Error("GitHub API error 404: Not Found");
      return (
        path.includes("/files?") ? [file("a.ts"), file("b.ts")] : pull()
      ) as T;
    };
    await assert.rejects(collect(plain), /404/);
  },
);

unitTest(
  "an unusable ignore-file payload is an invalid response, not an absent file",
  async () => {
    const payloads: unknown[] = [
      { encoding: "none", content: "" },
      { encoding: "utf-8", content: "x" },
      { content: "eA==" },
      [{ name: "dir-entry" }],
      { encoding: "base64", content: "not*base64!" },
      "string",
    ];
    for (const payload of payloads) {
      const { request } = fakeGithubRouted(
        routes({ contents: () => ({ json: payload }) }),
      );
      const error = await failure(collect(request));
      assert.equal(error.kind, "invalid_response", JSON.stringify(payload));
      assert.equal(error.retryable, false);
    }
  },
);

unitTest(
  "malformed pull request and file payloads are invalid responses",
  async () => {
    const badPulls: unknown[] = [
      pull({ title: undefined }),
      pull({ changed_files: "2" }),
      pull({ head: {} }),
      pull({ base: { sha: "" } }),
      pull({ base: { sha: "--upload-pack=evil" } }),
      null,
      [],
    ];
    for (const bad of badPulls) {
      const { request } = fakeGithubRouted(
        routes({ pull: () => ({ json: bad }) }),
      );
      const error = await failure(collect(request));
      assert.equal(error.kind, "invalid_response", JSON.stringify(bad));
    }
    const badPages: unknown[] = [
      { files: [] },
      [file("a.ts", { additions: "1" }), file("b.ts")],
      [file("a.ts", { filename: "" }), file("b.ts")],
      [file("a.ts", { patch: 5 }), file("b.ts")],
      [file("a.ts", { previous_filename: 3 }), file("b.ts")],
      [null, file("b.ts")],
    ];
    for (const bad of badPages) {
      const { request } = fakeGithubRouted(
        routes({ files: () => ({ json: bad }) }),
      );
      const error = await failure(collect(request));
      assert.equal(error.kind, "invalid_response", JSON.stringify(bad));
    }
    const oversized = fakeGithubRouted(
      routes({
        pull: () => ({ json: pull({ changed_files: 101 }) }),
        files: () => ({
          json: Array.from({ length: 101 }, (_, i) => file(`f${i}`)),
        }),
      }),
    );
    assert.equal(
      (await failure(collect(oversized.request))).kind,
      "invalid_response",
    );
  },
);

unitTest(
  "a head, base or count change during collection is a retryable revision change",
  async () => {
    const changes: Record<string, unknown> = {
      head: pull({ head: { sha: "c".repeat(40) } }),
      base: pull({ base: { sha: "d".repeat(40) } }),
      count: pull({ changed_files: 3 }),
    };
    for (const [name, changed] of Object.entries(changes)) {
      const { request } = fakeGithubRouted(
        routes({ pull: (n) => ({ json: n === 0 ? pull() : changed }) }),
      );
      const error = await failure(collect(request));
      assert.equal(error.kind, "revision_changed", name);
      assert.equal(error.retryable, true, name);
    }
  },
);

unitTest(
  "duplicate files, within or across pages, are never merged",
  async () => {
    const within = fakeGithubRouted(
      routes({ files: () => ({ json: [file("a.ts"), file("a.ts")] }) }),
    );
    const a = await failure(collect(within.request));
    assert.equal(a.kind, "revision_changed");
    assert.match(a.message, /changed during collection/);

    const across = fakeGithubRouted(
      routes({
        pull: () => ({ json: pull({ changed_files: 101 }) }),
        files: (page) => ({
          json:
            page === 1
              ? Array.from({ length: 100 }, (_, i) => file(`f${i}`))
              : [file("f5")],
        }),
      }),
    );
    const b = await failure(collect(across.request));
    assert.equal(b.kind, "revision_changed");
  },
);

unitTest(
  "fewer files than reported is incomplete coverage, never a clean source",
  async () => {
    const { request } = fakeGithubRouted(
      routes({ files: () => ({ json: [file("a.ts")] }) }),
    );
    const error = await failure(collect(request));
    assert.equal(error.kind, "coverage_incomplete");
    assert.equal(error.retryable, false);
    assert.match(error.message, /Incomplete GitHub file coverage/);
  },
);

unitTest(
  "a pull request beyond GitHub's 3000-file limit fails before paginating",
  async () => {
    const { request, urls } = fakeGithubRouted(
      routes({ pull: () => ({ json: pull({ changed_files: 3001 }) }) }),
    );
    const error = await failure(collect(request));
    assert.equal(error.kind, "coverage_incomplete");
    assert.match(error.message, /3000/);
    assert.equal(urls.filter((url) => url.includes("/files?")).length, 0);
  },
);

unitTest(
  "exactly 3000 files is collected completely across 30 pages",
  async () => {
    const { request, urls } = fakeGithubRouted(
      routes({
        pull: () => ({ json: pull({ changed_files: 3000 }) }),
        files: (page) => ({
          json: Array.from({ length: 100 }, (_, i) => file(`p${page}-${i}`)),
        }),
      }),
    );
    const source = await collect(request);
    assert.equal(source.files.length, 3000);
    assert.equal(urls.filter((url) => url.includes("/files?")).length, 30);
  },
);

unitTest("no page is requested after the caller aborts", async () => {
  const controller = new AbortController();
  const pages: number[] = [];
  // A requester that ignores the signal: pagination itself must stop.
  const request: GithubRequester = async <T>(path: string) => {
    if (!path.includes("/files?")) return pull({ changed_files: 250 }) as T;
    pages.push(pages.length + 1);
    controller.abort();
    return Array.from({ length: 100 }, (_, i) =>
      file(`p${pages.length}-${i}`),
    ) as T;
  };
  const error = await failure(
    getPullRequestFiles("o", "r", 1, 250, request, controller.signal),
  );
  assert.equal(error.kind, "aborted");
  assert.deepEqual(pages, [1]);
});

unitTest(
  "retries inside collection still end in a stable-snapshot check",
  async () => {
    // Page 1 fails once with 503; the retried page then succeeds.
    const flaky = fakeGithubRouted(
      routes({
        files: (_page, seen) =>
          seen === 0
            ? { status: 503, json: {} }
            : { json: [file("a.ts"), file("b.ts")] },
      }),
    );
    const source = await collect(flaky.request);
    assert.equal(source.headRevision, HEAD);
    assert.equal(flaky.sleeps.length, 1);
    assert.equal(flaky.urls.filter((url) => url.includes("/files?")).length, 2);
    // PR metadata is read twice in total: the snapshot and its confirmation.
    assert.equal(
      flaky.urls.filter((url) => url.endsWith("/pulls/7")).length,
      2,
    );

    // The same retry, but the PR moved meanwhile: the retried success is not trusted.
    const moved = fakeGithubRouted(
      routes({
        files: (_page, seen) =>
          seen === 0
            ? { status: 503, json: {} }
            : { json: [file("a.ts"), file("b.ts")] },
        pull: (n) => ({
          json: n === 0 ? pull() : pull({ head: { sha: "e".repeat(40) } }),
        }),
      }),
    );
    const error = await failure(collect(moved.request));
    assert.equal(error.kind, "revision_changed");
  },
);

unitTest("a rate-limited ignore lookup waits and then succeeds", async () => {
  const limited = fakeGithubRouted(
    routes({
      contents: (seen) =>
        seen === 0
          ? { status: 429, headers: { "retry-after": "3" }, json: {} }
          : { json: b64("dist/\n") },
    }),
  );
  const source = await collect(limited.request);
  assert.equal(source.trustedIgnoreContents, "dist/\n");
  assert.deepEqual(limited.sleeps, [3000]);
});
