import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PackParseError, RefNotFoundError } from "./errors.js";

describe("tagged errors", () => {
  it("discriminates by _tag", () => {
    const pack = new PackParseError({
      reason: "bad-signature",
      message: "not a packfile",
      offset: 0,
    });
    const ref = new RefNotFoundError({ ref: "main", message: "ref not found: main" });

    assert.deepStrictEqual(pack._tag, "PackParseError");
    assert.deepStrictEqual(PackParseError.is(pack), true);
    assert.deepStrictEqual(PackParseError.is(ref), false);
  });
});
