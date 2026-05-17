import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describe, it } from "https://deno.land/std@0.224.0/testing/bdd.ts";
import { pktLine } from "./pkt_line.ts";
import { demuxSideband, extractPackToFile } from "./upload_pack.ts";

describe("demuxSideband", () => {
  it("splits channels", () => {
    const enc = new TextEncoder();
    const packet = pktLine(new Uint8Array([1, ...enc.encode("PACKdata")]));
    if (packet.isErr()) throw packet.error;
    const data = demuxSideband(packet.value);
    if (data.isErr()) throw data.error;
    assertEquals(new TextDecoder().decode(data.value.pack), "PACKdata");
  });

  it("streams channel 1 to a pack file", async () => {
    const dir = await Deno.makeTempDir();
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
      await Deno.writeFile(src, raw);

      const length = await extractPackToFile(src, dest);
      if (length.isErr()) throw length.error;
      assertEquals(length.value, 8);
      assertEquals(new TextDecoder().decode(await Deno.readFile(dest)), "PACKdata");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});
