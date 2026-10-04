import assert from "node:assert/strict";
import { POLICY_VERSION } from "../src/review/types.js";
import { filesForChunks, fixtureIndex } from "./index-fixtures.js";
import { chunkSource } from "../src/retrieval/chunker.js";
import { DeterministicTestEmbedding } from "../src/retrieval/embeddings.js";
import { retrieveContext } from "../src/retrieval/retrieve.js";
import { CHUNKER_VERSION, type StoredVector } from "../src/retrieval/types.js";
import { unitTest } from "./helpers.js";
import { estimateTokens } from "../src/review/patch.js";
import { execFile } from "node:child_process";
import { mkdtemp, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  buildRepositoryIndex,
  embeddingCacheKey,
  embeddingInputHash,
} from "../src/retrieval/index-store.js";
import { loadIgnorePolicy } from "../src/review/ignore.js";
unitTest(
  "TypeScript chunking captures symbols, signatures, imports and ranges",
  () => {
    const chunks = chunkSource({
      repositoryId: "r",
      revision: "v",
      path: "src/user.ts",
      content:
        "import { Db } from './db';\nexport class UserService {\n load() { return new Db(); }\n}",
      maxTokens: 100,
    });
    const symbol = chunks.find((chunk) => chunk.name === "UserService");
    assert.match(symbol?.signature ?? "", /class UserService/);
    assert.deepEqual(symbol?.imports, ["./db"]);
    assert.equal(symbol?.startLine, 2);
  },
);
unitTest(
  "lexical and hybrid retrieval find cross-file symbol dependencies",
  async () => {
    const chunks = [
      ...chunkSource({
        repositoryId: "r",
        revision: "v",
        path: "src/types.ts",
        content:
          "export interface UserProfile { id: string; enabled: boolean }",
        maxTokens: 100,
      }),
      ...chunkSource({
        repositoryId: "r",
        revision: "v",
        path: "src/noise.ts",
        content: "export const unrelated = 1;",
        maxTokens: 100,
      }),
    ];
    const embedding = new DeterministicTestEmbedding();
    const vectors: Record<string, StoredVector> = {};
    for (const chunk of chunks) {
      const key = embeddingCacheKey(chunk, embedding, 100);
      const values = (await embedding.embed([chunk.content]))[0]!;
      vectors[key] = {
        cacheKey: key,
        values,
        inputHash: embeddingInputHash(chunk),
        dimensions: values.length,
        provider: embedding.provider,
        model: embedding.model,
        version: embedding.version,
        dimensionIdentity: String(embedding.dimensions),
        chunkerVersion: CHUNKER_VERSION,
        maxChunkTokens: 100,
      };
    }
    const index = fixtureIndex({
      policyVersion: POLICY_VERSION,
      chunkerVersion: CHUNKER_VERSION,
      repositoryId: "r",
      revision: "v",
      maxChunkTokens: 100,
      createdAt: "now",
      files: filesForChunks(chunks),
      chunks,
      vectors,
    });
    const lexical = await retrieveContext({
      index,
      repositoryId: "r",
      revision: "v",
      query: "UserProfile enabled",
      changedPath: "src/app.ts",
      mode: "lexical",
      candidates: 10,
      topK: 1,
      threshold: 0,
    });
    assert.equal(lexical[0]?.chunk.path, "src/types.ts");
    const hybrid = await retrieveContext({
      index,
      repositoryId: "r",
      revision: "v",
      query: "UserProfile enabled",
      changedPath: "src/app.ts",
      mode: "hybrid",
      candidates: 10,
      topK: 1,
      threshold: 0,
      embedding,
    });
    assert.equal(hybrid[0]?.chunk.path, "src/types.ts");
  },
);
unitTest(
  "retrieval refuses stale revisions and repository crossover",
  async () => {
    const index = fixtureIndex({
      policyVersion: POLICY_VERSION,
      chunkerVersion: CHUNKER_VERSION,
      repositoryId: "a",
      revision: "1",
      maxChunkTokens: 100,
      createdAt: "now",
      files: filesForChunks([]),
      chunks: [],
    });
    const base = {
      index,
      query: "x",
      changedPath: "x.ts",
      mode: "lexical" as const,
      candidates: 1,
      topK: 1,
      threshold: 0,
    };
    await assert.rejects(
      retrieveContext({ ...base, repositoryId: "a", revision: "2" }),
      /stale/,
    );
    await assert.rejects(
      retrieveContext({ ...base, repositoryId: "b", revision: "1" }),
      /different repository/,
    );
  },
);
unitTest("large symbols split within configured chunk budget", () => {
  const content = `export function huge() {\n${Array.from({ length: 100 }, (_, i) => `const value${i} = ${i};`).join("\n")}\n}`;
  const chunks = chunkSource({
    repositoryId: "r",
    revision: "v",
    path: "huge.ts",
    content,
    maxTokens: 50,
  });
  assert.ok(chunks.length > 1);
});
unitTest(
  "persistent index invalidates deleted chunks and reuses content-hash embeddings",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "acr-index-"));
    await promisify(execFile)("git", ["init"], { cwd: root });
    await writeFile(join(root, "keep.ts"), "export const keep = 1;\n");
    await writeFile(join(root, "delete.ts"), "export const removeMe = 1;\n");
    const policy = await loadIgnorePolicy(root);
    const delegate = new DeterministicTestEmbedding();
    let embedded = 0;
    const embedding = {
      ...delegate,
      provider: delegate.provider,
      model: delegate.model,
      version: delegate.version,
      async embed(texts: string[]) {
        embedded += texts.length;
        return delegate.embed(texts);
      },
    };
    const first = await buildRepositoryIndex({
      root,
      repositoryId: "repo",
      revision: "dirty-1",
      cacheDirName: ".cache",
      maxChunkTokens: 100,
      ignorePolicy: policy,
      embedding,
    });
    const initialCalls = embedded;
    assert.ok(first.chunks.some((chunk) => chunk.path === "delete.ts"));
    await unlink(join(root, "delete.ts"));
    const second = await buildRepositoryIndex({
      root,
      repositoryId: "repo",
      revision: "dirty-2",
      cacheDirName: ".cache",
      maxChunkTokens: 100,
      ignorePolicy: policy,
      embedding,
    });
    assert.equal(
      second.chunks.some((chunk) => chunk.path === "delete.ts"),
      false,
    );
    assert.equal(
      embedded,
      initialCalls,
      "unchanged content vector should be reused",
    );
    assert.ok(second.chunks.every((chunk) => chunk.revision === "dirty-2"));
  },
);

