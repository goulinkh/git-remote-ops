import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describe, it } from "https://deno.land/std@0.224.0/testing/bdd.ts";
import type { Result } from "better-result";
import { RemoteGit } from "../../index.ts";
import type { GitRemoteOpsError, TreeEntry } from "../../index.ts";
import { startGitContainer } from "../../../testing/containers.ts";
import { compatibilityProfiles } from "../../../testing/profiles.ts";
import { createDeterministicRepo } from "../../../testing/repositories.ts";

function unwrap<T>(result: Result<T, GitRemoteOpsError>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}

function entryNamed(entries: TreeEntry[], name: string): TreeEntry {
  const entry = entries.find((candidate) => candidate.name === name);
  assert(entry, `missing tree entry: ${name}`);
  return entry;
}

describe("RemoteGit compatibility", () => {
  for (const profile of compatibilityProfiles) {
    it(profile.name, async () => {
      const root = await Deno.makeTempDir({ dir: await Deno.cwd() });
      let server: Awaited<ReturnType<typeof startGitContainer>> | null = null;
      try {
        await createDeterministicRepo(root, profile);
        server = await startGitContainer(profile, root);
        const git = new RemoteGit(server.url);
        const probed = unwrap(await git.probe());
        assertEquals(probed.supportsShallow, profile.expectShallow);
        assertEquals(probed.supportsFilterBlobNone, profile.expectFilter);
        const { commit, sha } = unwrap(
          await git.fetchCommit("HEAD", {
            depth: 1,
            filter: profile.expectFilter ? "blob:none" : undefined,
          }),
        );
        assertEquals(unwrap(await git.resolveRef("HEAD")), sha);
        const rootTree = unwrap(await git.fetchTree(commit.tree));
        const srcTree = entryNamed(rootTree, "src");
        const srcEntries = unwrap(await git.fetchTree(srcTree.sha));
        const file = entryNamed(srcEntries, "file_5.py");
        assertEquals(
          new TextDecoder().decode(unwrap(await git.fetchBlob(file.sha))),
          "print(5)\n# TODO 5\n",
        );
        assertEquals(git.getObject(file.sha)?.type, "blob");
        const snapshot = unwrap(
          await git.fetchTreeForCommit("HEAD", {
            depth: 1,
            filter: profile.expectFilter ? "blob:none" : undefined,
          }),
        );
        const snapshotSrcTree = entryNamed(snapshot.entries, "src");
        assertEquals(git.getObject(snapshotSrcTree.sha)?.type, "tree");
        const cli = await new Deno.Command(Deno.execPath(), {
          args: ["run", "--allow-net", "src/cli.ts", "list-files", server.url, "--ref", "HEAD"],
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert(cli.success, new TextDecoder().decode(cli.stderr));
        assert(new TextDecoder().decode(cli.stdout).split("\n").includes("src/file_5.py"));
      } finally {
        await server?.close();
        await Deno.remove(root, { recursive: true });
      }
    });
  }
});
