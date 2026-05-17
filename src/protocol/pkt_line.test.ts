import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describe, it } from "https://deno.land/std@0.224.0/testing/bdd.ts";
import { parsePktLines, pktLine } from "./pkt_line.ts";

describe("pktLine", () => {
  it("frames payloads", () => {
    const result = pktLine(new TextEncoder().encode("hi\n"));
    if (result.isErr()) throw result.error;
    assertEquals(new TextDecoder().decode(result.value), "0007hi\n");
  });
});

describe("parsePktLines", () => {
  it("parses payload and flush", () => {
    const bytes = new TextEncoder().encode("0007hi\n0000");
    const result = parsePktLines(bytes);
    if (result.isErr()) throw result.error;
    assertEquals(
      result.value.map((line) => line.payload && new TextDecoder().decode(line.payload)),
      ["hi\n", null],
    );
  });
});
