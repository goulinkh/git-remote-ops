import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describe, it } from "https://deno.land/std@0.224.0/testing/bdd.ts";
import { sha1OfObject } from "./pack/objects.ts";
import { LooseObjectStore } from "./store.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("LooseObjectStore", () => {
  it("round-trips loose objects", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const store = new LooseObjectStore(dir);
      const content = encoder.encode("hello\n");
      const written = await store.write("blob", content);
      if (written.isErr()) throw written.error;

      const read = await store.read(written.value);
      if (read.isErr()) throw read.error;
      assertEquals(read.value.type, "blob");
      assertEquals(decoder.decode(read.value.content), "hello\n");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("deduplicates by sha", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const store = new LooseObjectStore(dir);
      const first = await store.write("blob", encoder.encode("same\n"));
      const second = await store.write("blob", encoder.encode("same\n"));
      if (first.isErr()) throw first.error;
      if (second.isErr()) throw second.error;
      assertEquals(second.value, first.value);
      assert(await store.has(first.value));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("matches canonical git object sha", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const store = new LooseObjectStore(dir);
      const content = encoder.encode("body");
      const written = await store.write("blob", content);
      const expected = sha1OfObject("blob", content);
      if (written.isErr()) throw written.error;
      if (expected.isErr()) throw expected.error;
      assertEquals(written.value, expected.value);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});
