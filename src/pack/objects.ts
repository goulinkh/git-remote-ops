/**
 * @module pack-objects
 *
 * Shared constants and the SHA-1 helper used by the packfile parser. Object
 * type codes, varint flags, and pack-format magic live here so that
 * {@link parser} and {@link delta} both reach for the same source of truth.
 *
 * Pack format reference:
 * https://git-scm.com/docs/pack-format
 */
import { Result } from "better-result";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { PackParseError } from "../errors.ts";
import type { GitObjectType } from "../types.ts";

/** Magic bytes opening every packfile: ASCII `"PACK"`. */
export const PACK_SIGNATURE = new Uint8Array([0x50, 0x41, 0x43, 0x4b]);
/** Bytes consumed by the fixed pack header (signature + version + count). */
export const PACK_HEADER_SIZE = 12;
/** Size of {@link PACK_SIGNATURE} in bytes. */
export const PACK_SIGNATURE_SIZE = 4;
/** Pack format versions this parser accepts. v4 exists but is not produced by mainline Git. */
export const SUPPORTED_PACK_VERSIONS: ReadonlySet<number> = new Set([2, 3]);

/** Trailing SHA-1 over the rest of the pack — sits at the very end of the buffer. */
export const PACK_TRAILER_SIZE = 20;

/** High bit set on a varint byte means "another byte follows". */
export const VARINT_CONTINUE = 0x80;
/** Low 7 bits of a varint byte hold value bits. */
export const VARINT_VALUE_MASK = 0x7f;

/** Packfile object type code: commit. */
export const OBJ_COMMIT = 1;
/** Packfile object type code: tree. */
export const OBJ_TREE = 2;
/** Packfile object type code: blob. */
export const OBJ_BLOB = 3;
/** Packfile object type code: annotated tag. */
export const OBJ_TAG = 4;
/** Delta object whose base is referenced by negative offset within the same pack. */
export const OBJ_OFS_DELTA = 6;
/** Delta object whose base is referenced by 20-byte SHA-1 (may be outside the pack). */
export const OBJ_REF_DELTA = 7;

/** Pack type code → loose-object type name. Excludes delta codes by design. */
export const OBJ_NAMES = new Map<number, GitObjectType>([
  [OBJ_COMMIT, "commit"],
  [OBJ_TREE, "tree"],
  [OBJ_BLOB, "blob"],
  [OBJ_TAG, "tag"],
]);

/** Reverse of {@link OBJ_NAMES} — type name → pack type code. */
export const OBJ_TYPES = new Map<GitObjectType, number>(
  [...OBJ_NAMES.entries()].map(([num, name]) => [name, num]),
);

const encoder = new TextEncoder();

/**
 * Compute the canonical Git SHA-1 of an object — `sha1("<type> <size>\0" || content)`.
 *
 * @param type Either a pack type code (1–4) or the loose-object type name.
 * @param content The uncompressed object body.
 * @returns Lowercase hex SHA-1, or {@link PackParseError} when `type` is a
 *   delta code or otherwise unknown.
 */
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
