/**
 * @module objects-commit
 *
 * Decoder for the loose-commit object body.
 *
 * A commit is a header block followed by a blank line and a freeform message.
 * Each header line is `<field> <value>` and only the first occurrence of any
 * header is significant for our purposes (Git allows multiple `parent` lines
 * for merge commits; this client deliberately keeps just the first since it
 * only ever walks toward the root snapshot).
 */
import { Result } from "better-result";
import { ObjectDecodeError } from "../errors.ts";
import type { CommitInfo } from "../types.ts";

const decoder = new TextDecoder();

/**
 * Parse the body of a commit object.
 *
 * @param content Uncompressed commit bytes (no `commit <size>\0` header).
 * @returns The decoded {@link CommitInfo}, or {@link ObjectDecodeError} if the
 *   mandatory `tree` field is absent.
 */
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
