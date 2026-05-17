import { Result } from "better-result";
import type { PktLineError } from "../errors.ts";
import type { ParsedRefAdvertisement } from "../types.ts";
import { parsePktLines } from "./pkt_line.ts";

const decoder = new TextDecoder();

const COMMENT_LINE = 0x23; // '#'
const SPACE = 0x20;
const LF = 0x0a;
const SHA_LENGTH = 40;

function stripTrailingLf(payload: Uint8Array): Uint8Array {
  return payload.at(-1) === LF ? payload.subarray(0, payload.length - 1) : payload;
}

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
