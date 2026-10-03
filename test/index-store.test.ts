import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseRepositoryIndex } from "../src/retrieval/index-schema.js";
import { chunkSource } from "../src/retrieval/chunker.js";
import { DeterministicTestEmbedding } from "../src/retrieval/embeddings.js";
import {
  buildRepositoryIndex,
  embeddingCacheKey,
  embeddingInputHash,
  indexPath,
  readIndex,
} from "../src/retrieval/index-store.js";
import {
  CHUNKER_VERSION,
  type RepositoryIndex,
} from "../src/retrieval/types.js";
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

const embedding = new DeterministicTestEmbedding();

async function validIndex(): Promise<RepositoryIndex> {
  const chunks = chunkSource({
    repositoryId: "repo",
    revision: "rev",
    path: "a.ts",
    content: "export const a = 1;",
    maxTokens: 100,
  });
  const vectors: RepositoryIndex["vectors"] = {};
  for (const chunk of chunks) {
    const key = embeddingCacheKey(chunk, embedding, 100);
    vectors[key] = {
      cacheKey: key,
      values: (await embedding.embed([chunk.content]))[0]!,
      inputHash: embeddingInputHash(chunk),
      dimensions: 64,
      provider: embedding.provider,
      model: embedding.model,
      version: embedding.version,
      dimensionIdentity: "64",
      chunkerVersion: CHUNKER_VERSION,
      maxChunkTokens: 100,
    };
  }
  return {
    schemaVersion: 1,
    chunkerVersion: CHUNKER_VERSION,
    repositoryId: "repo",
    revision: "rev",
    maxChunkTokens: 100,
    createdAt: "now",
    chunks,
    vectors,
  };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function writeIndexFile(dir: string, contents: string): Promise<string> {
  const path = indexPath(dir, ".cache");
  await mkdir(join(dir, ".cache"), { recursive: true });
  await writeFile(path, contents);
  return path;
}

unitTest(
  "a well-formed persisted index validates and round-trips",
  async () => {
    const index = await validIndex();
    const parsed = parseRepositoryIndex(clone(index));
    assert.ok(parsed.ok);
    // JSON drops `undefined` properties, so compare with the serialized form.
    assert.deepEqual(parsed.ok && parsed.index, clone(index));
  },
);

unitTest(
  "malformed persisted indexes are rejected with a value-free reason",
  async () => {
    const index = await validIndex();
    const firstKey = Object.keys(index.vectors)[0]!;
    const cases: Array<[string, (draft: any) => void]> = [
      ["schema version", (d) => (d.schemaVersion = 2)],
      ["repository identity", (d) => delete d.repositoryId],
      ["revision", (d) => (d.revision = "")],
      ["chunker version", (d) => delete d.chunkerVersion],
      ["max chunk tokens", (d) => (d.maxChunkTokens = 0)],
      ["chunk structure", (d) => (d.chunks[0].endLine = 0)],
      ["chunk shape", (d) => (d.chunks[0].imports = "x")],
      ["chunk identity", (d) => (d.chunks[0].revision = "other")],
      ["vector metadata", (d) => delete d.vectors[firstKey].provider],
      ["vector dimensions", (d) => (d.vectors[firstKey].dimensions = 3)],
      ["vector length", (d) => d.vectors[firstKey].values.pop()],
      // JSON cannot carry NaN/Infinity; they surface as null after a round-trip.
      ["non-finite values", (d) => (d.vectors[firstKey].values[0] = null)],
      ["string values", (d) => (d.vectors[firstKey].values[0] = "1")],
      ["vector key", (d) => (d.vectors.renamed = d.vectors[firstKey])],
    ];
    for (const [name, mutate] of cases) {
      const draft = clone(index);
      mutate(draft);
      const parsed = parseRepositoryIndex(draft);
      assert.equal(parsed.ok, false, `${name} should be rejected`);
    }
    assert.equal(parseRepositoryIndex(null).ok, false);
    assert.equal(parseRepositoryIndex("text").ok, false);
    const bad = clone(index);
    bad.chunks[0]!.content = "TOP_SECRET_VALUE";
    bad.chunks[0]!.endLine = 0;
    const result = parseRepositoryIndex(bad);
    assert.ok(!result.ok && !result.reason.includes("TOP_SECRET_VALUE"));
  },
);

unitTest(
  "readIndex distinguishes missing, corrupt, stale and valid",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "acr-readindex-"));
    const path = indexPath(dir, ".cache");
    assert.deepEqual(await readIndex(path), { status: "missing" });

    await writeIndexFile(dir, "{ not json");
    assert.equal((await readIndex(path)).status, "corrupt");
    await writeIndexFile(dir, JSON.stringify({ schemaVersion: 1 }));
    assert.equal((await readIndex(path)).status, "corrupt");

    const index = await validIndex();
    await writeIndexFile(dir, JSON.stringify(index));
    const valid = await readIndex(path, {
      chunkerVersion: CHUNKER_VERSION,
      maxChunkTokens: 100,
      repositoryId: "repo",
      revision: "rev",
    });
    assert.equal(valid.status, "valid");
    for (const expectation of [
      { chunkerVersion: "ts-js-ast-v0" },
      { maxChunkTokens: 99 },
      { repositoryId: "other" },
      { revision: "newer" },
    ]) {
      const stale = await readIndex(path, expectation);
      assert.equal(stale.status, "stale", JSON.stringify(expectation));
    }
  },
);

