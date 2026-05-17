import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommit } from "./commit.js";

describe("parseCommit", () => {
  it("reads first tree", () => {
    const commit = parseCommit(new TextEncoder().encode("tree abc\nparent def\n\nmessage\n"));
    if (commit.isErr()) throw commit.error;
    assert.deepStrictEqual(commit.value.tree, "abc");
  });
});
