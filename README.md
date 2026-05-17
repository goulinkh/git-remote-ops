# git-remote-ops

**Read-only Git over smart HTTP, without `git`.** A single Deno/TypeScript process speaks the same
wire protocol that `git fetch` does, then materializes the parts you actually want — one commit, one
tree, one file — into a caller-supplied loose-object store.

No `.git` directory. No subprocess. Reuse `--store-dir` across invocations to keep downloaded
objects.

```bash
deno run --allow-net --allow-read --allow-write jsr:@local/git-remote-ops/cli \
  --store-dir /tmp/git-remote-ops-cache \
  cat-blob https://github.com/torvalds/linux.git \
  e8c39d0f… > Makefile
```

The blob lands in `Makefile`; its Git object is cached under `/tmp/git-remote-ops-cache/objects/`.

## Why bother

A surprising amount of production code shells out to `git` just to read a file. That works, but it
forces a clone — every byte of every revision of every path — to retrieve one revision of one path.
On a large monorepo the clone is the entire latency budget.

The Git smart-HTTP protocol has supported targeted fetches for years. With shallow depth
(`--depth=1`) and partial-clone filters (`--filter=blob:none`, `--filter=tree:0`) you can ask the
server for _just the snapshot you care about_, often a few hundred kilobytes total. Mainline `git`
exposes this, but to use it you still need an on-disk clone and a forked process.

`git-remote-ops` is the thin client you'd write if you only ever did this one thing: a few hundred
lines of TypeScript that build the same `want`/`done` request `git` would, parse the packfile that
comes back, and hand you the decoded objects.

## What's in the box

Six subcommands, all read-only:

| Command      | Does                                                          |
| ------------ | ------------------------------------------------------------- |
| `probe`      | Capability sniff: protocol version, shallow, filter dialects. |
| `ls-refs`    | List advertised refs as `<sha> <name>`.                       |
| `cat-commit` | Fetch + decode a commit object.                               |
| `cat-tree`   | Fetch + decode a root tree (or a specific tree by sha).       |
| `list-files` | Walk a snapshot and emit every path.                          |
| `cat-blob`   | Stream one blob's raw bytes to stdout.                        |

And the same operations are available as a library:

```typescript
import { RemoteGit } from "jsr:@local/git-remote-ops";

const client = new RemoteGit("https://github.com/owner/repo.git", {
  storeDir: "/tmp/git-remote-ops-cache",
});
const { sha, commit } = (await client.fetchCommit("HEAD")).unwrap();
const tree = (await client.fetchTree(commit.tree)).unwrap();
const blob = (await client.fetchBlob(tree[0].sha)).unwrap();
```

