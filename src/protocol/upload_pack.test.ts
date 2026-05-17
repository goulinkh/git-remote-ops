import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pktLine } from "./pkt_line.js";
import { demuxSideband, extractPackToFile } from "./upload_pack.js";

describe("demuxSideband", () => {
  it("splits channels", () => {
    const enc = new TextEncoder();
    const packet = pktLine(new Uint8Array([1, ...enc.encode("PACKdata")]));
    if (packet.isErr()) throw packet.error;
    const data = demuxSideband(packet.value);
    if (data.isErr()) throw data.error;
    assert.deepStrictEqual(new TextDecoder().decode(data.value.pack), "PACKdata");
  });

  it("streams channel 1 to a pack file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-remote-ops-"));
    try {
      const enc = new TextEncoder();
      const first = pktLine(new Uint8Array([1, ...enc.encode("PACK")]));
      const second = pktLine(new Uint8Array([1, ...enc.encode("data")]));
      if (first.isErr()) throw first.error;
      if (second.isErr()) throw second.error;
      const raw = new Uint8Array(first.value.length + second.value.length);
      raw.set(first.value);
      raw.set(second.value, first.value.length);
      const src = `${dir}/raw`;
      const dest = `${dir}/pack`;
      await writeFile(src, raw);

      const length = await extractPackToFile(src, dest);
      if (length.isErr()) throw length.error;
      assert.deepStrictEqual(length.value, 8);
      assert.deepStrictEqual(new TextDecoder().decode(await readFile(dest)), "PACKdata");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
