import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ORPHAN_GRACE_MS,
  nodeFileOps,
  persistedRefsOf,
  publishIndex,
} from "../src/retrieval/index-generation.js";
import { indexPath, readIndex } from "../src/retrieval/index-store.js";
import {
  semanticSpaceFor,
  prepareRepositoryIndex,
} from "../src/retrieval/prepared-index.js";
import type { RepositoryIndex } from "../src/retrieval/types.js";
import { VectorStore } from "../src/retrieval/vector-store.js";
import {
  BYTES_PER_VALUE,
  VECTOR_HEADER_BYTES,
  decodeVectorHeader,
  float64LittleEndianBytes,
} from "../src/retrieval/vector-format.js";
import { unitTest } from "./helpers.js";
import {
  activeMetadataPath,
  generationsOf,
  indexSignature,
  rewriteMetadata,
  snapshotFiles,
  storedVectors,
  syntheticIndex,
} from "./index-fixtures.js";
import { faultyOps, SimulatedCrash } from "./index-faults.js";

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "acr-generation-"));
  return { dir, path: indexPath(dir, ".cache") };
}

async function load(path: string): Promise<RepositoryIndex> {
  const loaded = await readIndex(path);
  assert.equal(
    loaded.status,
    "valid",
    loaded.status === "valid" ? "" : JSON.stringify(loaded),
  );
  return (loaded as { status: "valid"; index: RepositoryIndex }).index;
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function blobPath(manifestPath: string): Promise<string> {
  const metadata = JSON.parse(
    await readFile(await activeMetadataPath(manifestPath), "utf8"),
  );
  return join(generationsOf(manifestPath), metadata.vectorStore.file);
}

/** Replace the blob bytes; optionally re-seal the metadata so only the intended check can trip. */
async function rewriteBlob(
  manifestPath: string,
  mutate: (bytes: Buffer) => Buffer,
  reseal: boolean,
): Promise<void> {
  const file = await blobPath(manifestPath);
  const next = mutate(await readFile(file));
  await writeFile(file, next);
  if (reseal)
    await rewriteMetadata(manifestPath, (draft) => {
      draft.vectorStore.bytes = next.length;
      draft.vectorStore.sha256 = sha256(next);
    });
}

// ------------------------------------------------------------------ format

unitTest(
  "vectors persist to a binary blob and load back bit for bit",
  async () => {
    const { path } = await workspace();
    const index = syntheticIndex({
      count: 30,
      spaces: [
        { provider: "alpha", dimensions: 8 },
        { provider: "beta", dimensions: 5 },
      ],
    });
    await publishIndex({ manifestPath: path, index });
    const back = await load(path);
    assert.deepEqual(storedVectors(back), storedVectors(index));
    for (const [position, segment] of index.vectors.segments.entries())
      assert.deepEqual(
        new Uint8Array(
          back.vectors.segments[position]!.vectors.buffer,
          back.vectors.segments[position]!.vectors.byteOffset,
          segment.vectors.byteLength,
        ),
        new Uint8Array(
          segment.vectors.buffer,
          segment.vectors.byteOffset,
          segment.vectors.byteLength,
        ),
        "identical IEEE-754 bit patterns",
      );
    assert.deepEqual(back.inputHashes, index.inputHashes);
  },
);

unitTest("the blob and metadata have the documented layout", async () => {
  const { path } = await workspace();
  const index = syntheticIndex({
    count: 10,
    spaces: [
      { provider: "alpha", dimensions: 8 },
      { provider: "beta", dimensions: 3 },
    ],
  });
  await publishIndex({ manifestPath: path, index });
  const manifest = JSON.parse(await readFile(path, "utf8"));
  assert.equal(manifest.kind, "repository-index-manifest");
  assert.equal(manifest.schemaVersion, 3);
  const metadataText = await readFile(await activeMetadataPath(path), "utf8");
  const metadata = JSON.parse(metadataText);
  const blob = await readFile(await blobPath(path));
  const payload = 10 * 8 * BYTES_PER_VALUE + 10 * 3 * BYTES_PER_VALUE;
  assert.equal(blob.length, VECTOR_HEADER_BYTES + payload);
  assert.equal(metadata.vectorStore.bytes, blob.length);
  assert.equal(metadata.vectorStore.sha256, sha256(blob));
  assert.equal(metadata.vectorStore.format, "f64le");
  assert.deepEqual(
    metadata.vectorStore.spaces.map(
      (s: { offsetBytes: number }) => s.offsetBytes,
    ),
    [0, 10 * 8 * BYTES_PER_VALUE],
  );
  const header = decodeVectorHeader(blob);
  assert.ok(header.ok);
  assert.equal(header.ok && header.header.vectorCount, 20);
  assert.equal(header.ok && header.header.blobId, metadata.vectorStore.blobId);
  // The first value of the first vector sits right after the header, as LE bytes.
  const first = index.vectors.segments[0]!.vectors.subarray(0, 1);
  assert.deepEqual(
    [...blob.subarray(VECTOR_HEADER_BYTES, VECTOR_HEADER_BYTES + 8)],
    [...float64LittleEndianBytes(first, true)],
  );
  // Numbers live only in the blob: the JSON carries no vector values.
  assert.ok(!("values" in metadata.vectorStore.spaces[0]));
  const probe = String(storedVectors(index)[0]!.values[0]).slice(0, 12);
  assert.ok(!metadataText.includes(probe), "no decimal vector text in JSON");
  assert.ok(
    !blob.includes(Buffer.from("export const")),
    "no source in the blob",
  );
});

unitTest(
  "a loaded blob is viewed in place, aligned, with no unpacked copy",
  async () => {
    const { path } = await workspace();
    await publishIndex({
      manifestPath: path,
      index: syntheticIndex({
        count: 20,
        spaces: [
          { provider: "alpha", dimensions: 8 },
          { provider: "beta", dimensions: 3 },
        ],
      }),
    });
    const loaded = await readIndex(path);
    assert.equal(loaded.status === "valid" && loaded.info?.zeroCopy, true);
    const { segments } = (loaded as { index: RepositoryIndex }).index.vectors;
    assert.equal(
      new Set(segments.map((segment) => segment.vectors.buffer)).size,
      1,
      "every space is a window onto the one buffer the file was read into",
    );
    for (const segment of segments) {
      assert.ok(segment.vectors instanceof Float64Array);
      assert.equal(segment.vectors.byteOffset % 8, 0);
    }
    const blob = await stat(await blobPath(path));
    assert.equal(segments[0]!.vectors.buffer.byteLength, blob.size);
  },
);

unitTest(
  "the search index of the active space is that same memory, not another copy",
  async () => {
    const { path } = await workspace();
    await publishIndex({
      manifestPath: path,
      index: syntheticIndex({ count: 25 }),
    });
    const index = await load(path);
    const prepared = prepareRepositoryIndex(index);
    const space = semanticSpaceFor(prepared, {
      provider: "synthetic",
      model: "m",
      version: "v1",
      dimensions: 8,
      embed: async () => [],
    });
    const segment = index.vectors.segments[0]!;
    assert.equal(space.index.count, 25);
    assert.equal(space.index.vectors, segment.vectors);
    assert.equal(space.index.vectors.buffer, segment.vectors.buffer);
  },
);

unitTest("an index without vectors writes no blob at all", async () => {
  const { path } = await workspace();
  const lexical = { ...syntheticIndex({ count: 5 }) };
  lexical.vectors = VectorStore.empty();
  await publishIndex({ manifestPath: path, index: lexical });
  const files = await readdir(generationsOf(path));
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^index-[0-9a-f]{32}\.json$/);
  const back = await load(path);
  assert.equal(back.vectors.count, 0);
  assert.equal(back.chunks.length, 5);
});

