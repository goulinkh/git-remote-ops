import { Result } from "better-result";
import { encodeHex } from "@std/encoding/hex";
import { ObjectDecodeError, PathNotFoundError } from "../errors.ts";
import type { FileEntry, GitObjectMap, TreeEntry } from "../types.ts";

const TREE_MODE = "40000";
const SPACE = 0x20;
const NUL = 0x00;
const SHA_BYTES = 20;

const decoder = new TextDecoder();

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
