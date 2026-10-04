import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import {
  indexPath,
  readIndex,
  refreshRepositoryIndex,
} from "../src/retrieval/index-store.js";
import { salvageSchemaV1Vectors } from "../src/retrieval/index-legacy.js";
import { unitTest } from "./helpers.js";
import {
  indexOptions,
  probedEmbedding,
  repo,
  sources,
} from "./index-harness.js";

/**
 * A schema-1 index exactly as the old code wrote it: no `policyVersion`, no
 * per-file `files` table. Derived from a real current index so the vectors
 * are genuine.
 */
async function legacyFixture(fileCount = 6) {
  const root = await repo(sources(fileCount));
  const path = indexPath(root, ".cache");
  const first = probedEmbedding();
  const built = await refreshRepositoryIndex(
    await indexOptions(root, { embedding: first.adapter }),
  );
  const { files: _files, policyVersion: _policy, ...rest } = built.index;
  const legacy = { ...rest, schemaVersion: 1 };
  await writeFile(path, JSON.stringify(legacy));
  return {
    root,
    path,
    legacy,
    vectorCount: Object.keys(built.index.vectors).length,
  };
}

unitTest("a schema-1 index is not reused as an index", async () => {
  const { path } = await legacyFixture();
  const loaded = await readIndex(path);
  assert.equal(loaded.status, "incompatible");
  assert.match(
    loaded.status === "incompatible" ? loaded.reason : "",
    /schema version 1/,
  );
});

unitTest(
  "a schema-1 index's vectors are salvaged: rebuilt from source, zero embedding calls",
  async () => {
    const { root, path, vectorCount } = await legacyFixture();
    const probe = probedEmbedding();
    const diagnostics: string[] = [];
    const result = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: probe.adapter,
        onDiagnostic: (message) => diagnostics.push(message),
      }),
    );
    assert.equal(result.loaded, "incompatible");
    assert.equal(result.stats.filesReused, 0, "chunks are re-derived");
    assert.equal(
      result.stats.filesRead,
      6,
      "every file is re-read and re-checked",
    );
    assert.equal(
      probe.state.requests,
      0,
      "paid vectors are not paid for twice",
    );
    assert.equal(result.stats.vectorsFromCheckpoint, vectorCount);
    assert.equal(Object.keys(result.index.vectors).length, vectorCount);
    assert.ok(
      diagnostics.some((m) => /schema version 1/.test(m) && /salvaged/.test(m)),
    );
    // The file on disk is now a valid current-schema index.
    const after = JSON.parse(await readFile(path, "utf8")) as {
      schemaVersion: number;
      files: unknown[];
      policyVersion: string;
    };
    assert.equal(after.schemaVersion, 2);
    assert.equal(after.files.length, 6);
    assert.ok(after.policyVersion);
    assert.equal((await readIndex(path)).status, "valid");
  },
);

unitTest("salvage is deterministic", async () => {
  const { legacy } = await legacyFixture();
  assert.deepEqual(
    salvageSchemaV1Vectors(legacy),
    salvageSchemaV1Vectors(legacy),
  );
});

unitTest(
  "salvaged vectors only serve chunks that still hash to the same input",
  async () => {
    const { root, vectorCount } = await legacyFixture();
    // m0 changes: its legacy vectors no longer match any current chunk input.
    await writeFile(
      `${root}/src/m0.ts`,
      "export function work0() { return 'changed'; }\n",
    );
    const probe = probedEmbedding();
    const result = await refreshRepositoryIndex(
      await indexOptions(root, { embedding: probe.adapter }),
    );
    // Only m0's symbol chunk changed (the residual file chunk is empty).
    assert.equal(probe.state.texts, 1);
    assert.equal(result.stats.vectorsFromCheckpoint, vectorCount - 1);
  },
);

unitTest(
  "salvage never crosses embedding identities or chunking settings",
  async () => {
    for (const [identity, maxChunkTokens] of [
      [{ model: "other-model" }, 100],
      [{ provider: "other" }, 100],
      [{ dimensions: undefined }, 100],
      [{}, 60],
    ] as const) {
      const { root } = await legacyFixture();
      const probe = probedEmbedding(identity);
      const result = await refreshRepositoryIndex(
        await indexOptions(root, { embedding: probe.adapter, maxChunkTokens }),
      );
      assert.equal(
        result.stats.vectorsFromCheckpoint,
        0,
        JSON.stringify(identity),
      );
      assert.ok(probe.state.texts > 0);
    }
  },
);

unitTest(
  "damaged schema-1 data rebuilds cleanly and salvages nothing it cannot prove",
  async () => {
    const { root, path, legacy } = await legacyFixture();
    const firstKey = Object.keys(legacy.vectors)[0]!;
    const damaged = structuredClone(legacy);
    damaged.vectors[firstKey]!.values = [1, 2, 3]; // length != dimensions
    const kept = salvageSchemaV1Vectors(damaged);
    assert.equal(kept.length, Object.keys(legacy.vectors).length - 1);
    assert.ok(!kept.some((vector) => vector.cacheKey === firstKey));
    assert.deepEqual(salvageSchemaV1Vectors({ schemaVersion: 1 }), []);
    assert.deepEqual(salvageSchemaV1Vectors("nonsense"), []);
    assert.deepEqual(salvageSchemaV1Vectors({ vectors: [1, 2] }), []);

    await writeFile(path, JSON.stringify({ schemaVersion: 1, vectors: "bad" }));
    const probe = probedEmbedding();
    const result = await refreshRepositoryIndex(
      await indexOptions(root, { embedding: probe.adapter }),
    );
    assert.equal(result.stats.vectorsFromCheckpoint, 0);
    assert.ok(probe.state.texts > 0);
    assert.equal((await readIndex(path)).status, "valid");
  },
);

unitTest("an unauthorized run salvages and spends nothing", async () => {
  const { root, path } = await legacyFixture();
  const result = await refreshRepositoryIndex(await indexOptions(root));
  assert.equal(result.stats.embeddingRequests, 0);
  assert.equal(Object.keys(result.index.vectors).length, 0);
  assert.equal((await readIndex(path)).status, "valid");
});
