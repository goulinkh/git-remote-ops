/**
 * @module objects-tree
 *
 * Tree decoder and helpers for walking trees / resolving paths to blobs.
 *
 * A tree entry on disk is `<octal-mode> <name>\0<20-byte-sha>` with no length
 * prefix; entries are concatenated. Subtrees use mode `"40000"`; everything
 * else (regular files, executable files, symlinks, gitlinks) is treated as a
 * leaf by {@link walkTree}.
 */
import { Result } from "better-result";
import { encodeHex } from "@std/encoding/hex";
import { ObjectDecodeError, PathNotFoundError } from "../errors.ts";
import type { GitObjectMap, TreeEntry } from "../types.ts";

interface FileEntry {
  mode: string;
  path: string;
  sha: string;
}

/** Octal mode marker for a subtree entry. */
const TREE_MODE = "40000";
/** ASCII space — separates mode from name. */
const SPACE = 0x20;
/** ASCII NUL — terminates the name field. */
const NUL = 0x00;
/** Raw SHA-1 width in bytes. */
const SHA_BYTES = 20;

const decoder = new TextDecoder();

/**
 * Parse a tree body into its entries, in the order they appear on disk.
 *
 * @param content Uncompressed tree bytes (no `tree <size>\0` header).
 * @returns Ordered entries, or {@link ObjectDecodeError} on a malformed entry.
 */
export function parseTree(content: Uint8Array): Result<TreeEntry[], ObjectDecodeError> {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(SPACE, offset);
    if (space < 0) {
      return Result.err(
        new ObjectDecodeError({
          reason: "missing-mode-separator",
          message: "tree entry missing mode separator",
          objectType: "tree",
        }),
      );
    }
    const nul = content.indexOf(NUL, space + 1);
    if (nul < 0 || nul + 1 + SHA_BYTES > content.length) {
      return Result.err(
        new ObjectDecodeError({
          reason: "truncated-tree-entry",
          message: "tree entry missing name terminator or sha",
          objectType: "tree",
        }),
      );
    }
    entries.push({
      mode: decoder.decode(content.subarray(offset, space)),
      name: decoder.decode(content.subarray(space + 1, nul)),
      sha: encodeHex(content.subarray(nul + 1, nul + 1 + SHA_BYTES)),
    });
    offset = nul + 1 + SHA_BYTES;
  }
  return Result.ok(entries);
}

/**
 * Recursively flatten a tree into its leaf entries.
 *
 * Subtrees are followed; every other mode is treated as a file and emitted
 * with its full path joined from `pathPrefix`. Requires that every reachable
 * tree object is already present in `objects` — typically the case after a
 * full (unfiltered) snapshot fetch.
 *
 * @param pathPrefix Internal: prefix prepended to entry names while recursing.
 */
export function walkTree(
  objects: GitObjectMap,
  treeSha: string,
  pathPrefix = "",
): Result<FileEntry[], ObjectDecodeError> {
  const object = objects.get(treeSha);
  if (!object) {
    return Result.err(
      new ObjectDecodeError({
        reason: "missing-tree-object",
        message: `tree object not found: ${treeSha}`,
        objectType: "tree",
        sha: treeSha,
      }),
    );
  }

  const entries = parseTree(object.content);
  if (entries.isErr()) return Result.err(entries.error);

  const files: FileEntry[] = [];
  for (const entry of entries.value) {
    const path = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
    if (entry.mode === TREE_MODE) {
      const child = walkTree(objects, entry.sha, path);
      if (child.isErr()) return Result.err(child.error);
      files.push(...child.value);
    } else {
      files.push({ mode: entry.mode, path, sha: entry.sha });
    }
  }
  return Result.ok(files);
}

/**
 * Resolve a slash-separated path inside a tree to the SHA of its leaf entry
 * (usually a blob).
 *
 * Intermediate components must be subtrees; the final component may be any
 * mode (blob, exec, symlink). Leading/trailing/duplicate slashes are tolerated.
 *
 * @returns Leaf SHA-1, or {@link PathNotFoundError} when any component is
 *   missing or an intermediate component is not a tree.
 */
export function resolvePathToBlob(
  objects: GitObjectMap,
  treeSha: string,
  path: string,
): Result<string, PathNotFoundError | ObjectDecodeError> {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) {
    return Result.err(
      new PathNotFoundError({
        path,
        treeSha,
        message: `path not found: ${path}`,
      }),
    );
  }

  let currentTree = treeSha;
  for (let i = 0; i < parts.length; i++) {
    const object = objects.get(currentTree);
    if (!object) {
      return Result.err(
        new PathNotFoundError({
          path,
          treeSha: currentTree,
          message: `path not found: ${path}`,
        }),
      );
    }

    const entries = parseTree(object.content);
    if (entries.isErr()) return Result.err(entries.error);
    const entry = entries.value.find((e) => e.name === parts[i]);
    if (!entry) {
      return Result.err(
        new PathNotFoundError({
          path,
          treeSha: currentTree,
          message: `path not found: ${path}`,
        }),
      );
    }

    const isLast = i === parts.length - 1;
    if (isLast) return Result.ok(entry.sha);
    if (entry.mode !== TREE_MODE) {
      return Result.err(
        new PathNotFoundError({
          path,
          treeSha: currentTree,
          message: `path not found: ${path}`,
        }),
      );
    }
    currentTree = entry.sha;
  }
  return Result.err(new PathNotFoundError({ path, treeSha, message: `path not found: ${path}` }));
}
