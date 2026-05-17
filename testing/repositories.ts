import type { CompatibilityProfile } from "./profiles.ts";

async function run(cwd: string, args: string[]): Promise<void> {
  const cmd = new Deno.Command(args[0], {
    args: args.slice(1),
    cwd,
    stdout: "null",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
}

export async function createDeterministicRepo(
  root: string,
  profile: CompatibilityProfile,
): Promise<string> {
  const repo = `${root}/repo.git`;
  const work = `${root}/work`;
  await Deno.mkdir(work, { recursive: true });
  await run(work, ["git", "init"]);
  await run(work, ["git", "config", "user.email", "test@example.com"]);
  await run(work, ["git", "config", "user.name", "Test User"]);
  await Deno.mkdir(`${work}/src`, { recursive: true });
  await Deno.writeTextFile(`${work}/src/file_5.py`, "print(5)\n# TODO 5\n");
  await Deno.writeTextFile(`${work}/README.md`, "demo\nTODO demo\n");
  await Deno.writeFile(`${work}/src/binary.bin`, new Uint8Array([1, 0, 2]));
  await run(work, ["git", "add", "."]);
  await run(work, ["git", "commit", "-m", "initial"]);
  await run(root, ["git", "clone", "--bare", work, repo]);
  await run(repo, ["git", "config", "http.receivepack", String(profile.httpReceivePack)]);
  await run(repo, ["git", "config", "uploadpack.allowFilter", String(profile.allowFilter)]);
  await run(repo, [
    "git",
    "config",
    "uploadpack.allowAnySHA1InWant",
    String(profile.allowAnySHA1InWant),
  ]);
  await run(repo, ["git", "config", "protocol.version", String(profile.protocolVersion)]);
  await run(repo, ["git", "update-server-info"]);
  return repo;
}
