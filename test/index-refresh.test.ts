import { cacheDirectory } from "../src/cache/paths.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ReviewEvent } from "../src/observability/events.js";
import { chunkSource } from "../src/retrieval/chunker.js";
import {
  DeterministicTestEmbedding,
  type EmbeddingAdapter,
} from "../src/retrieval/embeddings.js";
import {
  indexPath,
  readIndex,
  refreshRepositoryIndex,
  type RepositoryIndexInput,
} from "../src/retrieval/index-store.js";
import { prepareRepositoryIndex } from "../src/retrieval/prepared-index.js";
import { retrieveContext } from "../src/retrieval/retrieve.js";
import { loadIgnorePolicy } from "../src/review/ignore.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import {
  cleanResult,
  makeSource,
  request,
  sourceFile,
  testConfig,
} from "./fixtures.js";
import { unitTest } from "./helpers.js";
import {
  activeMetadataPath,
  rewriteMetadata,
  snapshotFiles,
} from "./index-fixtures.js";

const run = promisify(execFile);
const delegate = new DeterministicTestEmbedding();
const LONG_AGO = new Date("2020-01-01T00:00:00Z");

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acr-refresh-"));
  await run("git", ["init"], { cwd: root });
  await run("git", ["config", "user.email", "t@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "T"], { cwd: root });
  for (const [path, content] of Object.entries(files))
    await put(root, path, content);
  return root;
}

/** Write a file with an old mtime, so its size+mtime may be recorded as a hint. */
async function put(root: string, path: string, content: string) {
  const full = join(root, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
  await utimes(full, LONG_AGO, LONG_AGO);
}

function countingEmbedding() {
  const state = { requests: 0, texts: 0, fail: false };
  const adapter: EmbeddingAdapter = {
    provider: delegate.provider,
    model: delegate.model,
    version: delegate.version,
    dimensions: delegate.dimensions,
    async embed(texts: string[]) {
      state.requests++;
      if (state.fail) throw new Error("provider down");
      state.texts += texts.length;
      return delegate.embed(texts);
    },
  };
  return { state, adapter };
}

async function options(
  root: string,
  extra: Partial<RepositoryIndexInput> = {},
): Promise<RepositoryIndexInput> {
  return {
    root,
    repositoryId: "repo",
    revision: "rev-1",
    cacheDirName: ".cache",
    maxChunkTokens: 100,
    ignorePolicy: await loadIgnorePolicy(root),
    ...extra,
  };
}

const sources = (count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `src/m${i}.ts`,
      `export function work${i}() { return ${i}; }\n`,
    ]),
  );

unitTest(
  "an unchanged working tree is reused without reading a single file",
  async () => {
    const root = await repo(sources(12));
    const { adapter, state } = countingEmbedding();
    const first = await refreshRepositoryIndex(
      await options(root, { embedding: adapter }),
    );
    assert.equal(first.loaded, "missing");
    assert.equal(first.stats.filesRead, 12);
    const embeddedFirst = state.texts;
    const second = await refreshRepositoryIndex(
      await options(root, { revision: "rev-2", embedding: adapter }),
    );
    assert.equal(second.loaded, "valid");
    assert.equal(second.stats.filesRead, 0);
    assert.equal(second.stats.filesReused, 12);
    assert.equal(second.stats.chunksCreated, 0);
    assert.equal(second.stats.vectorsCreated, 0);
    assert.equal(state.texts, embeddedFirst, "no embedding for unchanged data");
    assert.ok(second.index.chunks.every((c) => c.revision === "rev-2"));
  },
);

