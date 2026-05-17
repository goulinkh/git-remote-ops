#!/usr/bin/env -S deno run --allow-net
import type { Result } from "better-result";
import { RemoteGit } from "./index.ts";
import type { GitRemoteOpsError } from "./index.ts";

function usage(): never {
  console.error("usage: git-remote-ops <probe|ls-refs|list-files|read-file|grep> <url> [args]");
  Deno.exit(2);
}

function unwrap<T>(result: Result<T, GitRemoteOpsError>): T {
  if (result.isErr()) {
    console.error(`[${result.error._tag}] ${result.error.message}`);
    Deno.exit(1);
  }
  return result.value;
}

const [command, url, ...args] = Deno.args;
if (!command || !url) usage();

const git = new RemoteGit(url, { diagnostic: (message) => console.error(message) });

switch (command) {
  case "probe": {
    const profile = unwrap(await git.probe(true));
    console.log(`refs=${profile.refs.size}`);
    console.log(`filter_blob_none=${profile.supportsFilterBlobNone}`);
    console.log(`filter_tree_0=${profile.supportsFilterTree0}`);
    console.log(`shallow=${profile.supportsShallow}`);
    break;
  }
  case "ls-refs": {
    for (const [name, sha] of unwrap(await git.lsRefs())) console.log(`${sha} ${name}`);
    break;
  }
  case "list-files": {
    const ref = args[0] ?? "HEAD";
    const prefix = args[1] ?? "";
    for (const file of unwrap(await git.listFiles(ref, prefix))) {
      console.log(`${file.mode} ${file.sha} ${file.path}`);
    }
    break;
  }
  case "read-file": {
    const path = args[0] ?? usage();
    const ref = args[1] ?? "HEAD";
    await Deno.stdout.write(unwrap(await git.readFile(path, ref)));
    break;
  }
  case "grep": {
    const pattern = args[0] ?? usage();
    const pathGlob = args[1];
    for (const match of unwrap(await git.grep(pattern, { pathGlob }))) {
      console.log(`${match.path}:${match.lineNumber}: ${match.line}`);
    }
    break;
  }
  default:
    usage();
}
