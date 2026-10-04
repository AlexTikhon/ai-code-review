import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DeterministicTestEmbedding } from "../src/retrieval/embeddings.js";
import {
  embeddingInputHash,
  normalizedEmbeddingInput,
} from "../src/retrieval/embedding-keys.js";
import {
  indexPath,
  readIndex,
  refreshRepositoryIndex,
  type IndexStoreEvent,
} from "../src/retrieval/index-store.js";
import {
  updateRepositoryIndex,
  type SourceFileRef,
} from "../src/retrieval/index-update.js";
import {
  prepareRepositoryIndex,
  semanticSpaceFor,
} from "../src/retrieval/prepared-index.js";
import type { ContextChunk, RepositoryIndex } from "../src/retrieval/types.js";
import { refInputHash } from "../src/retrieval/vector-store.js";
import { unitTest } from "./helpers.js";
import {
  generationsOf,
  snapshotFiles,
  storedVector,
  storedVectors,
} from "./index-fixtures.js";
import { indexOptions, probedEmbedding, put, repo } from "./index-harness.js";

const embedder = new DeterministicTestEmbedding();

/** A file of five distinct functions, so a 100-file tree yields ~500 vectors. */
const fileText = (id: number, variant = 0) =>
  Array.from(
    { length: 5 },
    (_, fn) =>
      `export function f${id}_${fn}(input: number) {\n  return input * ${id + fn + variant} + ${fn};\n}\n`,
  ).join("\n") + (variant ? "// edited, and longer\n" : "");

const tree = (count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, id) => [`src/g${id}.ts`, fileText(id)]),
  );

async function reload(path: string): Promise<RepositoryIndex> {
  const loaded = await readIndex(path);
  assert.equal(loaded.status, "valid");
  return (loaded as { status: "valid"; index: RepositoryIndex }).index;
}

