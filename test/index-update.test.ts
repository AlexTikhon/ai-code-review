import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chunkSource, rebindChunk } from "../src/retrieval/chunker.js";
import type { EmbeddingAdapter } from "../src/retrieval/embeddings.js";
import { DeterministicTestEmbedding } from "../src/retrieval/embeddings.js";
import {
  updateRepositoryIndex,
  type SourceFileRef,
} from "../src/retrieval/index-update.js";
import { embeddingInputHash } from "../src/retrieval/embedding-keys.js";
import { parseRepositoryIndex } from "../src/retrieval/index-schema.js";
import {
  CHUNKER_VERSION,
  type RepositoryIndex,
} from "../src/retrieval/types.js";
import { POLICY_VERSION } from "../src/review/types.js";
import { unitTest } from "./helpers.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** In-memory repository whose reads, chunking and embedding calls are counted. */
class Harness {
  files = new Map<string, string>();
  blobOverride = new Map<string, string>();
  reads: string[] = [];
  chunked: string[] = [];
  embedded: string[][] = [];
  failEmbeddingAt?: number;
  model = "hash-test";
  readonly delegate = new DeterministicTestEmbedding();

  set(path: string, content: string): void {
    this.files.set(path, content);
  }

  refs(): SourceFileRef[] {
    return [...this.files.keys()].sort().map((path) => ({
      path,
      size: Buffer.byteLength(this.files.get(path)!),
      blobId: this.blobOverride.get(path) ?? sha(this.files.get(path)!),
      read: async () => {
        this.reads.push(path);
        return this.files.get(path);
      },
    }));
  }

  get embedding(): EmbeddingAdapter {
    const harness = this;
    return {
      provider: this.delegate.provider,
      model: this.model,
      version: this.delegate.version,
      dimensions: this.delegate.dimensions,
      async embed(texts: string[]) {
        harness.embedded.push(texts);
        if (harness.failEmbeddingAt === harness.embedded.length)
          throw new Error("embedding provider failure");
        return harness.delegate.embed(texts);
      },
    };
  }

  reset(): void {
    this.reads = [];
    this.chunked = [];
    this.embedded = [];
  }

  get embeddedTexts(): number {
    return this.embedded.reduce((sum, batch) => sum + batch.length, 0);
  }

  update(
    previous: RepositoryIndex | undefined,
    options: {
      revision?: string;
      maxChunkTokens?: number;
      embedding?: boolean;
      signal?: AbortSignal;
      beforeEmbeddingRequest?: () => void;
      batch?: number;
    } = {},
  ) {
    return updateRepositoryIndex({
      previous,
      repositoryId: "repo",
      revision: options.revision ?? "rev-1",
      maxChunkTokens: options.maxChunkTokens ?? 200,
      files: this.refs(),
      embedding: options.embedding === false ? undefined : this.embedding,
      signal: options.signal,
      beforeEmbeddingRequest: options.beforeEmbeddingRequest,
      maxEmbeddingBatchSize: options.batch ?? 4,
      chunk: (input) => {
        this.chunked.push(input.path);
        return chunkSource(input);
      },
    });
  }
}

function source(name: string, value: number): string {
  return `import { dep } from "./dep";\nexport function ${name}() {\n  return dep(${value});\n}\n\nexport const ${name}Value = ${value};\n`;
}

function seeded(count = 6): Harness {
  const harness = new Harness();
  for (let i = 0; i < count; i++)
    harness.set(`src/f${i}.ts`, source(`fn${i}`, i));
  return harness;
}

/** Distinct embedding inputs among a snapshot's chunks. */
const uniqueInputs = (index: RepositoryIndex) =>
  new Set(index.chunks.map(embeddingInputHash)).size;

const vectorCount = (index: RepositoryIndex) =>
  Object.keys(index.vectors).length;

/** Everything that must match between an incremental and a from-scratch index. */
function comparable(index: RepositoryIndex) {
  return {
    ...index,
    createdAt: "",
    vectors: Object.fromEntries(Object.entries(index.vectors).sort()),
  };
}

unitTest("first update reads, chunks and embeds every file once", async () => {
  const harness = seeded(6);
  const { index, stats } = await harness.update(undefined);
  assert.equal(harness.reads.length, 6);
  assert.equal(harness.chunked.length, 6);
  assert.equal(stats.filesTotal, 6);
  assert.equal(stats.filesIndexed, 6);
  assert.equal(stats.filesAdded, 6);
  assert.equal(stats.filesReused, 0);
  assert.equal(stats.chunksCreated, index.chunks.length);
  // Chunks with identical embedding input (blank-line chunks of one file)
  // share one vector, so vectors are counted per unique input.
  assert.equal(stats.vectorsCreated, vectorCount(index));
  assert.equal(harness.embeddedTexts, stats.vectorsCreated);
  assert.equal(stats.previous, "none");
  assert.ok(parseRepositoryIndex(JSON.parse(JSON.stringify(index))).ok);
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.policyVersion, POLICY_VERSION);
  assert.deepEqual(
    index.files.map((file) => file.path),
    [...harness.files.keys()].sort(),
  );
});

