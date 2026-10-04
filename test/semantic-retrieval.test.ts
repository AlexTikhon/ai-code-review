import assert from "node:assert/strict";
import {
  indexPath,
  readIndex,
  refreshRepositoryIndex,
} from "../src/retrieval/index-store.js";
import {
  findStoredVector,
  prepareRepositoryIndex,
  semanticSpaceFor,
  type PreparedRepositoryIndex,
} from "../src/retrieval/prepared-index.js";
import { retrieveContext } from "../src/retrieval/retrieve.js";
import type { RepositoryIndex } from "../src/retrieval/types.js";
import {
  refValues,
  vectorStoreFromStored,
} from "../src/retrieval/vector-store.js";
import { unitTest } from "./helpers.js";
import { storedVectors } from "./index-fixtures.js";
import {
  indexOptions,
  probedEmbedding,
  put,
  repo,
  sources,
} from "./index-harness.js";
import { referenceRetrieve } from "./reference-retrieval.js";

const BATCH = 4;

async function indexed(files = 12) {
  const root = await repo(sources(files));
  const { adapter } = probedEmbedding();
  const { index } = await refreshRepositoryIndex(
    await indexOptions(root, {
      embedding: adapter,
      maxEmbeddingBatchSize: BATCH,
    }),
  );
  return { root, adapter, index };
}

const QUERIES: Array<[string, string]> = [
  ["src/m1.ts", "src/m1.ts\nwork1 return value"],
  ["src/m5.ts", "src/m5.ts\nfunction work5 compute"],
  ["src/zz.ts", "completely unrelated wording here"],
];

const hybrid = (
  index: RepositoryIndex | PreparedRepositoryIndex,
  adapter: Parameters<typeof retrieveContext>[0]["embedding"],
  query: string,
  changedPath: string,
  revision = "rev-1",
) =>
  retrieveContext({
    index,
    repositoryId: "repo",
    revision,
    query,
    changedPath,
    mode: "hybrid",
    candidates: 10,
    topK: 5,
    threshold: 0,
    embedding: adapter,
  });

/**
 * Row contents keyed by chunk identity that survives a revision change (chunk
 * ids embed the revision), so layouts can be compared across builds.
 */
function rowsByChunk(
  prepared: PreparedRepositoryIndex,
  adapter: Parameters<typeof semanticSpaceFor>[1],
) {
  const space = semanticSpaceFor(prepared, adapter);
  const { dimensions, vectors } = space.index;
  return new Map(
    space.chunks.map((chunk, ordinal) => [
      `${chunk.path}:${chunk.startLine}:${chunk.contentHash}`,
      [...vectors.subarray(ordinal * dimensions, (ordinal + 1) * dimensions)],
    ]),
  );
}

unitTest(
  "the packed space is built once per prepared index, not per segment",
  async () => {
    const { adapter, index } = await indexed();
    const prepared = prepareRepositoryIndex(index);
    assert.equal(prepared.semantic.builds, 0, "nothing is packed up front");
    for (let i = 0; i < 5; i++)
      await retrieveContext({
        index: prepared,
        repositoryId: "repo",
        revision: "rev-1",
        query: "work",
        changedPath: "src/m1.ts",
        mode: "lexical",
        candidates: 10,
        topK: 5,
        threshold: 0,
      });
    assert.equal(
      prepared.semantic.builds,
      0,
      "lexical retrieval never pays for packing",
    );
    for (let segment = 0; segment < 50; segment++)
      await hybrid(prepared, adapter, `segment ${segment} work`, "src/m1.ts");
    assert.equal(prepared.semantic.builds, 1);
    const space = semanticSpaceFor(prepared, adapter);
    assert.equal(semanticSpaceFor(prepared, adapter), space, "same instance");
    assert.equal(prepared.semantic.builds, 1);
  },
);

