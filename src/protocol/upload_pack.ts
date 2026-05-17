/**
 * @module upload-pack
 *
 * Build `git-upload-pack` request bodies (protocol v0 and v2) and demux the
 * sideband-multiplexed response back into a raw packfile.
 *
 * Sideband framing: each data pkt-line is prefixed by a single byte channel
 * marker — `1` packfile bytes, `2` human-readable progress, `3` fatal error
 * text. The packfile itself is the concatenation of all channel-1 payloads.
 */
import { Result } from "better-result";
import { readFile, writeFile } from "node:fs/promises";
import { PktLineError, UploadPackError } from "../errors.js";
import { PACK_SIGNATURE } from "../pack/objects.js";
import type { DiagnosticFn, FetchRequestOptions, SidebandData } from "../types.js";
import { DELIM_PKT, FLUSH_PKT, parsePktLines, pktLine } from "./pkt_line.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
type Bytes = Uint8Array<ArrayBufferLike>;

/** Sideband channel for packfile bytes. */
const BAND_PACK = 1;
/** Sideband channel for human-readable progress messages. */
const BAND_PROGRESS = 2;
/** Sideband channel for fatal error text. */
const BAND_ERROR = 3;

/**
 * Pkt-line payload prefixes that mark control / framing lines, not packfile
 * data. Used to skip past the v2 section headers (`packfile\n` etc.) when
 * hunting for the first real data line.
 */
const CONTROL_PREFIXES = [
  "version 2",
  "shallow-info",
  "wanted-refs",
  "packfile",
  "shallow ",
  "unshallow ",
  "NAK",
  "ACK",
];
/** Bytes of payload to peek at when matching against {@link CONTROL_PREFIXES}. */
const CONTROL_PREFIX_PEEK = 16;

