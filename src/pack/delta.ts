/**
 * @module pack-delta
 *
 * Pack format varint decoders and the Git delta reconstruction routine.
 *
 * Two varint flavours live in pack files. The "big-endian" form used by
 * `OBJ_OFS_DELTA` headers is decoded by {@link readVarintBe}; the
 * little-endian form used inside the delta opcode stream is handled inline
 * by {@link applyDelta}.
 *
 * Delta format spec: https://git-scm.com/docs/pack-format#_deltified_representation
 */
import { Result } from "better-result";
import { PackParseError } from "../errors.ts";
import type { ReadResult } from "../types.ts";
import { VARINT_CONTINUE, VARINT_VALUE_MASK } from "./objects.ts";

/** Bits of payload per varint byte. */
const VARINT_VALUE_BITS = 7;

/** High bit on a delta opcode byte → COPY instruction; otherwise INSERT. */
const DELTA_COPY_FLAG = 0x80;
/** Up to 4 bytes encode the copy offset (one per set bit in opcode low nibble). */
const DELTA_COPY_OFFSET_BYTES = 4;
/** Up to 3 bytes encode the copy size (one per set bit in opcode high nibble). */
const DELTA_COPY_SIZE_BYTES = 3;
/** Bit position of the first copy-size selector inside the opcode byte. */
const DELTA_COPY_SIZE_SHIFT = 4;
/** Special case: a copy with all size bytes absent means "copy 64 KiB". */
const DELTA_DEFAULT_COPY_SIZE = 0x10000;

/**
 * Decode Git's "offset-encoded" big-endian varint (used for `OBJ_OFS_DELTA`
 * base offsets).
 *
 * Each continuation byte adds an implicit `+1` before shifting, which lets the
 * encoding represent more values in the same number of bytes than a plain MSB
 * varint would.
 *
 * @returns `{ value, offset }` where `offset` points just past the last byte
 *   consumed, or {@link PackParseError} if the buffer ends mid-varint.
 */
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

/**
 * Reconstruct an object body from a delta against `base`.
 *
 * The delta stream begins with two little-endian varints (source size, target
 * size). Then a sequence of opcodes follows, each either:
 *
 *  - **COPY** (high bit set): copy a range from `base` into the output. The
 *    low nibble's set bits select which of up to 4 offset bytes follow; the
 *    next 3 bits select up to 3 size bytes. A size of 0 means 64 KiB.
 *  - **INSERT** (high bit clear, opcode `1..0x7f`): emit the next `opcode`
 *    bytes of the delta stream verbatim into the output.
 *  - opcode `0` is reserved and invalid.
 *
 * The source size is validated implicitly by every COPY's bounds check.
 *
 * @returns The fully reconstructed object, or {@link PackParseError} on any
 *   truncation, invalid opcode, or size mismatch.
 */
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
