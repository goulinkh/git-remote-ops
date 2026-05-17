# Pack parsing

Internal notes on smart-HTTP pack parsing path. Read before touching `src/pack/parser.ts`,
`src/protocol/pkt_line.ts`, or `src/protocol/upload_pack.ts`.

## Pipeline

```
HTTP body
  -> storeDir/incoming/*.raw
  -> extractPackToFile (src/protocol/upload_pack.ts)
       -> streamed pkt-line parse
       -> write BAND_PACK channel to storeDir/incoming/*.pack
  -> parsePackfile (src/pack/parser.ts)
       -> per object: readPackObjectHeader + decompressAt (+ applyDelta for delta types)
       -> optional sink writes loose objects to storeDir/objects/<aa>/<rest>
```

## pkt-line: do NOT strip LF in parser

`parsePktLines` returns raw payload bytes including trailing `0x0a`. Pack data is binary; legitimate
`0x0a` bytes occur inside zlib streams. Stripping at the pkt-line layer silently corrupted sideband
pack chunks and caused `inflate: incorrect data check` errors deep in the pack (e.g. after ~2800
valid objects on a Launchpad 30MB pack).

Text consumers (`parseRefAdvertisement`, `parseV2CapabilityAdvertisement`) strip trailing LF
themselves via `stripTrailingLf`. Do not push that back into `parsePktLines`.

## decompressAt: zlib consumed-byte tracking

Pack v2 has no inline per-object byte length. Each object's zlib stream length must be discovered
from the inflate state.

Implementation uses `node:zlib` `Inflate._processChunk(buffer, Z_FINISH)` synchronously. After the
call:

- return value = inflated output (`Buffer`)
- `engine.bytesWritten` = bytes of input consumed up to `Z_STREAM_END`

This is one inflate per object; cost is O(stream-length).

### What NOT to do

- **Byte-by-byte brute force** (`for end = offset+2 .. maxLen; inflate(data[offset:end])`): O(N²)
  per object. On large packs this looks like a hang.
- **Binary-search on inflate success**: correct in theory but each probe re-inflates from offset;
  total O(N log N) per object and complicates handling of stored blocks.
- **`pako`**: pako 2.x auto-resets the inflate stream after `Z_STREAM_END` and tries to decode a
  second stream from trailing bytes. With concatenated pack streams this fails with
  `incorrect header check` and `total_in` is unreliable.
- **`createInflate()` streaming**: works but forces an async `decompressAt`, cascading through
  `parsePackfile`. Not worth it while `_processChunk` is reliable on Node.js.

### Node zlib caveats

`Inflate` is exported as a type-only name in the type defs; instantiate via
`(zlib as { Inflate: new (opts) => ... }).Inflate({...})`. `Buffer.from(uint8array)` (copy form) is
used to avoid byteOffset edge cases when passing subarrays into `_processChunk`.

## parsePackfile shortcuts

- `targets?: Set<string>` option: when set, parser exits early once all target shas are
  materialized. Used for single-want fetches where we only need the requested object.
- `retainTypes?: Set<GitObjectType>` option: when set, parser still reconstructs objects needed for
  delta resolution but only returns and sinks retained types.
- Optional sink argument: called only for retained objects so client code can write loose objects to
  disk during parse without storing skipped blobs.
- `fetchTreeForCommit` uses `parseScope: "trees"`, which scans the snapshot pack and retains only
  commits and trees. Blob bytes may be reconstructed transiently for delta bases, but they are not
  returned or written to the loose-object store.

## ofs-delta vs ref-delta

- **OBJ_OFS_DELTA (type=6)**: varint-encoded negative offset BEFORE the zlib stream. Read varint via
  `readVarintBe` to advance offset, then call `decompressAt` for the delta payload. Base resolved
  via `byOffset.get(objectOffset - varintValue)`.
- **OBJ_REF_DELTA (type=7)**: 20-byte base SHA before the zlib stream. Base may not be present yet →
  push to `pendingRefDeltas` and resolve in a second pass.

`byOffset` is keyed by the object's start offset (before the type/size header), not after.

## Reproducing pack corruption bugs

Add to `parsePackfile`:

```ts
import { writeFileSync } from "node:fs";

if (process.env.PARSER_DUMP) {
  writeFileSync(process.env.PARSER_DUMP, pack);
}
```

Then run with `PARSER_DUMP=/tmp/p.pack` and verify against real git:

```
mkdir -p /tmp/v && cp /tmp/p.pack /tmp/v/pack-<40hex>.pack
cd /tmp/v && git index-pack pack-<40hex>.pack
```

If `git index-pack` reports the same offset failure, the bug is upstream of the parser (transport /
pkt-line / sideband). If git accepts the pack but our parser fails, the bug is in `parsePackfile`.

## Test coverage gap

Unit tests (`src/pack/parser.test.ts`) only cover small synthetic packs. Real-world packs from
Launchpad / GitHub exercise:

- Multi-KB to multi-MB single objects (chunked inflate output)
- Mixed ofs-delta and ref-delta
- Legitimate `0x0a` bytes inside zlib streams (the LF-strip regression)

The smart-HTTP harness at `src/testing/integration/remote_git.test.ts` covers github, gitlab,
forgejo, launchpad-turnip. Run with `pnpm test:integration` after parser changes.
