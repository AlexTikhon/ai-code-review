/**
 * Local benchmark for the retrieval stack: lexical index, exact semantic
 * search, and incremental indexing. Not part of CI: it
 * reports structural work (deterministic) and wall-clock time (supplemental).
 *
 *   npm run bench
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { DeterministicTestEmbedding } from "../retrieval/embeddings.js";
import { refreshRepositoryIndex } from "../retrieval/index-store.js";
import {
  buildLexicalIndex,
  lexicalTokens,
  rankLexicalCandidates,
} from "../retrieval/lexical-index.js";
import type { ContextChunk, RetrievalCandidate } from "../retrieval/types.js";
import { loadIgnorePolicy } from "../review/ignore.js";
import { persistenceBenchmark, QUICK } from "./persistence.js";
import { semanticBenchmark } from "./semantic.js";
import { average, prng } from "./util.js";

const VOCABULARY_SIZE = 4000;
const word = (index: number) => `term${index.toString(36)}x`;

/** Zipf-like draw: low indexes are common terms, high indexes are rare. */
function drawWord(random: () => number): string {
  return word(Math.floor(VOCABULARY_SIZE ** random()) - 1);
}

function syntheticChunks(count: number, random: () => number): ContextChunk[] {
  return Array.from({ length: count }, (_, id) => {
    const content = Array.from({ length: 40 }, () => drawWord(random)).join(
      " ",
    );
    const name = random() < 0.5 ? drawWord(random) : undefined;
    return {
      id: `c${id}`,
      repositoryId: "bench",
      revision: "v",
      path: `src/dir${id % 400}/file${id % 997}.ts`,
      language: "typescript",
      kind: name ? "symbol" : "file",
      name,
      signature: name ? `function ${name}()` : undefined,
      imports:
        random() < 0.5 ? [`./${drawWord(random)}`, drawWord(random)] : [],
      startLine: 1,
      endLine: 1,
      content,
      contentHash: `h${id}`,
      contentComplete: true,
    };
  });
}

/** The previous strategy: precomputed term sets, but every chunk scored per query. */
function fullScan(
  prepared: Array<{
    chunk: ContextChunk;
    terms: Set<string>;
    nameTerm?: string;
    importNeedles: string[];
  }>,
  query: string,
  changedPath: string,
  limit: number,
): { candidates: RetrievalCandidate[]; termLookups: number } {
  const queryTokens = lexicalTokens(query);
  let termLookups = 0;
  const scored = prepared.map((entry) => {
    let overlap = 0;
    for (const token of queryTokens) {
      termLookups++;
      if (entry.terms.has(token)) overlap++;
    }
    const importBoost = entry.importNeedles.some((needle) =>
      changedPath.includes(needle),
    )
      ? 0.2
      : 0;
    const symbolBoost =
      entry.nameTerm && queryTokens.has(entry.nameTerm) ? 0.35 : 0;
    const sameFileBoost = entry.chunk.path === changedPath ? 0.05 : 0;
    const score = Math.min(
      1,
      (queryTokens.size ? overlap / queryTokens.size : 0) +
        importBoost +
        symbolBoost +
        sameFileBoost,
    );
    const reasons = [
      overlap ? `keyword-overlap:${overlap}` : "",
      importBoost ? "import-link" : "",
      symbolBoost ? "symbol-match" : "",
      sameFileBoost ? "same-file" : "",
    ].filter(Boolean);
    return { chunk: entry.chunk, score, reasons } as RetrievalCandidate;
  });
  return {
    candidates: scored.sort((a, b) => b.score - a.score).slice(0, limit),
    termLookups,
  };
}