unitTest(
  "an identical repository is fully reused without reads, chunking or embedding",
  async () => {
    const harness = seeded(8);
    const first = await harness.update(undefined);
    harness.reset();
    const second = await harness.update(first.index, { revision: "rev-1" });
    assert.equal(harness.reads.length, 0);
    assert.equal(harness.chunked.length, 0);
    assert.equal(harness.embedded.length, 0);
    assert.equal(second.stats.filesReused, 8);
    assert.equal(second.stats.filesIndexed, 0);
    assert.equal(second.stats.filesRead, 0);
    assert.equal(second.stats.chunksReused, first.index.chunks.length);
    assert.equal(second.stats.chunksCreated, 0);
    assert.equal(second.stats.vectorsReused, vectorCount(first.index));
    assert.equal(second.stats.vectorsCreated, 0);
    assert.equal(second.stats.previous, "reused");
    assert.deepEqual(comparable(second.index), comparable(first.index));
  },
);

unitTest(
  "reused chunks are rebound to a new revision exactly as a rebuild would",
  async () => {
    const harness = seeded(5);
    const first = await harness.update(undefined, { revision: "rev-1" });
    harness.reset();
    const second = await harness.update(first.index, { revision: "rev-2" });
    const fresh = await seeded(5).update(undefined, { revision: "rev-2" });
    assert.equal(
      harness.chunked.length,
      0,
      "no re-chunking for a new revision",
    );
    assert.ok(second.index.chunks.every((chunk) => chunk.revision === "rev-2"));
    assert.deepEqual(comparable(second.index), comparable(fresh.index));
    const sample = first.index.chunks[0]!;
    assert.deepEqual(
      rebindChunk(sample, "rev-2"),
      second.index.chunks.find((chunk) => chunk.path === sample.path),
    );
  },
);

unitTest(
  "one modified file is the only file read, chunked and embedded",
  async () => {
    const harness = seeded(10);
    const first = await harness.update(undefined);
    harness.reset();
    harness.set("src/f3.ts", source("fn3", 999));
    const second = await harness.update(first.index, { revision: "rev-2" });
    assert.deepEqual(harness.reads, ["src/f3.ts"]);
    assert.deepEqual(harness.chunked, ["src/f3.ts"]);
    assert.equal(second.stats.filesReused, 9);
    assert.equal(second.stats.filesModified, 1);
    assert.equal(second.stats.filesAdded, 0);
    // Only chunks whose embedding input changed are embedded; the import-only
    // chunk of f3 is byte-identical, so its vector is reused.
    const f3 = second.index.chunks.filter(
      (chunk) => chunk.path === "src/f3.ts",
    );
    assert.ok(second.stats.vectorsCreated < f3.length + 1);
    assert.ok(second.stats.vectorsCreated >= 1);
    assert.ok(harness.embeddedTexts === second.stats.vectorsCreated);
    assert.equal(
      second.stats.vectorsReused + second.stats.vectorsCreated,
      vectorCount(second.index),
    );
    assert.deepEqual(
      comparable(second.index),
      comparable((await seeded10Modified()).index),
    );
  },
);

async function seeded10Modified() {
  const fresh = seeded(10);
  fresh.set("src/f3.ts", source("fn3", 999));
  return fresh.update(undefined, { revision: "rev-2" });
}

unitTest("an added file is indexed and nothing else is touched", async () => {
  const harness = seeded(4);
  const first = await harness.update(undefined);
  harness.reset();
  harness.set("src/new.ts", source("brandNew", 7));
  const second = await harness.update(first.index, { revision: "rev-2" });
  assert.deepEqual(harness.reads, ["src/new.ts"]);
  assert.equal(second.stats.filesAdded, 1);
  assert.equal(second.stats.filesReused, 4);
  assert.ok(second.index.chunks.some((chunk) => chunk.path === "src/new.ts"));
});

