import assert from "node:assert/strict";
import {
  buildSemanticIndex,
  searchSemanticIndex,
} from "../src/retrieval/semantic-index.js";
import { unitTest } from "./helpers.js";
import { referenceSemanticRank } from "./reference-retrieval.js";

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Style = "real" | "quantized" | "duplicates" | "sparse";

/** Rows drawn so that exact ties, duplicates, zeros and negatives are common. */
function randomRows(
  random: () => number,
  count: number,
  dimensions: number,
  style: Style,
): number[][] {
  const draw = () => {
    if (style === "quantized") return Math.floor(random() * 5) - 2;
    if (style === "sparse") return random() < 0.7 ? 0 : random() * 2 - 1;
    return random() * 2 - 1;
  };
  const rows: number[][] = [];
  for (let i = 0; i < count; i++) {
    if (style === "duplicates" && i > 0 && random() < 0.4)
      rows.push([...rows[Math.floor(random() * i)]!]);
    else rows.push(Array.from({ length: dimensions }, draw));
  }
  return rows;
}

const search = (rows: number[][], query: number[], limit: number) =>
  searchSemanticIndex(buildSemanticIndex(rows), query, limit).hits;

unitTest("a semantic index packs rows contiguously with exact norms", () => {
  const rows = [
    [1, 2, 3],
    [-1, 0, 0.5],
    [0.1, 0.2, 0.3],
  ];
  const index = buildSemanticIndex(rows);
  assert.equal(index.count, 3);
  assert.equal(index.dimensions, 3);
  assert.deepEqual(
    [...index.vectors],
    rows.flat(),
    "row r occupies [r*dimensions, (r+1)*dimensions)",
  );
  rows.forEach((row, ordinal) => {
    let expected = 0;
    for (const value of row) expected += value ** 2;
    assert.equal(
      index.squaredNorms[ordinal],
      expected,
      "bit-identical to the reference accumulation",
    );
  });
  assert.ok(index.vectors instanceof Float64Array, "no precision is dropped");
});

unitTest("an empty semantic index is valid and returns nothing", () => {
  const index = buildSemanticIndex([]);
  assert.equal(index.count, 0);
  assert.deepEqual(searchSemanticIndex(index, [1, 2], 5).hits, []);
});

unitTest(
  "malformed rows are rejected while building, not while scoring",
  () => {
    assert.throws(
      () => buildSemanticIndex([[1, 2], [1]]),
      /dimension mismatch/,
      "inconsistent dimensions",
    );
    assert.throws(() => buildSemanticIndex([[]]), /positive dimension/);
    for (const bad of [NaN, Infinity, -Infinity])
      assert.throws(
        () =>
          buildSemanticIndex([
            [1, 2],
            [1, bad],
          ]),
        /finite/,
        `non-finite ${bad}`,
      );
  },
);

unitTest("cosine scores identical, orthogonal and opposite vectors", () => {
  const hits = search(
    [
      [1, 2, 3],
      [3, 0, 0],
      [-1, -2, -3],
      [0, 5, 0],
    ],
    [1, 2, 3],
    4,
  );
  const byOrdinal = new Map(hits.map((hit) => [hit.ordinal, hit.score]));
  assert.ok(Math.abs(byOrdinal.get(0)! - 1) < 1e-12, "identical is 1");
  assert.equal(byOrdinal.get(2), 0, "negative cosine is clamped to 0");
  assert.ok(byOrdinal.get(1)! > 0 && byOrdinal.get(3)! > 0);
  assert.deepEqual(
    search(
      [
        [1, 0],
        [0, 1],
      ],
      [1, 0],
      2,
    ).map((hit) => hit.score),
    [1, 0],
    "orthogonal is exactly 0",
  );
});

unitTest("zero vectors score 0 and never produce NaN", () => {
  const zeroStored = search(
    [
      [0, 0],
      [1, 1],
    ],
    [1, 1],
    2,
  );
  assert.deepEqual(
    zeroStored.map((hit) => hit.ordinal),
    [1, 0],
  );
  assert.equal(zeroStored[1]!.score, 0);
  const zeroQuery = search(
    [
      [1, 1],
      [2, 2],
      [3, 3],
    ],
    [0, 0],
    2,
  );
  assert.deepEqual(
    zeroQuery,
    [
      { ordinal: 0, score: 0 },
      { ordinal: 1, score: 0 },
    ],
    "an all-zero query ties everything at 0, in row order",
  );
});

