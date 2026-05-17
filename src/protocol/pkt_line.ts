import { Result } from "better-result";
import { PktLineError } from "../errors.ts";
import type { PktLine } from "../types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const LF = 0x0a;

const PKT_LENGTH_PREFIX_SIZE = 4;
const PKT_LENGTH_HEX_BASE = 16;
const MAX_PKT_LINE_LENGTH = 0xffff;

const FLUSH_PKT_LENGTH = 0;
const DELIM_PKT_LENGTH = 1;
const RESPONSE_END_PKT_LENGTH = 2;

export const FLUSH_PKT = encoder.encode("0000");
export const DELIM_PKT = encoder.encode("0001");
export const RESPONSE_END_PKT = encoder.encode("0002");

export function pktLine(payload: Uint8Array): Result<Uint8Array, PktLineError> {
  if (payload.length === 0) {
    return Result.ok(FLUSH_PKT);
  }
  const length = payload.length + PKT_LENGTH_PREFIX_SIZE;
  if (length > MAX_PKT_LINE_LENGTH) {
    return Result.err(
      new PktLineError({
        reason: "pkt-line-too-long",
        message: `pkt-line too long: ${length}`,
      }),
    );
  }
  const prefix = encoder.encode(
    length.toString(PKT_LENGTH_HEX_BASE).padStart(PKT_LENGTH_PREFIX_SIZE, "0"),
  );
  const out = new Uint8Array(length);
  out.set(prefix, 0);
  out.set(payload, PKT_LENGTH_PREFIX_SIZE);
  return Result.ok(out);
}

export function parsePktLines(
  buf: Uint8Array,
  offset = 0,
): Result<PktLine[], PktLineError> {
  const lines: PktLine[] = [];
  while (offset + PKT_LENGTH_PREFIX_SIZE <= buf.length) {
    const lengthOffset = offset;
    const lengthHex = decoder.decode(buf.subarray(offset, offset + PKT_LENGTH_PREFIX_SIZE));
    const length = Number.parseInt(lengthHex, PKT_LENGTH_HEX_BASE);
    if (!Number.isFinite(length) || !/^[0-9a-fA-F]{4}$/.test(lengthHex)) {
      return Result.err(
        new PktLineError({
          reason: "invalid-length-prefix",
          message: `invalid pkt-line length: ${lengthHex}`,
          offset: lengthOffset,
        }),
      );
    }
    if (
      length === FLUSH_PKT_LENGTH || length === DELIM_PKT_LENGTH ||
      length === RESPONSE_END_PKT_LENGTH
    ) {
      offset += PKT_LENGTH_PREFIX_SIZE;
      lines.push({ offset, payload: null });
      continue;
    }
    if (length < PKT_LENGTH_PREFIX_SIZE || offset + length > buf.length) {
      return Result.err(
        new PktLineError({
          reason: "truncated-pkt-line",
          message: `truncated pkt-line length ${length}`,
          offset: lengthOffset,
        }),
      );
    }
    let payload = buf.subarray(offset + PKT_LENGTH_PREFIX_SIZE, offset + length);
    if (payload.at(-1) === LF) {
      payload = payload.subarray(0, payload.length - 1);
    }
    offset += length;
    lines.push({ offset, payload });
  }
  return Result.ok(lines);
}