function lexicalBenchmark(): void {
  const QUERIES = 50;
  const LIMIT = 20;
  console.log("== Lexical retrieval: full scan vs inverted index ==");
  console.log(
    `${QUERIES} queries of ~25 terms (Zipf-distributed), candidate limit ${LIMIT}; ranking is asserted identical.\n`,
  );
  console.log(
    [
      "chunks".padStart(7),
      "scan: chunks scored/q".padStart(22),
      "scan: term lookups/q".padStart(21),
      "index: docs scored/q".padStart(21),
      "index: postings/q".padStart(18),
      "index: import needles/q".padStart(24),
      "prepare ms".padStart(11),
      "scan ms/q".padStart(10),
      "index ms/q".padStart(11),
    ].join(" "),
  );
  for (const size of [1000, 5000, 10000, 25000]) {
    const random = prng(size);
    const chunks = syntheticChunks(size, random);
    const queries = Array.from({ length: QUERIES }, () => ({
      text: Array.from({ length: 25 }, () => drawWord(random)).join(" "),
      changedPath: chunks[Math.floor(random() * chunks.length)]!.path,
    }));

    const preparedStarted = performance.now();
    const lexical = buildLexicalIndex(chunks);
    const prepareMs = performance.now() - preparedStarted;
    const scanInput = chunks.map((chunk) => ({
      chunk,
      terms: lexicalTokens(
        `${chunk.path} ${chunk.name ?? ""} ${chunk.signature ?? ""} ${chunk.imports.join(" ")} ${chunk.content}`,
      ),
      nameTerm: chunk.name?.toLowerCase(),
      importNeedles: chunk.imports.map((item) => item.replace(/^\.\//, "")),
    }));

    const scanned: number[] = [];
    const lookups: number[] = [];
    const scored: number[] = [];
    const postings: number[] = [];
    const needles: number[] = [];
    let scanMs = 0;
    let indexMs = 0;
    for (const query of queries) {
      let started = performance.now();
      const reference = fullScan(
        scanInput,
        query.text,
        query.changedPath,
        LIMIT,
      );
      scanMs += performance.now() - started;
      started = performance.now();
      const actual = rankLexicalCandidates(
        lexical,
        query.text,
        query.changedPath,
        LIMIT,
      );
      indexMs += performance.now() - started;
      assert.deepEqual(
        actual.candidates,
        reference.candidates,
        "inverted index must rank exactly like the full scan",
      );
      scanned.push(chunks.length);
      lookups.push(reference.termLookups);
      scored.push(actual.work.documentsScored);
      postings.push(actual.work.postingsExamined);
      needles.push(actual.work.importNeedlesTested);
    }
    console.log(
      [
        String(size).padStart(7),
        average(scanned).toFixed(0).padStart(22),
        average(lookups).toFixed(0).padStart(21),
        average(scored).toFixed(0).padStart(21),
        average(postings).toFixed(0).padStart(18),
        average(needles).toFixed(0).padStart(24),
        prepareMs.toFixed(1).padStart(11),
        (scanMs / QUERIES).toFixed(3).padStart(10),
        (indexMs / QUERIES).toFixed(3).padStart(11),
      ].join(" "),
    );
  }
  console.log(
    "\nNote: Zipf-common terms make some queries match many chunks; rare-term queries touch few. Import-needle tests are per distinct needle, not per chunk.\n",
  );
}

async function incrementalBenchmark(): Promise<void> {
  const FILES = 1000;
  const EDITED = 3;
  console.log("== Incremental indexing: real git repository ==");
  const root = await mkdtemp(join(tmpdir(), "acr-bench-"));
  const run = promisify(execFile);
  try {
    await run("git", ["init"], { cwd: root });
    const longAgo = new Date("2020-01-01T00:00:00Z");
    const body = (i: number, variant = 0) =>
      `import { shared } from "./shared";\n\nexport function handler${i}(input: string) {\n  return shared(input) + ${i + variant};\n}\n\nexport const label${i} = "item ${i}";\n`;
    const write = async (i: number, variant = 0, mtime = longAgo) => {
      const path = join(root, `src/pkg${i % 20}/mod${i}.ts`);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, body(i, variant));
      await utimes(path, mtime, mtime);
    };
    for (let i = 0; i < FILES; i++) await write(i);

    const embedding = new DeterministicTestEmbedding();
    let embeddingRequests = 0;
    const counting = {
      provider: embedding.provider,
      model: embedding.model,
      version: embedding.version,
      dimensions: embedding.dimensions,
      async embed(texts: string[]) {
        embeddingRequests++;
        return embedding.embed(texts);
      },
    };
    const options = async (revision: string) => ({
      root,
      repositoryId: "bench",
      revision,
      cacheDirName: ".cache",
      maxChunkTokens: 200,
      ignorePolicy: await loadIgnorePolicy(root),
      embedding: counting,
    });
    const show = (
      label: string,
      result: Awaited<ReturnType<typeof refreshRepositoryIndex>>,
      ms: number,
    ) => {
      const s = result.stats;
      console.log(
        `${label}: ${ms.toFixed(0)} ms | files total ${s.filesTotal}, read ${s.filesRead}, reused ${s.filesReused}, indexed ${s.filesIndexed} | chunks created ${s.chunksCreated}, reused ${s.chunksReused} | vectors created ${s.vectorsCreated}, reused ${s.vectorsReused} | embedding requests ${s.embeddingRequests}`,
      );
    };
    let started = performance.now();
    const initial = await refreshRepositoryIndex(await options("rev-1"));
    show("initial          ", initial, performance.now() - started);
    started = performance.now();
    const unchanged = await refreshRepositoryIndex(await options("rev-2"));
    show("unchanged        ", unchanged, performance.now() - started);
    // A real edit moves the mtime (and here keeps it outside the racy window).
    const editedAt = new Date("2021-06-01T00:00:00Z");
    for (let i = 0; i < EDITED; i++) await write(i * 100, 7, editedAt);
    const before = embeddingRequests;
    started = performance.now();
    const edited = await refreshRepositoryIndex(await options("rev-3"));
    show(`${EDITED} files edited   `, edited, performance.now() - started);
    console.log(
      `embedding provider calls during the edited run: ${embeddingRequests - before}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

lexicalBenchmark();
await semanticBenchmark();
await persistenceBenchmark(QUICK);
await incrementalBenchmark();
