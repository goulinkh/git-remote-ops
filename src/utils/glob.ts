export function matchesGlob(path: string, glob: string): boolean {
  const pattern = glob.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${pattern}$`).test(path);
}

function escapeRegex(value: string): string {
  return value.replace(/[\\|{}()[\]^$+?.]/g, "\\$&");
}
