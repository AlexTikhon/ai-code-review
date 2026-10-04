import { endianness } from "node:os";

/**
 * Binary layout of a vector blob (`vectors-<blobId>.bin`). All integers and
 * all numbers are little-endian, independent of the host:
 *
 *   offset  size  field
 *        0     8  magic "ACRVECS\0"
 *        8     4  u32 format version (1)
 *       12     4  u32 numeric encoding (1 = IEEE-754 binary64, little-endian)
 *       16     8  u64 total vector count across every space
 *       24     8  u64 payload byte length
 *       32    16  blob id (the 32 hex digits of the id, as raw bytes)
 *       48    16  reserved, must be zero
 *       64     .  payload: rows of float64, space after space, row after row
 *
 * The header is a multiple of 8 bytes, so a payload read into an 8-aligned
 * buffer is itself 8-aligned and can be viewed as a Float64Array without a
 * copy. Which rows belong to which embedding space, and which chunk input each
 * row is, lives in the validated metadata JSON, never in this file: the blob
 * holds numbers only, no text, keys or credentials.
 */
export const VECTOR_FILE_MAGIC = "ACRVECS\0";
export const VECTOR_FORMAT_VERSION = 1;
export const ENCODING_F64LE = 1;
export const VECTOR_HEADER_BYTES = 64;
export const BYTES_PER_VALUE = 8;

const HEX32 = /^[0-9a-f]{32}$/;

export type VectorFileHeader = {
  formatVersion: number;
  encoding: number;
  blobId: string;
  vectorCount: number;
  payloadBytes: number;
};

export function encodeVectorHeader(header: VectorFileHeader): Uint8Array {
  if (!HEX32.test(header.blobId)) throw new Error("invalid vector blob id");
  const bytes = new Uint8Array(VECTOR_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  bytes.set(Buffer.from(VECTOR_FILE_MAGIC, "latin1"), 0);
  view.setUint32(8, header.formatVersion, true);
  view.setUint32(12, header.encoding, true);
  view.setBigUint64(16, BigInt(header.vectorCount), true);
  view.setBigUint64(24, BigInt(header.payloadBytes), true);
  bytes.set(Buffer.from(header.blobId, "hex"), 32);
  return bytes;
}

export type HeaderResult =
  { ok: true; header: VectorFileHeader } | { ok: false; reason: string };

/** Parse and bound-check a header; the reason never echoes file content. */
export function decodeVectorHeader(bytes: Uint8Array): HeaderResult {
  if (bytes.byteLength < VECTOR_HEADER_BYTES)
    return { ok: false, reason: "vector file is shorter than its header" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    Buffer.from(bytes.subarray(0, 8)).toString("latin1") !== VECTOR_FILE_MAGIC
  )
    return { ok: false, reason: "not a vector file (bad magic)" };
  const formatVersion = view.getUint32(8, true);
  if (formatVersion !== VECTOR_FORMAT_VERSION)
    return {
      ok: false,
      reason: `unknown vector format version ${formatVersion}`,
    };
  const encoding = view.getUint32(12, true);
  if (encoding !== ENCODING_F64LE)
    return { ok: false, reason: `unknown numeric encoding ${encoding}` };
  const vectorCount = view.getBigUint64(16, true);
  const payloadBytes = view.getBigUint64(24, true);
  if (
    vectorCount > BigInt(Number.MAX_SAFE_INTEGER) ||
    payloadBytes > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return { ok: false, reason: "vector file header sizes are out of range" };
  if (bytes.subarray(48, 64).some((byte) => byte !== 0))
    return { ok: false, reason: "vector file reserved header bytes are set" };
  return {
    ok: true,
    header: {
      formatVersion,
      encoding,
      blobId: Buffer.from(bytes.subarray(32, 48)).toString("hex"),
      vectorCount: Number(vectorCount),
      payloadBytes: Number(payloadBytes),
    },
  };
}

export const hostIsLittleEndian = (): boolean => endianness() === "LE";

/** Reverse the bytes of every value in place; the host-order fix-up on big-endian machines. */
function swapBytes64(values: Float64Array): void {
  const bytes = new Uint8Array(
    values.buffer,
    values.byteOffset,
    values.byteLength,
  );
  for (let i = 0; i < bytes.length; i += 8)
    for (let a = i, b = i + 7; a < b; a++, b--) {
      const swap = bytes[a]!;
      bytes[a] = bytes[b]!;
      bytes[b] = swap;
    }
}

export type Float64ViewResult = { view: Float64Array; zeroCopy: boolean };

/**
 * Interpret `length` little-endian float64 values starting `byteOffset` into
 * `bytes` as numbers.
 *
 *  - Little-endian host, 8-aligned address: a Float64Array over the SAME memory.
 *    Nothing is copied; the view keeps `bytes`' buffer alive.
 *  - Misaligned address: the values are copied once into a fresh aligned array
 *    (a typed array may not start at an unaligned offset).
 *  - Big-endian host: the values are byte-swapped, which needs a writable
 *    private copy, so the view is a copy unless `bytes` is owned by the caller
 *    (it is swapped in place; `zeroCopy` is then still true).
 *
 * The result is decoded exactly: JS number -> bytes -> JS number is lossless.
 */
export function float64View(
  bytes: Uint8Array,
  byteOffset: number,
  length: number,
  littleEndianHost: boolean = hostIsLittleEndian(),
): Float64ViewResult {
  const byteLength = length * BYTES_PER_VALUE;
  if (
    !Number.isSafeInteger(byteOffset) ||
    byteOffset < 0 ||
    byteOffset + byteLength > bytes.byteLength
  )
    throw new Error("vector span is outside its buffer");
  const address = bytes.byteOffset + byteOffset;
  if (address % BYTES_PER_VALUE === 0) {
    const view = new Float64Array(bytes.buffer, address, length);
    if (!littleEndianHost) swapBytes64(view);
    return { view, zeroCopy: true };
  }
  const copy = new Float64Array(length);
  new Uint8Array(copy.buffer).set(
    bytes.subarray(byteOffset, byteOffset + byteLength),
  );
  if (!littleEndianHost) swapBytes64(copy);
  return { view: copy, zeroCopy: false };
}

/**
 * The little-endian bytes of `values`: a view of the same memory on a
 * little-endian host, a swapped copy otherwise. The caller must not mutate
 * `values` while the result is still being written.
 */
export function float64LittleEndianBytes(
  values: Float64Array,
  littleEndianHost: boolean = hostIsLittleEndian(),
): Uint8Array {
  if (littleEndianHost)
    return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  const copy = new Float64Array(values);
  swapBytes64(copy);
  return new Uint8Array(copy.buffer);
}
