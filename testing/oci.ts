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
  try {
    const result = await new Deno.Command(command, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return result.success;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}