unitTest(
  "a metadata file records the embedding input hash per chunk",
  async () => {
    const { path } = await workspace();
    const index = syntheticIndex({ count: 6 });
    await publishIndex({ manifestPath: path, index });
    const metadata = JSON.parse(
      await readFile(await activeMetadataPath(path), "utf8"),
    );
    assert.deepEqual(metadata.chunkInputHashes, index.inputHashes);
    assert.equal(metadata.inputHashVersion, "sha256-path-signature-content-v1");
    await rewriteMetadata(path, (d) => (d.inputHashVersion = "something-else"));
    const loaded = await readIndex(path);
    assert.equal(loaded.status, "incompatible");
  },
);

// ------------------------------------------------------------- generations

unitTest(
  "publishing retires the previous generation after the new one is canonical",
  async () => {
    const { path } = await workspace();
    const first = syntheticIndex({ count: 8, seed: 1 });
    await publishIndex({ manifestPath: path, index: first });
    const loaded = await load(path);
    const second = syntheticIndex({ count: 8, seed: 2, revision: "rev2" });
    const result = await publishIndex({
      manifestPath: path,
      index: second,
      previous: persistedRefsOf(loaded),
    });
    assert.equal(result.vectorBlobReused, false);
    assert.deepEqual(result.cleanup, { removed: 2, failed: 0 });
    const files = await readdir(generationsOf(path));
    assert.equal(files.length, 2, "exactly one metadata and one blob remain");
    assert.equal(indexSignature(await load(path)), indexSignature(second));
  },
);

