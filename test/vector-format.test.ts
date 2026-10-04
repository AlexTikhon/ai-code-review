import assert from "node:assert/strict";
import {
  BYTES_PER_VALUE,
  ENCODING_F64LE,
  VECTOR_FORMAT_VERSION,
  VECTOR_HEADER_BYTES,
  decodeVectorHeader,
  encodeVectorHeader,
  float64LittleEndianBytes,
  float64View,
} from "../src/retrieval/vector-format.js";
import { buildSemanticIndex } from "../src/retrieval/semantic-index.js";
import { unitTest } from "./helpers.js";

const BLOB_ID = "0123456789abcdef0123456789abcdef";

const header = () => ({
  formatVersion: VECTOR_FORMAT_VERSION,
  encoding: ENCODING_F64LE,
  blobId: BLOB_ID,
  vectorCount: 7,
  payloadBytes: 7 * 4 * BYTES_PER_VALUE,
});

/** Numbers that expose any lossy or order-dependent encoding. */
const AWKWARD = [
  0,
  -0,
  0.1,
  -0.1,
  1 / 3,
  Math.PI,
  Number.MIN_VALUE, // smallest denormal
  Number.EPSILON,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  1e-300,
  1.7976931348623155e308,
  0.012345678912345678,
  // float32 -> float64 widening noise, as real embedding APIs produce
  Math.fround(0.0023064255),
  Number("0.0023064255"),
];

unitTest("the vector file header round-trips and is 8-byte aligned", () => {
  assert.equal(VECTOR_HEADER_BYTES % BYTES_PER_VALUE, 0);
  const bytes = encodeVectorHeader(header());
  assert.equal(bytes.byteLength, VECTOR_HEADER_BYTES);
  const decoded = decodeVectorHeader(bytes);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.ok && decoded.header, header());
});

unitTest("the documented header layout is what is written", () => {
  const bytes = encodeVectorHeader(header());
  assert.equal(
    Buffer.from(bytes.subarray(0, 8)).toString("latin1"),
    "ACRVECS\0",
  );
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(8, true), 1, "format version, little-endian");
  assert.equal(view.getUint32(12, true), 1, "encoding 1 = float64 LE");
  assert.equal(view.getBigUint64(16, true), 7n, "vector count");
  assert.equal(view.getBigUint64(24, true), 224n, "payload bytes");
  assert.equal(Buffer.from(bytes.subarray(32, 48)).toString("hex"), BLOB_ID);
  assert.ok(
    bytes.subarray(48).every((byte) => byte === 0),
    "reserved is zero",
  );
});

unitTest("a damaged or foreign header is rejected without echoing it", () => {
  const good = encodeVectorHeader(header());
  const mutate = (change: (bytes: Uint8Array, view: DataView) => void) => {
    const copy = new Uint8Array(good);
    change(copy, new DataView(copy.buffer));
    return decodeVectorHeader(copy);
  };
  const cases: Array<[string, ReturnType<typeof mutate>, RegExp]> = [
    ["short", decodeVectorHeader(good.subarray(0, 63)), /shorter/],
    ["magic", mutate((b) => (b[0] = 0x58)), /bad magic/],
    ["version", mutate((_, v) => v.setUint32(8, 2, true)), /format version 2/],
    ["encoding", mutate((_, v) => v.setUint32(12, 2, true)), /encoding 2/],
    [
      "huge count",
      mutate((_, v) => v.setBigUint64(16, 2n ** 63n, true)),
      /out of range/,
    ],
    ["reserved", mutate((b) => (b[60] = 1)), /reserved/],
  ];
  for (const [name, result, pattern] of cases) {
    assert.equal(result.ok, false, name);
    assert.match(result.ok ? "" : result.reason, pattern, name);
  }
  assert.throws(
    () => encodeVectorHeader({ ...header(), blobId: "nothex" }),
    /blob id/,
  );
});

unitTest("floats are stored as little-endian IEEE-754 doubles", () => {
  const bytes = float64LittleEndianBytes(new Float64Array([1, -2]), true);
  // 1.0 = 0x3FF0000000000000, -2.0 = 0xC000000000000000, least significant first.
  assert.deepEqual(
    [...bytes],
    [0, 0, 0, 0, 0, 0, 0xf0, 0x3f, 0, 0, 0, 0, 0, 0, 0, 0xc0],
  );
});

