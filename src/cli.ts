#!/usr/bin/env node
/**
 * @module cli
 *
 * Commander-driven command-line front-end. Each subcommand wires the global
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
import { Command, InvalidArgumentError } from "commander";
import type { Result } from "better-result";
import { Logger, RemoteGit } from "./index.js";
import type { GitRemoteOpsError, LogLevel, TreeEntry } from "./index.js";
import { parseTree } from "./objects/index.js";

/** Bumped in lockstep with `package.json`. Surfaced by `git-remote-ops --version`. */
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
    process.exit(1);
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
    process.exit(1);
  }
  if (object.type !== "tree") {
    console.error(`[ObjectDecodeError] object is not a tree: ${treeSha}`);
    process.exit(1);
  }
  const entries = parseTree(object.content);
  if (entries.isErr()) {
    console.error(`[${entries.error._tag}] ${entries.error.message}`);
    process.exit(1);
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

function parseDepth(value: string): number {
  const depth = Number(value);
  if (!Number.isInteger(depth) || depth < 1) {
    throw new InvalidArgumentError("--depth must be >= 1");
  }
  return depth;
}

function globalFlags(): GlobalFlags {
  return program.opts<GlobalFlags>();
}

const program: Command = new Command()
  .name("git-remote-ops")
  .version(VERSION)
  .description("Read-only Git remote operations over smart HTTP.")
  .showHelpAfterError()
  .option("-q, --quiet", "Suppress all log output (silent level).")
  .option("-v, --verbose", "Enable debug-level logs to stderr.")
  .option("--debug", "Enable trace-level logs to stderr (very chatty).")
  .requiredOption("--store-dir <path>", "Directory for reusable loose-object cache.")
  .option("--stats", "Print performance/analytics summary on stderr after completion.")
  .hook("preAction", (thisCommand) => {
    const flags = thisCommand.optsWithGlobals<GlobalFlags>();
    if (flags.quiet && (flags.verbose || flags.debug)) {
      thisCommand.error("error: option '-q, --quiet' cannot be used with '-v, --verbose' or '--debug'");
    }
  });

program
  .command("probe")
  .description("Probe server capabilities (protocol, filter, shallow).")
  .argument("<url>")
  .action(async (url: string, command: Command) => {
    const flags = globalFlags();
    const { client, logger } = makeClient(url, flags);
    const profile = unwrap(await client.probe(true));
    console.log(`refs=${profile.refs.size}`);
    console.log(`protocol=${profile.protocolVersion}`);
    console.log(`filter_blob_none=${profile.supportsFilterBlobNone}`);
    console.log(`filter_tree_0=${profile.supportsFilterTree0}`);
    console.log(`shallow=${profile.supportsShallow}`);
    maybeStats(logger, flags);
  });

program
  .command("ls-refs")
  .description("List remote refs as '<sha> <name>' per line.")
  .argument("<url>")
  .action(async (url: string, command: Command) => {
    const flags = globalFlags();
    const { client, logger } = makeClient(url, flags);
    for (const [name, sha] of unwrap(await client.lsRefs())) {
      console.log(`${sha} ${name}`);
    }
    maybeStats(logger, flags);
  });

program
  .command("cat-commit")
  .description("Fetch & print a commit object.")
  .argument("<url>")
  .option("--ref <ref>", "Ref or sha to resolve.", "HEAD")
  .option("--depth <n>", "Shallow depth (ignored if server lacks shallow).", parseDepth, 1)
  .option("--filter <spec>", "Object filter spec (e.g. blob:none, tree:0).", "blob:none")
  .option("--no-filter", "Fetch without object filter; may download a full snapshot pack.")
  .action(async (url: string, options: { ref: string; depth: number; filter: string | false }) => {
    const flags = globalFlags();
    const { client, logger } = makeClient(url, flags);
    const filter = options.filter === false ? undefined : options.filter;
    const { sha, commit } = unwrap(
      await client.fetchCommit(options.ref, { depth: options.depth, filter }),
    );
    console.log(`commit ${sha}`);
    console.log(`tree ${commit.tree}`);
    if (commit.parent) console.log(`parent ${commit.parent}`);
    if (commit.author) console.log(`author ${commit.author}`);
    if (commit.committer) console.log(`committer ${commit.committer}`);
    maybeStats(logger, flags);
  });

program
  .command("cat-tree")
  .description("Fetch a commit snapshot and print its root tree as '<mode> <sha> <name>' per entry.")
  .argument("<url>")
  .option("--ref <ref>", "Ref or commit sha to resolve.", "HEAD")
  .option("--depth <n>", "Shallow depth (ignored if server lacks shallow).", parseDepth, 1)
  .option("--filter <spec>", "Object filter spec (e.g. blob:none, tree:0).", "blob:none")
  .option("--no-filter", "Fetch without object filter; downloads a full snapshot pack.")
  .option("--tree-sha <sha>", "Fetch the tree by SHA directly (no commit snapshot).")
  .action(
    async (
      url: string,
      options: { ref: string; depth: number; filter: string | false; treeSha?: string },
    ) => {
      const flags = globalFlags();
      const { client, logger } = makeClient(url, flags);
      if (options.treeSha) {
        for (const entry of unwrap(await client.fetchTree(options.treeSha))) {
          console.log(`${entry.mode} ${entry.sha} ${entry.name}`);
        }
      } else {
        const filter = options.filter === false ? undefined : options.filter;
        const result = unwrap(
          await client.fetchTreeForCommit(options.ref, { depth: options.depth, filter }),
        );
        for (const entry of result.entries) {
          console.log(`${entry.mode} ${entry.sha} ${entry.name}`);
        }
      }
      maybeStats(logger, flags);
    },
  );

program
  .command("list-files")
  .description("List all files in a commit snapshot without cloning.")
  .argument("<url>")
  .option("--ref <ref>", "Ref or commit sha to resolve.", "HEAD")
  .option("--depth <n>", "Shallow depth (ignored if server lacks shallow).", parseDepth, 1)
  .option("--filter <spec>", "Object filter spec (e.g. blob:none, tree:0).", "blob:none")
  .option("--no-filter", "Fetch without object filter; downloads a full snapshot pack.")
  .option("--details", "Print '<mode> <sha> <path>' instead of path only.")
  .action(
    async (
      url: string,
      options: { ref: string; depth: number; filter: string | false; details?: boolean },
    ) => {
      const flags = globalFlags();
      const { client, logger } = makeClient(url, flags);
      const filter = options.filter === false ? undefined : options.filter;
      const result = unwrap(
        await client.fetchTreeForCommit(options.ref, {
          depth: options.depth,
          filter,
        }),
      );
      await printCachedFiles(client, result.entries, "", !!options.details);
      maybeStats(logger, flags);
    },
  );

program
  .command("cat-blob")
  .description("Fetch a blob and write raw bytes to stdout.")
  .argument("<url>")
  .argument("<blob-sha>")
  .action(async (url: string, sha: string, command: Command) => {
    const flags = globalFlags();
    const { client, logger } = makeClient(url, flags);
    process.stdout.write(unwrap(await client.fetchBlob(sha)));
    maybeStats(logger, flags);
  });

await program.parseAsync(process.argv);
