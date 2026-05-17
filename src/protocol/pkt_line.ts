/**
 * @module pkt-line
 *
 * Encode/decode Git's framing format. A pkt-line is a 4-byte ASCII-hex length
 * prefix followed by `length - 4` payload bytes. Three reserved length values
 * carry no payload and act as control markers (flush / delim / response-end).
 *
 * Spec: https://git-scm.com/docs/protocol-common
 */
import { Result } from "better-result";
import { PktLineError } from "../errors.ts";
import type { PktLine } from "../types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Width of the ASCII-hex length prefix that opens every pkt-line. */
const PKT_LENGTH_PREFIX_SIZE = 4;
/** Numeric base for the length prefix (lowercase hex). */
const PKT_LENGTH_HEX_BASE = 16;
/** Hard cap on total pkt-line size (length prefix + payload) per the spec. */
const MAX_PKT_LINE_LENGTH = 0xffff;

/** Sentinel length signalling end-of-section. Payload is empty. */
const FLUSH_PKT_LENGTH = 0;
/** Sentinel length separating header from body in protocol v2 requests. */
const DELIM_PKT_LENGTH = 1;
/** Sentinel length marking the end of a v2 response stream. */
const RESPONSE_END_PKT_LENGTH = 2;

/** Encoded `"0000"` flush packet — closes a section in v0 and v2. */
export const FLUSH_PKT = encoder.encode("0000");
/** Encoded `"0001"` delim packet — only valid in protocol v2. */
export const DELIM_PKT = encoder.encode("0001");
/** Encoded `"0002"` response-end packet — only valid in protocol v2. */
export const RESPONSE_END_PKT = encoder.encode("0002");

/**
 * Wrap `payload` in a pkt-line frame.
 *
 * An empty payload returns the flush packet rather than a 4-byte zero-length
 * frame, matching `git`'s convention.
 *
 * @param payload Raw bytes to frame. Pass any trailing `\n` you want preserved.
 * @returns The framed bytes, or {@link PktLineError} if the total would exceed
 *   {@link MAX_PKT_LINE_LENGTH}.
 */
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

/**
 * Decode a sequence of pkt-lines from `buf`.
 *
 * Returns one entry per frame. Control packets (flush/delim/response-end) have
 * `payload: null`. Data packets expose `payload` as a subarray view into `buf` —
 * no bytes are copied. Trailing `\n` bytes inside payloads are preserved; callers
 * that want them stripped must do so explicitly.
 *
 * @param buf Bytes containing zero or more concatenated pkt-lines.
 * @param offset Starting byte index in `buf` (default `0`).
 * @returns The decoded frames in order, or {@link PktLineError} on a bad length
 *   prefix or a frame that runs past `buf`'s end.
 */
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
    const payload = buf.subarray(offset + PKT_LENGTH_PREFIX_SIZE, offset + length);
    offset += length;
    lines.push({ offset, payload });
  }
  return Result.ok(lines);
}
