import { Result } from "better-result";
import { PackParseError } from "../errors.ts";
import type { ReadResult } from "../types.ts";
import { VARINT_CONTINUE, VARINT_VALUE_MASK } from "./objects.ts";

const VARINT_VALUE_BITS = 7;

const DELTA_COPY_FLAG = 0x80;
const DELTA_COPY_OFFSET_BYTES = 4;
const DELTA_COPY_SIZE_BYTES = 3;
const DELTA_COPY_SIZE_SHIFT = 4;
const DELTA_DEFAULT_COPY_SIZE = 0x10000;

export function readVarintBe(
  data: Uint8Array,
  offset: number,
): Result<ReadResult<number>, PackParseError> {
  if (offset >= data.length) {
    return Result.err(
      new PackParseError({
        reason: "truncated-varint",
        message: "truncated varint",
        offset,
      }),
    );
  }

  let byte = data[offset++];
  let value = byte & VARINT_VALUE_MASK;
  while ((byte & VARINT_CONTINUE) !== 0) {
    if (offset >= data.length) {
      return Result.err(
        new PackParseError({
          reason: "truncated-varint",
          message: "truncated varint",
          offset,
        }),
      );
    }
    value += 1;
    byte = data[offset++];
    value = (value << VARINT_VALUE_BITS) | (byte & VARINT_VALUE_MASK);
  }
  return Result.ok({ value, offset });
}

export function applyDelta(
  base: Uint8Array,
  delta: Uint8Array,
): Result<Uint8Array, PackParseError> {
  let offset = 0;

  function readVarint(): Result<number, PackParseError> {
    let result = 0;
    let shift = 0;
    while (true) {
      if (offset >= delta.length) {
        return Result.err(
          new PackParseError({
            reason: "truncated-delta-varint",
            message: "truncated delta varint",
            offset,
          }),
        );
      }
      const byte = delta[offset++];
      result |= (byte & VARINT_VALUE_MASK) << shift;
      if ((byte & VARINT_CONTINUE) === 0) return Result.ok(result);
      shift += VARINT_VALUE_BITS;
    }
  }

  const sourceSize = readVarint();
  if (sourceSize.isErr()) return Result.err(sourceSize.error);
  const targetSize = readVarint();
  if (targetSize.isErr()) return Result.err(targetSize.error);

  const out = new Uint8Array(targetSize.value);
  let outOffset = 0;
  while (offset < delta.length) {
    const cmdOffset = offset;
    const cmd = delta[offset++];
    if ((cmd & DELTA_COPY_FLAG) !== 0) {
      let copyOffset = 0;
      let size = 0;
      for (let i = 0; i < DELTA_COPY_OFFSET_BYTES; i++) {
        if ((cmd & (1 << i)) !== 0) {
          if (offset >= delta.length) {
            return Result.err(
              new PackParseError({
                reason: "truncated-copy-offset",
                message: "truncated delta copy offset",
                offset,
              }),
            );
          }
          copyOffset |= delta[offset++] << (i * 8);
        }
      }
      for (let i = 0; i < DELTA_COPY_SIZE_BYTES; i++) {
        if ((cmd & (1 << (DELTA_COPY_SIZE_SHIFT + i))) !== 0) {
          if (offset >= delta.length) {
            return Result.err(
              new PackParseError({
                reason: "truncated-copy-size",
                message: "truncated delta copy size",
                offset,
              }),
            );
          }
          size |= delta[offset++] << (i * 8);
        }
      }
      if (size === 0) size = DELTA_DEFAULT_COPY_SIZE;
      if (copyOffset + size > base.length || outOffset + size > out.length) {
        return Result.err(
          new PackParseError({
            reason: "delta-copy-out-of-bounds",
            message: "delta copy exceeds source or target size",
            offset: cmdOffset,
          }),
        );
      }
      out.set(base.subarray(copyOffset, copyOffset + size), outOffset);
      outOffset += size;
    } else if (cmd !== 0) {
      if (offset + cmd > delta.length || outOffset + cmd > out.length) {
        return Result.err(
          new PackParseError({
            reason: "delta-insert-out-of-bounds",
            message: "delta insert exceeds source or target size",
            offset: cmdOffset,
          }),
        );
      }
      out.set(delta.subarray(offset, offset + cmd), outOffset);
      outOffset += cmd;
      offset += cmd;
    } else {
      return Result.err(
        new PackParseError({
          reason: "invalid-delta-opcode",
          message: "invalid delta opcode 0",
          offset: cmdOffset,
        }),
      );
    }
  }

  if (outOffset !== out.length) {
    return Result.err(
      new PackParseError({
        reason: "delta-target-size-mismatch",
        message: `delta produced ${outOffset} bytes, expected ${out.length}`,
        offset,
      }),
    );
  }

  return Result.ok(out);
}