unitTest("a deleted file leaves no chunks, vectors or metadata", async () => {
  const harness = seeded(5);
  const first = await harness.update(undefined);
  const doomed = first.index.chunks.filter((c) => c.path === "src/f2.ts");
  assert.ok(doomed.length > 0);
  harness.reset();
  harness.files.delete("src/f2.ts");
  const second = await harness.update(first.index, { revision: "rev-2" });
  assert.equal(harness.reads.length, 0);
  assert.equal(second.stats.filesDeleted, 1);
  assert.ok(second.index.chunks.every((chunk) => chunk.path !== "src/f2.ts"));
  assert.ok(second.index.files.every((file) => file.path !== "src/f2.ts"));
  assert.equal(
    Object.keys(second.index.vectors).length,
    uniqueInputs(second.index),
  );
  assert.ok(second.stats.vectorsPruned > 0);
  assert.equal(second.stats.vectorsCreated, 0);
  assert.deepEqual(
    comparable(second.index),
    comparable(
      await (async () => {
        const fresh = seeded(5);
        fresh.files.delete("src/f2.ts");
        return (await fresh.update(undefined, { revision: "rev-2" })).index;
      })(),
    ),
  );
});

unitTest(
  "a renamed file is a delete plus an add; its path-bound vectors are recomputed",
  async () => {
    const harness = seeded(4);
    const first = await harness.update(undefined);
    harness.reset();
    const content = harness.files.get("src/f1.ts")!;
    harness.files.delete("src/f1.ts");
    harness.set("src/renamed.ts", content);
    const second = await harness.update(first.index, { revision: "rev-2" });
    assert.deepEqual(harness.reads, ["src/renamed.ts"]);
    assert.equal(second.stats.filesDeleted, 1);
    assert.equal(second.stats.filesAdded, 1);
    assert.ok(second.index.chunks.every((c) => c.path !== "src/f1.ts"));
    assert.ok(second.index.chunks.some((c) => c.path === "src/renamed.ts"));
    // The embedding input includes the path, so reuse across a rename would
    // attach a vector to text it was not computed from.
    assert.equal(second.stats.vectorsCreated, harness.embeddedTexts);
    assert.ok(second.stats.vectorsCreated > 0);
  },
);

unitTest(
  "a touched but unchanged file is re-read but neither re-chunked nor re-embedded",
  async () => {
    const harness = seeded(5);
    const first = await harness.update(undefined);
    harness.reset();
    harness.blobOverride.set("src/f2.ts", "different-blob-id");
    const second = await harness.update(first.index, { revision: "rev-2" });
    assert.deepEqual(harness.reads, ["src/f2.ts"]);
    assert.equal(harness.chunked.length, 0);
    assert.equal(harness.embedded.length, 0);
    assert.equal(second.stats.filesReused, 5);
    assert.equal(
      second.index.files.find((file) => file.path === "src/f2.ts")?.blobId,
      "different-blob-id",
    );
  },
);

unitTest(
  "a changed chunker version, chunk budget or repository rebuilds everything",
  async () => {
    const harness = seeded(4);
    const first = await harness.update(undefined);
    const cases: Array<[string, RepositoryIndex, number]> = [
      ["chunker", { ...first.index, chunkerVersion: "ts-js-ast-v0" }, 200],
      ["budget", first.index, 150],
      ["repository", { ...first.index, repositoryId: "other" }, 200],
      ["policy", { ...first.index, policyVersion: "0.0.1" }, 200],
    ];
    for (const [name, previous, maxChunkTokens] of cases) {
      harness.reset();
      const result = await harness.update(previous, {
        revision: "rev-2",
        maxChunkTokens,
      });
      assert.equal(result.stats.previous, "incompatible", name);
      assert.equal(result.stats.filesReused, 0, name);
      assert.equal(harness.reads.length, 4, name);
      assert.equal(harness.chunked.length, 4, name);
      assert.equal(result.stats.chunksReused, 0, name);
    }
  },
);

unitTest(
  "vectors are reused only for the same embedding identity",
  async () => {
    const harness = seeded(4);
    const first = await harness.update(undefined);
    harness.reset();
    const same = await harness.update(first.index);
    assert.equal(harness.embedded.length, 0);
    assert.equal(same.stats.vectorsReused, vectorCount(first.index));

    harness.model = "another-model";
    const changed = await harness.update(first.index);
    assert.equal(changed.stats.vectorsReused, 0);
    assert.equal(changed.stats.vectorsCreated, vectorCount(first.index));
    assert.equal(harness.embeddedTexts, vectorCount(first.index));
    assert.equal(changed.stats.filesReused, 4, "chunks stay reusable");
    const models = new Set(
      Object.values(changed.index.vectors).map((vector) => vector.model),
    );
    assert.ok(models.has("another-model"));

    harness.reset();
    const chunkOnly = await harness.update(first.index, { embedding: false });
    assert.equal(harness.embedded.length, 0);
    assert.equal(chunkOnly.stats.vectorsCreated, 0);
  },
);