unitTest(
  "incremental indexing of a persisted index reuses unchanged vectors and nothing else",
  async () => {
    const root = await repo(tree(100));
    const first = probedEmbedding();
    const initial = await refreshRepositoryIndex(
      await indexOptions(root, { embedding: first.adapter }),
    );
    const total = initial.index.vectors.count;
    assert.ok(total >= 400, `a realistic number of vectors, got ${total}`);
    assert.equal(first.state.texts, total);
    const oldByHash = new Map(
      storedVectors(initial.index).map((vector) => [vector.inputHash, vector]),
    );

    // Edit 3 files, delete 2, add 1.
    await put(root, "src/g3.ts", fileText(3, 1));
    await put(root, "src/g40.ts", fileText(40, 1));
    await put(root, "src/g77.ts", fileText(77, 1));
    await rm(join(root, "src/g5.ts"));
    await rm(join(root, "src/g90.ts"));
    await put(root, "src/extra.ts", fileText(500));

    const second = probedEmbedding();
    const events: IndexStoreEvent[] = [];
    const next = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: second.adapter,
        revision: "rev-2",
        onStoreEvent: (event) => events.push(event),
      }),
    );
    const { index, stats } = next;
    assert.equal(stats.previous, "reused");
    assert.equal(stats.filesRead, 4, "only edited and added files are read");
    assert.equal(stats.filesDeleted, 2);
    assert.equal(stats.filesReused, 100 - 2 - 3, "98 remain, 3 of them edited");

    // Exactly the new embedding inputs were embedded; no unchanged file was.
    const keptHashes = new Set(index.inputHashes);
    const created = [...keptHashes].filter((hash) => !oldByHash.has(hash));
    assert.equal(second.state.texts, created.length);
    assert.equal(stats.vectorsCreated, created.length);
    assert.equal(stats.vectorsReused, keptHashes.size - created.length);
    assert.ok(created.length >= 15 && created.length <= 30);
    assert.ok(second.state.requests <= 1);
    assert.ok(
      stats.vectorsPruned >= 10,
      "vectors of edited/deleted code are dropped",
    );

    // The store is exactly the vectors of the current chunks: nothing missing,
    // nothing left over from deleted or edited code.
    assert.equal(index.vectors.count, keptHashes.size);
    for (const ref of index.vectors.refs())
      assert.ok(keptHashes.has(refInputHash(ref)), "no ghost vector");
    for (const hash of keptHashes)
      assert.ok(
        [...index.vectors.refs()].some((ref) => refInputHash(ref) === hash),
        "every chunk input has its vector",
      );
    const removedHashes = [...oldByHash.keys()].filter(
      (hash) => !keptHashes.has(hash),
    );
    assert.ok(removedHashes.length >= 10);

    // Reused vectors are bit-identical to what was stored before.
    for (const vector of storedVectors(index)) {
      const earlier = oldByHash.get(vector.inputHash);
      if (earlier) assert.deepEqual(vector.values, earlier.values);
      else
        assert.deepEqual(
          vector.values,
          (await embedder.embed([findInput(index, vector.inputHash)]))[0],
        );
    }

    // Search rows line up with chunks: row `o` is the embedding of chunk `o`.
    const prepared = prepareRepositoryIndex(index);
    const space = semanticSpaceFor(prepared, second.adapter);
    assert.equal(space.index.count, space.chunks.length);
    const { dimensions, vectors } = space.index;
    for (const ordinal of [0, 1, 123, space.chunks.length - 1]) {
      const chunk = space.chunks[ordinal]!;
      assert.deepEqual(
        [...vectors.subarray(ordinal * dimensions, (ordinal + 1) * dimensions)],
        (await embedder.embed([normalizedEmbeddingInput(chunk)]))[0],
      );
    }

    // Persisted and reloaded: same chunks, same hashes, same bytes.
    const reloaded = await reload(indexPath(root, ".cache"));
    assert.deepEqual(reloaded.inputHashes, index.inputHashes);
    assert.deepEqual(storedVectors(reloaded), storedVectors(index));

    // And equal to indexing the final tree from scratch.
    const final = await repo({
      ...Object.fromEntries(
        Object.entries(tree(100)).filter(
          ([path]) => !["src/g5.ts", "src/g90.ts"].includes(path),
        ),
      ),
      "src/g3.ts": fileText(3, 1),
      "src/g40.ts": fileText(40, 1),
      "src/g77.ts": fileText(77, 1),
      "src/extra.ts": fileText(500),
    });
    const scratch = await refreshRepositoryIndex(
      await indexOptions(final, {
        embedding: probedEmbedding().adapter,
        revision: "rev-2",
      }),
    );
    const byKey = (vectors: ReturnType<typeof storedVectors>) =>
      vectors.sort((a, b) => a.cacheKey.localeCompare(b.cacheKey));
    assert.deepEqual(
      byKey(storedVectors(index)),
      byKey(storedVectors(scratch.index)),
    );
    assert.ok(events.some((event) => event.type === "published"));
  },
);

function findInput(index: RepositoryIndex, hash: string): string {
  const position = index.inputHashes.indexOf(hash);
  return normalizedEmbeddingInput(index.chunks[position]!);
}

unitTest("a run with no changes rewrites no vector bytes", async () => {
  const root = await repo(tree(30));
  const probe = probedEmbedding();
  await refreshRepositoryIndex(
    await indexOptions(root, { embedding: probe.adapter }),
  );
  const path = indexPath(root, ".cache");
  const before = await snapshotFiles(generationsOf(path));
  const blob = Object.keys(before).find((name) => name.endsWith(".bin"))!;
  const events: IndexStoreEvent[] = [];
  const again = await refreshRepositoryIndex(
    await indexOptions(root, {
      embedding: probe.adapter,
      revision: "rev-2",
      onStoreEvent: (event) => events.push(event),
    }),
  );
  assert.equal(again.stats.vectorsCreated, 0);
  const published = events.find((event) => event.type === "published");
  assert.ok(published?.type === "published" && published.vectorBlobReused);
  assert.equal(
    (await snapshotFiles(generationsOf(path)))[blob],
    before[blob],
    "the 100% reusable blob is kept as is",
  );
  // The retained vector set is also the very same in-memory store.
  const loaded = await reload(path);
  assert.equal(loaded.revision, "rev-2");
});