unitTest(
  "a corrupt persisted index is rebuilt from source and reported",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "acr-corrupt-index-"));
    await promisify(execFile)("git", ["init"], { cwd: root });
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    const path = await writeIndexFile(root, "{ truncated");
    const diagnostics: string[] = [];
    const index = await buildRepositoryIndex({
      root,
      repositoryId: "repo",
      revision: "r1",
      cacheDirName: ".cache",
      maxChunkTokens: 100,
      ignorePolicy: await loadIgnorePolicy(root),
      onDiagnostic: (message) => diagnostics.push(message),
    });
    assert.ok(index.chunks.some((chunk) => chunk.path === "a.ts"));
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!, /unusable.*rebuilt from source/);
    assert.equal((await readIndex(path)).status, "valid");
    // Atomic write leaves no temporary files behind.
    assert.deepEqual(await readdir(join(root, ".cache")), [
      "repository-index.json",
    ]);
  },
);

unitTest("a stale persisted index contributes no vectors", async () => {
  const root = await mkdtemp(join(tmpdir(), "acr-stale-index-"));
  await promisify(execFile)("git", ["init"], { cwd: root });
  await writeFile(join(root, "a.ts"), "export const a = 1;\n");
  const policy = await loadIgnorePolicy(root);
  let embedded = 0;
  const counting = {
    provider: embedding.provider,
    model: embedding.model,
    version: embedding.version,
    dimensions: embedding.dimensions,
    async embed(texts: string[]) {
      embedded += texts.length;
      return embedding.embed(texts);
    },
  };
  const common = {
    root,
    repositoryId: "repo",
    cacheDirName: ".cache",
    maxChunkTokens: 100,
    ignorePolicy: policy,
  };
  await buildRepositoryIndex({
    ...common,
    revision: "r1",
    embedding: counting,
  });
  const first = embedded;
  assert.ok(first > 0);
  // Re-label the persisted index as built by a different chunker.
  const path = indexPath(root, ".cache");
  const stored = clone(await validIndexFrom(path));
  stored.chunkerVersion = "ts-js-ast-v0";
  await writeFile(path, JSON.stringify(stored));
  const diagnostics: string[] = [];
  await buildRepositoryIndex({
    ...common,
    revision: "r2",
    embedding: counting,
    onDiagnostic: (message) => diagnostics.push(message),
  });
  assert.ok(embedded > first, "stale vectors must be recomputed");
  assert.match(diagnostics.join(" "), /stale/);
});

async function validIndexFrom(path: string): Promise<RepositoryIndex> {
  const loaded = await readIndex(path);
  assert.equal(loaded.status, "valid");
  return (loaded as { status: "valid"; index: RepositoryIndex }).index;
}

unitTest(
  "pipeline surfaces a rebuilt index in the context message without failing",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "acr-pipeline-corrupt-"));
    await promisify(execFile)("git", ["init"], { cwd: root });
    await writeFile(join(root, "dep.ts"), "export const dep = 1;\n");
    await writeIndexFile(root, "garbage");
    const result = await executeReviewPipeline(
      { ...request, contextMode: "lexical" },
      testConfig,
      {
        model: { provider: "test", review: async () => cleanResult() },
        source: makeSource([sourceFile("app.ts", "@@ -0,0 +1 @@\n+dep()")], {
          repositoryRoot: root,
        }),
      },
    );
    assert.equal(result.status, "complete");
    assert.equal(result.context.state, "used");
    assert.match(result.context.message ?? "", /rebuilt from source/);
  },
);