unitTest(
  "unchanged vectors keep their blob; only metadata is rewritten",
  async () => {
    const { path } = await workspace();
    const first = syntheticIndex({ count: 40 });
    await publishIndex({ manifestPath: path, index: first });
    const before = await snapshotFiles(generationsOf(path));
    const blobName = Object.keys(before).find((name) => name.endsWith(".bin"))!;
    // A new revision: new chunk ids and metadata, the very same vector store.
    const next: RepositoryIndex = {
      ...syntheticIndex({ count: 40, revision: "rev2" }),
      vectors: first.vectors,
      createdAt: "later",
    };
    const result = await publishIndex({
      manifestPath: path,
      index: next,
      previous: persistedRefsOf(first),
    });
    assert.equal(result.vectorBlobReused, true);
    // Even an ancient blob is safe: the new manifest still reaches it.
    const after = await snapshotFiles(generationsOf(path));
    assert.equal(after[blobName], before[blobName], "blob bytes untouched");
    assert.equal(Object.keys(after).length, 2);
    const back = await load(path);
    assert.equal(back.revision, "rev2");
    assert.deepEqual(storedVectors(back), storedVectors(first));
  },
);

unitTest("a cleanup failure never fails or undoes a publication", async () => {
  const { path } = await workspace();
  const first = syntheticIndex({ count: 8, seed: 1 });
  await publishIndex({ manifestPath: path, index: first });
  const previous = persistedRefsOf(first)!;
  const second = syntheticIndex({ count: 8, seed: 2 });
  const { ops } = faultyOps((event) =>
    event.op === "remove" && event.phase === "before" ? "fail" : undefined,
  );
  const result = await publishIndex({
    manifestPath: path,
    index: second,
    previous,
    ops,
  });
  assert.ok(result.cleanup.failed > 0);
  assert.equal(result.cleanup.removed, 0);
  assert.equal(indexSignature(await load(path)), indexSignature(second));
  // The leftovers are harmless garbage that a later publication retires.
  const third = syntheticIndex({ count: 8, seed: 3 });
  const cleaned = await publishIndex({
    manifestPath: path,
    index: third,
    previous: persistedRefsOf(second),
  });
  assert.ok(cleaned.cleanup.removed >= 2);
});

