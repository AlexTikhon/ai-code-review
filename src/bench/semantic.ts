/**
 * Semantic retrieval benchmark: the pre-optimization scorer against the packed
 * exact scorer, on synthetic vectors at the production embedding dimension.
 *
 * Structural work counters are deterministic. Wall-clock numbers are medians
 * over repeated, warmed-up runs and are informative only (V8 timing is noisy).
 * Every measured query also asserts that both scorers return identical hits.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { embeddingInputHash } from "../retrieval/embedding-keys.js";
import { prepareRepositoryIndex } from "../retrieval/prepared-index.js";
import { retrieveContext } from "../retrieval/retrieve.js";
import {
  buildSemanticIndex,
  searchSemanticIndex,
  type SemanticHit,
} from "../retrieval/semantic-index.js";
import {
  CHUNKER_VERSION,
  INDEX_SCHEMA_VERSION,
  type ContextChunk,
  type RepositoryIndex,
} from "../retrieval/types.js";
import { median, prng } from "./util.js";

/** text-embedding-3-small, the default OpenAI embedding model. */
const DIMENSIONS = 1536;
const SIZES = [1000, 5000, 10000, 25000, 50000, 100000];
const LIMITS = [3, 10, 20, 50];
const WARMUP_PASSES = 1;
const MEASURED_PASSES = 5;
const QUERIES_PER_PASS = 2;
const MIB = 1024 * 1024;

function randomRows(count: number, dimensions: number, seed: number) {
  const random = prng(seed);
  return Array.from({ length: count }, () =>
    Array.from({ length: dimensions }, () => random() * 2 - 1),
  );
}

type ReferenceWork = {
  vectorsCompared: number;
  multiplyAdds: number;
  normAccumulations: number;
  candidateObjects: number;
  reasonStrings: number;
  sortComparisons: number;
};

/**
 * The scorer before this change: every vector is scored with freshly computed
 * norms, a candidate and reason string is allocated per vector, everything is
 * sorted, and only then truncated. `work` is filled only when asked, so the
 * counting comparator never perturbs the timed runs.
 */
function referenceSearch(
  rows: number[][],
  query: number[],
  limit: number,
  work?: ReferenceWork,
): SemanticHit[] {
  const scored = rows.map((row, ordinal) => {
    let dot = 0;
    let aa = 0;
    let bb = 0;
    for (let i = 0; i < query.length; i++) {
      dot += query[i]! * row[i]!;
      aa += query[i]! ** 2;
      bb += row[i]! ** 2;
    }
    const score = Math.max(0, aa && bb ? dot / Math.sqrt(aa * bb) : 0);
    return { ordinal, score, reasons: [`semantic:${score.toFixed(3)}`] };
  });
  let comparisons = 0;
  scored
    .sort((a, b) => {
      comparisons++;
      return b.score - a.score;
    })
    .splice(limit);
  if (work) {
    work.vectorsCompared = rows.length;
    work.multiplyAdds = rows.length * query.length * 3;
    work.normAccumulations = rows.length * 2;
    work.candidateObjects = rows.length;
    work.reasonStrings = rows.length;
    work.sortComparisons = comparisons;
  }
  return scored.map(({ ordinal, score }) => ({ ordinal, score }));
}

/** Median milliseconds per query over warmed-up, repeated passes. */
function timePerQuery(run: (query: number[]) => unknown, queries: number[][]) {
  const pass = () => {
    const started = performance.now();
    for (const query of queries) run(query);
    return (performance.now() - started) / queries.length;
  };
  for (let i = 0; i < WARMUP_PASSES; i++) pass();
  return median(Array.from({ length: MEASURED_PASSES }, pass));
}

const fixed = (value: number, digits = 1, width = 0) =>
  value.toFixed(digits).padStart(width);

