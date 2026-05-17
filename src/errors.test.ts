import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describe, it } from "https://deno.land/std@0.224.0/testing/bdd.ts";
import { PackParseError, RefNotFoundError } from "./errors.ts";

describe("tagged errors", () => {
  it("discriminates by _tag", () => {
    const pack = new PackParseError({
      reason: "bad-signature",
      message: "not a packfile",
      offset: 0,
    });
    const ref = new RefNotFoundError({ ref: "main", message: "ref not found: main" });

    assertEquals(pack._tag, "PackParseError");
    assertEquals(PackParseError.is(pack), true);
    assertEquals(PackParseError.is(ref), false);
  });
});
