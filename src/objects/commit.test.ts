import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describe, it } from "https://deno.land/std@0.224.0/testing/bdd.ts";
import { parseCommit } from "./commit.ts";

describe("parseCommit", () => {
  it("reads first tree", () => {
    const commit = parseCommit(new TextEncoder().encode("tree abc\nparent def\n\nmessage\n"));
    if (commit.isErr()) throw commit.error;
    assertEquals(commit.value.tree, "abc");
  });
});
