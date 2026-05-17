import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import type { CompatibilityProfile } from "./profiles.js";

const decoder = new TextDecoder();

async function run(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), { cwd, stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(decoder.decode(Buffer.concat(stderr))));
    });
  });
}

export async function createDeterministicRepo(
  root: string,
  profile: CompatibilityProfile,
): Promise<string> {
  const repo = `${root}/repo.git`;
  const work = `${root}/work`;
  await mkdir(work, { recursive: true });
  await run(work, ["git", "init"]);
  await run(work, ["git", "config", "user.email", "test@example.com"]);
  await run(work, ["git", "config", "user.name", "Test User"]);
  await mkdir(`${work}/src`, { recursive: true });
  await writeFile(`${work}/src/file_5.py`, "print(5)\n# TODO 5\n");
  await writeFile(`${work}/README.md`, "demo\nTODO demo\n");
  await writeFile(`${work}/src/binary.bin`, new Uint8Array([1, 0, 2]));
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
