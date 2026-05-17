import { spawn } from "node:child_process";

export type OciCli = "podman" | "docker";

export async function ociCli(): Promise<OciCli> {
  if (await commandExists("podman")) {
    return "podman";
  }
  if (await commandExists("docker")) {
    return "docker";
  }
  throw new Error(
    "No OCI runtime found on PATH. Install podman or docker, then run `bash testing/docker/build.sh`.",
  );
}

async function commandExists(command: OciCli): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") resolve(false);
      else reject(error);
    });
    child.on("close", (code) => resolve(code === 0));
  });
}
