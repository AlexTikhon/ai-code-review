/**
 * Persistence benchmark: the previous layout (one JSON file with every vector as
 * a number array) against the current one (manifest + metadata + binary blob),
 * on synthetic embeddings at the production dimension.
 *
 *   npm run bench:persistence          full table, up to 100k vectors
 *   npm run bench                      includes a short version of it
 *
 * Every measurement runs in its own child process (see persistence-worker.ts) so
 * heap and RSS start clean. Sizes are exact; times are wall clock, informative
 * only. Memory figures are Node's own counters after a forced GC, minus the
 * bare process: heapUsed (JS objects), external+arrayBuffers (typed-array
 * backing stores), RSS (what the OS has resident; it can stay high after memory
 * is freed). The peak is the OS-reported peak working set of the whole process.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { embeddingInputHash } from "../retrieval/embedding-keys.js";
import { publishIndex } from "../retrieval/index-generation.js";
import {
  CHUNKER_VERSION,
  INDEX_SCHEMA_VERSION,
  type ContextChunk,
  type RepositoryIndex,
} from "../retrieval/types.js";
import { VectorStore, createSegment } from "../retrieval/vector-store.js";
import { POLICY_VERSION } from "../review/types.js";
import { prng } from "./util.js";

const run = promisify(execFile);
const WORKER = fileURLToPath(
  new URL("./persistence-worker.ts", import.meta.url),
);
const DIMENSIONS = 1536;
const MIB = 1024 * 1024;

export type PersistenceBenchOptions = {
  sizes: number[];
  /** Largest size for which the old JSON file is even attempted. */
  legacyAttemptMax: number;
  incrementalSizes: number[];
};

export const FULL: PersistenceBenchOptions = {
  sizes: [1000, 5000, 10000, 17000, 25000, 50000, 100000],
  legacyAttemptMax: 25000,
  incrementalSizes: [25000, 100000],
};
export const QUICK: PersistenceBenchOptions = {
  sizes: [1000, 5000],
  legacyAttemptMax: 5000,
  incrementalSizes: [],
};

type Stage = {
  stage: string;
  ms: number;
  heapMiB: number;
  externalMiB: number;
  arrayBuffersMiB: number;
  rssMiB: number;
};
type WorkerResult = {
  stages: Stage[];
  peakRssMiB: number;
  msPerQuery?: number;
  vectors: number;
  parts?: Record<string, number>;
  zeroCopy?: boolean;
  spaceIsSegment?: boolean;
  [key: string]: unknown;
};

async function worker(
  mode: "old" | "v3" | "incremental",
  file: string,
): Promise<WorkerResult> {
  const { stdout } = await run(
    process.execPath,
    [
      "--expose-gc",
      "--max-old-space-size=12288",
      "--import",
      "tsx",
      WORKER,
      mode,
      file,
      String(DIMENSIONS),
    ],
    { maxBuffer: 64 * MIB },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as WorkerResult;
}

const total = (result: WorkerResult) =>
  result.stages.slice(1).reduce((sum, stage) => sum + stage.ms, 0);

/** The median-total run of several, after discarded warm-ups. */
async function measure(
  mode: "old" | "v3",
  file: string,
  size: number,
): Promise<WorkerResult> {
  const warmups = size <= 25000 ? 1 : 0;
  const measured = size <= 10000 ? 3 : size <= 25000 ? 2 : 1;
  for (let i = 0; i < warmups; i++) await worker(mode, file);
  const runs: WorkerResult[] = [];
  for (let i = 0; i < measured; i++) runs.push(await worker(mode, file));
  runs.sort((a, b) => total(a) - total(b));
  return runs[Math.floor(runs.length / 2)]!;
}

/** Realistic embedding-like values: unit-ish gaussians, 9 significant digits. */
function vectorsFor(size: number, round: boolean): Float64Array {
  const random = prng(size);
  const scale = 1 / Math.sqrt(DIMENSIONS);
  const values = new Float64Array(size * DIMENSIONS);
  for (let i = 0; i < values.length; i++) {
    const u = Math.max(random(), 1e-12);
    const v = random();
    const gaussian = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    values[i] = round
      ? Number((gaussian * scale).toPrecision(9))
      : gaussian * scale;
  }
  return values;
}

function indexFor(size: number, vectors: Float64Array): RepositoryIndex {
  const chunks: ContextChunk[] = Array.from({ length: size }, (_, i) => ({
    id: `c${i}`,
    repositoryId: "bench",
    revision: "v",
    path: `src/f${i}.ts`,
    language: "typescript",
    kind: "file",
    imports: [],
    startLine: 1,
    endLine: 1,
    content: `export const v${i} = ${i};`,
    contentHash: `h${i}`,
    contentComplete: true,
  }));
  const inputHashes = chunks.map(embeddingInputHash);
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    chunkerVersion: CHUNKER_VERSION,
    policyVersion: POLICY_VERSION,
    repositoryId: "bench",
    revision: "v",
    maxChunkTokens: 200,
    createdAt: "now",
    files: chunks.map((chunk, i) => ({
      path: chunk.path,
      contentHash: `f${i}`,
      size: 30,
      mtimeMs: 1_000_000,
      chunkIds: [chunk.id],
    })),
    chunks,
    inputHashes,
    vectors: new VectorStore([
      createSegment(
        {
          provider: "bench",
          model: "m",
          version: "v",
          dimensionIdentity: String(DIMENSIONS),
          dimensions: DIMENSIONS,
        },
        inputHashes.map((_, i) => `k${i}`),
        inputHashes,
        vectors,
      ),
    ]),
  };
}