unitTest(
  "stored chunk input hashes are carried over, not recomputed, for unchanged files",
  async () => {
    const root = await repo(tree(6));
    const probe = probedEmbedding();
    const { index } = await refreshRepositoryIndex(
      await indexOptions(root, { embedding: probe.adapter }),
    );
    // Poison one persisted hash: if it is reused as is, the poison survives.
    const poisoned = "f".repeat(64);
    const previous: RepositoryIndex = {
      ...index,
      inputHashes: index.inputHashes.map((hash, i) =>
        i === 0 ? poisoned : hash,
      ),
    };
    const files: SourceFileRef[] = index.files.map((file) => ({
      path: file.path,
      size: file.size,
      mtimeMs: file.mtimeMs,
      read: async () => {
        throw new Error("an unchanged file must not be read");
      },
    }));
    const { index: next, stats } = await updateRepositoryIndex({
      previous,
      repositoryId: "repo",
      revision: index.revision,
      maxChunkTokens: 100,
      files,
    });
    assert.equal(stats.filesReused, index.files.length);
    assert.equal(next.inputHashes[0], poisoned, "reused from the index");
    assert.deepEqual(next.inputHashes.slice(1), index.inputHashes.slice(1));
    // Changed content, by contrast, is hashed fresh.
    const changed = await updateRepositoryIndex({
      previous,
      repositoryId: "repo",
      revision: index.revision,
      maxChunkTokens: 100,
      files: [
        {
          path: index.files[0]!.path,
          read: async () => "export const changed = 1;\n",
        },
      ],
    });
    assert.deepEqual(
      changed.index.inputHashes,
      changed.index.chunks.map(embeddingInputHash),
    );
  },
);

unitTest("the chunk input hash covers exactly the embedding input", () => {
  const chunk = (over: Partial<ContextChunk> = {}): ContextChunk => ({
    id: "c",
    repositoryId: "r",
    revision: "v1",
    path: "src/a.ts",
    language: "typescript",
    kind: "symbol",
    signature: "function a()",
    imports: [],
    startLine: 1,
    endLine: 3,
    content: "function a() {\n  return 1;\n}",
    contentHash: "x",
    contentComplete: true,
    ...over,
  });
  const base = embeddingInputHash(chunk());
  assert.match(base, /^[0-9a-f]{64}$/);
  // Anything that changes what is embedded changes the hash ...
  for (const changed of [
    chunk({ path: "src/b.ts" }),
    chunk({ signature: "function b()" }),
    chunk({ content: "function a() {\n  return 2;\n}" }),
  ])
    assert.notEqual(embeddingInputHash(changed), base);
  // ... and what is not part of the input does not.
  for (const same of [
    chunk({ id: "other", revision: "v2" }),
    chunk({ startLine: 10, endLine: 12 }),
    chunk({ repositoryId: "elsewhere" }),
    chunk({ content: "function a() {\r\n  return 1;\r\n}" }),
    chunk({ path: "src\\a.ts" }),
  ])
    assert.equal(embeddingInputHash(same), base);
  // The hash is one-way: no input text is recoverable from it.
  assert.ok(!base.includes("return"));
});

unitTest(
  "persisted chunk hashes equal the hash of each persisted chunk",
  async () => {
    const root = await repo(tree(8));
    await refreshRepositoryIndex(
      await indexOptions(root, { embedding: probedEmbedding().adapter }),
    );
    const index = await reload(indexPath(root, ".cache"));
    assert.deepEqual(index.inputHashes, index.chunks.map(embeddingInputHash));
    const metadata = JSON.parse(
      await readFile(
        join(
          generationsOf(indexPath(root, ".cache")),
          JSON.parse(await readFile(indexPath(root, ".cache"), "utf8"))
            .metadataFile,
        ),
        "utf8",
      ),
    );
    assert.equal(metadata.chunkInputHashes.length, metadata.chunks.length);
    const vector = storedVector(index, index.vectors.keys()[0]!);
    assert.ok(index.inputHashes.includes(vector.inputHash));
  },
);
