import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewEvent } from "../src/observability/events.js";
import { publishIndex } from "../src/retrieval/index-generation.js";
import {
  indexPath,
  readIndex,
  refreshRepositoryIndex,
} from "../src/retrieval/index-store.js";
import { migrateSchemaV2 } from "../src/retrieval/index-legacy.js";
import {
  prepareRepositoryIndex,
  semanticSpaceFor,
} from "../src/retrieval/prepared-index.js";
import type { RepositoryIndex } from "../src/retrieval/types.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import {
  cleanResult,
  makeSource,
  request,
  sourceFile,
  testConfig,
} from "./fixtures.js";
import { unitTest } from "./helpers.js";
import {
  generationsOf,
  schema2Document,
  syntheticIndex,
} from "./index-fixtures.js";
import {
  indexOptions,
  probedEmbedding,
  repo,
  sources,
} from "./index-harness.js";

type Census = {
  typedArrayBytes: number;
  float64Arrays: Float64Array[];
  /** Arrays of numbers long enough to be a vector held as plain JS. */
  numberArrays: number[];
};

/**
 * Walk everything reachable from `root` (objects, arrays, Maps, Sets) and count
 * what holds numbers: typed arrays on one side, plain `number[]` on the other.
 * An index that carried an unpacked copy of its vectors would show up as many
 * long `number[]` here.
 */
function census(root: unknown): Census {
  const result: Census = {
    typedArrayBytes: 0,
    float64Arrays: [],
    numberArrays: [],
  };
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  const buffers = new Set<ArrayBuffer>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || typeof value !== "object" || seen.has(value))
      continue;
    seen.add(value);
    if (ArrayBuffer.isView(value)) {
      if (!buffers.has(value.buffer as ArrayBuffer)) {
        buffers.add(value.buffer as ArrayBuffer);
        result.typedArrayBytes += value.buffer.byteLength;
      }
      if (value instanceof Float64Array) result.float64Arrays.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length >= 8 && value.every((item) => typeof item === "number"))
        result.numberArrays.push(value.length);
      for (const item of value) stack.push(item);
    } else if (value instanceof Map) {
      for (const [key, item] of value) stack.push(key, item);
    } else if (value instanceof Set) {
      for (const item of value) stack.push(item);
    } else for (const item of Object.values(value)) stack.push(item);
  }
  return result;
}

const SEARCH = {
  provider: "synthetic",
  model: "m",
  version: "v1",
  dimensions: 8,
  embed: async () => [],
};

unitTest(
  "a loaded index holds its vectors as one packed array and no number[][]",
  async () => {
    const root = await repo(sources(4)); // for a cache directory only
    const manifest = indexPath(root, ".cache");
    const index = syntheticIndex({ count: 200 });
    await publishIndex({ manifestPath: manifest, index });
    const loaded = await readIndex(manifest);
    assert.equal(loaded.status, "valid");
    const live = (loaded as { index: RepositoryIndex }).index;
    const { typedArrayBytes, float64Arrays, numberArrays } = census(live);
    assert.deepEqual(numberArrays, [], "no unpacked vector copy anywhere");
    // One Float64Array of all the numbers, and a norms array: nothing else.
    const vectors = live.vectors.segments[0]!.vectors;
    assert.ok(float64Arrays.includes(vectors));
    assert.equal(vectors.length, 200 * 8);
    // The only large buffer is the one the blob was read into (header + payload
    // + the small norms array).
    assert.equal(typedArrayBytes, 64 + 200 * 8 * 8 + 200 * 8);

    // Preparing for retrieval and packing the search space adds no vector copy.
    const prepared = prepareRepositoryIndex(live);
    const space = semanticSpaceFor(prepared, SEARCH);
    assert.equal(space.index.vectors, vectors);
    // (The lexical index legitimately holds number[] postings of chunk ordinals;
    // vectors are everything else.)
    const afterPrepare = census([live, { ...prepared, lexical: undefined }]);
    assert.deepEqual(afterPrepare.numberArrays, []);
    assert.equal(afterPrepare.typedArrayBytes, typedArrayBytes);
  },
);

