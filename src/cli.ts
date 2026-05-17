#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write
/**
 * @module cli
 *
 * Cliffy-driven command-line front-end. Each subcommand wires the global
 * verbosity / stats flags into a freshly built {@link RemoteGit}, executes
 * one operation, and prints a plain-text result to stdout. Errors come back
 * through {@link unwrap} as `[Tag] message` lines on stderr with exit 1.
 *
 * Subcommands:
 *  - `probe`       — capability + filter probe
 *  - `ls-refs`     — list advertised refs
 *  - `cat-commit`  — fetch one commit
 *  - `cat-tree`    — fetch a commit's root tree (or a tree by sha)
 *  - `list-files`  — walk a snapshot and emit every file path
 *  - `cat-blob`    — pipe one blob's raw bytes to stdout
 */
import { Command, ValidationError } from "@cliffy/command";
import type { Result } from "better-result";
import { Logger, RemoteGit } from "./index.ts";
import type { GitRemoteOpsError, LogLevel, TreeEntry } from "./index.ts";
import { parseTree } from "./objects/index.ts";

/** Bumped in lockstep with `deno.json`. Surfaced by `git-remote-ops --version`. */
const VERSION = "0.1.0";
/** Octal mode of a subtree entry — used to recurse during `list-files`. */
const TREE_MODE = "40000";

interface GlobalFlags {
  storeDir: string;
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
  stats?: boolean;
}

function resolveLevel(flags: GlobalFlags): LogLevel {
  if (flags.quiet) return "silent";
  if (flags.debug) return "trace";
  if (flags.verbose) return "debug";
  return "info";
}

function makeClient(url: string, flags: GlobalFlags): { client: RemoteGit; logger: Logger } {
  const logger = new Logger({
    level: resolveLevel(flags),
    sink: (line: string) => console.error(line),
  }, "client");
  const client = new RemoteGit(url, { logger, storeDir: flags.storeDir });
  return { client, logger };
}

function unwrap<T>(result: Result<T, GitRemoteOpsError>): T {
  if (result.isErr()) {
    console.error(`[${result.error._tag}] ${result.error.message}`);
    Deno.exit(1);
  }
  return result.value;
}

function maybeStats(logger: Logger, flags: GlobalFlags): void {
  if (flags.stats) console.error(logger.summary());
}

async function cachedTreeEntries(client: RemoteGit, treeSha: string): Promise<TreeEntry[]> {
  const object = await client.getObject(treeSha);
  if (!object) {
    console.error(`[ObjectNotFoundError] tree not present in fetched pack: ${treeSha}`);
    Deno.exit(1);
  }
  if (object.type !== "tree") {
    console.error(`[ObjectDecodeError] object is not a tree: ${treeSha}`);
    Deno.exit(1);
  }
  const entries = parseTree(object.content);
  if (entries.isErr()) {
    console.error(`[${entries.error._tag}] ${entries.error.message}`);
    Deno.exit(1);
  }
  return entries.value;
}

async function printCachedFiles(
  client: RemoteGit,
  entries: TreeEntry[],
  prefix: string,
  details: boolean,
): Promise<void> {
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === TREE_MODE) {
      await printCachedFiles(client, await cachedTreeEntries(client, entry.sha), path, details);
    } else {
      console.log(details ? `${entry.mode} ${entry.sha} ${path}` : path);
    }
  }
}

