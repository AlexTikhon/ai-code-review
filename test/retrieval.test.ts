import assert from "node:assert/strict";
import { chunkSource } from "../src/retrieval/chunker.js";
import { DeterministicTestEmbedding } from "../src/retrieval/embeddings.js";
import { retrieveContext } from "../src/retrieval/retrieve.js";
import {
  CHUNKER_VERSION,
  type RepositoryIndex,
} from "../src/retrieval/types.js";
import { unitTest } from "./helpers.js";
import { execFile } from "node:child_process";
import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildRepositoryIndex } from "../src/retrieval/index-store.js";
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
    assert.equal(chunks[0]?.name, "UserService");
    assert.match(chunks[0]?.signature ?? "", /class UserService/);
    assert.deepEqual(chunks[0]?.imports, ["./db"]);
    assert.equal(chunks[0]?.startLine, 2);
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
    const vectors: RepositoryIndex["vectors"] = {};
    for (const chunk of chunks) {
      const key = `${chunk.contentHash}:${embedding.model}:${embedding.version}:${CHUNKER_VERSION}`;
      vectors[key] = {
        cacheKey: key,
        values: (await embedding.embed([chunk.content]))[0]!,
      };
    }
    const index: RepositoryIndex = {
      schemaVersion: 1,
      chunkerVersion: CHUNKER_VERSION,
      repositoryId: "r",
      revision: "v",
      createdAt: "now",
      chunks,
      vectors,
    };
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
    const index: RepositoryIndex = {
      schemaVersion: 1,
      chunkerVersion: CHUNKER_VERSION,
      repositoryId: "a",
      revision: "1",
      createdAt: "now",
      chunks: [],
      vectors: {},
    };
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