function concat(parts: Bytes[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Build the POST body for `/git-upload-pack`. Dispatches to a v0 or v2 encoder
 * based on `options.protocolVersion` (defaults to v0).
 *
 * @returns Encoded request bytes, or {@link PktLineError} if any inner frame
 *   exceeds the pkt-line size cap.
 */
export function buildFetchRequest(
  options: FetchRequestOptions,
): Result<Uint8Array, PktLineError> {
  return options.protocolVersion === 2
    ? buildV2FetchRequest(options)
    : buildV0FetchRequest(options);
}

/**
 * Encode a v0 fetch request: one `want <sha>` per oid (capabilities ride on
 * the first `want` line, space-separated after the sha), optional `deepen`
 * and `filter` lines, a flush, then `done`.
 */
function buildV0FetchRequest(
  options: FetchRequestOptions,
): Result<Uint8Array, PktLineError> {
  const lines: Uint8Array[] = [];
  for (let index = 0; index < options.wants.length; index++) {
    const sha = options.wants[index];
    const caps = index === 0 && options.caps.length > 0 ? ` ${options.caps.join(" ")}` : "";
    const line = pktLine(encoder.encode(`want ${sha}${caps}\n`));
    if (line.isErr()) return Result.err(line.error);
    lines.push(line.value);
  }
  if (options.depth !== undefined) {
    const line = pktLine(encoder.encode(`deepen ${options.depth}\n`));
    if (line.isErr()) return Result.err(line.error);
    lines.push(line.value);
  }
  if (options.filterSpec !== undefined) {
    const line = pktLine(encoder.encode(`filter ${options.filterSpec}\n`));
    if (line.isErr()) return Result.err(line.error);
    lines.push(line.value);
  }
  lines.push(FLUSH_PKT);
  const done = pktLine(encoder.encode("done\n"));
  if (done.isErr()) return Result.err(done.error);
  lines.push(done.value);
  return Result.ok(concat(lines));
}

/**
 * Encode a v2 fetch command. Header section carries `command=fetch` and an
 * `agent=` string, separated from the argument section by a delim packet.
 * The argument section lists transport hints (`thin-pack`, `ofs-delta`),
 * `want` lines, optional `deepen`/`filter`, then `done` and a flush.
 */
function buildV2FetchRequest(
  options: FetchRequestOptions,
): Result<Uint8Array, PktLineError> {
  const lines: Uint8Array[] = [];
  for (const text of ["command=fetch\n", "agent=git-remote-ops/0.1\n"]) {
    const line = pktLine(encoder.encode(text));
    if (line.isErr()) return Result.err(line.error);
    lines.push(line.value);
  }
  lines.push(DELIM_PKT);
  for (const text of ["thin-pack\n", "ofs-delta\n"]) {
    const line = pktLine(encoder.encode(text));
    if (line.isErr()) return Result.err(line.error);
    lines.push(line.value);
  }
  for (const sha of options.wants) {
    const line = pktLine(encoder.encode(`want ${sha}\n`));
    if (line.isErr()) return Result.err(line.error);
    lines.push(line.value);
  }
  if (options.depth !== undefined) {
    const line = pktLine(encoder.encode(`deepen ${options.depth}\n`));
    if (line.isErr()) return Result.err(line.error);
    lines.push(line.value);
  }
  if (options.filterSpec !== undefined) {
    const line = pktLine(encoder.encode(`filter ${options.filterSpec}\n`));
    if (line.isErr()) return Result.err(line.error);
    lines.push(line.value);
  }
  const done = pktLine(encoder.encode("done\n"));
  if (done.isErr()) return Result.err(done.error);
  lines.push(done.value, FLUSH_PKT);
  return Result.ok(concat(lines));
}

/**
 * Demultiplex sideband-framed `git-upload-pack` response bytes into three
 * channel-segregated streams (pack / progress / errors). All payloads from a
 * given channel are concatenated in order.
 *
 * Inputs that lack a sideband framing byte are dropped — callers needing the
 * non-sideband path should use {@link extractPack}.
 */
export function demuxSideband(body: Uint8Array): Result<SidebandData, PktLineError> {
  const packChunks: Uint8Array[] = [];
  const progressChunks: Uint8Array[] = [];
  const errorChunks: Uint8Array[] = [];

  const lines = parsePktLines(body);
  if (lines.isErr()) return Result.err(lines.error);
  for (const { payload } of lines.value) {
    if (payload === null || payload.length === 0) continue;
    const data = payload.subarray(1);
    switch (payload[0]) {
      case BAND_PACK:
        packChunks.push(data);
        break;
      case BAND_PROGRESS:
        progressChunks.push(data);
        break;
      case BAND_ERROR:
        errorChunks.push(data);
        break;
    }
  }

  return Result.ok({
    pack: concat(packChunks),
    progress: concat(progressChunks),
    errors: concat(errorChunks),
  });
}

function findFirstDataPktLine(
  response: Uint8Array,
): Result<{ payload: Uint8Array; bodyOffset: number }, PktLineError | UploadPackError> {
  let previousOffset = 0;
  const lines = parsePktLines(response);
  if (lines.isErr()) return Result.err(lines.error);
  for (const { offset, payload } of lines.value) {
    if (payload === null) {
      previousOffset = offset;
      continue;
    }
    const head = decoder.decode(payload.subarray(0, Math.min(payload.length, CONTROL_PREFIX_PEEK)));
    if (CONTROL_PREFIXES.some((prefix) => head.startsWith(prefix))) {
      previousOffset = offset;
      continue;
    }
    return Result.ok({ payload, bodyOffset: previousOffset });
  }
  return Result.err(
    new UploadPackError({
      reason: "missing-data-pkt-line",
      message: "no data in upload-pack response",
    }),
  );
}

/**
 * Pull the packfile bytes out of a `git-upload-pack` response.
 *
 * Walks pkt-lines until it finds the first non-control data line and then
 * picks the right strategy:
 *
 *  1. raw `PACK` signature inline — slice from there to end-of-buffer;
 *  2. sideband byte (1/2/3) prefix — demux and return channel 1;
 *  3. no framed data at all — fall back to a byte-level `PACK` search.
 *
 * @param response Raw HTTP response body.
 * @param diagnostic Optional sink for non-fatal server stderr (channel 3).
 */
export function extractPack(
  response: Uint8Array,
  diagnostic?: DiagnosticFn,
): Result<Uint8Array, PktLineError | UploadPackError> {
  const first = findFirstDataPktLine(response);

  if (first.isErr()) {
    if (first.error._tag === "UploadPackError" && first.error.reason === "missing-data-pkt-line") {
      const idx = indexOfBytes(response, PACK_SIGNATURE);
      if (idx >= 0) return Result.ok(response.subarray(idx));
    }
    return Result.err(first.error);
  }

  const { payload, bodyOffset } = first.value;

  if (startsWith(payload, PACK_SIGNATURE)) {
    return Result.ok(response.subarray(bodyOffset + PACK_SIGNATURE.length));
  }
  if (payload[0] === BAND_PACK || payload[0] === BAND_PROGRESS || payload[0] === BAND_ERROR) {
    const data = demuxSideband(response.subarray(bodyOffset));
    if (data.isErr()) return Result.err(data.error);
    if (data.value.errors.length > 0) {
      diagnostic?.(`server stderr: ${decoder.decode(data.value.errors)}`);
    }
    return Result.ok(data.value.pack);
  }
  return Result.err(
    new UploadPackError({
      reason: "unrecognized-data-pkt-line",
      message: `unrecognized data pkt-line (starts with ${
        Array.from(payload.subarray(0, 8)).join(",")
      })`,
    }),
  );
}

export async function extractPackToFile(
  srcPath: string,
  destPath: string,
  diagnostic?: DiagnosticFn,
): Promise<Result<number, PktLineError | UploadPackError>> {
  const pack = extractPack(new Uint8Array(await readFile(srcPath)), diagnostic);
  if (pack.isErr()) return Result.err(pack.error);
  await writeFile(destPath, pack.value);
  return Result.ok(pack.value.length);
}

function startsWith(bytes: Bytes, prefix: Bytes): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function indexOfBytes(haystack: Bytes, needle: Bytes): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