unitTest(
  "a recent mtime is never trusted as a hint, but still avoids re-chunking",
  async () => {
    const root = await repo({});
    // Written just now: within the racy window, so no hint is recorded.
    await writeFile(join(root, "fresh.ts"), "export const fresh = 1;\n");
    const first = await refreshRepositoryIndex(await options(root));
    assert.equal(
      first.index.files[0]!.mtimeMs,
      undefined,
      "racy mtimes are not recorded",
    );
    let chunkCalls = 0;
    const second = await refreshRepositoryIndex(
      await options(root, {
        chunk: (input) => {
          chunkCalls++;
          return chunkSource(input);
        },
      }),
    );
    assert.equal(second.stats.filesRead, 1, "re-read to establish identity");
    assert.equal(second.stats.filesReused, 1, "identical content is reused");
    assert.equal(chunkCalls, 0);
  },
);

unitTest(
  "only the edited file is read and chunked, even when size and mtime are untouched elsewhere",
  async () => {
    const root = await repo(sources(20));
    const { adapter, state } = countingEmbedding();
    await refreshRepositoryIndex(await options(root, { embedding: adapter }));
    const baseline = state.texts;
    await put(root, "src/m7.ts", "export function work7() { return 777; }\n");
    const chunked: string[] = [];
    const second = await refreshRepositoryIndex(
      await options(root, {
        revision: "rev-2",
        embedding: adapter,
        chunk: (input) => {
          chunked.push(input.path);
          return chunkSource(input);
        },
      }),
    );
    assert.deepEqual(chunked, ["src/m7.ts"]);
    assert.equal(second.stats.filesRead, 1);
    assert.equal(second.stats.filesReused, 19);
    assert.equal(second.stats.filesModified, 1);
    assert.ok(state.texts - baseline <= second.stats.vectorsCreated);
    assert.ok(state.texts - baseline >= 1);
  },
);

unitTest(
  "disabling stat hints re-reads every file but still reuses by content",
  async () => {
    const root = await repo(sources(6));
    await refreshRepositoryIndex(await options(root));
    let chunkCalls = 0;
    const second = await refreshRepositoryIndex(
      await options(root, {
        trustFileStat: false,
        chunk: (input) => {
          chunkCalls++;
          return chunkSource(input);
        },
      }),
    );
    assert.equal(second.stats.filesRead, 6);
    assert.equal(second.stats.filesReused, 6);
    assert.equal(chunkCalls, 0);
  },
);

unitTest(
  "a same-size, same-mtime rewrite is caught when stat hints are disabled",
  async () => {
    const root = await repo({ "a.ts": "export const a = 1;\n" });
    await refreshRepositoryIndex(await options(root));
    await put(root, "a.ts", "export const a = 2;\n"); // same size, same mtime
    const trusting = await refreshRepositoryIndex(await options(root));
    const verifying = await refreshRepositoryIndex(
      await options(root, { trustFileStat: false }),
    );
    // Documented trade-off of the cheap path: it is Git's own size+mtime model.
    assert.equal(trusting.stats.filesModified, 0);
    assert.equal(verifying.stats.filesModified, 1);
    assert.match(verifying.index.chunks[0]!.content, /a = 2/);
  },
);

unitTest(
  "deleted files leave no ghost chunks anywhere in retrieval",
  async () => {
    const root = await repo({
      "keep.ts": "export const keep = 1;\n",
      "gone.ts":
        "export function ghostlyUniqueSymbol() { return 'ghostlyUniqueSymbol'; }\n",
    });
    const { adapter } = countingEmbedding();
    await refreshRepositoryIndex(await options(root, { embedding: adapter }));
    await unlink(join(root, "gone.ts"));
    const { index, stats } = await refreshRepositoryIndex(
      await options(root, { revision: "rev-2", embedding: adapter }),
    );
    assert.equal(stats.filesDeleted, 1);
    assert.ok(index.chunks.every((chunk) => chunk.path !== "gone.ts"));
    assert.ok(index.files.every((file) => file.path !== "gone.ts"));
    assert.ok(
      !JSON.stringify(index).includes("ghostlyUniqueSymbol"),
      "no trace of deleted content in the persisted index",
    );
    const prepared = prepareRepositoryIndex(index);
    assert.equal(prepared.lexical.postings.has("ghostlyuniquesymbol"), false);
    const results = await retrieveContext({
      index: prepared,
      repositoryId: "repo",
      revision: "rev-2",
      query: "ghostlyUniqueSymbol",
      changedPath: "keep.ts",
      mode: "hybrid",
      candidates: 10,
      topK: 10,
      threshold: 0,
      embedding: adapter,
    });
    assert.ok(results.every((candidate) => candidate.chunk.path !== "gone.ts"));
  },
);

