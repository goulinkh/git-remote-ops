# git-remote-ops CLI

Read-only Git remote operations over smart HTTP. No working tree, no clone — fetches just the
objects you ask for.

## Install / Run

```sh
# Run from source via Deno tasks
deno run --allow-net --allow-read --allow-write src/cli.ts --store-dir /tmp/gro-cache <command> <url> [options]

# Or install as a binary (requires deno install)
deno install --global -A -n git-remote-ops src/cli.ts
git-remote-ops <command> <url> [options]
```

Required permissions: `--allow-net --allow-read --allow-write`.

`--store-dir <path>` is required. Reuse the same directory to dedupe objects across runs.

## Commands

### `probe <url>`

Probe server capabilities. Prints key=value lines.

```
refs=42
protocol=2
filter_blob_none=true
filter_tree_0=true
shallow=true
```

### `ls-refs <url>`

List refs as `<sha> <name>`, one per line.

```sh
git-remote-ops --store-dir /tmp/gro-cache ls-refs https://github.com/owner/repo
```

### `cat-commit <url> [--ref REF] [--depth N] [--filter SPEC]`

Fetch and print a commit. Defaults: `--ref HEAD`, `--depth 1`, `--filter blob:none`.

```sh
git-remote-ops --store-dir /tmp/gro-cache cat-commit https://github.com/owner/repo --ref main --depth 1
```

Output:

```
commit <sha>
tree <sha>
parent <sha>
author Name <email> <timestamp>
committer Name <email> <timestamp>
```

`--depth` is ignored if the server does not advertise shallow. `--filter` is ignored if the server
does not advertise `filter`. Positional ref also accepted: `cat-commit <url> <ref>`.

### `cat-tree <url> <tree-sha>`

Print tree entries as `<mode> <sha> <name>`, one per line.

### `cat-blob <url> <blob-sha>`

Write raw blob bytes to stdout. Pipe to a file for binary content:

```sh
git-remote-ops --store-dir /tmp/gro-cache cat-blob https://github.com/owner/repo <sha> > out.bin
```

## Global Options

| Flag              | Effect                                                         |
| ----------------- | -------------------------------------------------------------- |
| `-q`, `--quiet`   | Silent — no logs                                               |
| `-v`, `--verbose` | Debug logs (HTTP req/resp, pack parse, fetch counts)           |
| `--debug`         | Trace-level logs (very chatty)                                 |
| `--store-dir DIR` | Required reusable loose-object cache directory                 |
| `--stats`         | Print performance/analytics summary on stderr after completion |
| `-h`, `--help`    | Show top-level or per-command help                             |
| `-V`, `--version` | Print version                                                  |

Default log level: `info`. `--quiet` conflicts with `--verbose`/`--debug`. CLI parsing handled by
`@cliffy/command`.

### Stats output

`--stats` prints aggregated counters across all modules:

```
--- stats ---
http: 3 req, in=128456B out=420B, 612.4ms
pack: 87 objects (1c/45t/41b/0T), 119800B, parse 18.2ms
```

Metrics tracked: HTTP request count, bytes in/out, total HTTP duration, pack object count by type,
pack bytes, pack parse duration.

## Programmatic logging

`RemoteGit` accepts a `Logger` directly:

```ts
import { Logger, RemoteGit } from "git-remote-ops";

const logger = new Logger({ level: "debug", sink: console.error });
const git = new RemoteGit(url, { logger, storeDir: "/tmp/gro-cache" });
await git.fetchCommit("HEAD");
console.log(logger.summary());
console.log(logger.metrics); // structured access
```

Levels: `silent` | `info` | `debug` | `trace`. Modules use namespaced child loggers (`client`,
`client.transport`, `client.pack`) — tags appear in output as `[debug:client.transport]`.

## Exit Codes

| Code | Meaning                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------- |
| 0    | Success                                                                                                         |
| 1    | Runtime error (transport, pack, decode, ref-not-found). Tag + message logged to stderr as `[ErrorTag] message`. |
| 2    | Usage error (missing/unknown command, bad flag)                                                                 |

## Examples

```sh
# What does the server support?
git-remote-ops --store-dir /tmp/gro-cache probe https://github.com/torvalds/linux

# HEAD commit metadata only, no blobs
git-remote-ops --store-dir /tmp/gro-cache cat-commit https://github.com/torvalds/linux

# Dump a specific tree
git-remote-ops --store-dir /tmp/gro-cache cat-tree https://github.com/owner/repo --tree-sha abc123...

# Save a blob to disk
git-remote-ops --store-dir /tmp/gro-cache cat-blob https://github.com/owner/repo def456... > file.txt
```
