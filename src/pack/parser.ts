/**
 * @module pack-parser
 *
 * Decode an in-memory packfile into a `sha → GitObject` map.
 *
 * The parser handles the four loose-object types directly and resolves both
 * delta encodings (`OBJ_OFS_DELTA`, `OBJ_REF_DELTA`) by applying
 * {@link applyDelta} against bases discovered earlier in the same pack. Ref
 * deltas whose bases haven't appeared yet are deferred and retried in fixed
 * point until every delta resolves or progress stalls.
 *
 * Optimization: passing a `targets` set lets the parser bail out as soon as
 * every requested SHA has been materialized — useful for "fetch one object"
 * paths where the server may have sent a much larger pack.
 *
 * zlib note: we reach into `node:zlib`'s `_processChunk` to learn exactly how
 * many compressed input bytes were consumed. The public Streams API doesn't
 * expose that, and parsing the next object requires knowing where the current
 * one's compressed run ends.
 */
import { Result } from "better-result";
import zlib from "node:zlib";
import { Buffer } from "node:buffer";
import { encodeHex } from "@std/encoding/hex";
import { PackParseError } from "../errors.ts";
import type {
  GitObject,
  GitObjectMap,
  GitObjectType,
  PackObjectHeader,
  ReadResult,
} from "../types.ts";
import { applyDelta, readVarintBe } from "./delta.ts";
import {
  OBJ_NAMES,
  OBJ_OFS_DELTA,
  OBJ_REF_DELTA,
  OBJ_TYPES,
  PACK_HEADER_SIZE,
  PACK_SIGNATURE,
  PACK_SIGNATURE_SIZE,
  PACK_TRAILER_SIZE,
  sha1OfObject,
  SUPPORTED_PACK_VERSIONS,
  VARINT_CONTINUE,
  VARINT_VALUE_MASK,
} from "./objects.ts";

/** Mask for the 3-bit object type field in the first header byte. */
const TYPE_FIELD_MASK = 0x07;
/** Shift to bring the type field into the low bits. */
const TYPE_FIELD_SHIFT = 4;
/** Mask for the size bits in the first header byte (bottom 4 bits). */
const SIZE_LOW_NIBBLE_MASK = 0x0f;
/** Bit width of those size bits. */
const SIZE_LOW_NIBBLE_BITS = 4;
/** Bit width of each subsequent varint byte's payload. */
const VARINT_VALUE_BITS = 7;

/** Raw 20-byte SHA-1 inline-prefixed on every `OBJ_REF_DELTA`. */
const REF_DELTA_SHA_SIZE = 20;
/** Offset of the big-endian pack version word inside the 12-byte header. */
const VERSION_OFFSET = 4;
/** Offset of the big-endian object count word inside the 12-byte header. */
const COUNT_OFFSET = 8;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function typeNumberOf(type: GitObjectType): Result<number, PackParseError> {
  const num = OBJ_TYPES.get(type);
  if (num === undefined) {
    return Result.err(
      new PackParseError({
        reason: "unknown-base-object-type",
        message: `unknown base object type ${type}`,
      }),
    );
  }
  return Result.ok(num);
}

interface RefDelta {
  offset: number;
  baseSha: string;
  delta: Uint8Array;
}

/**
 * Decode a single pack-entry header starting at `offset`.
 *
 * Format: one byte holds `[MSB | type:3 | size_lo:4]`. While MSB is set,
 * each additional byte contributes 7 more size bits. Returns the parsed
 * type code, uncompressed size, and the offset just past the header.
 */
export function readPackObjectHeader(
  data: Uint8Array,
  offset: number,
): Result<PackObjectHeader, PackParseError> {
  if (offset >= data.length) {
    return Result.err(
      new PackParseError({
        reason: "truncated-object-header",
        message: "truncated pack object header",
        offset,
      }),
    );
  }
  let byte = data[offset++];
  const type = (byte >> TYPE_FIELD_SHIFT) & TYPE_FIELD_MASK;
  let size = byte & SIZE_LOW_NIBBLE_MASK;
  let shift = SIZE_LOW_NIBBLE_BITS;
  while ((byte & VARINT_CONTINUE) !== 0) {
    if (offset >= data.length) {
      return Result.err(
        new PackParseError({
          reason: "truncated-object-header",
          message: "truncated pack object header",
          offset,
        }),
      );
    }
    byte = data[offset++];
    size |= (byte & VARINT_VALUE_MASK) << shift;
    shift += VARINT_VALUE_BITS;
  }
  return Result.ok({ type, size, offset });
}

