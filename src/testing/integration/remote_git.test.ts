import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Result } from "better-result";
import { RemoteGit } from "../../index.js";
import type { GitRemoteOpsError, TreeEntry } from "../../index.js";
import { startGitContainer } from "../../../testing/containers.js";
import { compatibilityProfiles } from "../../../testing/profiles.js";
import { createDeterministicRepo } from "../../../testing/repositories.js";

function unwrap<T>(result: Result<T, GitRemoteOpsError>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}

function entryNamed(entries: TreeEntry[], name: string): TreeEntry {
  const entry = entries.find((candidate) => candidate.name === name);
  assert(entry, `missing tree entry: ${name}`);
  return entry;
}

async function runCli(args: string[]): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        success: code === 0,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

describe("RemoteGit compatibility", () => {
  for (const profile of compatibilityProfiles) {
    it(profile.name, async () => {
      const root = await mkdtemp(join(process.cwd(), "git-remote-ops-"));
      let server: Awaited<ReturnType<typeof startGitContainer>> | null = null;
      try {
        await createDeterministicRepo(root, profile);
        server = await startGitContainer(profile, root);
        const git = new RemoteGit(server.url, { storeDir: `${root}/store` });
        const probed = unwrap(await git.probe());
        assert.deepStrictEqual(probed.supportsShallow, profile.expectShallow);
        assert.deepStrictEqual(probed.supportsFilterBlobNone, profile.expectFilter);
        const { commit, sha } = unwrap(
          await git.fetchCommit("HEAD", {
            depth: 1,
            filter: profile.expectFilter ? "blob:none" : undefined,
          }),
        );
        assert.deepStrictEqual(unwrap(await git.resolveRef("HEAD")), sha);
        const rootTree = unwrap(await git.fetchTree(commit.tree));
        const srcTree = entryNamed(rootTree, "src");
        const srcEntries = unwrap(await git.fetchTree(srcTree.sha));
        const file = entryNamed(srcEntries, "file_5.py");
        assert.deepStrictEqual(
          new TextDecoder().decode(unwrap(await git.fetchBlob(file.sha))),
          "print(5)\n# TODO 5\n",
        );
        assert.deepStrictEqual((await git.getObject(file.sha))?.type, "blob");
        const snapshot = unwrap(
          await git.fetchTreeForCommit("HEAD", {
            depth: 1,
            filter: profile.expectFilter ? "blob:none" : undefined,
          }),
        );
        const snapshotSrcTree = entryNamed(snapshot.entries, "src");
        assert.deepStrictEqual((await git.getObject(snapshotSrcTree.sha))?.type, "tree");
        const cli = await runCli([
          "--store-dir",
          `${root}/cli-store`,
          "list-files",
          server.url,
          "--ref",
          "HEAD",
        ]);
        assert(cli.success, cli.stderr);
        assert(cli.stdout.split("\n").includes("src/file_5.py"));
      } finally {
        await server?.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