unitTest("every double survives number -> bytes -> number bit for bit", () => {
  const original = new Float64Array(AWKWARD);
  for (let i = 0; i < 2000; i++)
    original[i % original.length] = Math.random() * 2 - 1;
  const values = new Float64Array([...AWKWARD, ...original]);
  const bytes = float64LittleEndianBytes(values, true);
  const { view } = float64View(bytes, 0, values.length, true);
  assert.equal(view.length, values.length);
  assert.deepEqual(
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
    "identical bit patterns, including -0 and denormals",
  );
  assert.ok(Object.is(view[1], -0));
  assert.equal(view[6], Number.MIN_VALUE);
});

unitTest(
  "round-tripped vectors rank exactly like the originals under exact search",
  () => {
    const rows = Array.from({ length: 40 }, (_, row) =>
      Array.from({ length: 16 }, (_, d) => Math.sin(row * 31 + d * 7) * 0.7),
    );
    const flat = new Float64Array(rows.flat());
    const { view } = float64View(
      float64LittleEndianBytes(flat, true),
      0,
      flat.length,
      true,
    );
    const direct = buildSemanticIndex(rows);
    const viaBytes = {
      ...direct,
      vectors: view,
    };
    assert.deepEqual(viaBytes.vectors, direct.vectors);
    assert.deepEqual(viaBytes.squaredNorms, direct.squaredNorms);
  },
);

unitTest("an aligned span is a zero-copy view of the same memory", () => {
  const source = Buffer.allocUnsafeSlow(VECTOR_HEADER_BYTES + 4 * 8);
  const payload = new Float64Array(
    source.buffer,
    source.byteOffset + VECTOR_HEADER_BYTES,
    4,
  );
  payload.set([1, 2, 3, 4]);
  const { view, zeroCopy } = float64View(source, VECTOR_HEADER_BYTES, 4, true);
  assert.equal(zeroCopy, true);
  assert.equal(view.buffer, source.buffer, "same ArrayBuffer");
  assert.equal(view.byteOffset, source.byteOffset + VECTOR_HEADER_BYTES);
  payload[0] = 99;
  assert.equal(view[0], 99, "a view, not a copy");
});

unitTest("a misaligned span is copied once instead of read unsafely", () => {
  const backing = new Uint8Array(8 + 3 * 8);
  const offset = 3; // not a multiple of 8
  const numbers = float64LittleEndianBytes(new Float64Array([5, 6, 7]), true);
  backing.set(numbers, offset);
  const { view, zeroCopy } = float64View(backing, offset, 3, true);
  assert.equal(zeroCopy, false);
  assert.deepEqual([...view], [5, 6, 7]);
  assert.notEqual(view.buffer, backing.buffer);
  assert.equal(view.byteOffset % 8, 0);
});

unitTest("spans outside the buffer are refused", () => {
  const bytes = new Uint8Array(64);
  assert.throws(() => float64View(bytes, 0, 9, true), /outside/);
  assert.throws(() => float64View(bytes, -8, 1, true), /outside/);
  assert.throws(() => float64View(bytes, 1.5, 1, true), /outside/);
});

unitTest("a big-endian host decodes and encodes the same file format", () => {
  const values = new Float64Array([1.5, -0.25, Math.PI, 1e-300]);
  const canonical = float64LittleEndianBytes(values, true);
  const copyOfCanonical = new Uint8Array(canonical);
  // Reading the canonical little-endian bytes as a big-endian host would: every
  // value is byte-reversed, i.e. exactly what a big-endian read of the same
  // bytes yields.
  const swapped = float64View(
    new Uint8Array(copyOfCanonical),
    0,
    4,
    false,
  ).view;
  const asBigEndian = new DataView(copyOfCanonical.buffer);
  for (let i = 0; i < 4; i++)
    assert.equal(swapped[i], asBigEndian.getFloat64(i * 8, false));
  // Writing from a big-endian host must produce the little-endian layout.
  const nativeOnBigEndian = float64View(
    new Uint8Array(copyOfCanonical),
    0,
    4,
    false,
  ).view;
  assert.deepEqual(
    [...float64LittleEndianBytes(nativeOnBigEndian, false)],
    [...copyOfCanonical],
  );
});
