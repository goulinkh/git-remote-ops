import { Result } from "better-result";
import { inflateSync } from "node:zlib";
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

const TYPE_FIELD_MASK = 0x07;
const TYPE_FIELD_SHIFT = 4;
const SIZE_LOW_NIBBLE_MASK = 0x0f;
const SIZE_LOW_NIBBLE_BITS = 4;
const VARINT_VALUE_BITS = 7;

const REF_DELTA_SHA_SIZE = 20;
const VERSION_OFFSET = 4;
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

export function decompressAt(
  data: Uint8Array,
  offset: number,
  expectedSize?: number,
): Result<ReadResult<Uint8Array>, PackParseError> {
  const max = Math.max(offset + 2, data.length - PACK_TRAILER_SIZE);
  for (let end = offset + 2; end <= max; end++) {
    try {
      const value = new Uint8Array(inflateSync(data.subarray(offset, end)));
      if (expectedSize === undefined || value.length === expectedSize) {
        return Result.ok({ value, offset: end });
      }
    } catch {
      // try longer zlib stream
    }
  }

  const fallback = Result.try({
    try: () => new Uint8Array(inflateSync(data.subarray(offset))),
    catch: (cause) =>
      new PackParseError({
        reason: "inflate-failed",
        message: "failed to inflate pack object",
        offset,
        cause,
      }),
  });
  if (fallback.isErr()) return Result.err(fallback.error);
  if (expectedSize !== undefined && fallback.value.length !== expectedSize) {
    return Result.err(
      new PackParseError({
        reason: "inflated-size-mismatch",
        message: `object inflated to ${fallback.value.length} bytes, expected ${expectedSize}`,
        offset,
      }),
    );
  }
  return Result.ok({ value: fallback.value, offset: data.length });
}

export function parsePackfile(pack: Uint8Array): Result<GitObjectMap, PackParseError> {
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
  ): Result<void, PackParseError> {
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
    return Result.ok();
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