interface InflateEngine {
  _processChunk(chunk: Buffer, flushFlag: number): Buffer;
  bytesWritten: number;
  close(): void;
}

/**
 * Inflate one zlib stream embedded in the pack at `offset`.
 *
 * The pack's 20-byte trailer is sliced off before inflation so the deflate
 * engine never sees it. `bytesWritten` on the `Inflate` engine reports how
 * many input bytes were consumed, which is the only reliable way to advance
 * `offset` to the next entry — multiple deflate streams sit back-to-back
 * inside the pack and there's no length prefix at this layer.
 *
 * @param expectedSize Uncompressed size reported by the object header. When
 *   provided, used to right-size the inflate chunk buffer and to assert the
 *   output length post-hoc.
 */
export function decompressAt(
  data: Uint8Array,
  offset: number,
  expectedSize?: number,
): Result<ReadResult<Uint8Array>, PackParseError> {
  const slice = data.subarray(offset, data.length - PACK_TRAILER_SIZE);
  const input = Buffer.from(slice);
  const engine = new (zlib as unknown as {
    Inflate: new (opts: { chunkSize?: number }) => InflateEngine;
  }).Inflate({
    chunkSize: expectedSize !== undefined ? Math.max(expectedSize + 16, 1024) : 16384,
  });
  let output: Buffer;
  try {
    output = engine._processChunk(input, zlib.constants.Z_FINISH);
  } catch (cause) {
    engine.close();
    return Result.err(
      new PackParseError({
        reason: "inflate-failed",
        message: `failed to inflate pack object: ${(cause as Error)?.message ?? cause}`,
        offset,
        cause,
      }),
    );
  }
  const consumed = engine.bytesWritten;
  engine.close();
  if (expectedSize !== undefined && output.length !== expectedSize) {
    return Result.err(
      new PackParseError({
        reason: "inflated-size-mismatch",
        message: `object inflated to ${output.length} bytes, expected ${expectedSize}`,
        offset,
      }),
    );
  }
  const value = new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
  return Result.ok({ value, offset: offset + consumed });
}

/**
 * Walk every entry in `pack` and return a map of resolved objects keyed by
 * SHA-1.
 *
 * For non-delta entries, the inflated bytes are hashed and stored. For
 * `OBJ_OFS_DELTA` the base is looked up via `byOffset` (always present, since
 * pack ordering guarantees the base appears earlier in the stream). For
 * `OBJ_REF_DELTA` the base may be either earlier or later — unresolved ones
 * accumulate in `pendingRefDeltas` and are retried until either all resolve
 * or a pass makes no progress (cyclic / out-of-pack reference).
 *
 * @param targets Optional set of "wanted" SHAs. If supplied, the parser
 *   returns as soon as every target has been materialized — even mid-pack.
 */