unitTest("an aborted update stops reading and returns nothing", async () => {
  const harness = seeded(8);
  const controller = new AbortController();
  const refs = harness.refs().map((ref, i) => ({
    ...ref,
    read: async () => {
      if (i === 2) controller.abort(new Error("cancelled"));
      return ref.read();
    },
  }));
  await assert.rejects(
    updateRepositoryIndex({
      previous: undefined,
      repositoryId: "repo",
      revision: "rev-1",
      maxChunkTokens: 200,
      files: refs,
      embedding: harness.embedding,
      signal: controller.signal,
    }),
    /cancelled/,
  );
  assert.ok(harness.reads.length <= 3, "no file starts after cancellation");
  assert.equal(harness.embedded.length, 0);
});

unitTest(
  "cancellation prevents new embedding requests from starting",
  async () => {
    const harness = seeded(8);
    const controller = new AbortController();
    let requests = 0;
    await assert.rejects(
      harness.update(undefined, {
        signal: controller.signal,
        batch: 2,
        beforeEmbeddingRequest: () => {
          requests++;
          if (requests === 2) controller.abort(new Error("cancelled"));
        },
      }),
      /cancelled/,
    );
    assert.equal(harness.embedded.length, 1, "no request after abort");
  },
);

unitTest(
  "an embedding failure rejects instead of returning a partial index",
  async () => {
    const harness = seeded(6);
    harness.failEmbeddingAt = 2;
    await assert.rejects(
      harness.update(undefined),
      /embedding provider failure/,
    );
    assert.equal(harness.embedded.length, 2);
  },
);

unitTest(
  "the request budget bounds embedding calls and reused vectors cost nothing",
  async () => {
    const harness = seeded(8);
    const first = await harness.update(undefined);
    let budget = 0;
    const reserve = () => {
      budget++;
    };
    harness.reset();
    await harness.update(first.index, { beforeEmbeddingRequest: reserve });
    assert.equal(budget, 0, "reuse reserves nothing");

    harness.model = "new-model";
    harness.reset();
    let remaining = 2;
    await assert.rejects(
      harness.update(first.index, {
        batch: 1,
        beforeEmbeddingRequest: () => {
          if (remaining-- <= 0) throw new Error("request budget exhausted");
        },
      }),
      /budget exhausted/,
    );
    assert.equal(harness.embedded.length, 2, "never exceeds the allowance");
  },
);

unitTest("every real embedding call reserves exactly one request", async () => {
  const harness = seeded(7);
  let reservations = 0;
  const { index } = await harness.update(undefined, {
    batch: 3,
    beforeEmbeddingRequest: () => reservations++,
  });
  assert.equal(reservations, harness.embedded.length);
  assert.equal(reservations, Math.ceil(vectorCount(index) / 3));
});

unitTest(
  "incremental updates equal from-scratch builds across random edits",
  async () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const harness = seeded(12);
    let index = (await harness.update(undefined, { revision: "r0" })).index;
    for (let round = 1; round <= 12; round++) {
      const paths = [...harness.files.keys()];
      const operation = Math.floor(random() * 4);
      const path = paths[Math.floor(random() * paths.length)]!;
      if (operation === 0)
        harness.set(path, source(`edit${round}`, Math.floor(random() * 99)));
      else if (operation === 1 && paths.length > 3) harness.files.delete(path);
      else if (operation === 2)
        harness.set(`src/added${round}.ts`, source(`added${round}`, round));
      else {
        const content = harness.files.get(path)!;
        harness.files.delete(path);
        harness.set(`src/moved${round}.ts`, content);
      }
      harness.reset();
      const revision = `r${round}`;
      const incremental = await harness.update(index, { revision });
      const scratch = await (async () => {
        const fresh = new Harness();
        fresh.files = new Map(harness.files);
        return fresh.update(undefined, { revision });
      })();
      assert.deepEqual(
        comparable(incremental.index),
        comparable(scratch.index),
        `round ${round}`,
      );
      assert.ok(harness.reads.length <= 2, `round ${round} read too much`);
      index = incremental.index;
    }
  },
);

unitTest(
  "duplicate or unavailable files never produce duplicate state",
  async () => {
    const harness = seeded(3);
    const refs = harness.refs();
    const withDuplicate = [
      ...refs,
      refs[0]!,
      { path: "src/gone.ts", read: async () => undefined },
    ];
    const result = await updateRepositoryIndex({
      previous: undefined,
      repositoryId: "repo",
      revision: "rev-1",
      maxChunkTokens: 200,
      files: withDuplicate,
    });
    assert.equal(result.index.files.length, 3);
    assert.equal(result.stats.filesSkipped, 1);
    assert.ok(result.index.files.every((file) => file.path !== "src/gone.ts"));
    assert.equal(CHUNKER_VERSION, result.index.chunkerVersion);
  },
);