await new Command()
  .name("git-remote-ops")
  .version(VERSION)
  .description("Read-only Git remote operations over smart HTTP.")
  .globalOption("-q, --quiet", "Suppress all log output (silent level).")
  .globalOption("-v, --verbose", "Enable debug-level logs to stderr.", {
    conflicts: ["quiet"],
  })
  .globalOption("--debug", "Enable trace-level logs to stderr (very chatty).", {
    conflicts: ["quiet"],
  })
  .globalOption("--store-dir <path:string>", "Directory for reusable loose-object cache.", {
    required: true,
  })
  .globalOption("--stats", "Print performance/analytics summary on stderr after completion.")
  .action(function () {
    this.showHelp();
  })
  .command("probe", "Probe server capabilities (protocol, filter, shallow).")
  .arguments("<url:string>")
  .action(async (flags: GlobalFlags, url) => {
    const { client, logger } = makeClient(url, flags);
    const profile = unwrap(await client.probe(true));
    console.log(`refs=${profile.refs.size}`);
    console.log(`protocol=${profile.protocolVersion}`);
    console.log(`filter_blob_none=${profile.supportsFilterBlobNone}`);
    console.log(`filter_tree_0=${profile.supportsFilterTree0}`);
    console.log(`shallow=${profile.supportsShallow}`);
    maybeStats(logger, flags);
  })
  .command("ls-refs", "List remote refs as '<sha> <name>' per line.")
  .arguments("<url:string>")
  .action(async (flags: GlobalFlags, url) => {
    const { client, logger } = makeClient(url, flags);
    for (const [name, sha] of unwrap(await client.lsRefs())) {
      console.log(`${sha} ${name}`);
    }
    maybeStats(logger, flags);
  })
  .command("cat-commit", "Fetch & print a commit object.")
  .arguments("<url:string>")
  .option("--ref <ref:string>", "Ref or sha to resolve.", { default: "HEAD" })
  .option("--depth <n:integer>", "Shallow depth (ignored if server lacks shallow).", {
    default: 1,
    value: (n: number) => {
      if (n < 1) throw new ValidationError("--depth must be >= 1");
      return n;
    },
  })
  .option("--filter <spec:string>", "Object filter spec (e.g. blob:none, tree:0).", {
    default: "blob:none",
  })
  .option("--no-filter", "Fetch without object filter; may download a full snapshot pack.")
  .action(
    async (
      flags: GlobalFlags & { ref: string; depth: number; filter: string | false },
      url,
    ) => {
      const { client, logger } = makeClient(url, flags);
      const filter = flags.filter === false ? undefined : flags.filter;
      const { sha, commit } = unwrap(
        await client.fetchCommit(flags.ref, { depth: flags.depth, filter }),
      );
      console.log(`commit ${sha}`);
      console.log(`tree ${commit.tree}`);
      if (commit.parent) console.log(`parent ${commit.parent}`);
      if (commit.author) console.log(`author ${commit.author}`);
      if (commit.committer) console.log(`committer ${commit.committer}`);
      maybeStats(logger, flags);
    },
  )
  .command(
    "cat-tree",
    "Fetch a commit snapshot and print its root tree as '<mode> <sha> <name>' per entry.",
  )
  .arguments("<url:string>")
  .option("--ref <ref:string>", "Ref or commit sha to resolve.", { default: "HEAD" })
  .option("--depth <n:integer>", "Shallow depth (ignored if server lacks shallow).", {
    default: 1,
    value: (n: number) => {
      if (n < 1) throw new ValidationError("--depth must be >= 1");
      return n;
    },
  })
  .option("--filter <spec:string>", "Object filter spec (e.g. blob:none, tree:0).", {
    default: "blob:none",
  })
  .option("--no-filter", "Fetch without object filter; downloads a full snapshot pack.")
  .option("--tree-sha <sha:string>", "Fetch the tree by SHA directly (no commit snapshot).")
  .action(
    async (
      flags: GlobalFlags & {
        ref: string;
        depth: number;
        filter: string | false;
        treeSha?: string;
      },
      url,
    ) => {
      const { client, logger } = makeClient(url, flags);
      if (flags.treeSha) {
        for (const entry of unwrap(await client.fetchTree(flags.treeSha))) {
          console.log(`${entry.mode} ${entry.sha} ${entry.name}`);
        }
      } else {
        const filter = flags.filter === false ? undefined : flags.filter;
        const result = unwrap(
          await client.fetchTreeForCommit(flags.ref, { depth: flags.depth, filter }),
        );
        for (const entry of result.entries) {
          console.log(`${entry.mode} ${entry.sha} ${entry.name}`);
        }
      }
      maybeStats(logger, flags);
    },
  )
  .command("list-files", "List all files in a commit snapshot without cloning.")
  .arguments("<url:string>")
  .option("--ref <ref:string>", "Ref or commit sha to resolve.", { default: "HEAD" })
  .option("--depth <n:integer>", "Shallow depth (ignored if server lacks shallow).", {
    default: 1,
    value: (n: number) => {
      if (n < 1) throw new ValidationError("--depth must be >= 1");
      return n;
    },
  })
  .option("--filter <spec:string>", "Object filter spec (e.g. blob:none, tree:0).", {
    default: "blob:none",
  })
  .option("--no-filter", "Fetch without object filter; downloads a full snapshot pack.")
  .option("--details", "Print '<mode> <sha> <path>' instead of path only.")
  .action(
    async (
      flags: GlobalFlags & {
        ref: string;
        depth: number;
        filter: string | false;
        details?: boolean;
      },
      url,
    ) => {
      const { client, logger } = makeClient(url, flags);
      const filter = flags.filter === false ? undefined : flags.filter;
      const result = unwrap(
        await client.fetchTreeForCommit(flags.ref, {
          depth: flags.depth,
          filter,
        }),
      );
      await printCachedFiles(client, result.entries, "", !!flags.details);
      maybeStats(logger, flags);
    },
  )
  .command("cat-blob", "Fetch a blob and write raw bytes to stdout.")
  .arguments("<url:string> <blob-sha:string>")
  .action(async (flags: GlobalFlags, url, sha) => {
    const { client, logger } = makeClient(url, flags);
    await Deno.stdout.write(unwrap(await client.fetchBlob(sha)));
    maybeStats(logger, flags);
  })
  .parse(Deno.args);