unitTest(
  "each packed row maps back to the chunk it was built from",
  async () => {
    const { adapter, index } = await indexed();
    // Drop every other vector: ordinals must follow vectors, not chunk positions.
    const kept = storedVectors(index).filter((_, i) => i % 2 === 0);
    const prepared = prepareRepositoryIndex({
      ...index,
      vectors: vectorStoreFromStored(kept),
    });
    const space = semanticSpaceFor(prepared, adapter);
    assert.equal(space.index.count, kept.length);
    assert.equal(space.chunks.length, space.index.count);
    const { dimensions, vectors } = space.index;
    space.chunks.forEach((chunk, ordinal) => {
      const stored = findStoredVector(
        prepared,
        prepared.chunks.find((item) => item.chunk.id === chunk.id)!,
        adapter,
      )!;
      assert.deepEqual(
        [...vectors.subarray(ordinal * dimensions, (ordinal + 1) * dimensions)],
        [...refValues(stored)],
      );
    });
    const ordinalsInRepositoryOrder = space.chunks.map((chunk) =>
      prepared.chunks.findIndex((item) => item.chunk.id === chunk.id),
    );
    assert.deepEqual(
      ordinalsInRepositoryOrder,
      [...ordinalsInRepositoryOrder].sort((a, b) => a - b),
      "rows keep repository order so ties break exactly as before",
    );
  },
);

unitTest(
  "vectors of other embedding spaces never enter the packed rows",
  async () => {
    const { adapter, index } = await indexed();
    const own = storedVectors(index);
    const foreign = own.map((vector) => ({
      ...vector,
      cacheKey: `other-${vector.cacheKey}`,
      provider: "other",
      dimensionIdentity: "3",
      dimensions: 3,
      values: [1, 2, 3],
    }));
    const prepared = prepareRepositoryIndex({
      ...index,
      vectors: vectorStoreFromStored([...own, ...foreign]),
    });
    const space = semanticSpaceFor(prepared, adapter);
    assert.equal(space.index.count, index.vectors.count);
    assert.equal(space.index.dimensions, 64);
    const other = semanticSpaceFor(prepared, {
      provider: "other",
      model: adapter.model,
      version: adapter.version,
      dimensions: 3,
      embed: async () => [[1, 2, 3]],
    });
    assert.equal(other.index.dimensions, 3);
    assert.equal(prepared.semantic.builds, 2, "one packed space per identity");
  },
);

unitTest(
  "malformed vectors cannot enter a store, and mixed widths fail retrieval clearly",
  async () => {
    const { adapter, index } = await indexed();
    const [first, ...rest] = storedVectors(index);
    // A vector of the wrong length or with non-finite values never gets packed.
    assert.throws(
      () =>
        vectorStoreFromStored([{ ...first!, values: first!.values.slice(1) }]),
      /declared dimensions/,
    );
    assert.throws(
      () =>
        vectorStoreFromStored([
          { ...first!, values: [Number.NaN, ...first!.values.slice(1)] },
        ]),
      /finite/,
    );
    // Two widths under one embedding identity are separate segments; a search
    // that would need both rows in one matrix fails instead of mis-scoring.
    const narrow = { ...first!, values: [1, 2, 3], dimensions: 3 };
    await assert.rejects(
      hybrid(
        { ...index, vectors: vectorStoreFromStored([narrow, ...rest]) },
        adapter,
        "work",
        "src/m1.ts",
      ),
      /dimension mismatch/,
    );
  },
);

unitTest(
  "hybrid still returns semantic-only chunks with zero lexical score",
  async () => {
    const { adapter, index } = await indexed();
    const prepared = prepareRepositoryIndex(index);
    const results = await hybrid(
      prepared,
      adapter,
      "qqqqq zzzzz xxxxx",
      "nowhere/else.ts",
    );
    assert.ok(results.length > 0, "semantic candidates survive a lexical miss");
    for (const candidate of results)
      assert.deepEqual(
        candidate.reasons.map((reason) => reason.split(":")[0]),
        ["semantic"],
        "no lexical signal contributed",
      );
  },
);

unitTest("packed hybrid retrieval equals the reference algorithm", async () => {
  const { adapter, index } = await indexed(16);
  const prepared = prepareRepositoryIndex(index);
  for (const [changedPath, query] of QUERIES) {
    assert.deepEqual(
      await hybrid(prepared, adapter, query, changedPath),
      await referenceRetrieve(index, query, changedPath, "hybrid", 10, 5, 0),
      changedPath,
    );
  }
});

