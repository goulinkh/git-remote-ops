import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyDelta } from "./delta.js";

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
    assert.deepStrictEqual(new TextDecoder().decode(result.value), "hello world\n");
  });
});
