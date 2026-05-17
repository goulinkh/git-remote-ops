import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Result } from "better-result";
import { pktLine } from "./pkt_line.js";
import { parseRefAdvertisement } from "./refs.js";

function unwrap<T, E>(result: Result<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}

describe("parseRefAdvertisement", () => {
  it("reads refs and capabilities", () => {
    const enc = new TextEncoder();
    const parts = [
      unwrap(pktLine(enc.encode("# service=git-upload-pack\n"))),
      enc.encode("0000"),
      unwrap(pktLine(
        enc.encode("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa HEAD\0multi_ack shallow filter\n"),
      )),
    ];
    const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      body.set(part, offset);
      offset += part.length;
    }
    const parsed = parseRefAdvertisement(body);
    if (parsed.isErr()) throw parsed.error;
    assert.deepStrictEqual(parsed.value.refs.get("HEAD"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.deepStrictEqual(parsed.value.capabilities.has("filter"), true);
  });
});
