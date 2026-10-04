/**
 * One persistence measurement in its own process, so heap/RSS numbers start from
 * a clean slate and one scenario cannot pollute the next. Spawned by
 * persistence.ts with --expose-gc; prints a single JSON line.
 *
 *   old          the previous layout: one JSON file, vectors as number arrays
 *   v3           manifest + metadata JSON + binary vector blob
 *   incremental  load a v3 index, change 3 files, build and publish the next one
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { embeddingInputHash } from "../retrieval/embedding-keys.js";
import { legacyIndexSchema } from "../retrieval/index-legacy.js";
import {
  persistedRefsOf,
  publishIndex,
} from "../retrieval/index-generation.js";
import { readIndex } from "../retrieval/index-store.js";
import { updateRepositoryIndex } from "../retrieval/index-update.js";
import { buildLexicalIndex } from "../retrieval/lexical-index.js";
import {
  prepareRepositoryIndex,
  semanticSpaceFor,
} from "../retrieval/prepared-index.js";
import {
  buildSemanticIndex,
  packedSquaredNorms,
  searchSemanticIndex,
} from "../retrieval/semantic-index.js";
import type { RepositoryIndex, StoredVector } from "../retrieval/types.js";
import { median, prng } from "./util.js";

const MIB = 1024 * 1024;
const [mode, file, dimensionsArgument] = process.argv.slice(2) as [
  string,
  string,
  string,
];
const dimensions = Number(dimensionsArgument);
const collect = (globalThis as { gc?: () => void }).gc;
if (!collect) throw new Error("run with --expose-gc");

type Stage = {
  stage: string;
  ms: number;
  heapMiB: number;
  externalMiB: number;
  arrayBuffersMiB: number;
  rssMiB: number;
};
const stages: Stage[] = [];

/** Settle the heap, then record where memory is. Timing excludes the settling. */
function mark(stage: string, startedAt: number): void {
  const ms = performance.now() - startedAt;
  collect!();
  collect!();
  const usage = process.memoryUsage();
  stages.push({
    stage,
    ms,
    heapMiB: usage.heapUsed / MIB,
    externalMiB: usage.external / MIB,
    arrayBuffersMiB: usage.arrayBuffers / MIB,
    rssMiB: usage.rss / MIB,
  });
}

const adapter = {
  provider: "bench",
  model: "m",
  version: "v",
  dimensions,
  embed: async () => [] as number[][],
};

function searchTimings(index: {
  dimensions: number;
  count: number;
  vectors: Float64Array;
  squaredNorms: Float64Array;
}): number {
  const random = prng(99);
  const queries = Array.from({ length: 2 }, () =>
    Array.from({ length: index.dimensions }, () => random() * 2 - 1),
  );
  const pass = () => {
    const started = performance.now();
    for (const query of queries) searchSemanticIndex(index, query, 20);
    return (performance.now() - started) / queries.length;
  };
  pass();
  return median(Array.from({ length: 5 }, pass));
}

/** Reading the file, and hashing bytes already in memory, timed separately. */
async function readAndHash(
  path: string,
): Promise<{ readMs: number; sha256Ms: number }> {
  let started = performance.now();
  const bytes = await readFile(path);
  const readMs = performance.now() - started;
  started = performance.now();
  createHash("sha256").update(bytes).digest("hex");
  return { readMs, sha256Ms: performance.now() - started };
}

async function runOld(): Promise<Record<string, unknown>> {
  mark("process start", performance.now());
  let started = performance.now();
  let text = await readFile(file, "utf8");
  mark("readFile utf8", started);
  started = performance.now();
  const raw = JSON.parse(text);
  text = "";
  mark("JSON.parse", started);
  started = performance.now();
  const parsed = legacyIndexSchema.safeParse(raw);
  if (!parsed.success) throw new Error("legacy index invalid");
  const index = parsed.data;
  mark("schema validation", started);
  // The previous prepare + first-query packing, with the parsed index retained.
  started = performance.now();
  const byHash = new Map<string, StoredVector[]>();
  for (const vector of Object.values(index.vectors)) {
    const group = byHash.get(vector.inputHash);
    if (group) group.push(vector);
    else byHash.set(vector.inputHash, [vector]);
  }
  const chunks = index.chunks.map((chunk) => ({
    chunk,
    inputHash: embeddingInputHash(chunk),
  }));
  const lexical = buildLexicalIndex(index.chunks);
  mark("prepare (hash + lexical + group)", started);
  started = performance.now();
  const rows: number[][] = [];
  for (const { inputHash } of chunks) {
    const stored = byHash.get(inputHash)?.[0];
    if (stored) rows.push(stored.values);
  }
  const packed = buildSemanticIndex(rows);
  rows.length = 0;
  mark("semantic packing", started);
  const search = searchTimings(packed);
  const keep = [index, lexical, packed, chunks, byHash];
  return {
    vectors: packed.count,
    msPerQuery: search,
    retained: keep.length,
  };
}