unitTest(
  "a migrated index is packed too: the parsed JSON arrays are dropped",
  () => {
    const document = schema2Document(syntheticIndex({ count: 50 }));
    // Before: the parsed file holds every vector as a number[].
    assert.equal(census(document).numberArrays.length, 50);
    const migrated = migrateSchemaV2(document);
    assert.ok(migrated.ok);
    // After: nothing the migrated index references is a number[] (so once the
    // parsed document is unreachable, every JSON array is collectable).
    assert.deepEqual(
      census(migrated.ok ? migrated.value : null).numberArrays,
      [],
    );
  },
);

unitTest("freshly built indexes are packed from the first moment", async () => {
  const root = await repo(sources(10));
  const { index } = await refreshRepositoryIndex(
    await indexOptions(root, { embedding: probedEmbedding().adapter }),
  );
  assert.deepEqual(census(index).numberArrays, []);
});

unitTest(
  "an index file never contains vector values, and neither do events",
  async () => {
    const root = await repo({
      "dep.ts": "export const dependency = 'EVENT_LEAK_CANARY';\n",
      "other.ts": "export const other = 2;\n",
    });
    const events: ReviewEvent[] = [];
    const { adapter } = probedEmbedding();
    const run = (snapshotId: string) =>
      executeReviewPipeline({ ...request, contextMode: "hybrid" }, testConfig, {
        model: { provider: "test", review: async () => cleanResult() },
        embedding: adapter,
        source: makeSource([sourceFile("app.ts", "@@ -0,0 +1 @@\n+dep()")], {
          repositoryRoot: root,
          snapshotId,
        }),
        events: (event) => events.push(event),
      });
    await run("snap-1");
    await run("snap-2");
    const store = events.filter((event) => event.stage === "index_store");
    assert.deepEqual(
      store.map((event) => event.message),
      // First run: nothing to load, one publication. Second run: load, publish
      // (the vector blob is shared), and retire the superseded metadata.
      ["published", "loaded", "published", "cleanup"],
    );
    const allowed = new Set([
      "vectors",
      "vectorBytes",
      "metadataBytes",
      "zeroCopy",
      "durationMs",
      "generation",
      "vectorBlobReused",
      "removed",
      "failed",
      "fromSchemaVersion",
      "reason",
    ]);
    for (const event of store)
      for (const [key, value] of Object.entries(event.data ?? {})) {
        assert.ok(allowed.has(key), `unexpected event field ${key}`);
        assert.ok(["number", "string", "boolean"].includes(typeof value));
      }
    const text = JSON.stringify(events);
    assert.ok(!text.includes("EVENT_LEAK_CANARY"));
    assert.ok(!text.includes("dep.ts"));
    assert.ok(!/values/.test(JSON.stringify(store)));

    // On disk: the JSON has no numbers of a vector, the blob has no text.
    const manifestPath = indexPath(root, ".cache");
    const directory = generationsOf(manifestPath);
    for (const name of await readdir(directory)) {
      const bytes = await readFile(join(directory, name));
      if (name.endsWith(".bin")) {
        assert.ok(
          !bytes.includes(Buffer.from("dependency")),
          "no source in the blob",
        );
        assert.ok(
          !bytes.includes(Buffer.from("sk-")),
          "no credentials in the blob",
        );
        assert.equal(bytes.subarray(0, 7).toString("latin1"), "ACRVECS");
      } else {
        const metadata = JSON.parse(bytes.toString("utf8"));
        for (const space of metadata.vectorStore.spaces)
          assert.deepEqual(
            Object.keys(space).sort(),
            [
              "cacheKeys",
              "count",
              "dimensionIdentity",
              "dimensions",
              "inputHashes",
              "model",
              "offsetBytes",
              "provider",
              "version",
            ],
            "descriptive fields only; the numbers are in the blob",
          );
      }
    }
  },
);
