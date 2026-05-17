import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePktLines, pktLine } from "./pkt_line.js";

describe("pktLine", () => {
  it("frames payloads", () => {
    const result = pktLine(new TextEncoder().encode("hi\n"));
    if (result.isErr()) throw result.error;
    assert.deepStrictEqual(new TextDecoder().decode(result.value), "0007hi\n");
  });
});

describe("parsePktLines", () => {
  it("parses payload and flush", () => {
    const bytes = new TextEncoder().encode("0007hi\n0000");
    const result = parsePktLines(bytes);
    if (result.isErr()) throw result.error;
    assert.deepStrictEqual(
      result.value.map((line) => line.payload && new TextDecoder().decode(line.payload)),
      ["hi\n", null],
    );
  });
});
