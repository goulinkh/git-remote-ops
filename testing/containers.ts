import { spawn } from "node:child_process";
import type { CompatibilityProfile } from "./profiles.js";
import { ociCli } from "./oci.js";

export interface GitContainer {
  url: string;
  close(): Promise<void>;
}

const decoder = new TextDecoder();

export async function startGitContainer(
  profile: CompatibilityProfile,
  repoRoot: string,
): Promise<GitContainer> {
  const cli = await ociCli();
  let id = "";
  try {
    id = (await run(cli, [
      "run",
      "-d",
      "--rm",
      "-p",
      "127.0.0.1::80",
      "--mount",
      `type=bind,source=${repoRoot},target=/srv/git,readonly`,
      "-e",
      "GIT_PROJECT_ROOT=/srv/git",
      "-e",
      "GIT_HTTP_EXPORT_ALL=1",
      profile.imageTag,
    ])).trim();
    const portOutput = await run(cli, ["port", id, "80/tcp"]);
    const port = parsePort(portOutput);
    const url = `http://127.0.0.1:${port}/repo.git`;
    await waitForReady(url);
    return {
      url,
      close: () => closeContainer(cli, id),
    };
  } catch (error) {
    if (id) {
      await closeContainer(cli, id);
    }
    throw error instanceof Error
      ? new Error(
        `${error.message}\nRun \`bash testing/docker/build.sh\` if image ${profile.imageTag} is missing.`,
      )
      : error;
  }
}

async function closeContainer(cli: string, id: string): Promise<void> {
  await run(cli, ["rm", "-f", id]);
}

async function waitForReady(url: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${url}/info/refs?service=git-upload-pack`);
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`git server did not become ready: ${lastError}`);
}

function parsePort(output: string): string {
  const match = output.match(/(?:127\.0\.0\.1|0\.0\.0\.0|::):(?<port>\d+)/) ??
    output.match(/(?<port>\d+)\s*$/);
  const port = match?.groups?.port;
  if (!port) {
    throw new Error(`could not parse container port from: ${output.trim()}`);
  }
  return port;
}

async function run(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(decoder.decode(Buffer.concat(stdout)));
      else {
        const text = decoder.decode(Buffer.concat(stderr)).trim();
        reject(new Error(`${command} ${args.join(" ")} failed${text ? `: ${text}` : ""}`));
      }
    });
  });
}
