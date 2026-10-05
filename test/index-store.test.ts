import { cacheDirectory } from "../src/cache/paths.js";
import assert from "node:assert/strict";
import { POLICY_VERSION } from "../src/review/types.js";
import {
  filesForChunks,
  fixtureIndex,
  generationsOf,
  rewriteMetadata,
  schema2Document,
  storedVectors,
} from "./index-fixtures.js";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  parsePersistedMetadata,
  validateRepositoryIndex,
} from "../src/retrieval/index-schema.js";
import { publishIndex } from "../src/retrieval/index-generation.js";
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
  type StoredVector,
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
  const vectors: StoredVector[] = [];
  for (const chunk of chunks) {
    const key = embeddingCacheKey(chunk, embedding, 100);
    vectors.push({
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
    });
  }
  return fixtureIndex({
    policyVersion: POLICY_VERSION,
    chunkerVersion: CHUNKER_VERSION,
    repositoryId: "repo",
    revision: "rev",
    maxChunkTokens: 100,
    createdAt: "now",
    files: filesForChunks(chunks),
    chunks,
    vectors,
  });
}

/** Publish `index` the way refresh does, returning the manifest path. */
async function publish(dir: string, index: RepositoryIndex): Promise<string> {
  const path = indexPath(dir, ".cache");
  await publishIndex({ manifestPath: path, index });
  return path;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function writeIndexFile(dir: string, contents: string): Promise<string> {
  const path = indexPath(dir, ".cache");
  await mkdir(cacheDirectory(dir, ".cache"), { recursive: true, mode: 0o700 });
  await writeFile(path, contents);
  return path;
}

unitTest(
  "a well-formed persisted index validates and round-trips",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "acr-roundtrip-"));
    const index = await validIndex();
    const path = await publish(dir, index);
    const loaded = await readIndex(path);
    assert.equal(loaded.status, "valid");
    const back = (loaded as { status: "valid"; index: RepositoryIndex }).index;
    // JSON drops `undefined` properties, so compare with the serialized form.
    assert.deepEqual(clone(back.chunks), clone(index.chunks));
    assert.deepEqual(back.files, index.files);
    assert.deepEqual(back.inputHashes, index.inputHashes);
    assert.deepEqual(storedVectors(back), storedVectors(index));
    assert.equal(validateRepositoryIndex(back), undefined);
  },
);

unitTest(
  "malformed persisted metadata is rejected with a value-free reason",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "acr-malformed-"));
    const path = await publish(dir, await validIndex());
    const manifest = JSON.parse(await readFile(path, "utf8"));
    const metadata = JSON.parse(
      await readFile(join(generationsOf(path), manifest.metadataFile), "utf8"),
    );
    assert.ok(parsePersistedMetadata(metadata).ok);
    const cases: Array<[string, (draft: any) => void]> = [
      ["schema version", (d) => (d.schemaVersion = 99)],
      ["policy version", (d) => delete d.policyVersion],
      ["file entries", (d) => (d.files[0].chunkIds = ["missing"])],
      ["duplicate file", (d) => d.files.push({ ...d.files[0] })],
      ["unowned chunks", (d) => (d.files = [])],
      ["repository identity", (d) => delete d.repositoryId],
      ["revision", (d) => (d.revision = "")],
      ["chunker version", (d) => delete d.chunkerVersion],
      ["max chunk tokens", (d) => (d.maxChunkTokens = 0)],
      ["chunk structure", (d) => (d.chunks[0].endLine = 0)],
      ["chunk shape", (d) => (d.chunks[0].imports = "x")],
      ["chunk identity", (d) => (d.chunks[0].revision = "other")],
      ["missing input hash", (d) => d.chunkInputHashes.pop()],
      ["bad input hash", (d) => (d.chunkInputHashes[0] = "xyz")],
      ["generation id", (d) => (d.generation = "short")],
      ["vector format", (d) => (d.vectorStore.format = "f32le")],
      ["vector format version", (d) => (d.vectorStore.version = 2)],
      ["vector file name", (d) => (d.vectorStore.file = "../escape.bin")],
      ["vector identity", (d) => delete d.vectorStore.spaces[0].provider],
      ["vector dimensions", (d) => (d.vectorStore.spaces[0].dimensions = 3)],
      ["vector count", (d) => (d.vectorStore.count += 1)],
      ["space count", (d) => (d.vectorStore.spaces[0].count += 1)],
      ["vector keys", (d) => d.vectorStore.spaces[0].cacheKeys.pop()],
      ["negative offset", (d) => (d.vectorStore.spaces[0].offsetBytes = -8)],
      ["offset gap", (d) => (d.vectorStore.spaces[0].offsetBytes = 8)],
      ["file size", (d) => (d.vectorStore.bytes += 8)],
      ["checksum", (d) => (d.vectorStore.sha256 = "0")],
      [
        "duplicate space",
        (d) => d.vectorStore.spaces.push({ ...d.vectorStore.spaces[0] }),
      ],
    ];
    for (const [name, mutate] of cases) {
      const draft = clone(metadata);
      mutate(draft);
      assert.equal(
        parsePersistedMetadata(draft).ok,
        false,
        `${name} should be rejected`,
      );
    }
    assert.equal(parsePersistedMetadata(null).ok, false);
    assert.equal(parsePersistedMetadata("text").ok, false);
    const bad = clone(metadata);
    bad.chunks[0].content = "TOP_SECRET_VALUE";
    bad.chunks[0].endLine = 0;
    const result = parsePersistedMetadata(bad);
    assert.ok(!result.ok && !result.reason.includes("TOP_SECRET_VALUE"));
  },
);