unitTest(
  "syntax-aware chunking does not treat braces in strings as syntax",
  () => {
    const content =
      'export function authorize(user) {\n  const marker = "}";\n  return user.admin;\n}';
    const chunks = chunkSource({
      repositoryId: "r",
      revision: "v",
      path: "auth.ts",
      content,
      maxTokens: 200,
    });
    assert.ok(
      chunks.some((chunk) => chunk.content.includes("return user.admin")),
    );
    const covered = new Set(
      chunks.flatMap((chunk) =>
        Array.from(
          { length: chunk.endLine - chunk.startLine + 1 },
          (_, index) => chunk.startLine + index,
        ),
      ),
    );
    assert.deepEqual(
      [...covered].sort((a, b) => a - b),
      [1, 2, 3, 4],
    );
  },
);

unitTest(
  "AST chunking preserves fallback source and multiline declarations",
  () => {
    const content = `// leading comment
const template = \`value } \${1 + 2}\`;
doSideEffect();
export function
multiline(
  value: string,
) {
  /* } is not syntax here */
  return { value };
}
cleanup();`;
    const chunks = chunkSource({
      repositoryId: "r",
      revision: "v",
      path: "all.ts",
      content,
      maxTokens: 120,
    });
    const combined = chunks.map((chunk) => chunk.content).join("\n");
    assert.match(combined, /leading comment/);
    assert.match(combined, /doSideEffect/);
    assert.match(combined, /return \{ value \}/);
    assert.match(combined, /cleanup/);
    assert.ok(chunks.every((chunk) => estimateTokens(chunk.content) <= 120));
  },
);

