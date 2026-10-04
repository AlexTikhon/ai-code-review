import assert from "node:assert/strict";
import {
  buildSemanticIndex,
  searchSemanticIndex,
} from "../src/retrieval/semantic-index.js";
import type { StoredVector } from "../src/retrieval/types.js";
import {
  VectorStore,
  VectorStoreBuilder,
  materializeVector,
  packSearchIndex,
  refValues,
  vectorStoreFromStored,
  type EmbeddingSpace,
} from "../src/retrieval/vector-store.js";
import { unitTest } from "./helpers.js";

const SPACE: EmbeddingSpace = {
  provider: "p",
  model: "m",
  version: "v",
  dimensionIdentity: "4",
  dimensions: 4,
};

const vector = (
  n: number,
  overrides: Partial<StoredVector> = {},
): StoredVector => ({
  cacheKey: `k${n}`,
  values: [n, n + 0.5, -n, 1 / (n + 1)],
  inputHash: `h${n}`,
  dimensions: 4,
  provider: "p",
  model: "m",
  version: "v",
  dimensionIdentity: "4",
  chunkerVersion: "c",
  maxChunkTokens: 100,
  ...overrides,
});

unitTest("a store keeps rows exactly and per embedding space", () => {
  const wide = vector(9, {
    cacheKey: "w",
    dimensions: 2,
    dimensionIdentity: "2",
    values: [0.1, 0.2],
  });
  const store = vectorStoreFromStored([vector(1), vector(2), wide, vector(3)]);
  assert.equal(store.count, 4);
  assert.equal(store.segments.length, 2, "grouped by embedding space");
  assert.deepEqual(
    store.segments.map((segment) => segment.count),
    [3, 1],
  );
  assert.deepEqual(store.keys(), ["k1", "k2", "k3", "w"]);
  const ref = store.locate("k2")!;
  assert.deepEqual([...refValues(ref)], vector(2).values);
  assert.deepEqual(
    materializeVector(store.locate("w")!, {
      chunkerVersion: "c",
      maxChunkTokens: 100,
    }),
    wide,
  );
  assert.equal(store.has("nope"), false);
});

unitTest("the first row under a cache key wins and keys stay unique", () => {
  const builder = new VectorStoreBuilder();
  assert.equal(builder.addStored(vector(1)), true);
  assert.equal(builder.addStored(vector(1, { values: [9, 9, 9, 9] })), false);
  const store = builder.build();
  assert.equal(store.count, 1);
  assert.deepEqual([...refValues(store.locate("k1")!)], vector(1).values);
  assert.throws(
    () =>
      new VectorStore([
        ...store.segments,
        ...vectorStoreFromStored([vector(1)]).segments,
      ]),
    /duplicate cache key/,
  );
});

unitTest("rows are copied from packed sources without number[] detours", () => {
  const source = new Float64Array([0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const builder = new VectorStoreBuilder();
  builder.add(SPACE, "a", "ha", source, 4);
  builder.add(SPACE, "b", "hb", source, 8);
  builder.add(SPACE, "c", "hc", [9, 10, 11, 12]);
  const store = builder.build();
  assert.deepEqual(
    [...store.segments[0]!.vectors],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  assert.ok(store.segments[0]!.vectors instanceof Float64Array);
  assert.notEqual(
    store.segments[0]!.vectors.buffer,
    source.buffer,
    "the new segment owns its memory",
  );
});

unitTest("a row too short for its declared dimensions is rejected", () => {
  const builder = new VectorStoreBuilder();
  builder.add(SPACE, "a", "ha", [1, 2, 3]);
  assert.throws(() => builder.build(), /declared dimensions/);
});

unitTest("non-finite and overflowing vectors can never be stored", () => {
  for (const [values, pattern] of [
    [[1, Number.NaN, 0, 0], /finite/],
    [[1, Number.POSITIVE_INFINITY, 0, 0], /finite/],
    [[1e200, 1e200, 0, 0], /norm is not finite/],
  ] as const)
    assert.throws(
      () => vectorStoreFromStored([vector(1, { values: [...values] })]),
      pattern,
    );
});

unitTest("squared norms match the exact-search builder bit for bit", () => {
  const rows = Array.from({ length: 25 }, (_, r) =>
    Array.from({ length: 4 }, (_, d) => Math.cos(r * 13 + d) / 3),
  );
  const store = vectorStoreFromStored(
    rows.map((values, r) => vector(r, { values })),
  );
  const reference = buildSemanticIndex(rows);
  assert.deepEqual(store.segments[0]!.vectors, reference.vectors);
  assert.deepEqual(store.segments[0]!.squaredNorms, reference.squaredNorms);
});

unitTest("an unchanged row set returns the very same store", () => {
  const store = vectorStoreFromStored([vector(1), vector(2)]);
  const same = new VectorStoreBuilder();
  for (const ref of store.refs())
    same.add(
      ref.segment.space,
      ref.segment.cacheKeys[ref.row]!,
      ref.segment.inputHashes[ref.row]!,
      ref.segment.vectors,
      ref.row * 4,
    );
  assert.equal(same.build(store), store);
  const reordered = new VectorStoreBuilder();
  reordered.addStored(vector(2));
  reordered.addStored(vector(1));
  assert.notEqual(reordered.build(store), store, "order is part of identity");
  const extended = new VectorStoreBuilder();
  extended.addStored(vector(1));
  extended.addStored(vector(2));
  extended.addStored(vector(3));
  assert.notEqual(extended.build(store), store);
});

unitTest(
  "searching a whole segment in row order scans the segment itself",
  () => {
    const store = vectorStoreFromStored(
      Array.from({ length: 10 }, (_, n) => vector(n)),
    );
    const refs = [...store.refs()];
    const packed = packSearchIndex(refs);
    assert.equal(packed.vectors, store.segments[0]!.vectors, "no copy");
    assert.equal(packed.squaredNorms, store.segments[0]!.squaredNorms);
    assert.equal(packed.count, 10);
  },
);

unitTest(
  "partial, reordered and shared rows are gathered and rank exactly",
  () => {
    const rows = Array.from({ length: 12 }, (_, r) =>
      Array.from({ length: 4 }, (_, d) => Math.sin(r * 5 + d * 3)),
    );
    const store = vectorStoreFromStored(
      rows.map((values, r) => vector(r, { values })),
    );
    const refs = [...store.refs()];
    // Drop rows, reorder, and use one vector for two chunks.
    const selection = [refs[7]!, refs[2]!, refs[2]!, refs[11]!, refs[0]!];
    const packed = packSearchIndex(selection);
    const expectedRows = [7, 2, 2, 11, 0].map((r) => rows[r]!);
    const reference = buildSemanticIndex(expectedRows);
    assert.notEqual(packed.vectors, store.segments[0]!.vectors);
    assert.deepEqual(packed.vectors, reference.vectors);
    assert.deepEqual(packed.squaredNorms, reference.squaredNorms);
    for (const limit of [1, 3, 5])
      assert.deepEqual(
        searchSemanticIndex(packed, [0.3, -0.2, 0.9, 0.1], limit).hits,
        searchSemanticIndex(reference, [0.3, -0.2, 0.9, 0.1], limit).hits,
      );
  },
);

unitTest("an empty selection packs to an empty index", () => {
  const packed = packSearchIndex([]);
  assert.equal(packed.count, 0);
  assert.deepEqual(searchSemanticIndex(packed, [1, 2, 3, 4], 5).hits, []);
});