unitTest(
  "old orphans are swept, young ones and the active files never",
  async () => {
    const { path } = await workspace();
    const index = syntheticIndex({ count: 8 });
    await publishIndex({ manifestPath: path, index });
    const directory = generationsOf(path);
    const hex = (n: number) => String(n).repeat(32).slice(0, 32);
    const oldOrphan = join(directory, `index-${hex(1)}.json`);
    const oldBlob = join(directory, `vectors-${hex(2)}.bin`);
    const oldTemp = join(directory, `vectors-${hex(3)}.bin.123.abc.tmp`);
    const youngOrphan = join(directory, `index-${hex(4)}.json`);
    const stranger = join(directory, "notes.txt");
    for (const file of [oldOrphan, oldBlob, oldTemp, youngOrphan, stranger])
      await writeFile(file, "x");
    const ancient = new Date(Date.now() - ORPHAN_GRACE_MS - 60_000);
    for (const file of [oldOrphan, oldBlob, oldTemp])
      await utimes(file, ancient, ancient);
    const stale = syntheticIndex({ count: 8, seed: 9 });
    await publishIndex({
      manifestPath: path,
      index: stale,
      previous: persistedRefsOf(index),
    });
    const left = await readdir(directory);
    assert.ok(!left.includes(`index-${hex(1)}.json`));
    assert.ok(!left.includes(`vectors-${hex(2)}.bin`));
    assert.ok(!left.some((name) => name.endsWith(".tmp")));
    assert.ok(
      left.includes(`index-${hex(4)}.json`),
      "a possible live publisher's file",
    );
    assert.ok(
      left.includes("notes.txt"),
      "files that are not ours are never touched",
    );
    assert.equal(indexSignature(await load(path)), indexSignature(stale));
  },
);

// ----------------------------------------------------------- crash safety

/**
 * Run one publication of a new index over a previous one with a fault, then
 * report what a restart sees. Each run builds its own indexes: an index
 * remembers which blob it was persisted to, so reusing one would change the
 * sequence of filesystem calls.
 */
async function crashAt(
  decide: Parameters<typeof faultyOps>[0],
  makePrev: () => RepositoryIndex,
  makeNext: () => RepositoryIndex,
) {
  const { path } = await workspace();
  await publishIndex({ manifestPath: path, index: makePrev() });
  const fresh = await load(path);
  const harness = faultyOps(decide);
  let outcome: "published" | "crashed" | "failed" = "published";
  try {
    await publishIndex({
      manifestPath: path,
      index: makeNext(),
      previous: persistedRefsOf(fresh),
      ops: harness.ops,
    });
  } catch (error) {
    outcome = error instanceof SimulatedCrash ? "crashed" : "failed";
  }
  // "Restart": a brand-new reader with the real filesystem.
  return { path, outcome, harness, loaded: await readIndex(path) };
}

unitTest(
  "a crash at any filesystem step leaves exactly one complete generation",
  async () => {
    const prev = () => syntheticIndex({ count: 20, seed: 1, revision: "old" });
    const next = () => syntheticIndex({ count: 22, seed: 2, revision: "new" });
    const prevSignature = indexSignature(prev());
    const nextSignature = indexSignature(next());
    // Learn the sequence of steps from a clean run.
    const clean = await crashAt(undefined as never, prev, next);
    const steps = clean.harness.log.filter((event) => event.phase === "before");
    const manifestStep = steps.find(
      (event) => event.op === "rename" && event.to === clean.path,
    )!.step;
    assert.ok(steps.length > 12, "the sweep covers a real sequence of steps");

    let sawPrevious = 0;
    let sawNext = 0;
    for (const event of steps)
      for (const phase of ["before", "after"] as const) {
        const { loaded, outcome } = await crashAt(
          (e) =>
            e.step === event.step && e.phase === phase ? "crash" : undefined,
          prev,
          next,
        );
        const label = `${event.op} ${phase} step ${event.step}`;
        const committed =
          event.step > manifestStep ||
          (event.step === manifestStep && phase === "after");
        // After the commit the code deliberately ignores housekeeping failures, so
        // a "crash" there can still end in a successful return; before it, never.
        assert.ok(
          outcome === "crashed" || (committed && outcome === "published"),
          `${label}: ${outcome}`,
        );
        assert.equal(
          loaded.status,
          "valid",
          `${label}: index must load, got ${JSON.stringify(loaded)}`,
        );
        const signature = indexSignature(
          (loaded as { index: RepositoryIndex }).index,
        );
        assert.equal(
          signature,
          committed ? nextSignature : prevSignature,
          `${label}: must be exactly ${committed ? "the new" : "the previous"} generation`,
        );
        if (committed) sawNext++;
        else sawPrevious++;
      }
    assert.ok(sawPrevious > 10 && sawNext > 0);
  },
);