unitTest(
  "hybrid retrieval admits semantic-only candidates outside the lexical shortlist",
  async () => {
    const noise = chunkSource({
      repositoryId: "r",
      revision: "v",
      path: "noise.ts",
      content: "export function query() { return 0; }",
      maxTokens: 100,
    }).find((chunk) => chunk.name)!;
    const relevant = chunkSource({
      repositoryId: "r",
      revision: "v",
      path: "relevant.ts",
      content: "export function target() { return 1; }",
      maxTokens: 100,
    }).find((chunk) => chunk.name)!;
    const embedding = {
      provider: "test",
      model: "semantic",
      version: "v1",
      dimensions: 2,
      async embed() {
        return [[1, 0]];
      },
    };
    const vectors: Record<string, StoredVector> = {};
    for (const [chunk, values] of [
      [noise, [0, 1]],
      [relevant, [1, 0]],
    ] as const) {
      const key = embeddingCacheKey(chunk, embedding, 100);
      vectors[key] = {
        cacheKey: key,
        values: [...values],
        inputHash: embeddingInputHash(chunk),
        dimensions: 2,
        provider: embedding.provider,
        model: embedding.model,
        version: embedding.version,
        dimensionIdentity: "2",
        chunkerVersion: CHUNKER_VERSION,
        maxChunkTokens: 100,
      };
    }
    const found = await retrieveContext({
      index: fixtureIndex({
        policyVersion: POLICY_VERSION,
        chunkerVersion: CHUNKER_VERSION,
        repositoryId: "r",
        revision: "v",
        maxChunkTokens: 100,
        createdAt: "now",
        files: filesForChunks([noise, relevant]),
        chunks: [noise, relevant],
        vectors,
      }),
      repositoryId: "r",
      revision: "v",
      query: "query",
      changedPath: "app.ts",
      mode: "hybrid",
      candidates: 1,
      topK: 1,
      threshold: 0,
      embedding,
    });
    assert.equal(found[0]?.chunk.path, "relevant.ts");
  },
);

unitTest(
  "hybrid retrieval rejects incompatible vector dimensions",
  async () => {
    const chunk = chunkSource({
      repositoryId: "r",
      revision: "v",
      path: "a.ts",
      content: "export const value = 1;",
      maxTokens: 100,
    }).find((item) => item.name)!;
    const embedding = {
      provider: "test",
      model: "shape",
      version: "v1",
      async embed() {
        return [[1, 0]];
      },
    };
    const key = embeddingCacheKey(chunk, embedding, 100);
    await assert.rejects(
      retrieveContext({
        index: fixtureIndex({
          policyVersion: POLICY_VERSION,
          chunkerVersion: CHUNKER_VERSION,
          repositoryId: "r",
          revision: "v",
          maxChunkTokens: 100,
          createdAt: "now",
          files: filesForChunks([chunk]),
          chunks: [chunk],
          vectors: {
            [key]: {
              cacheKey: key,
              values: [1, 0, 0],
              inputHash: embeddingInputHash(chunk),
              dimensions: 3,
              provider: embedding.provider,
              model: embedding.model,
              version: embedding.version,
              dimensionIdentity: "provider-default",
              chunkerVersion: CHUNKER_VERSION,
              maxChunkTokens: 100,
            },
          },
        }),
        repositoryId: "r",
        revision: "v",
        query: "value",
        changedPath: "b.ts",
        mode: "hybrid",
        candidates: 1,
        topK: 1,
        threshold: 0,
        embedding,
      }),
      /dimension mismatch/,
    );
  },
);

