import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describe, it } from "https://deno.land/std@0.224.0/testing/bdd.ts";
import { parseTree } from "./tree.ts";

describe("parseTree", () => {
  it("reads entry", () => {
    const sha = new Uint8Array(20).fill(1);
    const prefix = new TextEncoder().encode("100644 file.txt\0");
    const content = new Uint8Array(prefix.length + sha.length);
    content.set(prefix);
    content.set(sha, prefix.length);
    const result = parseTree(content);
    if (result.isErr()) throw result.error;
    assertEquals(result.value, [{
      mode: "100644",
      name: "file.txt",
      sha: "0101010101010101010101010101010101010101",
    }]);
  });
});
