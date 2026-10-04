import assert from "node:assert/strict";
import { POLICY_VERSION } from "../src/review/types.js";
import { filesForChunks, fixtureIndex } from "./index-fixtures.js";
import { DeterministicTestEmbedding } from "../src/retrieval/embeddings.js";
import {
  buildLexicalIndex,
  rankLexicalCandidates,
} from "../src/retrieval/lexical-index.js";
import { prepareRepositoryIndex } from "../src/retrieval/prepared-index.js";
import { retrieveContext } from "../src/retrieval/retrieve.js";
import {
  embeddingCacheKey,
  embeddingInputHash,
} from "../src/retrieval/index-store.js";
import {
  CHUNKER_VERSION,
  type ContextChunk,
  type RepositoryIndex,
  type StoredVector,
} from "../src/retrieval/types.js";
import { unitTest } from "./helpers.js";
import { referenceLexical, referenceRetrieve } from "./reference-retrieval.js";

const embedding = new DeterministicTestEmbedding();

/** Small deterministic PRNG so every run explores the same index/query space. */
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

const VOCABULARY = [
  "user",
  "profile",
  "retry",
  "parse",
  "queue",
  "order",
  "cache",
  "$store",
  "_private",
  "CamelCase",
  "ab", // below the 3-character token minimum: never a term
  "x1y",
  "ünïcode",
  "123",
  "render",
  "admin",
];
const PATHS = ["src/a.ts", "src/b/c.ts", "lib/user.ts", "lib/queue.ts"];
const IMPORTS = [
  "./user",
  "../lib/queue",
  "./",
  "",
  "src/a.ts",
  "queue",
  "b/c",
];

function chunk(
  id: number,
  fields: Partial<ContextChunk> & { path: string },
): ContextChunk {
  return {
    id: `c${id}`,
    repositoryId: "r",
    revision: "v",
    language: "typescript",
    kind: fields.name ? "symbol" : "file",
    imports: [],
    startLine: 1,
    endLine: 1,
    content: "",
    contentHash: `h${id}`,
    contentComplete: true,
    ...fields,
  };
}

function makeIndex(
  chunks: ContextChunk[],
  vectors: StoredVector[] = [],
): RepositoryIndex {
  return fixtureIndex({
    policyVersion: POLICY_VERSION,
    chunkerVersion: CHUNKER_VERSION,
    repositoryId: "r",
    revision: "v",
    maxChunkTokens: 200,
    createdAt: "now",
    files: filesForChunks(chunks),
    chunks,
    vectors,
  });
}

function randomChunks(random: () => number, count: number): ContextChunk[] {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)]!;
  return Array.from({ length: count }, (_, id) => {
    const words = Array.from({ length: Math.floor(random() * 12) }, () =>
      pick(VOCABULARY),
    );
    const name = random() < 0.4 ? pick(VOCABULARY) : undefined;
    return chunk(id, {
      path: pick(PATHS),
      name,
      signature: name && random() < 0.5 ? `function ${name}()` : undefined,
      imports: Array.from({ length: Math.floor(random() * 3) }, () =>
        pick(IMPORTS),
      ),
      content: words.join(" "),
    });
  });
}

function randomQuery(random: () => number): string {
  const length = Math.floor(random() * 7);
  return Array.from(
    { length },
    () => VOCABULARY[Math.floor(random() * VOCABULARY.length)]!,
  ).join(" ");
}

function rank(
  chunks: ContextChunk[],
  query: string,
  changedPath: string,
  limit: number,
) {
  return rankLexicalCandidates(
    buildLexicalIndex(chunks),
    query,
    changedPath,
    limit,
  ).candidates;
}

unitTest(
  "inverted lexical index ranks exactly like the full-scan reference",
  () => {
    const random = prng(20260401);
    let comparisons = 0;
    for (let round = 0; round < 12; round++) {
      const chunks = randomChunks(random, [0, 1, 2, 7, 25, 60][round % 6]!);
      const lexical = buildLexicalIndex(chunks);
      for (let q = 0; q < 40; q++) {
        const query = randomQuery(random);
        const changedPath =
          random() < 0.5
            ? PATHS[Math.floor(random() * PATHS.length)]!
            : "src/other/file.ts";
        const limit = [1, 3, 10, 80][Math.floor(random() * 4)]!;
        assert.deepEqual(
          rankLexicalCandidates(lexical, query, changedPath, limit).candidates,
          referenceLexical({ chunks }, query, changedPath, limit),
          `round ${round} query "${query}" path ${changedPath} limit ${limit}`,
        );
        comparisons++;
      }
    }
    assert.equal(comparisons, 480);
  },
);