unitTest(
  "readIndex distinguishes missing, corrupt, incompatible, stale and valid",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "acr-readindex-"));
    const path = indexPath(dir, ".cache");
    assert.deepEqual(await readIndex(path), { status: "missing" });

    await writeIndexFile(dir, "{ not json");
    assert.equal((await readIndex(path)).status, "corrupt");
    await writeIndexFile(dir, JSON.stringify({ schemaVersion: 2 }));
    assert.equal((await readIndex(path)).status, "corrupt");

    const index = await validIndex();
    await publish(dir, index);
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
      { policyVersion: "0.0.1" },
      { repositoryId: "other" },
    ]) {
      const incompatible = await readIndex(path, expectation);
      assert.equal(
        incompatible.status,
        "incompatible",
        JSON.stringify(expectation),
      );
    }
    // Compatible but built for another revision: stale, not incompatible.
    assert.equal(
      (await readIndex(path, { revision: "newer" })).status,
      "stale",
    );
    // A well-formed index of another schema version is incompatible, not corrupt.
    await writeIndexFile(
      dir,
      JSON.stringify({ ...schema2Document(index), schemaVersion: 1 }),
    );
    assert.equal((await readIndex(path)).status, "incompatible");
    await writeIndexFile(dir, JSON.stringify({ schemaVersion: 99 }));
    assert.equal((await readIndex(path)).status, "incompatible");
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
    // Atomic publication leaves no temporary files behind: the manifest and
    // one generation (metadata only: there are no vectors without embeddings).
    assert.deepEqual(await readdir(cacheDirectory(root, ".cache")), [
      "repository-index.generations",
      "repository-index.json",
    ]);
    assert.equal(
      (
        await readdir(
          join(cacheDirectory(root, ".cache"), "repository-index.generations"),
        )
      ).length,
      1,
    );
  },
);

unitTest("an incompatible persisted index contributes no vectors", async () => {
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
  await validIndexFrom(path);
  await rewriteMetadata(
    path,
    (draft) => (draft.chunkerVersion = "ts-js-ast-v0"),
  );
  const diagnostics: string[] = [];
  await buildRepositoryIndex({
    ...common,
    revision: "r2",
    embedding: counting,
    onDiagnostic: (message) => diagnostics.push(message),
  });
  assert.ok(embedded > first, "stale vectors must be recomputed");
  assert.match(diagnostics.join(" "), /incompatible/);
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
