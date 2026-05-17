import { Result } from "better-result";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { PackParseError } from "../errors.ts";
import type { GitObjectType } from "../types.ts";

export const PACK_SIGNATURE = new Uint8Array([0x50, 0x41, 0x43, 0x4b]); // "PACK"
export const PACK_HEADER_SIZE = 12;
export const PACK_SIGNATURE_SIZE = 4;
export const SUPPORTED_PACK_VERSIONS: ReadonlySet<number> = new Set([2, 3]);

export const PACK_TRAILER_SIZE = 20;

export const VARINT_CONTINUE = 0x80;
export const VARINT_VALUE_MASK = 0x7f;

export const OBJ_COMMIT = 1;
export const OBJ_TREE = 2;
export const OBJ_BLOB = 3;
export const OBJ_TAG = 4;
export const OBJ_OFS_DELTA = 6;
export const OBJ_REF_DELTA = 7;

export const OBJ_NAMES = new Map<number, GitObjectType>([
  [OBJ_COMMIT, "commit"],
  [OBJ_TREE, "tree"],
  [OBJ_BLOB, "blob"],
  [OBJ_TAG, "tag"],
]);

export const OBJ_TYPES = new Map<GitObjectType, number>(
  [...OBJ_NAMES.entries()].map(([num, name]) => [name, num]),
);

const encoder = new TextEncoder();

export function sha1OfObject(
  type: number | GitObjectType,
  content: Uint8Array,
): Result<string, PackParseError> {
  const name = typeof type === "number" ? OBJ_NAMES.get(type) : type;
  if (!name) {
    return Result.err(
      new PackParseError({
        reason: "unknown-object-type",
        message: `unknown object type ${type}`,
      }),
    );
  }
  const header = encoder.encode(`${name} ${content.length}\0`);
  const input = new Uint8Array(header.length + content.length);
  input.set(header);
  input.set(content, header.length);
  return Result.ok(encodeHex(new Uint8Array(crypto.subtle.digestSync("SHA-1", input))));
}
