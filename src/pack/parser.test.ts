import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describe, it } from "https://deno.land/std@0.224.0/testing/bdd.ts";
import { Result } from "better-result";
import { deflateSync } from "node:zlib";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { parsePackfile } from "./parser.ts";

function packHeader(type: number, size: number): Uint8Array {
  const out = [];
  let first = (type << 4) | (size & 0x0f);
  size >>= 4;
  if (size) first |= 0x80;
  out.push(first);
  while (size) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size) byte |= 0x80;
    out.push(byte);
  }
  return new Uint8Array(out);
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function sha(type: string, content: Uint8Array): string {
  const input = concat([new TextEncoder().encode(`${type} ${content.length}\0`), content]);
  return encodeHex(new Uint8Array(crypto.subtle.digestSync("SHA-1", input as BufferSource)));
}

describe("parsePackfile", () => {
  it("stops after requested target", () => {
    const blob = new TextEncoder().encode("target\n");
    const blobSha = sha("blob", blob);
    const body = concat([
      new TextEncoder().encode("PACK"),
      new Uint8Array([0, 0, 0, 2, 0, 0, 0, 2]),
      concat([packHeader(3, blob.length), deflateSync(blob)]),
      new Uint8Array([0xff]),
    ]);
    const pack = concat([
      body,
      new Uint8Array(crypto.subtle.digestSync("SHA-1", body as BufferSource)),
    ]);
    const parsed = parsePackfile(pack, { targets: new Set([blobSha]) });
    if (parsed.isErr()) throw parsed.error;
    assertEquals(new TextDecoder().decode(parsed.value.objects.get(blobSha)!.content), "target\n");
  });

  it("handles ref delta", () => {
    const base = new TextEncoder().encode("hello ");
    const target = new TextEncoder().encode("hello world\n");
    const delta = new Uint8Array([
      0x06,
      0x0c,
      0x90,
      0x06,
      0x06,
      ...new TextEncoder().encode("world\n"),
    ]);
    const baseSha = sha("blob", base);
    const objects = [
      concat([packHeader(3, base.length), deflateSync(base)]),
      concat([
        packHeader(7, delta.length),
        Uint8Array.from(baseSha.match(/../g)!.map((h) => parseInt(h, 16))),
        deflateSync(delta),
      ]),
    ];
    const body = concat([
      new TextEncoder().encode("PACK"),
      new Uint8Array([0, 0, 0, 2, 0, 0, 0, 2]),
      ...objects,
    ]);
    const pack = concat([
      body,
      new Uint8Array(crypto.subtle.digestSync("SHA-1", body as BufferSource)),
    ]);
    const parsed = parsePackfile(pack);
    if (parsed.isErr()) throw parsed.error;
    assertEquals(
      new TextDecoder().decode(parsed.value.objects.get(sha("blob", target))!.content),
      "hello world\n",
    );
  });

  it("skips unretained blobs but keeps them as delta bases", () => {
    const base = new TextEncoder().encode("hello ");
    const delta = new Uint8Array([
      0x06,
      0x0c,
      0x90,
      0x06,
      0x06,
      ...new TextEncoder().encode("world\n"),
    ]);
    const baseSha = sha("blob", base);
    const objects = [
      concat([packHeader(3, base.length), deflateSync(base)]),
      concat([
        packHeader(7, delta.length),
        Uint8Array.from(baseSha.match(/../g)!.map((h) => parseInt(h, 16))),
        deflateSync(delta),
      ]),
    ];
    const body = concat([
      new TextEncoder().encode("PACK"),
      new Uint8Array([0, 0, 0, 2, 0, 0, 0, 2]),
      ...objects,
    ]);
    const pack = concat([
      body,
      new Uint8Array(crypto.subtle.digestSync("SHA-1", body as BufferSource)),
    ]);
    const sinked: string[] = [];
    const parsed = parsePackfile(pack, { retainTypes: new Set(["tree"]) }, (objectSha) => {
      sinked.push(objectSha);
      return Result.ok(undefined);
    });
    if (parsed.isErr()) throw parsed.error;
    assertEquals(parsed.value.objects.size, 0);
    assertEquals(sinked.length, 0);
    assertEquals(parsed.value.stats.materialized, 2);
    assertEquals(parsed.value.stats.retained, 0);
    assertEquals(parsed.value.stats.skippedByType.blob, 2);
  });
});