unitTest(
  "the named crash points each expose the previous or the new generation, never a mix",
  async () => {
    const prev = () => syntheticIndex({ count: 16, seed: 1, revision: "old" });
    const next = () => syntheticIndex({ count: 18, seed: 2, revision: "new" });
    const expectations: Array<
      [
        string,
        (e: {
          op: string;
          phase: string;
          path: string;
          to?: string;
        }) => boolean,
        "old" | "new",
      ]
    > = [
      [
        "after vector temp write",
        (e) =>
          e.op === "close" &&
          e.phase === "after" &&
          /vectors-.*\.tmp$/.test(e.path),
        "old",
      ],
      [
        "after metadata temp write",
        (e) =>
          e.op === "close" &&
          e.phase === "after" &&
          /index-.*\.json\..*\.tmp$/.test(e.path),
        "old",
      ],
      [
        "after vector rename",
        (e) =>
          e.op === "rename" &&
          e.phase === "after" &&
          /vectors-[0-9a-f]{32}\.bin$/.test(e.to ?? ""),
        "old",
      ],
      [
        "after metadata rename",
        (e) =>
          e.op === "rename" &&
          e.phase === "after" &&
          /index-[0-9a-f]{32}\.json$/.test(e.to ?? ""),
        "old",
      ],
      [
        "before manifest replace",
        (e) =>
          e.op === "rename" &&
          e.phase === "before" &&
          /repository-index\.json$/.test(e.to ?? ""),
        "old",
      ],
      [
        "after manifest replace, before cleanup",
        (e) =>
          e.op === "rename" &&
          e.phase === "after" &&
          /repository-index\.json$/.test(e.to ?? ""),
        "new",
      ],
    ];
    for (const [name, matches, expected] of expectations) {
      const { loaded, outcome } = await crashAt(
        (event) => (matches(event) ? "crash" : undefined),
        prev,
        next,
      );
      assert.equal(outcome, "crashed", name);
      assert.equal(loaded.status, "valid", name);
      assert.equal(
        indexSignature((loaded as { index: RepositoryIndex }).index),
        indexSignature(expected === "old" ? prev() : next()),
        name,
      );
    }
  },
);

unitTest(
  "an I/O error at any step before the commit leaves the previous index and no litter",
  async () => {
    const prev = () => syntheticIndex({ count: 20, seed: 1, revision: "old" });
    const next = () => syntheticIndex({ count: 21, seed: 2, revision: "new" });
    const clean = await crashAt(undefined as never, prev, next);
    const steps = clean.harness.log.filter((event) => event.phase === "before");
    const manifestStep = steps.find(
      (event) => event.op === "rename" && event.to === clean.path,
    )!.step;
    for (const event of steps.filter((e) => e.step <= manifestStep)) {
      const { path, outcome, loaded } = await crashAt(
        (e) =>
          e.step === event.step && e.phase === "before" ? "fail" : undefined,
        prev,
        next,
      );
      const label = `${event.op} step ${event.step}`;
      assert.equal(outcome, "failed", label);
      assert.equal(loaded.status, "valid", label);
      assert.equal(
        indexSignature((loaded as { index: RepositoryIndex }).index),
        indexSignature(prev()),
        label,
      );
      const left = await readdir(generationsOf(path));
      assert.equal(
        left.length,
        2,
        `${label}: failed publication left nothing behind`,
      );
      assert.deepEqual(
        (await readdir(join(path, ".."))).filter((name) =>
          name.endsWith(".tmp"),
        ),
        [],
        label,
      );
    }
  },
);

unitTest(
  "failures after the commit cannot turn a published index into an error",
  async () => {
    const prev = () => syntheticIndex({ count: 10, seed: 1, revision: "old" });
    const next = () => syntheticIndex({ count: 10, seed: 2, revision: "new" });
    const clean = await crashAt(undefined as never, prev, next);
    const steps = clean.harness.log.filter((event) => event.phase === "before");
    const manifestStep = steps.find(
      (event) => event.op === "rename" && event.to === clean.path,
    )!.step;
    for (const event of steps.filter((e) => e.step > manifestStep)) {
      const { outcome, loaded } = await crashAt(
        (e) =>
          e.step === event.step && e.phase === "before" ? "fail" : undefined,
        prev,
        next,
      );
      assert.equal(outcome, "published", `${event.op} step ${event.step}`);
      assert.equal(
        indexSignature((loaded as { index: RepositoryIndex }).index),
        indexSignature(next()),
      );
    }
  },
);