unitTest(
  "immutable Git revision indexing excludes dirty and untracked content",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "acr-revision-index-"));
    const run = async (args: string[]) =>
      promisify(execFile)("git", args, { cwd: root, encoding: "utf8" });
    await run(["init"]);
    await run(["config", "user.email", "test@example.invalid"]);
    await run(["config", "user.name", "Test"]);
    await writeFile(
      join(root, "dependency.ts"),
      "export const value = 'pr';\n",
    );
    await run(["add", "."]);
    await run(["commit", "-m", "pr revision"]);
    const prSha = (await run(["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(
      join(root, "dependency.ts"),
      "export const value = 'later committed';\n",
    );
    await run(["add", "."]);
    await run(["commit", "-m", "wrong head"]);
    await writeFile(
      join(root, "dependency.ts"),
      "export const value = 'DIRTY_LOCAL_NOT_IN_PR';\n",
    );
    await writeFile(
      join(root, "untracked.ts"),
      "export const untracked = 'NOT_IN_PR';\n",
    );
    const policy = await loadIgnorePolicy(root);
    const pinned = await buildRepositoryIndex({
      root,
      repositoryId: "repo",
      revision: "pr-snapshot",
      gitRevision: prSha,
      cacheDirName: ".pinned-cache",
      maxChunkTokens: 200,
      ignorePolicy: policy,
    });
    assert.ok(pinned.chunks.some((chunk) => chunk.content.includes("'pr'")));
    assert.ok(
      pinned.chunks.every(
        (chunk) =>
          !chunk.content.includes("DIRTY_LOCAL_NOT_IN_PR") &&
          !chunk.content.includes("later committed") &&
          chunk.path !== "untracked.ts",
      ),
    );
    const local = await buildRepositoryIndex({
      root,
      repositoryId: "repo",
      revision: "working-snapshot",
      cacheDirName: ".local-cache",
      maxChunkTokens: 200,
      ignorePolicy: policy,
    });
    assert.ok(
      local.chunks.some((chunk) =>
        chunk.content.includes("DIRTY_LOCAL_NOT_IN_PR"),
      ),
    );
    assert.ok(local.chunks.some((chunk) => chunk.path === "untracked.ts"));
  },
);

unitTest(
  "embedding keys include paths and lexical rebuilds preserve vectors",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "acr-vector-identity-"));
    await promisify(execFile)("git", ["init"], { cwd: root });
    await writeFile(join(root, "before.ts"), "export const stable = 1;\n");
    const policy = await loadIgnorePolicy(root);
    const delegate = new DeterministicTestEmbedding();
    let embedded = 0;
    const embedding = {
      provider: delegate.provider,
      model: delegate.model,
      version: delegate.version,
      dimensions: delegate.dimensions,
      async embed(texts: string[]) {
        embedded += texts.length;
        return delegate.embed(texts);
      },
    };
    const common = {
      root,
      repositoryId: "repo",
      cacheDirName: ".identity-cache",
      maxChunkTokens: 100,
      ignorePolicy: policy,
    };
    const first = await buildRepositoryIndex({
      ...common,
      revision: "one",
      embedding,
    });
    const firstCount = embedded;
    const firstKeys = first.vectors.keys();
    await buildRepositoryIndex({ ...common, revision: "lexical" });
    await buildRepositoryIndex({
      ...common,
      revision: "hybrid-again",
      embedding,
    });
    assert.equal(
      embedded,
      firstCount,
      "lexical rebuild must retain valid vectors",
    );
    await rename(join(root, "before.ts"), join(root, "after.ts"));
    const renamed = await buildRepositoryIndex({
      ...common,
      revision: "renamed",
      embedding,
    });
    assert.ok(
      embedded > firstCount,
      "renaming changes the exact embedding input",
    );
    assert.notDeepEqual(renamed.vectors.keys(), firstKeys);
  },
);

unitTest("same-file helper context remains retrievable", async () => {
  const chunks = chunkSource({
    repositoryId: "r",
    revision: "v",
    path: "src/limits.ts",
    content:
      "function parseLimit(value: string) { return Number(value); }\nexport function use(input: string) { return parseLimit(input); }",
    maxTokens: 200,
  });
  const result = await retrieveContext({
    index: fixtureIndex({
      policyVersion: POLICY_VERSION,
      chunkerVersion: CHUNKER_VERSION,
      repositoryId: "r",
      revision: "v",
      maxChunkTokens: 200,
      createdAt: "now",
      files: filesForChunks(chunks),
      chunks,
    }),
    repositoryId: "r",
    revision: "v",
    query: "parseLimit input",
    changedPath: "src/limits.ts",
    mode: "lexical",
    candidates: 5,
    topK: 2,
    threshold: 0,
  });
  assert.ok(result.some((item) => item.chunk.path === "src/limits.ts"));
});
