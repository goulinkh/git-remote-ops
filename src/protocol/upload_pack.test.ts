import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describe, it } from "https://deno.land/std@0.224.0/testing/bdd.ts";
import { pktLine } from "./pkt_line.ts";
import { demuxSideband } from "./upload_pack.ts";

describe("demuxSideband", () => {
  it("splits channels", () => {
    const enc = new TextEncoder();
    const packet = pktLine(new Uint8Array([1, ...enc.encode("PACKdata")]));
    if (packet.isErr()) throw packet.error;
    const data = demuxSideband(packet.value);
    if (data.isErr()) throw data.error;
    assertEquals(new TextDecoder().decode(data.value.pack), "PACKdata");
  });
});