// ---------------------------------------------------------------- corruption

type Damage = [
  name: string,
  apply: (path: string, directory: string) => Promise<void>,
  reason: RegExp,
];

const DAMAGES: Damage[] = [
  [
    "truncated binary file",
    (path) => rewriteBlob(path, (b) => b.subarray(0, b.length - 8), false),
    /vector file is \d+ bytes, expected \d+/,
  ],
  [
    "truncated mid-header",
    (path) => rewriteBlob(path, (b) => b.subarray(0, 20), false),
    /vector file is 20 bytes/,
  ],
  [
    "extra bytes",
    (path) =>
      rewriteBlob(path, (b) => Buffer.concat([b, Buffer.alloc(8)]), false),
    /vector file is \d+ bytes, expected \d+/,
  ],
  [
    "wrong checksum",
    (path) =>
      rewriteBlob(
        path,
        (b) => {
          const copy = Buffer.from(b);
          copy[copy.length - 1] ^= 0xff;
          return copy;
        },
        false,
      ),
    /checksum mismatch/,
  ],
  [
    "wrong dimensions",
    (path) =>
      rewriteMetadata(path, (d) => (d.vectorStore.spaces[0].dimensions += 1)),
    /vector file size does not match its spans/,
  ],
  [
    "wrong vector count",
    (path) =>
      rewriteMetadata(path, (d) => {
        d.vectorStore.spaces[0].count += 1;
        d.vectorStore.spaces[0].cacheKeys.push("extra");
        d.vectorStore.spaces[0].inputHashes.push("extra");
        d.vectorStore.count += 1;
      }),
    /vector file size does not match its spans/,
  ],
  [
    "unknown binary format version",
    (path) =>
      rewriteBlob(
        path,
        (b) => {
          const copy = Buffer.from(b);
          copy.writeUInt32LE(7, 8);
          return copy;
        },
        true,
      ),
    /unknown vector format version 7/,
  ],
  [
    "unknown numeric encoding",
    (path) =>
      rewriteBlob(
        path,
        (b) => {
          const copy = Buffer.from(b);
          copy.writeUInt32LE(9, 12);
          return copy;
        },
        true,
      ),
    /unknown numeric encoding 9/,
  ],
  [
    "metadata points outside the file",
    (path) =>
      rewriteMetadata(
        path,
        (d) => (d.vectorStore.spaces[0].offsetBytes = 1 << 30),
      ),
    /vector spans/,
  ],
  [
    "metadata points at a negative offset",
    (path) =>
      rewriteMetadata(path, (d) => (d.vectorStore.spaces[0].offsetBytes = -8)),
    /offsetBytes/,
  ],
  [
    "metadata and binary of different generations",
    (path) =>
      rewriteBlob(
        path,
        (b) => {
          const copy = Buffer.from(b);
          copy.fill(0xab, 32, 48); // another blob id in the header
          return copy;
        },
        true,
      ),
    /belongs to another generation/,
  ],
  [
    "header count disagrees with metadata",
    (path) =>
      rewriteBlob(
        path,
        (b) => {
          const copy = Buffer.from(b);
          copy.writeBigUInt64LE(1n, 16);
          return copy;
        },
        true,
      ),
    /header disagrees with metadata/,
  ],
  [
    "missing binary file",
    async (path) => rm(await blobPath(path)),
    /vector file is missing/,
  ],
  [
    "missing metadata file",
    async (path) => rm(await activeMetadataPath(path)),
    /metadata file is missing/,
  ],
  [
    "metadata edited without re-sealing the manifest",
    async (path) => {
      const file = await activeMetadataPath(path);
      await writeFile(
        file,
        (await readFile(file, "utf8")).replace("repo", "repX"),
      );
    },
    /metadata (file is|checksum)/,
  ],
  [
    "malformed manifest",
    (path) => writeFile(path, "{ not json"),
    /not valid JSON/,
  ],
  [
    "manifest of the wrong shape",
    (path) =>
      writeFile(
        path,
        JSON.stringify({ schemaVersion: 3, kind: "repository-index-manifest" }),
      ),
    /generation/,
  ],
  [
    "manifest naming a path instead of a file",
    async (path) => {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.metadataFile = "../../etc/passwd";
      await writeFile(path, JSON.stringify(manifest));
    },
    /metadataFile/,
  ],
  [
    "manifest pointing at an incomplete generation",
    async (path) => {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.generation = "f".repeat(32);
      manifest.metadataFile = `index-${"f".repeat(32)}.json`;
      await writeFile(path, JSON.stringify(manifest));
    },
    /metadata file is missing/,
  ],
  [
    "manifest and metadata of different generations",
    async (path) => {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.generation = "e".repeat(32);
      await writeFile(path, JSON.stringify(manifest));
    },
    /different generation/,
  ],
  [
    "a non-finite stored vector (NaN)",
    (path) =>
      rewriteBlob(
        path,
        (b) => {
          const copy = Buffer.from(b);
          copy.writeDoubleLE(Number.NaN, VECTOR_HEADER_BYTES + 8);
          return copy;
        },
        true,
      ),
    /finite/,
  ],
  [
    "a non-finite stored vector (Infinity)",
    (path) =>
      rewriteBlob(
        path,
        (b) => {
          const copy = Buffer.from(b);
          copy.writeDoubleLE(Number.POSITIVE_INFINITY, VECTOR_HEADER_BYTES);
          return copy;
        },
        true,
      ),
    /finite/,
  ],
  [
    "duplicate cache keys",
    (path) =>
      rewriteMetadata(path, (d) => {
        const keys = d.vectorStore.spaces[0].cacheKeys;
        keys[1] = keys[0];
      }),
    /duplicate cache key/,
  ],
];