unitTest("a renamed file is indexed under its new path only", async () => {
  const root = await repo({ "old/name.ts": "export const moved = 42;\n" });
  await refreshRepositoryIndex(await options(root));
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["mv", "old/name.ts", "new-name.ts"], { cwd: root });
  const { index, stats } = await refreshRepositoryIndex(
    await options(root, { revision: "rev-2" }),
  );
  assert.deepEqual(
    index.files.map((file) => file.path),
    ["new-name.ts"],
  );
  assert.equal(stats.filesDeleted, 1);
  assert.equal(stats.filesAdded, 1);
});

unitTest(
  "committed revisions are reused by Git blob id with zero reads",
  async () => {
    const root = await repo(sources(8));
    await run("git", ["add", "."], { cwd: root });
    await run("git", ["commit", "-m", "base"], { cwd: root });
    const first = await refreshRepositoryIndex(
      await options(root, { gitRevision: "HEAD" }),
    );
    assert.equal(first.stats.filesRead, 8);
    assert.ok(first.index.files.every((file) => file.blobId));
    const second = await refreshRepositoryIndex(
      await options(root, { gitRevision: "HEAD", revision: "rev-2" }),
    );
    assert.equal(second.stats.filesRead, 0, "blob ids prove identity for free");
    assert.equal(second.stats.filesReused, 8);

    await put(root, "src/m3.ts", "export function work3() { return 333; }\n");
    await run("git", ["commit", "-am", "edit"], { cwd: root });
    const third = await refreshRepositoryIndex(
      await options(root, { gitRevision: "HEAD", revision: "rev-3" }),
    );
    assert.equal(third.stats.filesRead, 1);
    assert.equal(third.stats.filesModified, 1);
    assert.equal(third.stats.filesReused, 7);
  },
);

unitTest(
  "a failed embedding update leaves the previous valid index byte-identical",
  async () => {
    const root = await repo(sources(6));
    const { adapter, state } = countingEmbedding();
    await refreshRepositoryIndex(await options(root, { embedding: adapter }));
    const path = indexPath(root, ".cache");
    const before = await snapshotFiles(cacheDirectory(root, ".cache"));
    await put(root, "src/m2.ts", "export function work2() { return 222; }\n");
    state.fail = true;
    await assert.rejects(
      refreshRepositoryIndex(
        await options(root, {
          revision: "rev-2",
          embedding: adapter,
        }),
      ),
      /provider down/,
    );
    // Manifest, metadata and vector blob: not one byte differs, nothing is added.
    assert.deepEqual(
      await snapshotFiles(cacheDirectory(root, ".cache")),
      before,
    );
    assert.equal(path, indexPath(root, ".cache"));
    // Recovery: the next successful run builds on the intact previous index.
    state.fail = false;
    const recovered = await refreshRepositoryIndex(
      await options(root, { revision: "rev-2", embedding: adapter }),
    );
    assert.equal(recovered.stats.filesReused, 5);
    assert.equal(recovered.stats.filesRead, 1);
  },
);

unitTest(
  "an invalid next index is rejected before it can replace the previous one",
  async () => {
    const root = await repo(sources(3));
    await refreshRepositoryIndex(await options(root));
    const path = indexPath(root, ".cache");
    const before = await readFile(path, "utf8");
    await put(root, "src/m0.ts", "export function work0() { return 909; }\n");
    await assert.rejects(
      refreshRepositoryIndex(
        await options(root, {
          revision: "rev-2",
          chunk: (input) =>
            chunkSource(input).map((chunk) => ({ ...chunk, endLine: 0 })),
        }),
      ),
      /invalid repository index/,
    );
    assert.equal(await readFile(path, "utf8"), before);
  },
);