unitTest("a persisted and reloaded index packs identically", async () => {
  const { adapter, index, root } = await indexed();
  const loaded = await readIndex(indexPath(root, ".cache"));
  assert.equal(loaded.status, "valid");
  const fresh = prepareRepositoryIndex(index);
  const reloaded = prepareRepositoryIndex(
    (loaded as { status: "valid"; index: RepositoryIndex }).index,
  );
  const a = semanticSpaceFor(fresh, adapter);
  const b = semanticSpaceFor(reloaded, adapter);
  assert.deepEqual(a.index.vectors, b.index.vectors);
  assert.deepEqual(a.index.squaredNorms, b.index.squaredNorms);
  assert.deepEqual(
    a.chunks.map((chunk) => chunk.id),
    b.chunks.map((chunk) => chunk.id),
  );
});

unitTest(
  "incremental updates pack changed vectors and keep unchanged ones",
  async () => {
    const root = await repo(sources(10));
    const { adapter } = probedEmbedding();
    const options = (revision: string) =>
      indexOptions(root, {
        revision,
        embedding: adapter,
        maxEmbeddingBatchSize: BATCH,
      });
    const first = await refreshRepositoryIndex(await options("rev-1"));
    await put(
      root,
      "src/m3.ts",
      "export function work3() { return 'a completely different body'; }\n",
    );
    const second = await refreshRepositoryIndex(await options("rev-2"));
    assert.ok(
      second.stats.vectorsCreated > 0 && second.stats.vectorsReused > 0,
    );

    const before = rowsByChunk(prepareRepositoryIndex(first.index), adapter);
    const preparedAfter = prepareRepositoryIndex(second.index);
    const after = rowsByChunk(preparedAfter, adapter);
    let unchanged = 0;
    let changed = 0;
    for (const [id, row] of after) {
      const previous = before.get(id);
      if (previous && previous.every((value, i) => value === row[i]))
        unchanged++;
      else changed++;
    }
    assert.ok(unchanged > 0 && changed > 0);
    assert.equal(after.size, second.index.chunks.length);
    for (const [changedPath, query] of QUERIES)
      assert.deepEqual(
        await hybrid(preparedAfter, adapter, query, changedPath, "rev-2"),
        await referenceRetrieve(
          { ...second.index, revision: "rev-2" },
          query,
          changedPath,
          "hybrid",
          10,
          5,
          0,
        ),
      );
  },
);

unitTest(
  "checkpoint-restored vectors pack like freshly embedded ones",
  async () => {
    const root = await repo(sources(6));
    const seed = probedEmbedding();
    await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: seed.adapter,
        maxEmbeddingBatchSize: BATCH,
      }),
    );
    for (const [path, text] of Object.entries(sources(20, 6)))
      await put(root, path, text);
    const failing = probedEmbedding();
    failing.state.failAt = 4;
    await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: failing.adapter,
        maxEmbeddingBatchSize: BATCH,
      }),
    ).catch(() => undefined);
    const resumedProbe = probedEmbedding();
    const resumed = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: resumedProbe.adapter,
        maxEmbeddingBatchSize: BATCH,
      }),
    );
    assert.ok(
      resumed.stats.vectorsFromCheckpoint > 0,
      "the checkpoint was used",
    );

    const direct = await refreshRepositoryIndex(
      await indexOptions(await repo(sources(26)), {
        embedding: probedEmbedding().adapter,
        maxEmbeddingBatchSize: BATCH,
      }),
    );
    const { adapter } = probedEmbedding();
    const restoredPrepared = prepareRepositoryIndex(resumed.index);
    const directPrepared = prepareRepositoryIndex(direct.index);
    assert.deepEqual(
      rowsByChunk(restoredPrepared, adapter),
      rowsByChunk(directPrepared, adapter),
    );
    for (const [changedPath, query] of QUERIES)
      assert.deepEqual(
        (await hybrid(restoredPrepared, adapter, query, changedPath)).map(
          (candidate) => [candidate.chunk.id, candidate.score],
        ),
        (await hybrid(directPrepared, adapter, query, changedPath)).map(
          (candidate) => [candidate.chunk.id, candidate.score],
        ),
      );
  },
);
