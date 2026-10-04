import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generationsOf as generationsDirOf } from "./index-fixtures.js";
import {
  indexPath,
  readIndex,
  refreshRepositoryIndex,
  type IndexStoreEvent,
} from "../src/retrieval/index-store.js";
import { migrateSchemaV2 } from "../src/retrieval/index-legacy.js";
import { prepareRepositoryIndex } from "../src/retrieval/prepared-index.js";
import { retrieveContext } from "../src/retrieval/retrieve.js";
import type { RepositoryIndex } from "../src/retrieval/types.js";
import { unitTest } from "./helpers.js";
import { faultyOps } from "./index-faults.js";
import {
  activeMetadataPath,
  schema2Document,
  snapshotFiles,
  storedVectors,
} from "./index-fixtures.js";
import {
  indexOptions,
  probedEmbedding,
  repo,
  sources,
} from "./index-harness.js";

const QUERIES: Array<[string, string]> = [
  ["src/m1.ts", "src/m1.ts\nwork1 return value"],
  ["src/m4.ts", "src/m4.ts\nfunction work4 compute"],
  ["src/zz.ts", "unrelated wording entirely"],
];

type Fixture = {
  root: string;
  path: string;
  original: RepositoryIndex;
  legacyBytes: string;
  adapter: ReturnType<typeof probedEmbedding>["adapter"];
};

/** A real index, rewritten on disk exactly as the previous release stored it. */
async function legacyFixture(files = 10): Promise<Fixture> {
  const root = await repo(sources(files));
  const { adapter } = probedEmbedding();
  const { index } = await refreshRepositoryIndex(
    await indexOptions(root, { embedding: adapter }),
  );
  const path = indexPath(root, ".cache");
  await rm(join(root, ".cache"), { recursive: true, force: true });
  await mkdir(join(root, ".cache"), { recursive: true });
  const legacyBytes = JSON.stringify(schema2Document(index));
  await writeFile(path, legacyBytes);
  return { root, path, original: index, legacyBytes, adapter };
}

const hybrid = (
  index: RepositoryIndex,
  adapter: Fixture["adapter"],
  [changedPath, query]: [string, string],
) =>
  retrieveContext({
    index: prepareRepositoryIndex(index),
    repositoryId: "repo",
    revision: "rev-1",
    query,
    changedPath,
    mode: "hybrid",
    candidates: 10,
    topK: 5,
    threshold: 0,
    embedding: adapter,
  });

unitTest(
  "a schema-2 index is upgraded without any provider call, losing nothing",
  async () => {
    const { root, path, original, adapter } = await legacyFixture();
    const probe = probedEmbedding();
    let reserved = 0;
    const events: IndexStoreEvent[] = [];
    const result = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: probe.adapter,
        beforeEmbeddingRequest: () => reserved++,
        onStoreEvent: (event) => events.push(event),
      }),
    );
    assert.equal(
      result.loaded,
      "valid",
      "the old index was reused, not rebuilt",
    );
    assert.equal(probe.state.requests, 0, "no embedding provider call");
    assert.equal(reserved, 0, "no embedding budget used");
    assert.equal(result.stats.vectorsCreated, 0);
    assert.equal(result.stats.vectorsFromCheckpoint, 0);
    assert.equal(result.stats.vectorsReused, original.vectors.count);

    // Values, keys, hashes and order all survived the representation change.
    assert.deepEqual(storedVectors(result.index), storedVectors(original));
    assert.deepEqual(result.index.inputHashes, original.inputHashes);

    // The on-disk index is now the new layout.
    const manifest = JSON.parse(await readFile(path, "utf8"));
    assert.equal(manifest.schemaVersion, 3);
    assert.equal((await readdir(generationsDirOf(path))).length, 2);
    const reloaded = await readIndex(path);
    assert.equal(reloaded.status, "valid");
    assert.equal(
      reloaded.status === "valid" && reloaded.migratedFromSchema,
      undefined,
    );

    // Same retrieval, candidate for candidate.
    // (JSON round trip: persisted chunks omit absent optional fields.)
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
    for (const query of QUERIES)
      assert.deepEqual(
        plain(await hybrid(result.index, adapter, query)),
        plain(await hybrid(original, adapter, query)),
        query[0],
      );

    assert.deepEqual(
      events.map((event) => event.type),
      ["migration_started", "published", "migration_completed"],
    );
    const started = events[0]!;
    assert.ok(
      started.type === "migration_started" && started.fromSchemaVersion === 2,
    );
    assert.ok(
      started.type === "migration_started" &&
        started.vectors === original.vectors.count,
    );
  },
);

unitTest("a migrated index is not migrated again", async () => {
  const { root, path } = await legacyFixture();
  const first = probedEmbedding();
  await refreshRepositoryIndex(
    await indexOptions(root, { embedding: first.adapter }),
  );
  const before = await snapshotFiles(generationsDirOf(path));
  const blob = Object.keys(before).find((name) => name.endsWith(".bin"))!;
  const probe = probedEmbedding();
  const events: IndexStoreEvent[] = [];
  const second = await refreshRepositoryIndex(
    await indexOptions(root, {
      embedding: probe.adapter,
      revision: "rev-2",
      onStoreEvent: (event) => events.push(event),
    }),
  );
  assert.equal(second.loaded, "valid");
  assert.equal(probe.state.requests, 0);
  assert.ok(
    !events.some((event) => event.type.startsWith("migration")),
    "no migration events on a current-format index",
  );
  assert.deepEqual(
    events.map((event) => event.type).filter((type) => type !== "cleanup"),
    ["loaded", "published"],
  );
  const published = events.find((event) => event.type === "published");
  assert.ok(published?.type === "published" && published.vectorBlobReused);
  const after = await snapshotFiles(generationsDirOf(path));
  assert.equal(after[blob], before[blob], "the blob is not rewritten");
});

