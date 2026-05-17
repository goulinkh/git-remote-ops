import { Result } from "better-result";
import { ObjectDecodeError } from "../errors.ts";
import type { CommitInfo } from "../types.ts";

const decoder = new TextDecoder();

export function parseCommit(content: Uint8Array): Result<CommitInfo, ObjectDecodeError> {
  const text = decoder.decode(content);
  const headerEnd = text.indexOf("\n\n");
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text;

  const fields = new Map<string, string>();
  for (const line of header.split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0 || fields.has(line.slice(0, space))) continue;
    fields.set(line.slice(0, space), line.slice(space + 1));
  }

  const tree = fields.get("tree");
  if (!tree) {
    return Result.err(
      new ObjectDecodeError({
        reason: "missing-tree",
        message: "commit missing tree field",
        objectType: "commit",
      }),
    );
  }

  return Result.ok({
    tree,
    parent: fields.get("parent"),
    author: fields.get("author"),
    committer: fields.get("committer"),
  });
}