unitTest(
  "a query of the wrong size or with non-finite values is rejected",
  () => {
    const index = buildSemanticIndex([[1, 2, 3]]);
    assert.throws(
      () => searchSemanticIndex(index, [1, 2], 1),
      /dimension mismatch: query=2, stored=3/,
    );
    for (const bad of [NaN, Infinity])
      assert.throws(() => searchSemanticIndex(index, [1, bad, 3], 1), /finite/);
  },
);

unitTest(
  "equal scores keep ascending row order, at any block alignment",
  () => {
    for (let count = 1; count <= 11; count++) {
      const rows = Array.from({ length: count }, () => [0.3, -0.4, 0.5]);
      for (let limit = 1; limit <= count + 1; limit++)
        assert.deepEqual(
          search(rows, [0.3, -0.4, 0.5], limit).map((hit) => hit.ordinal),
          Array.from({ length: Math.min(limit, count) }, (_, i) => i),
          `count=${count} limit=${limit}`,
        );
    }
    // A tie that straddles the K boundary: the later row must lose, not the earlier.
    const rows = [
      [1, 0],
      [0, 1],
      [1, 0],
      [1, 0],
      [0.9, 0.1],
    ];
    assert.deepEqual(
      search(rows, [1, 0], 3).map((hit) => hit.ordinal),
      [0, 2, 3],
    );
  },
);

unitTest("a higher score always outranks an earlier row", () => {
  const rows = [
    [0, 1],
    [0.2, 1],
    [1, 0.2],
    [1, 0],
  ];
  assert.deepEqual(
    search(rows, [1, 0], 4).map((hit) => hit.ordinal),
    [3, 2, 1, 0],
  );
});

unitTest("top-K handles K=0, K=1 and K larger than the index", () => {
  const rows = randomRows(prng(7), 9, 6, "real");
  const query = randomRows(prng(8), 1, 6, "real")[0]!;
  assert.deepEqual(search(rows, query, 0), []);
  assert.equal(search(rows, query, 1).length, 1);
  assert.deepEqual(
    search(rows, query, 1000),
    referenceSemanticRank(rows, query, 1000),
  );
  assert.deepEqual(
    search(rows, query, 3),
    search(rows, query, 3),
    "repeatable",
  );
});

unitTest("packed search equals the reference over seeded random cases", () => {
  const styles: Style[] = ["real", "quantized", "duplicates", "sparse"];
  let cases = 0;
  for (let seed = 1; seed <= 240; seed++) {
    const random = prng(seed * 7919);
    const count = Math.floor(random() * 60);
    const dimensions = 1 + Math.floor(random() * 40);
    const style = styles[seed % styles.length]!;
    const rows = randomRows(random, count, dimensions, style);
    const query =
      random() < 0.2 && count > 0
        ? [...rows[Math.floor(random() * count)]!]
        : randomRows(random, 1, dimensions, style)[0]!;
    const index = buildSemanticIndex(rows);
    for (const limit of [1, 3, 10, 20, count, count + 5]) {
      assert.deepEqual(
        searchSemanticIndex(index, query, limit).hits,
        referenceSemanticRank(rows, query, limit),
        `seed=${seed} style=${style} n=${count} d=${dimensions} k=${limit}`,
      );
      cases++;
    }
  }
  assert.ok(cases > 1000);
});

unitTest("packed search is exact at the real embedding dimension", () => {
  const random = prng(99);
  const rows = randomRows(random, 70, 1536, "real");
  const query = randomRows(random, 1, 1536, "real")[0]!;
  assert.deepEqual(
    search(rows, query, 20),
    referenceSemanticRank(rows, query, 20),
  );
});

unitTest("search work is bounded by K and reports what it did", () => {
  const rows = randomRows(prng(3), 103, 8, "real");
  const query = randomRows(prng(4), 1, 8, "real")[0]!;
  const index = buildSemanticIndex(rows);
  const { hits, work } = searchSemanticIndex(index, query, 5);
  assert.equal(hits.length, 5);
  assert.equal(work.vectorsCompared, 103);
  assert.equal(work.dimensionsProcessed, 103 * 8);
  assert.equal(work.queryNormsComputed, 1, "the query norm is computed once");
  assert.ok(work.insertions >= 5 && work.insertions <= 103);
  // Searching again reuses the stored norms rather than recomputing them.
  const norms = index.squaredNorms;
  searchSemanticIndex(index, query, 5);
  assert.equal(index.squaredNorms, norms);
});
