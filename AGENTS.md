# AGENTS.md

Consumer-facing orientation for coding agents working **with** `git-remote-ops`. For
contributor-internal lore (parser invariants, harness boot), see `docs/`.

## What this library is

Read-only Git client over smart HTTP. No `.git` dir, no subprocess, no working tree. Fetches one
commit / one tree / one blob from a remote and stores decoded objects in caller-supplied `storeDir`.

## What it is NOT

- Not a `git` replacement. No push, no working tree, no ref writes, no merges.
- Not a clone manager. No `have` negotiation, no incremental sync — every fetch is from-scratch with
  `done`.
- Not a fully streaming parser. Extracted packs are loaded in memory during parse.

If consumer needs writes or full clones, shell out to `git` instead.

## Install

```ts
import { RemoteGit } from "git-remote-ops";
```

Node.js 24 LTS package. Use pnpm for local development and npm-compatible package installs for consumers.

CLI:

```sh
pnpm install
pnpm build
pnpm exec git-remote-ops --help
```

## Core API

One class. All methods async. All return `Result<T, GitRemoteOpsError>` from
`better-result` — never throw.

```ts
const client = new RemoteGit(url, { storeDir, logger?, diagnostic? });

await client.discover();      // -> ServerProfile
await client.probe(verbose?); // -> ServerProfile (filter probe)
await client.lsRefs();        // -> Map<refName, sha>
await client.resolveRef(ref); // -> sha
await client.fetchCommit(ref, { depth?, filter?, parseScope? });
await client.fetchBlob(sha);
await client.fetchTree(sha);
await client.fetchTreeForCommit(ref, opts);
await client.getObject(sha);  // disk store lookup, no network
```

## Result handling

```ts
const r = await client.fetchBlob(sha);
if (r.isErr()) {
  // narrow on _tag
  if (r.error._tag === "TransportError") console.error(r.error.status);
  return;
}
const bytes = r.value;
```

Error tags: `PackParseError`, `ObjectDecodeError`, `PktLineError`, `UploadPackError`,
`TransportError`, `RefNotFoundError`, `ObjectNotFoundError`, `PathNotFoundError`. Union =
`GitRemoteOpsError`.

Never `try/catch` for control flow — these calls don't throw. Wrap user code that calls `.unwrap()`
if you want exceptions.

## Caching behaviour consumers should know

`RemoteGit` keeps one `ServerProfile` in memory. Objects live on disk under `storeDir`:

- `objects/<aa>/<rest>` — Git-compatible loose objects.
- `incoming/` — transient raw responses and extracted packs.
- `snapshots/` — depth-1 snapshot markers.

Implications:

- Reuse `storeDir` across calls/processes — commit → tree → blob dedupes `want`s from disk.
- `getObject` is async because it reads the loose-object store.
- Concurrent writers rely on atomic temp-file rename only; no lockfile yet.

## Choosing options

| Goal                        | Recipe                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------ |
| One commit's metadata       | `fetchCommit(ref, { depth: 1, filter: "blob:none" })`                                |
| List files at snapshot      | `fetchTreeForCommit(ref, { depth: 1, filter: "blob:none" })`                         |
| One known blob              | `fetchBlob(sha)` (no profile probe needed)                                           |
| Path → blob without network | read trees from `getObject` / `LooseObjectStore`, then use `objects/tree.ts` helpers |

`depth: 1` + `filter: "blob:none"` is the cheap default. Both gracefully degrade if server doesn't
advertise the capability — depth drops, filter logs at info and proceeds.

## Logging

Library silent unless told otherwise.

```ts
import { Logger } from "git-remote-ops";

const logger = new Logger({ level: "debug" });
const client = new RemoteGit(url, { logger, storeDir });
// ...
console.error(logger.summary()); // metrics table
```

Levels: `silent` < `info` < `debug` < `trace`. Metrics roll up across child loggers automatically.

## CLI surface

```text
git-remote-ops probe       <url>
git-remote-ops ls-refs     <url>
git-remote-ops cat-commit  <url> [--ref HEAD] [--depth N] [--filter SPEC | --no-filter]
git-remote-ops cat-tree    <url> [--ref HEAD] [--depth N] [--filter SPEC | --no-filter]
                                 [--tree-sha SHA]
git-remote-ops list-files  <url> [--ref HEAD] [--depth N] [--filter SPEC | --no-filter]
                                 [--details]
git-remote-ops cat-blob    <url> <blob-sha>

Global: --store-dir <path> | -q | -v | --debug | --stats
```

Stdout = data. Stderr = logs + errors. Exit 1 on any `Result.err`.

Full reference: `docs/cli.md`.

## Common pitfalls

**Calling `fetchTree(commit.tree)` after `fetchCommit(ref)` with default options.** Default
`parseScope: "target"` only materializes the commit itself. Use `fetchTreeForCommit` or pass
`{ parseScope: "all" }` to `fetchCommit`.

**Expecting full history.** `depth: 1` (the CLI default) gives one commit. Drop depth for full
history; expect a much larger pack.

**Treating `RefNotFoundError` as fatal.** A 40-char hex sha is accepted even when not in the ad —
try direct sha if your ref is unusual.

**Confusing `getObject` with a fetch.** `getObject` only checks the disk store. Returns `undefined`
if not yet materialized. No network call.

**Throwing away `storeDir` between calls.** Re-fetches the same objects. Reuse the directory.

## Where to look in source

| Concern                | File                          |
| ---------------------- | ----------------------------- |
| Public API             | `src/client.ts`               |
| Types                  | `src/types.ts`                |
| Errors                 | `src/errors.ts`               |
| Logging / metrics      | `src/logger.ts`               |
| HTTP                   | `src/transport.ts`            |
| Wire framing           | `src/protocol/pkt_line.ts`    |
| Ref / capability parse | `src/protocol/refs.ts`        |
| Fetch req + sideband   | `src/protocol/upload_pack.ts` |
| Packfile decode        | `src/pack/parser.ts`          |
| Delta application      | `src/pack/delta.ts`           |
| Pack constants + hash  | `src/pack/objects.ts`         |
| Commit decode          | `src/objects/commit.ts`       |
| Tree decode / walk     | `src/objects/tree.ts`         |
| CLI                    | `src/cli.ts`                  |

Every file carries a module-level JSDoc banner with intent. Every constant documented inline.

## Versioning

Pre-1.0. API may shift. Pin exact package versions in `package.json`.

## License

See `LICENSE`.