Every public call returns a `Result<T, GitRemoteOpsError>` from
[`better-result`](https://jsr.io/@local/better-result) — never throws.

## How it works

The work splits into four layers, and the codebase mirrors that split.

```
                 ┌──────────────────────────┐
src/client.ts ─→ │  RemoteGit (public API)  │
                 └────────────┬─────────────┘
                              │
     ┌────────────────────────┼───────────────────────┐
     ▼                        ▼                       ▼
src/protocol/            src/pack/                src/objects/
pkt-line, refs,         pack parser, delta,       commit + tree
upload-pack             zlib bridge               decoders
     │                        ▲
     ▼                        │
src/transport.ts ─────────────┘
(fetch wrappers)
```

### 1. Transport — `src/transport.ts`

Two `fetch` calls do all the network work:

1. `GET /info/refs?service=git-upload-pack` — the ref advertisement.
2. `POST /git-upload-pack` — the actual fetch, body framed below.

Both helpers thread an optional `Logger` so byte counts and durations roll into the same metrics
struct the CLI's `--stats` flag prints.

### 2. Protocol — `src/protocol/`

**pkt-line framing.** Everything Git sends over HTTP is wrapped in a 4-byte ASCII-hex length prefix.
Length `0000` is a flush; `0001` and `0002` are v2 control packets. `parsePktLines` walks a buffer
end-to-end, returning subarray views — no payload bytes are copied. Trailing `\n`s are preserved
because some callers care.

**Ref advertisement.** v0/v1 puts capabilities NUL-separated on the first ref line; v2 puts them on
standalone pkt-lines after `version 2`. We parse both, merge the capability sets, and prefer v2 when
both are advertised.

**`git-upload-pack` request.** A `want <sha>` line per object, an optional `deepen <n>` for shallow,
an optional `filter <spec>` for partial-clone, a flush, then `done`. The v2 encoder adds a
`command=fetch` header section and turns capabilities into separate argument lines instead of riding
the first `want`.

**Sideband demux.** The response is itself a stream of pkt-lines; each data line starts with a
channel byte. Channel 1 is the packfile, channel 2 is human-readable progress, channel 3 is fatal
stderr. Client fetches stream the HTTP body to `incoming/*.raw`, then `extractPackToFile` writes
channel-1 bytes to `incoming/*.pack` without concatenating the response in memory.

### 3. Packfile — `src/pack/`

A packfile is `PACK` + version + count + N variable-length object entries + a trailing SHA-1. Each
entry has a type/size header (a varint with a 3-bit type field jammed into the first byte) followed
by a zlib-compressed body.

The parser walks entries in order. For non-delta types it inflates and hashes the body in one shot.
For deltas — two flavours, `OBJ_OFS_DELTA` (base referenced by negative byte offset) and
`OBJ_REF_DELTA` (base referenced by 20-byte sha) — it applies the delta against the resolved base
and re-hashes the reconstructed object.

Two implementation notes worth flagging:

**zlib boundaries.** Multiple deflate streams sit back-to-back inside the pack with no length
prefix. The streaming API doesn't tell you how many input bytes a single decode consumed, so we
reach into `node:zlib`'s `_processChunk` and read `bytesWritten` to advance the cursor. It's an
implementation detail of Node's zlib binding, but it's a stable one, and the alternative is parsing
deflate headers ourselves.

**Targeted bailout.** If you only need a single commit, the parser accepts a `targets` set and
returns as soon as those shas are materialized — even mid-pack. On a large snapshot pack that's the
difference between parsing five megabytes of objects and parsing fifty kilobytes.

**Delta application.** The delta stream is a tiny opcode language: "copy `n` bytes from base at
offset `o`" or "insert these `n` literal bytes". A size of zero on a copy opcode means 64 KiB.
Out-of-bounds copies become typed errors, never silent corruption.

### 4. Objects — `src/objects/`

Commit and tree decoders. Both inputs are the _uncompressed_ bodies produced by layer 3; neither
parser cares how the bytes got there.

A tree is `<mode> <name>\0<sha20>` repeated, with no length prefix. A commit is RFC822-ish headers +
blank line + free-form message; we keep `tree`, first `parent`, `author`, `committer`. Multiple
`parent` lines (merge commits) collapse to the first because this client only walks toward snapshots
— never along history.

`walkTree` and `resolvePathToBlob` round out the layer for callers that want to flatten a tree or
resolve `path/to/file` to a blob sha without touching the network.

### 5. The client — `src/client.ts`

`RemoteGit` ties the layers together and caches two things across calls:

- A `ServerProfile` (refs + capabilities + filter probe results), populated lazily on the first call
  and shared by everything after.
- Every materialized object, as Git-compatible loose objects under `storeDir/objects/<aa>/<rest>`.
  Subsequent fetches dedupe `want` lists against disk, so cache reuse works across client instances
  and CLI invocations.

`storeDir/incoming/` holds transient raw responses and pack files during parsing.
`storeDir/snapshots/` marks depth-1 snapshot wants that have already been fetched.

There's a small bit of negotiation logic: shallow depth is dropped if the server didn't advertise
`shallow`; filters are dropped (with an info log) if the server didn't advertise `filter`. `probe()`
exists because some servers _advertise_ filter support but don't honour it — we send minimal-cost
test fetches with `blob:none` and `tree:0` and look at the returned pack to find out.

## Errors

Every public function returns `Result<T, E>`. Errors are tagged classes from `better-result`, so you
can narrow on `_tag` and pull structured fields off:

```typescript
const result = await client.fetchBlob(sha);
if (result.isErr()) {
  switch (result.error._tag) {
    case "TransportError": // .status, .url, .method available
    case "PackParseError": // .offset, .reason
    case "ObjectNotFoundError": // .sha
      // …
  }
}
```

The full union is exported as `GitRemoteOpsError`. See `src/errors.ts`.

## Observability

The bundled `Logger` does three jobs at once:

- Levelled messages (`info`, `debug`, `trace`) with namespaced children.
- Cumulative metrics: HTTP request count / bytes / time, pack objects by type / bytes / parse time.
- An aligned summary table for `--stats`.

The library never logs above `info` unless you ask. Pass a configured `Logger` via
`new RemoteGit(url, { logger, storeDir })`, or hand it a `diagnostic` callback and the constructor
will route debug-level lines to it.

## CLI

```text
git-remote-ops <command> [options] <url>

Global flags:
  -q, --quiet       silent
  -v, --verbose     debug
      --debug       trace
      --store-dir   reusable loose-object cache directory (required)
      --stats       print metrics summary after completion

probe <url>
ls-refs <url>
cat-commit <url> [--ref HEAD] [--depth 1] [--filter blob:none | --no-filter]
cat-tree <url>   [--ref HEAD] [--depth 1] [--filter blob:none | --no-filter]
                 [--tree-sha <sha>]
list-files <url> [--ref HEAD] [--depth 1] [--filter blob:none | --no-filter]
                 [--details]
cat-blob <url> <blob-sha>
```

See `docs/cli.md` for the long-form reference.

## Development

```bash
deno task check        # type-check
deno task lint
deno task fmt:check
deno task test         # unit tests (no network)
deno task test:integration   # spins up a local git server
deno task verify       # fmt + lint + check, what CI runs
```

Tests for each layer live next to their code as `*.test.ts`. The integration tests under
`src/testing/integration/` exercise a real `git-upload-pack` talking to the client — see
`docs/git-server-harness-AGENTS.md` for how the harness boots.

## Limitations

By design this client only does fetches. It can't push, can't write to a working tree, can't manage
refs. It also makes no attempt to negotiate `have` lines — every request is a from-scratch fetch
with `done`, on the assumption that you're after small slices of remote history rather than
incrementally syncing a clone.

The pack parser still loads each extracted pack file into memory for delta resolution. Snapshot tree
operations retain only commits and trees, so blobs are not written to the loose-object cache unless
requested directly. A fully streaming parser remains future work.

## License

See `LICENSE`.
