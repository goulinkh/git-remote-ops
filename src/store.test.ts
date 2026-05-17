import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sha1OfObject } from "./pack/objects.js";
import { LooseObjectStore } from "./store.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("LooseObjectStore", () => {
  it("round-trips loose objects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-remote-ops-"));
    try {
      const store = new LooseObjectStore(dir);
      const content = encoder.encode("hello\n");
      const written = await store.write("blob", content);
      if (written.isErr()) throw written.error;

      const read = await store.read(written.value);
      if (read.isErr()) throw read.error;
      assert.deepStrictEqual(read.value.type, "blob");
      assert.deepStrictEqual(decoder.decode(read.value.content), "hello\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates by sha", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-remote-ops-"));
    try {
      const store = new LooseObjectStore(dir);
      const first = await store.write("blob", encoder.encode("same\n"));
      const second = await store.write("blob", encoder.encode("same\n"));
      if (first.isErr()) throw first.error;
      if (second.isErr()) throw second.error;
      assert.deepStrictEqual(second.value, first.value);
      assert(await store.has(first.value));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("matches canonical git object sha", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-remote-ops-"));
    try {
      const store = new LooseObjectStore(dir);
      const content = encoder.encode("body");
      const written = await store.write("blob", content);
      const expected = sha1OfObject("blob", content);
      if (written.isErr()) throw written.error;
      if (expected.isErr()) throw expected.error;
      assert.deepStrictEqual(written.value, expected.value);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