export function parsePackfile(
  pack: Uint8Array,
  targets?: ReadonlySet<string>,
): Result<GitObjectMap, PackParseError> {
  if (pack.length < PACK_HEADER_SIZE + PACK_TRAILER_SIZE) {
    return Result.err(
      new PackParseError({
        reason: "truncated-packfile",
        message: "packfile too small",
        offset: 0,
      }),
    );
  }

  const signature = pack.subarray(0, PACK_SIGNATURE_SIZE);
  if (!bytesEqual(signature, PACK_SIGNATURE)) {
    return Result.err(
      new PackParseError({
        reason: "invalid-signature",
        message: `not a packfile, starts with ${Array.from(signature).join(",")}`,
        offset: 0,
      }),
    );
  }
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = view.getUint32(VERSION_OFFSET);
  const count = view.getUint32(COUNT_OFFSET);
  if (!SUPPORTED_PACK_VERSIONS.has(version)) {
    return Result.err(
      new PackParseError({
        reason: "unsupported-version",
        message: `unsupported pack version ${version}`,
        offset: VERSION_OFFSET,
      }),
    );
  }

  const bySha = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = PACK_HEADER_SIZE;
  let pendingRefDeltas: RefDelta[] = [];

  function store(
    typeNumber: number,
    content: Uint8Array,
    objectOffset: number,
  ): Result<string, PackParseError> {
    const type = OBJ_NAMES.get(typeNumber);
    if (!type) {
      return Result.err(
        new PackParseError({
          reason: "unknown-object-type",
          message: `unknown object type ${typeNumber}`,
          offset: objectOffset,
        }),
      );
    }
    const sha = sha1OfObject(typeNumber, content);
    if (sha.isErr()) return Result.err(sha.error);
    const object = { type, content };
    bySha.set(sha.value, object);
    byOffset.set(objectOffset, object);
    return Result.ok(sha.value);
  }

  function foundTargets(): boolean {
    return targets !== undefined && [...targets].every((sha) => bySha.has(sha));
  }

  for (let i = 0; i < count; i++) {
    const objectOffset = offset;
    const header = readPackObjectHeader(pack, offset);
    if (header.isErr()) return Result.err(header.error);
    offset = header.value.offset;
    if (OBJ_NAMES.has(header.value.type)) {
      const result = decompressAt(pack, offset, header.value.size);
      if (result.isErr()) return Result.err(result.error);
      const stored = store(header.value.type, result.value.value, objectOffset);
      if (stored.isErr()) return Result.err(stored.error);
      if (foundTargets()) return Result.ok(bySha);
      offset = result.value.offset;
    } else if (header.value.type === OBJ_OFS_DELTA) {
      const varint = readVarintBe(pack, offset);
      if (varint.isErr()) return Result.err(varint.error);
      offset = varint.value.offset;
      const base = byOffset.get(objectOffset - varint.value.value);
      if (!base) {
        return Result.err(
          new PackParseError({
            reason: "unresolved-ofs-delta-base",
            message: "unresolved ofs-delta base object",
            offset: objectOffset,
          }),
        );
      }
      const result = decompressAt(pack, offset, header.value.size);
      if (result.isErr()) return Result.err(result.error);
      const applied = applyDelta(base.content, result.value.value);
      if (applied.isErr()) return Result.err(applied.error);
      const typeNumber = typeNumberOf(base.type);
      if (typeNumber.isErr()) return Result.err(typeNumber.error);
      const stored = store(typeNumber.value, applied.value, objectOffset);
      if (stored.isErr()) return Result.err(stored.error);
      if (foundTargets()) return Result.ok(bySha);
      offset = result.value.offset;
    } else if (header.value.type === OBJ_REF_DELTA) {
      if (offset + REF_DELTA_SHA_SIZE > pack.length) {
        return Result.err(
          new PackParseError({
            reason: "truncated-ref-delta-base",
            message: "truncated ref-delta base sha",
            offset,
          }),
        );
      }
      const baseSha = encodeHex(pack.subarray(offset, offset + REF_DELTA_SHA_SIZE));
      offset += REF_DELTA_SHA_SIZE;
      const result = decompressAt(pack, offset, header.value.size);
      if (result.isErr()) return Result.err(result.error);
      pendingRefDeltas.push({ offset: objectOffset, baseSha, delta: result.value.value });
      offset = result.value.offset;
    } else {
      return Result.err(
        new PackParseError({
          reason: "unknown-object-type",
          message: `unknown object type ${header.value.type}`,
          offset: objectOffset,
        }),
      );
    }
  }

  while (pendingRefDeltas.length > 0) {
    const remaining: RefDelta[] = [];
    let resolved = 0;
    for (const delta of pendingRefDeltas) {
      const base = bySha.get(delta.baseSha);
      if (!base) {
        remaining.push(delta);
        continue;
      }
      const applied = applyDelta(base.content, delta.delta);
      if (applied.isErr()) return Result.err(applied.error);
      const typeNumber = typeNumberOf(base.type);
      if (typeNumber.isErr()) return Result.err(typeNumber.error);
      const stored = store(typeNumber.value, applied.value, delta.offset);
      if (stored.isErr()) return Result.err(stored.error);
      if (foundTargets()) return Result.ok(bySha);
      resolved++;
    }
    if (resolved === 0) {
      return Result.err(
        new PackParseError({
          reason: "unresolved-ref-delta-base",
          message: `unresolved ref-delta base object(s): ${
            remaining.map((item) => item.baseSha).slice(0, 3).join(", ")
          }`,
        }),
      );
    }
    pendingRefDeltas = remaining;
  }

  return Result.ok(bySha);
}