unitTest(
  "cancellation and request budgets leave the previous index untouched",
  async () => {
    const root = await repo(sources(6));
    const { adapter } = countingEmbedding();
    await refreshRepositoryIndex(await options(root, { embedding: adapter }));
    const path = indexPath(root, ".cache");
    const before = await readFile(path, "utf8");
    await put(root, "src/m1.ts", "export function work1() { return 11; }\n");
    await assert.rejects(
      refreshRepositoryIndex(
        await options(root, {
          revision: "rev-2",
          embedding: adapter,
          beforeEmbeddingRequest: () => {
            throw new Error("request budget exhausted");
          },
        }),
      ),
      /exhausted/,
    );
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(
      refreshRepositoryIndex(
        await options(root, {
          revision: "rev-2",
          embedding: adapter,
          signal: controller.signal,
        }),
      ),
      /cancelled/,
    );
    assert.equal(await readFile(path, "utf8"), before);
  },
);

unitTest(
  "corrupt, schema-1 and policy-mismatched indexes are rebuilt and reported distinctly",
  async () => {
    const root = await repo(sources(2));
    const messages: string[] = [];
    const first = await refreshRepositoryIndex(await options(root));
    const path = indexPath(root, ".cache");
    // Each case damages whatever valid index the previous step left behind.
    const cases: Array<[string, () => Promise<void>, RegExp]> = [
      ["corrupt", () => writeFile(path, "{ truncated"), /unusable/],
      [
        "incompatible",
        () => writeFile(path, JSON.stringify({ schemaVersion: 1 })),
        /incompatible \(schema version 1/,
      ],
      [
        "incompatible",
        () => rewriteMetadata(path, (d) => (d.policyVersion = "0.0.1")),
        /incompatible \(privacy policy version/,
      ],
      [
        "corrupt",
        () => rewriteMetadata(path, (d) => (d.files = [])),
        /unusable \(files: chunks and file entries disagree\)/,
      ],
    ];
    for (const [status, damage, pattern] of cases) {
      await damage();
      messages.length = 0;
      const result = await refreshRepositoryIndex(
        await options(root, { onDiagnostic: (m) => messages.push(m) }),
      );
      assert.equal(result.loaded, status);
      assert.equal(result.stats.previous, "none");
      assert.equal(result.stats.filesReused, 0);
      assert.match(messages.join(" "), pattern);
      assert.equal((await readIndex(path)).status, "valid");
    }
    assert.equal(first.index.files.length, 2);
  },
);

unitTest(
  "a chunk-budget change rebuilds, a repository move is reported, vectors are re-embedded",
  async () => {
    const root = await repo(sources(4));
    const { adapter, state } = countingEmbedding();
    await refreshRepositoryIndex(await options(root, { embedding: adapter }));
    const baseline = state.texts;
    const budget = await refreshRepositoryIndex(
      await options(root, { maxChunkTokens: 60, embedding: adapter }),
    );
    assert.equal(budget.loaded, "incompatible");
    assert.equal(budget.stats.filesReused, 0);
    assert.ok(state.texts > baseline, "vector keys cover the chunk budget");
  },
);

unitTest(
  "the persisted index is plain JSON and never records file text for skipped files",
  async () => {
    const root = await repo({
      "ok.ts": "export const ok = 1;\n",
      "secret.ts":
        'export const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n',
    });
    const { index, stats } = await refreshRepositoryIndex(await options(root));
    assert.equal(stats.filesSkipped, 1);
    assert.deepEqual(
      index.files.map((file) => file.path),
      ["ok.ts"],
    );
    const manifestPath = indexPath(root, ".cache");
    const text = await readFile(await activeMetadataPath(manifestPath), "utf8");
    assert.ok(!text.includes("ghp_abcdefghijklmnop"));
    const metadata = JSON.parse(text);
    const plain = JSON.parse(JSON.stringify(index));
    assert.deepEqual(metadata.chunks, plain.chunks);
    assert.deepEqual(metadata.files, plain.files);
    assert.deepEqual(metadata.chunkInputHashes, plain.inputHashes);
  },
);

unitTest(
  "the index stage reports reuse counters and never source text",
  async () => {
    const root = await repo({
      "dep.ts": "export const dependency = 'EVENT_LEAK_CANARY';\n",
      "other.ts": "export const other = 2;\n",
    });
    const events: ReviewEvent[] = [];
    const reviewRun = (snapshotId: string) =>
      executeReviewPipeline(
        { ...request, contextMode: "lexical" },
        testConfig,
        {
          model: { provider: "test", review: async () => cleanResult() },
          source: makeSource([sourceFile("app.ts", "@@ -0,0 +1 @@\n+dep()")], {
            repositoryRoot: root,
            snapshotId,
          }),
          events: (event) => events.push(event),
        },
      );
    await reviewRun("snap-1");
    await reviewRun("snap-2");
    const complete = events.filter(
      (event) => event.stage === "index" && event.type === "complete",
    );
    assert.equal(complete.length, 2);
    assert.equal(complete[0]!.data?.filesIndexed, 2);
    assert.equal(complete[0]!.data?.filesReused, 0);
    assert.equal(complete[1]!.data?.filesIndexed, 0);
    assert.equal(complete[1]!.data?.filesReused, 2);
    assert.equal(complete[1]!.data?.chunksCreated, 0);
    assert.equal(complete[1]!.data?.embeddingRequests, 0);
    assert.ok(!JSON.stringify(events).includes("EVENT_LEAK_CANARY"));
    assert.ok(!JSON.stringify(events).includes("dep.ts"));
  },
);

unitTest(
  "hybrid review reuses stored vectors, so a repeat run only pays for query embeddings",
  async () => {
    const root = await repo({
      "dep.ts": "export const dependency = 1;\n",
      "other.ts": "export const other = 2;\n",
    });
    const { adapter, state } = countingEmbedding();
    const reviewRun = (snapshotId: string) =>
      executeReviewPipeline({ ...request, contextMode: "hybrid" }, testConfig, {
        model: { provider: "test", review: async () => cleanResult() },
        embedding: adapter,
        source: makeSource([sourceFile("app.ts", "@@ -0,0 +1 @@\n+dep()")], {
          repositoryRoot: root,
          snapshotId,
        }),
      });
    const first = await reviewRun("snap-1");
    const second = await reviewRun("snap-2");
    const queryRequests = second.usage.embeddingRequests;
    assert.ok(first.usage.embeddingRequests > queryRequests);
    assert.equal(queryRequests, 1, "one query embedding, zero index requests");
    assert.ok(state.requests >= first.usage.embeddingRequests + queryRequests);
  },
);

unitTest(
  "without embedding authorization no embedding call is possible during indexing",
  async () => {
    const root = await repo({ "dep.ts": "export const dependency = 1;\n" });
    const result = await executeReviewPipeline(
      { ...request, contextMode: "hybrid" },
      testConfig,
      {
        model: { provider: "test", review: async () => cleanResult() },
        embedding: undefined,
        source: makeSource([sourceFile("app.ts", "@@ -0,0 +1 @@\n+dep()")], {
          repositoryRoot: root,
        }),
      },
    );
    assert.equal(result.usage.embeddingRequests, 0);
    assert.match(result.context.message ?? "", /not permitted/);
    const index = await readIndex(indexPath(root, ".cache"));
    assert.equal(index.status, "valid");
    assert.equal(index.status === "valid" && index.index.vectors.count, 0);
  },
);