function scorerComparison(): void {
  console.log("== Semantic search: reference scorer vs packed exact scorer ==");
  console.log(
    `${DIMENSIONS} dimensions, synthetic uniform vectors. Median of ${MEASURED_PASSES} passes x ${QUERIES_PER_PASS} queries after ${WARMUP_PASSES} warm-up pass; hits are asserted identical.\n`,
  );
  const timing: string[] = [];
  const work: string[] = [];
  const memory: string[] = [];
  for (const size of SIZES) {
    const rows = randomRows(size, DIMENSIONS, size);
    const queries = randomRows(QUERIES_PER_PASS, DIMENSIONS, size + 1);
    const builtAt = performance.now();
    const index = buildSemanticIndex(rows);
    const buildMs = performance.now() - builtAt;

    for (const limit of LIMITS) {
      for (const query of queries)
        assert.deepEqual(
          searchSemanticIndex(index, query, limit).hits,
          referenceSearch(rows, query, limit),
          `packed search must equal the reference (n=${size}, k=${limit})`,
        );
      const reference = timePerQuery(
        (query) => referenceSearch(rows, query, limit),
        queries,
      );
      const packed = timePerQuery(
        (query) => searchSemanticIndex(index, query, limit),
        queries,
      );
      timing.push(
        [
          String(size).padStart(7),
          String(DIMENSIONS).padStart(5),
          String(limit).padStart(3),
          fixed(reference, 2, 13),
          fixed(packed, 2, 11),
          `${fixed(reference / packed, 1)}x`.padStart(8),
        ].join(" "),
      );
    }

    const before: ReferenceWork = {
      vectorsCompared: 0,
      multiplyAdds: 0,
      normAccumulations: 0,
      candidateObjects: 0,
      reasonStrings: 0,
      sortComparisons: 0,
    };
    referenceSearch(rows, queries[0]!, 20, before);
    const after = searchSemanticIndex(index, queries[0]!, 20).work;
    work.push(
      [
        String(size).padStart(7),
        `${before.multiplyAdds}`.padStart(13),
        `${after.dimensionsProcessed}`.padStart(11),
        `${before.normAccumulations}`.padStart(12),
        `${after.queryNormsComputed}`.padStart(11),
        `${before.candidateObjects}+${before.reasonStrings}`.padStart(15),
        `${Math.min(20, after.insertions)}+${Math.min(20, after.insertions)}`.padStart(
          9,
        ),
        `${before.sortComparisons}`.padStart(11),
        `0 (${after.insertions} inserts)`.padStart(18),
      ].join(" "),
    );

    const bytes = index.vectors.byteLength + index.squaredNorms.byteLength;
    // number[] holds unboxed doubles: 8 bytes per value, plus array headers.
    const unpacked = size * DIMENSIONS * 8;
    memory.push(
      [
        String(size).padStart(7),
        fixed(buildMs, 0, 10),
        fixed(bytes / MIB, 0, 13),
        fixed(unpacked / MIB, 0, 14),
        fixed((size * DIMENSIONS * 4 + size * 4) / MIB, 0, 18),
      ].join(" "),
    );
  }

  console.log(
    [
      "vectors".padStart(7),
      "dim".padStart(5),
      "K".padStart(3),
      "reference ms/q".padStart(13),
      "packed ms/q".padStart(11),
      "speedup".padStart(8),
    ].join(" "),
  );
  console.log(timing.join("\n"));
  console.log("\nStructural work per query at K=20 (production default):");
  console.log(
    [
      "vectors".padStart(7),
      "ref mult-adds".padStart(13),
      "new mult-adds".padStart(11),
      "ref norm accs".padStart(12),
      "new norm accs".padStart(11),
      "ref cand+reason".padStart(15),
      "new allocs".padStart(9),
      "ref sort cmp".padStart(11),
      "new sort".padStart(18),
    ].join(" "),
  );
  console.log(work.join("\n"));
  console.log(
    "\nOne-time preparation and memory (the unpacked number[][] stays resident in the loaded RepositoryIndex):",
  );
  console.log(
    [
      "vectors".padStart(7),
      "build ms".padStart(10),
      "packed F64 MiB".padStart(13),
      "unpacked MiB".padStart(14),
      "hypothetical F32 MiB".padStart(18),
    ].join(" "),
  );
  console.log(memory.join("\n"));
  console.log();
}

/** The real retrieveContext hybrid path, with the lexical-only cost subtracted. */
async function retrievalContextBenchmark(): Promise<void> {
  console.log("== retrieveContext (hybrid) end to end, K=20 ==");
  console.log(
    "semantic share = hybrid minus lexical-only median; includes the first-query packing in the first row only.\n",
  );
  for (const size of [5000, 25000]) {
    const rows = randomRows(size, DIMENSIONS, size + 7);
    const query = randomRows(1, DIMENSIONS, size + 8)[0]!;
    const embedding = {
      provider: "bench",
      model: "m",
      version: "v",
      dimensions: DIMENSIONS,
      embed: async () => [query],
    };
    const chunks: ContextChunk[] = rows.map((_, id) => ({
      id: `c${id}`,
      repositoryId: "bench",
      revision: "v",
      path: `src/f${id}.ts`,
      language: "typescript",
      kind: "file",
      imports: [],
      startLine: 1,
      endLine: 1,
      content: `export const v${id} = ${id};`,
      contentHash: `h${id}`,
      contentComplete: true,
    }));
    const index: RepositoryIndex = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      policyVersion: "bench",
      chunkerVersion: CHUNKER_VERSION,
      repositoryId: "bench",
      revision: "v",
      maxChunkTokens: 200,
      createdAt: "now",
      files: [],
      chunks,
      vectors: Object.fromEntries(
        chunks.map((chunk, id) => [
          `k${id}`,
          {
            cacheKey: `k${id}`,
            values: rows[id]!,
            inputHash: embeddingInputHash(chunk),
            dimensions: DIMENSIONS,
            provider: "bench",
            model: "m",
            version: "v",
            dimensionIdentity: String(DIMENSIONS),
            chunkerVersion: CHUNKER_VERSION,
            maxChunkTokens: 200,
          },
        ]),
      ),
    };
    const prepared = prepareRepositoryIndex(index);
    const run = async (mode: "lexical" | "hybrid") => {
      const started = performance.now();
      await retrieveContext({
        index: prepared,
        repositoryId: "bench",
        revision: "v",
        query: "zzzunmatched",
        changedPath: "x.ts",
        mode,
        candidates: 20,
        topK: 5,
        threshold: 0,
        embedding: mode === "hybrid" ? embedding : undefined,
      });
      return performance.now() - started;
    };
    const first = await run("hybrid");
    const hybrid: number[] = [];
    const lexical: number[] = [];
    for (let i = 0; i < WARMUP_PASSES; i++) {
      await run("hybrid");
      await run("lexical");
    }
    for (let i = 0; i < MEASURED_PASSES; i++) {
      hybrid.push(await run("hybrid"));
      lexical.push(await run("lexical"));
    }
    console.log(
      `${String(size).padStart(7)} vectors: first hybrid query ${fixed(first, 1)} ms (includes packing), then hybrid ${fixed(median(hybrid), 2)} ms, lexical ${fixed(median(lexical), 2)} ms, semantic share ${fixed(median(hybrid) - median(lexical), 2)} ms; packed spaces built: ${prepared.semantic.builds}`,
    );
  }
  console.log();
}

export async function semanticBenchmark(): Promise<void> {
  scorerComparison();
  await retrievalContextBenchmark();
}