/** The previous release's file, written the way it wrote it. */
async function writeLegacy(
  path: string,
  index: RepositoryIndex,
): Promise<{ ok: true; bytes: number } | { ok: false; reason: string }> {
  const segment = index.vectors.segments[0]!;
  const vectors: Record<string, unknown> = {};
  for (let row = 0; row < segment.count; row++)
    vectors[segment.cacheKeys[row]!] = {
      cacheKey: segment.cacheKeys[row],
      values: Array.from(
        segment.vectors.subarray(row * DIMENSIONS, (row + 1) * DIMENSIONS),
      ),
      inputHash: segment.inputHashes[row],
      dimensions: DIMENSIONS,
      provider: "bench",
      model: "m",
      version: "v",
      dimensionIdentity: String(DIMENSIONS),
      chunkerVersion: CHUNKER_VERSION,
      maxChunkTokens: 200,
    };
  try {
    const text = JSON.stringify({
      schemaVersion: 2,
      chunkerVersion: index.chunkerVersion,
      policyVersion: index.policyVersion,
      repositoryId: index.repositoryId,
      revision: index.revision,
      maxChunkTokens: index.maxChunkTokens,
      createdAt: index.createdAt,
      files: index.files,
      chunks: index.chunks,
      vectors,
    });
    await writeFile(path, text);
    return { ok: true, bytes: (await stat(path)).size };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

const mib = (bytes: number) => (bytes / MIB).toFixed(bytes < 10 * MIB ? 1 : 0);
const pad = (value: string | number, width: number) =>
  String(value).padStart(width);

export async function persistenceBenchmark(
  options: PersistenceBenchOptions,
): Promise<void> {
  console.log("== Persistence: JSON vectors (old) vs binary blob (current) ==");
  console.log(
    `${DIMENSIONS} dimensions, synthetic 9-significant-digit values (as an embedding API returns), one embedding space.\n` +
      "Each cell is a separate process; times are the median of the measured runs after a discarded warm-up (a single run above 25k vectors).\n",
  );
  const root = await mkdtemp(join(tmpdir(), "acr-persist-bench-"));
  const disk: string[] = [];
  const load: string[] = [];
  const memory: string[] = [];
  const parts: string[] = [];
  const search: string[] = [];
  try {
    for (const size of options.sizes) {
      const directory = join(root, String(size));
      await mkdir(directory, { recursive: true });
      const attemptLegacy = size <= options.legacyAttemptMax;
      const index = indexFor(size, vectorsFor(size, attemptLegacy));
      const manifest = join(directory, "repository-index.json");
      await publishIndex({ manifestPath: manifest, index });
      const generations = manifest.replace(/\.json$/, ".generations");
      let v3Bytes = 0;
      let blobBytes = 0;
      for (const name of await readdir(generations)) {
        const bytes = (await stat(join(generations, name))).size;
        v3Bytes += bytes;
        if (name.endsWith(".bin")) blobBytes = bytes;
      }
      v3Bytes += (await stat(manifest)).size;
      const legacyPath = join(directory, "legacy.json");
      const legacy = attemptLegacy
        ? await writeLegacy(legacyPath, index)
        : ({ ok: false, reason: "not attempted" } as const);

      const v3 = await measure("v3", manifest, size);
      const old = legacy.ok
        ? await measure("old", legacyPath, size)
        : undefined;

      disk.push(
        [
          pad(size, 7),
          pad(legacy.ok ? `${mib(legacy.bytes)} MiB` : "cannot persist", 15),
          pad(`${mib(blobBytes)} MiB`, 12),
          pad(`${mib(v3Bytes - blobBytes)} MiB`, 10),
          pad(
            legacy.ok
              ? `${(legacy.bytes / v3Bytes).toFixed(2)}x smaller`
              : "n/a",
            15,
          ),
        ].join(" "),
      );
      const v3Ms = total(v3);
      load.push(
        [
          pad(size, 7),
          pad(old ? total(old).toFixed(0) : "n/a", 12),
          pad(v3Ms.toFixed(0), 10),
          pad(old ? `${(total(old) / v3Ms).toFixed(1)}x` : "n/a", 8),
          pad(
            v3.stages
              .slice(1)
              .map(
                (stage) =>
                  `${stage.stage.split(" ")[0]} ${stage.ms.toFixed(0)}`,
              )
              .join(" | "),
            0,
          ),
        ].join(" "),
      );
      const settle = (result: WorkerResult) => {
        const base = result.stages[0]!;
        const end = result.stages.at(-1)!;
        return {
          heap: end.heapMiB - base.heapMiB,
          external: end.externalMiB - base.externalMiB,
          arrays: end.arrayBuffersMiB - base.arrayBuffersMiB,
          rss: end.rssMiB - base.rssMiB,
          peak: result.peakRssMiB,
        };
      };
      const m3 = settle(v3);
      const mo = old ? settle(old) : undefined;
      const cell = (m: ReturnType<typeof settle> | undefined) =>
        m
          ? `${pad(m.heap.toFixed(0), 6)} ${pad(m.arrays.toFixed(0), 6)} ${pad(m.rss.toFixed(0), 6)} ${pad(m.peak.toFixed(0), 6)}`
          : `${pad("n/a", 6)} ${pad("n/a", 6)} ${pad("n/a", 6)} ${pad("n/a", 6)}`;
      memory.push(`${pad(size, 7)} | ${cell(mo)} | ${cell(m3)}`);
      parts.push(
        [
          pad(size, 7),
          pad((v3.parts!.metadataParseMs ?? 0).toFixed(0), 14),
          pad((v3.parts!.readMs ?? 0).toFixed(0), 9),
          pad((v3.parts!.sha256Ms ?? 0).toFixed(0), 8),
          pad((v3.parts!.normsMs ?? 0).toFixed(0), 14),
          pad(String(v3.zeroCopy), 9),
          pad(String(v3.spaceIsSegment), 14),
        ].join(" "),
      );
      search.push(
        [
          pad(size, 7),
          pad(
            old?.msPerQuery !== undefined ? old.msPerQuery.toFixed(2) : "n/a",
            10,
          ),
          pad(v3.msPerQuery!.toFixed(2), 10),
        ].join(" "),
      );
      await rm(directory, { recursive: true, force: true });
    }

    const incremental: string[] = [];
    for (const size of options.incrementalSizes) {
      const directory = join(root, `inc-${size}`);
      await mkdir(directory, { recursive: true });
      const manifest = join(directory, "repository-index.json");
      await publishIndex({
        manifestPath: manifest,
        index: indexFor(size, vectorsFor(size, false)),
      });
      const result = await worker("incremental", manifest);
      const [, loaded, updated, published] = result.stages;
      incremental.push(
        [
          pad(size, 7),
          pad(loaded!.ms.toFixed(0), 8),
          pad(updated!.ms.toFixed(0), 10),
          pad(published!.ms.toFixed(0), 11),
          pad(`${result.reused}/${result.created}/${result.pruned}`, 18),
          pad(String(result.embedded), 9),
          pad(result.peakRssMiB.toFixed(0), 9),
        ].join(" "),
      );
      await rm(directory, { recursive: true, force: true });
    }

    console.log(
      "Disk (blob = vectors only; metadata = chunks, files, keys, hashes):",
    );
    console.log(
      `${pad("vectors", 7)} ${pad("old JSON", 15)} ${pad("V3 blob", 12)} ${pad("V3 other", 10)} ${pad("reduction", 15)}`,
    );
    console.log(disk.join("\n"));
    console.log("\nReady to query (read + validate + prepare + pack), ms:");
    console.log(
      `${pad("vectors", 7)} ${pad("old", 12)} ${pad("V3", 10)} ${pad("speedup", 8)} V3 stages`,
    );
    console.log(load.join("\n"));
    console.log(
      "\nWhat the V3 load is made of (each measured alone, warm cache), ms:",
    );
    console.log(
      `${pad("vectors", 7)} ${pad("metadata parse", 14)} ${pad("blob read", 9)} ${pad("sha256", 8)} ${pad("norms+finite", 14)} ${pad("zero-copy", 9)} ${pad("search==blob", 14)}`,
    );
    console.log(parts.join("\n"));
    console.log(
      "\nSteady-state memory once ready, MiB over the bare process (heap | arrayBuffers | RSS | peak RSS of the whole run):",
    );
    console.log(
      `${pad("vectors", 7)} | ${pad("old heap", 6)} ${pad("old ab", 6)} ${pad("old rss", 6)} ${pad("peak", 6)} | ${pad("V3 heap", 6)} ${pad("V3 ab", 6)} ${pad("V3 rss", 6)} ${pad("peak", 6)}`,
    );
    console.log(memory.join("\n"));
    console.log("\nExact search, median ms per query at K=20:");
    console.log(`${pad("vectors", 7)} ${pad("old", 10)} ${pad("V3", 10)}`);
    console.log(search.join("\n"));
    if (incremental.length > 0) {
      console.log(
        "\nIncremental refresh of a persisted index, 3 edited files (V3), ms:",
      );
      console.log(
        `${pad("vectors", 7)} ${pad("load", 8)} ${pad("update", 10)} ${pad("publish", 11)} ${pad("reused/new/pruned", 18)} ${pad("embedded", 9)} ${pad("peak MiB", 9)}`,
      );
      console.log(incremental.join("\n"));
    }
    console.log();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && /persistence\.ts$/.test(process.argv[1])) {
  await persistenceBenchmark(process.argv.includes("--quick") ? QUICK : FULL);
}
