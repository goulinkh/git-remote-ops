import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describe, it } from "https://deno.land/std@0.224.0/testing/bdd.ts";
import { applyDelta } from "./delta.ts";

describe("applyDelta", () => {
  it("handles copy and insert", () => {
    const base = new TextEncoder().encode("hello ");
    const delta = new Uint8Array([
      0x06,
      0x0c,
      0x90,
      0x06,
      0x06,
      ...new TextEncoder().encode("world\n"),
    ]);
    const result = applyDelta(base, delta);
    if (result.isErr()) throw result.error;
    assertEquals(new TextDecoder().decode(result.value), "hello world\n");
  });
});