unitTest("a query matching nothing still fills in document order", () => {
  // Empty import needles match every path, so strip imports to get zero scores.
  const chunks = randomChunks(prng(1), 12).map((item) => ({
    ...item,
    imports: [],
  }));
  const ranked = rank(chunks, "zzzzzz qqqqqq", "src/none.ts", 5);
  assert.deepEqual(
    ranked.map((candidate) => candidate.chunk.id),
    chunks.slice(0, 5).map((item) => item.id),
  );
  assert.ok(ranked.every((c) => c.score === 0 && c.reasons.length === 0));
  assert.deepEqual(
    ranked,
    referenceLexical({ chunks }, "zzzzzz qqqqqq", "src/none.ts", 5),
  );
});

unitTest("zero-score fill skips scored chunks and keeps document order", () => {
  const chunks = [
    chunk(0, { path: "p/zero0.ts", content: "nothing here" }),
    chunk(1, { path: "p/hit1.ts", content: "needle" }),
    chunk(2, { path: "p/zero2.ts", content: "nothing here" }),
    chunk(3, { path: "p/hit3.ts", content: "needle" }),
    chunk(4, { path: "p/zero4.ts", content: "nothing here" }),
  ];
  const ranked = rank(chunks, "needle", "x.ts", 4);
  assert.deepEqual(
    ranked.map((c) => [c.chunk.id, c.score > 0]),
    [
      ["c1", true],
      ["c3", true],
      ["c0", false],
      ["c2", false],
    ],
  );
  assert.deepEqual(ranked, referenceLexical({ chunks }, "needle", "x.ts", 4));
});

unitTest("equal scores keep document order, including past topK", () => {
  const chunks = Array.from({ length: 30 }, (_, id) =>
    chunk(id, { path: `p/${id}.ts`, content: "needle" }),
  );
  const ranked = rank(chunks, "needle", "x.ts", 10);
  assert.deepEqual(
    ranked.map((c) => c.chunk.id),
    chunks.slice(0, 10).map((c) => c.id),
  );
});

unitTest("duplicate query terms count once; short tokens never match", () => {
  const chunks = [
    chunk(0, { path: "a.ts", content: "needle thread" }),
    chunk(1, { path: "b.ts", content: "ab ab ab" }),
  ];
  assert.deepEqual(
    rank(chunks, "needle needle NEEDLE ab", "x.ts", 5),
    referenceLexical({ chunks }, "needle needle NEEDLE ab", "x.ts", 5),
  );
  const [first] = rank(chunks, "needle needle NEEDLE", "x.ts", 1);
  assert.equal(first!.score, 1);
  assert.deepEqual(first!.reasons, ["keyword-overlap:1"]);
});

unitTest("a term present in every chunk ranks by overlap then order", () => {
  const chunks = Array.from({ length: 50 }, (_, id) =>
    chunk(id, {
      path: `p/${id}.ts`,
      content: id % 7 === 0 ? "common special" : "common",
    }),
  );
  const ranked = rank(chunks, "common special", "x.ts", 12);
  assert.deepEqual(
    ranked,
    referenceLexical({ chunks }, "common special", "x.ts", 12),
  );
  assert.equal(ranked[0]!.chunk.id, "c0");
});

unitTest("limit above the number of chunks returns every chunk", () => {
  const chunks = randomChunks(prng(9), 6);
  assert.equal(rank(chunks, "user", "src/a.ts", 100).length, 6);
  assert.deepEqual(rank(chunks, "user", "src/a.ts", 0), []);
  assert.deepEqual(rank([], "user", "src/a.ts", 5), []);
});

