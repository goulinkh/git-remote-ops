/**
 * @module refs
 *
 * Decoders for the two flavours of `info/refs` response Git can return for the
 * `git-upload-pack` service:
 *
 *  - **Protocol v0/v1** — a flat stream of `<sha> <ref>` pkt-lines where the
 *    first ref also carries a NUL-separated capability list.
 *  - **Protocol v2** — a capability advertisement (`version 2`, then one
 *    `key[=args]` pkt-line per capability).
 */
import { Result } from "better-result";
import type { PktLineError } from "../errors.js";
import type { ParsedRefAdvertisement } from "../types.js";
import { parsePktLines } from "./pkt_line.js";

const decoder = new TextDecoder();

/** ASCII `'#'` — leading byte of the optional `# service=...` banner line. */
const COMMENT_LINE = 0x23;
/** ASCII space separating sha from ref name. */
const SPACE = 0x20;
/** ASCII line-feed — trailing terminator on most advertisement lines. */
const LF = 0x0a;
/** Hex-encoded SHA-1 is always 40 chars. */
const SHA_LENGTH = 40;

function stripTrailingLf(payload: Uint8Array): Uint8Array {
  return payload.at(-1) === LF ? payload.subarray(0, payload.length - 1) : payload;
}

/**
 * Parse a v0/v1 ref advertisement (response body of
 * `GET /info/refs?service=git-upload-pack`).
 *
 * The first non-comment data line is special: its payload contains the ref
 * pair, a NUL byte, then a space-separated list of capabilities. Subsequent
 * lines are plain `<sha> <ref>\n` pairs.
 *
 * @param body Raw response bytes (including any `# service=...` banner).
 * @returns The advertised refs (name → sha) and capabilities, or
 *   {@link PktLineError} if the pkt-line framing is malformed.
 */
export function parseRefAdvertisement(
  body: Uint8Array,
): Result<ParsedRefAdvertisement, PktLineError> {
  const refs = new Map<string, string>();
  const capabilities = new Set<string>();
  let firstRef = true;

  const lines = parsePktLines(body);
  if (lines.isErr()) return Result.err(lines.error);
  for (const { payload } of lines.value) {
    if (payload === null || payload.length === 0 || payload[0] === COMMENT_LINE) {
      continue;
    }
    let line = stripTrailingLf(payload);
    if (firstRef) {
      const nul = line.indexOf(0);
      if (nul >= 0) {
        const capText = decoder.decode(line.subarray(nul + 1));
        for (const cap of capText.split(/\s+/).filter(Boolean)) {
          capabilities.add(cap);
        }
        line = line.subarray(0, nul);
      }
    }
    if (line.length >= SHA_LENGTH + 1 && line[SHA_LENGTH] === SPACE) {
      refs.set(
        decoder.decode(line.subarray(SHA_LENGTH + 1)),
        decoder.decode(line.subarray(0, SHA_LENGTH)),
      );
      firstRef = false;
    }
  }

  return Result.ok({ refs, capabilities });
}

/**
 * Parse a v2 capability advertisement.
 *
 * The first data line is always `version 2`; we encode that as the synthetic
 * capability `"version=2"` so callers can detect protocol v2 with a single
 * lookup. For the `fetch` capability, any space-separated arguments (e.g.
 * `shallow`, `filter`, `wait-for-done`) are added as separate set entries.
 *
 * @param body Raw response bytes from the `git-upload-pack` advertisement.
 * @returns Set of capability tokens, or {@link PktLineError} on bad framing.
 */
export function parseV2CapabilityAdvertisement(
  body: Uint8Array,
): Result<Set<string>, PktLineError> {
  const capabilities = new Set<string>();
  const lines = parsePktLines(body);
  if (lines.isErr()) return Result.err(lines.error);
  for (const { payload } of lines.value) {
    if (payload === null || payload.length === 0 || payload[0] === COMMENT_LINE) {
      continue;
    }
    const line = decoder.decode(stripTrailingLf(payload));
    if (line === "version 2") {
      capabilities.add("version=2");
      continue;
    }
    const [name, args] = line.split("=", 2);
    capabilities.add(name);
    if (name === "fetch" && args) {
      for (const arg of args.split(/\s+/).filter(Boolean)) capabilities.add(arg);
    }
  }
  return Result.ok(capabilities);
}
