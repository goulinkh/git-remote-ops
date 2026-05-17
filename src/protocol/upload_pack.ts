import { Result } from "better-result";
import { PktLineError, UploadPackError } from "../errors.ts";
import { PACK_SIGNATURE } from "../pack/objects.ts";
import type { DiagnosticFn, FetchRequestOptions, SidebandData } from "../types.ts";
import { parsePktLines, pktLine } from "./pkt_line.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const BAND_PACK = 1;
const BAND_PROGRESS = 2;
const BAND_ERROR = 3;

const CONTROL_PREFIXES = ["shallow ", "unshallow ", "NAK", "ACK"];
const CONTROL_PREFIX_PEEK = 16;

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function buildFetchRequest(
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
  lines.push(encoder.encode("0000"));
  const done = pktLine(encoder.encode("done\n"));
  if (done.isErr()) return Result.err(done.error);
  lines.push(done.value);
  return Result.ok(concat(lines));
}

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

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