async function runV3(): Promise<Record<string, unknown>> {
  mark("process start", performance.now());
  let started = performance.now();
  const loaded = await readIndex(file);
  if (loaded.status !== "valid") throw new Error(`index ${loaded.status}`);
  mark("readIndex (read+sha256+norms+metadata)", started);
  started = performance.now();
  const prepared = prepareRepositoryIndex(loaded.index);
  mark("prepare (lexical + group)", started);
  started = performance.now();
  const space = semanticSpaceFor(prepared, adapter);
  mark("semantic space", started);
  const search = searchTimings(space.index);
  // What the load is made of, measured on their own (warm page cache).
  const directory = file.replace(/\.json$/, ".generations");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  const metadataPath = join(directory, manifest.metadataFile);
  const metadataBytes = (await stat(metadataPath)).size;
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const blobPath = join(directory, metadata.vectorStore.file);
  started = performance.now();
  JSON.parse(await readFile(metadataPath, "utf8"));
  const metadataParseMs = performance.now() - started;
  const { readMs, sha256Ms } = await readAndHash(blobPath);
  const segment = loaded.index.vectors.segments[0]!;
  started = performance.now();
  packedSquaredNorms(segment.vectors, segment.count, segment.space.dimensions);
  const normsMs = performance.now() - started;
  const keep = [loaded, prepared, space];
  return {
    vectors: loaded.index.vectors.count,
    msPerQuery: search,
    zeroCopy: loaded.info?.zeroCopy,
    spaceIsSegment: space.index.vectors === segment.vectors,
    parts: { metadataParseMs, readMs, sha256Ms, normsMs, metadataBytes },
    retained: keep.length,
  };
}

async function runIncremental(): Promise<Record<string, unknown>> {
  mark("process start", performance.now());
  let started = performance.now();
  const loaded = await readIndex(file);
  if (loaded.status !== "valid") throw new Error(`index ${loaded.status}`);
  const previous: RepositoryIndex = loaded.index;
  mark("load previous index", started);
  const random = prng(5);
  const files = previous.files.map((entry, position) => ({
    path: entry.path,
    // A different size marks the three edited files; the rest match and are not read.
    size:
      position % Math.floor(previous.files.length / 3) === 0
        ? entry.size + 1
        : entry.size,
    mtimeMs: entry.mtimeMs,
    read:
      position % Math.floor(previous.files.length / 3) === 0
        ? async () => `export const changed${position} = ${position};\n`
        : async () => {
            throw new Error("unchanged file read");
          },
  }));
  let embedded = 0;
  started = performance.now();
  const { index, stats } = await updateRepositoryIndex({
    previous,
    repositoryId: previous.repositoryId,
    revision: "next",
    maxChunkTokens: previous.maxChunkTokens,
    files,
    embedding: {
      ...adapter,
      embed: async (texts: string[]) => {
        embedded += texts.length;
        return texts.map(() =>
          Array.from({ length: dimensions }, () => random() * 2 - 1),
        );
      },
    },
  });
  mark("update (reuse + embed changed)", started);
  started = performance.now();
  const result = await publishIndex({
    manifestPath: file,
    index,
    previous: persistedRefsOf(previous),
  });
  mark("publish next generation", started);
  const keep = [index, stats];
  return {
    vectors: index.vectors.count,
    reused: stats.vectorsReused,
    created: stats.vectorsCreated,
    pruned: stats.vectorsPruned,
    embedded,
    blobReused: result.vectorBlobReused,
    retained: keep.length,
  };
}

const extra = await (mode === "old"
  ? runOld()
  : mode === "v3"
    ? runV3()
    : runIncremental());
console.log(
  JSON.stringify({
    mode,
    stages,
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
    ...extra,
  }),
);