unitTest("symbol, import, same-file and overlap contributions combine", () => {
  const chunks = [
    chunk(0, {
      path: "src/app.ts",
      name: "Parser",
      imports: ["./helpers"],
      content: "parser helpers",
    }),
    chunk(1, { path: "src/helpers.ts", name: "other", content: "nothing" }),
    chunk(2, { path: "src/x.ts", imports: ["./"], content: "nothing" }),
  ];
  const ranked = rank(chunks, "parser", "src/app.ts", 3);
  assert.deepEqual(
    ranked,
    referenceLexical({ chunks }, "parser", "src/app.ts", 3),
  );
  assert.deepEqual(ranked[0]!.reasons, [
    "keyword-overlap:1",
    "symbol-match",
    "same-file",
  ]);
  // An import of "./" has an empty needle, which every path contains.
  assert.ok(
    ranked.find((c) => c.chunk.id === "c2")!.reasons.includes("import-link"),
  );
});

unitTest("lexical work scales with matches, not with chunk count", () => {
  const chunks = Array.from({ length: 3000 }, (_, id) =>
    chunk(id, {
      path: `p/${id}.ts`,
      content: id % 1000 === 7 ? "rareterm filler" : "filler words only",
    }),
  );
  const lexical = buildLexicalIndex(chunks);
  const { candidates, work } = rankLexicalCandidates(
    lexical,
    "rareterm",
    "x.ts",
    20,
  );
  assert.equal(work.postingsExamined, 3);
  assert.equal(work.documentsScored, 3);
  assert.equal(work.documentsFilled, 17);
  assert.equal(candidates.length, 20);
  assert.deepEqual(
    candidates,
    referenceLexical({ chunks }, "rareterm", "x.ts", 20),
  );
});

unitTest(
  "retrieval after preparation never reads chunk text, names or imports",
  async () => {
    const chunks = randomChunks(prng(77), 80);
    const reads: Record<string, number> = {};
    for (const item of chunks)
      for (const field of [
        "content",
        "signature",
        "name",
        "imports",
        "path",
      ] as const) {
        const value = item[field];
        Object.defineProperty(item, field, {
          enumerable: true,
          get() {
            reads[field] = (reads[field] ?? 0) + 1;
            return value;
          },
        });
      }
    const index = makeIndex(chunks);
    const prepared = prepareRepositoryIndex(index);
    const afterPrepare = { ...reads };
    assert.ok((afterPrepare.content ?? 0) >= chunks.length);
    for (let i = 0; i < 25; i++)
      await retrieveContext({
        index: prepared,
        repositoryId: "r",
        revision: "v",
        query: randomQuery(prng(i)),
        changedPath: PATHS[i % PATHS.length]!,
        mode: "lexical",
        candidates: 10,
        topK: 5,
        threshold: 0,
      });
    assert.deepEqual(reads, afterPrepare);
  },
);

unitTest(
  "hybrid and lexical retrieval match the reference across random indexes",
  async () => {
    const random = prng(424242);
    for (let round = 0; round < 6; round++) {
      const chunks = randomChunks(random, [3, 9, 30][round % 3]!);
      const vectors: StoredVector[] = [];
      // Vectors for only some chunks: vector-only and lexical-only candidates.
      for (const item of chunks)
        if (random() < 0.7) {
          const key = embeddingCacheKey(item, embedding, 200);
          vectors.push({
            cacheKey: key,
            values: (await embedding.embed([item.content]))[0]!,
            inputHash: embeddingInputHash(item),
            dimensions: 64,
            provider: embedding.provider,
            model: embedding.model,
            version: embedding.version,
            dimensionIdentity: "64",
            chunkerVersion: CHUNKER_VERSION,
            maxChunkTokens: 200,
          });
        }
      const index = makeIndex(chunks, vectors);
      const prepared = prepareRepositoryIndex(index);
      for (let q = 0; q < 8; q++) {
        const query = randomQuery(random);
        const changedPath = PATHS[q % PATHS.length]!;
        for (const mode of ["lexical", "hybrid"] as const)
          for (const [candidates, topK, threshold] of [
            [4, 3, 0],
            [10, 5, 0.1],
            [50, 50, 0],
          ] as const)
            assert.deepEqual(
              await retrieveContext({
                index: prepared,
                repositoryId: "r",
                revision: "v",
                query,
                changedPath,
                mode,
                candidates,
                topK,
                threshold,
                embedding: mode === "hybrid" ? embedding : undefined,
              }),
              await referenceRetrieve(
                index,
                query,
                changedPath,
                mode,
                candidates,
                topK,
                threshold,
              ),
              `${mode} round ${round} "${query}" ${candidates}/${topK}/${threshold}`,
            );
      }
    }
  },
);
