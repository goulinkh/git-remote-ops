import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describe, it } from "https://deno.land/std@0.224.0/testing/bdd.ts";
import type { Result } from "better-result";
import { RemoteGit } from "../../index.ts";
import type { GitRemoteOpsError } from "../../index.ts";
import { startGitContainer } from "../../../testing/containers.ts";
import { compatibilityProfiles } from "../../../testing/profiles.ts";
import { createDeterministicRepo } from "../../../testing/repositories.ts";

function unwrap<T>(result: Result<T, GitRemoteOpsError>): T {
  if (result.isErr()) throw result.error;
  return result.value;
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
        const files = unwrap(await git.listFiles("HEAD", "src"));
        assert(files.some((file) => file.path === "src/file_5.py"));
        assertEquals(
          new TextDecoder().decode(unwrap(await git.readFile("src/file_5.py"))),
          "print(5)\n# TODO 5\n",
        );
        assertEquals(unwrap(await git.grep("TODO", { pathGlob: "src/file_5.py" })), [{
          path: "src/file_5.py",
          lineNumber: 2,
          line: "# TODO 5",
        }]);
      } finally {
        await server?.close();
        await Deno.remove(root, { recursive: true });
      }
    });
  }
});