for (const [name, damage, reason] of DAMAGES)
  unitTest(
    `corruption is reported, never mistaken for an empty index: ${name}`,
    async () => {
      const { dir, path } = await workspace();
      await publishIndex({
        manifestPath: path,
        index: syntheticIndex({ count: 9 }),
      });
      await damage(path, generationsOf(path));
      const loaded = await readIndex(path);
      assert.equal(loaded.status, "corrupt", JSON.stringify(loaded));
      assert.match(loaded.status === "corrupt" ? loaded.reason : "", reason);
      assert.equal(typeof dir, "string");
    },
  );

unitTest(
  "an old valid generation stays usable when only the new one is damaged",
  async () => {
    const { path } = await workspace();
    const first = syntheticIndex({ count: 9, seed: 1, revision: "old" });
    await publishIndex({ manifestPath: path, index: first });
    const manifestBefore = await readFile(path, "utf8");
    const directory = generationsOf(path);
    const oldFiles = await snapshotFiles(directory);
    // A second generation is written but never committed; then it is damaged.
    const second = syntheticIndex({ count: 9, seed: 2, revision: "new" });
    const { ops } = faultyOps((e) =>
      e.op === "rename" &&
      e.phase === "before" &&
      /repository-index\.json$/.test(e.to ?? "")
        ? "crash"
        : undefined,
    );
    await assert.rejects(
      publishIndex({ manifestPath: path, index: second, ops }),
      SimulatedCrash,
    );
    for (const name of await readdir(directory))
      if (!(name in oldFiles) && name.endsWith(".bin"))
        await writeFile(join(directory, name), "garbage");
    assert.equal(await readFile(path, "utf8"), manifestBefore);
    assert.equal(indexSignature(await load(path)), indexSignature(first));
  },
);

unitTest(
  "the generation directory is created on demand and files are owner-only",
  async () => {
    const { path } = await workspace();
    await mkdir(join(path, ".."), { recursive: true });
    await publishIndex({
      manifestPath: path,
      index: syntheticIndex({ count: 3 }),
      ops: nodeFileOps,
    });
    if (process.platform !== "win32")
      for (const name of await readdir(generationsOf(path)))
        assert.equal(
          (await stat(join(generationsOf(path), name))).mode & 0o077,
          0,
          `${name} must not be group/world accessible`,
        );
    assert.equal((await load(path)).chunks.length, 3);
  },
);