unitTest(
  "migration is transactional: a failure keeps the old file canonical and a retry succeeds",
  async () => {
    const { root, path, original, legacyBytes } = await legacyFixture();
    const probe = probedEmbedding();
    const events: IndexStoreEvent[] = [];
    const { ops } = faultyOps((event) =>
      event.op === "rename" && event.phase === "before" && event.to === path
        ? "fail"
        : undefined,
    );
    await assert.rejects(
      refreshRepositoryIndex(
        await indexOptions(root, {
          embedding: probe.adapter,
          fileOps: ops,
          onStoreEvent: (event) => events.push(event),
        }),
      ),
      /injected failure/,
    );
    assert.equal(
      await readFile(path, "utf8"),
      legacyBytes,
      "old file untouched",
    );
    const failed = events.find((event) => event.type === "migration_failed");
    assert.ok(failed?.type === "migration_failed");
    assert.equal(failed.fromSchemaVersion, 2);
    assert.ok(!JSON.stringify(failed).includes("src/"), "no paths or text");
    const stillUsable = await readIndex(path);
    assert.equal(stillUsable.status, "valid");
    assert.equal(
      stillUsable.status === "valid" && stillUsable.migratedFromSchema,
      2,
    );
    assert.equal(probe.state.requests, 0);

    const retry = await refreshRepositoryIndex(
      await indexOptions(root, { embedding: probe.adapter }),
    );
    assert.equal(retry.loaded, "valid");
    assert.deepEqual(storedVectors(retry.index), storedVectors(original));
    assert.equal(JSON.parse(await readFile(path, "utf8")).schemaVersion, 3);
    assert.equal(probe.state.requests, 0);
  },
);

unitTest("a migration needs no embedding adapter at all", async () => {
  const { root, path, original } = await legacyFixture();
  const result = await refreshRepositoryIndex(await indexOptions(root));
  assert.equal(result.loaded, "valid");
  assert.equal(result.stats.embeddingRequests, 0);
  // Without an adapter the stored vectors are carried over untouched.
  assert.deepEqual(storedVectors(result.index), storedVectors(original));
  assert.equal(JSON.parse(await readFile(path, "utf8")).schemaVersion, 3);
});

unitTest(
  "vectors of several embedding spaces all survive migration",
  async () => {
    const root = await repo(sources(6));
    const a = probedEmbedding();
    const b = probedEmbedding({ model: "other-model" });
    await refreshRepositoryIndex(
      await indexOptions(root, { embedding: a.adapter }),
    );
    const { index } = await refreshRepositoryIndex(
      await indexOptions(root, { embedding: b.adapter, revision: "rev-1" }),
    );
    assert.equal(index.vectors.segments.length, 2);
    const path = indexPath(root, ".cache");
    await rm(join(root, ".cache"), { recursive: true, force: true });
    await mkdir(join(root, ".cache"), { recursive: true });
    await writeFile(path, JSON.stringify(schema2Document(index)));
    const probe = probedEmbedding();
    const migrated = await refreshRepositoryIndex(
      await indexOptions(root, { embedding: probe.adapter }),
    );
    assert.equal(migrated.index.vectors.segments.length, 2);
    assert.deepEqual(
      storedVectors(migrated.index).sort((x, y) =>
        x.cacheKey.localeCompare(y.cacheKey),
      ),
      storedVectors(index).sort((x, y) => x.cacheKey.localeCompare(y.cacheKey)),
    );
    assert.equal(probe.state.requests, 0);
  },
);

unitTest("migration trusts only what the old file proves", async () => {
  const { original } = await legacyFixture(4);
  const document = schema2Document(original);
  // A vector made under another chunker is unreachable and is not carried over.
  const foreign = structuredClone(document);
  const [firstKey] = Object.keys(foreign.vectors);
  foreign.vectors[firstKey!]!.chunkerVersion = "ts-js-ast-v0";
  const migrated = migrateSchemaV2(foreign);
  assert.ok(migrated.ok);
  assert.equal(
    migrated.ok && migrated.value.vectors.count,
    original.vectors.count - 1,
  );
  // Structural damage is corruption, never a silently smaller index.
  const damaged = structuredClone(document);
  damaged.vectors[firstKey!]!.values.pop();
  assert.equal(migrateSchemaV2(damaged).ok, false);
  const unowned = structuredClone(document);
  unowned.files = [];
  assert.equal(migrateSchemaV2(unowned).ok, false);
  const overflow = structuredClone(document);
  overflow.vectors[firstKey!]!.values = overflow.vectors[firstKey!]!.values.map(
    () => 1e200,
  );
  const result = migrateSchemaV2(overflow);
  assert.ok(!result.ok && /norm is not finite/.test(result.reason));
});

unitTest(
  "an incompatible schema-2 index is rebuilt, not migrated",
  async () => {
    const { root, path, original } = await legacyFixture(4);
    await writeFile(
      path,
      JSON.stringify({ ...schema2Document(original), policyVersion: "0.0.1" }),
    );
    const probe = probedEmbedding();
    const result = await refreshRepositoryIndex(
      await indexOptions(root, { embedding: probe.adapter }),
    );
    assert.equal(result.loaded, "incompatible");
    assert.ok(probe.state.requests > 0, "nothing could be proven reusable");
    assert.ok((await activeMetadataPath(path)).includes("generations"));
  },
);
