/**
 * @module store
 *
 * Disk-backed Git loose-object store.
 */
import { Result } from "better-result";
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";
import { ObjectDecodeError, ObjectNotFoundError, PackParseError } from "./errors.js";
import { sha1OfObject } from "./pack/objects.js";
import type { GitObject, GitObjectType } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const VALID_SHA = /^[0-9a-f]{40}$/;
const VALID_TYPES = new Set<GitObjectType>(["commit", "tree", "blob", "tag"]);

function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function isAlreadyExists(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EEXIST";
}

export class LooseObjectStore {
  readonly rootDir: string;
  readonly objectsDir: string;
  readonly incomingDir: string;
  readonly snapshotsDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir.replace(/\/+$/, "");
    this.objectsDir = `${this.rootDir}/objects`;
    this.incomingDir = `${this.rootDir}/incoming`;
    this.snapshotsDir = `${this.rootDir}/snapshots`;
    mkdirSync(this.objectsDir, { recursive: true });
    mkdirSync(this.incomingDir, { recursive: true });
    mkdirSync(this.snapshotsDir, { recursive: true });
  }

  objectPath(sha: string): string {
    return `${this.objectsDir}/${sha.slice(0, 2)}/${sha.slice(2)}`;
  }

  snapshotPath(sha: string): string {
    return `${this.snapshotsDir}/${sha}`;
  }

  incomingPath(suffix: string): string {
    const safeSuffix = suffix.startsWith(".") ? suffix : `.${suffix}`;
    return `${this.incomingDir}/${Date.now()}-${crypto.randomUUID()}${safeSuffix}`;
  }

  async has(sha: string): Promise<boolean> {
    if (!VALID_SHA.test(sha)) return false;
    try {
      const info = await stat(this.objectPath(sha));
      return info.isFile();
    } catch (cause) {
      if (isNotFound(cause)) return false;
      throw cause;
    }
  }

  hasSync(sha: string): boolean {
    if (!VALID_SHA.test(sha)) return false;
    try {
      return statSync(this.objectPath(sha)).isFile();
    } catch (cause) {
      if (isNotFound(cause)) return false;
      throw cause;
    }
  }

  async hasSnapshot(sha: string): Promise<boolean> {
    try {
      const info = await stat(this.snapshotPath(sha));
      return info.isFile();
    } catch (cause) {
      if (isNotFound(cause)) return false;
      throw cause;
    }
  }

  async markSnapshot(sha: string): Promise<void> {
    await writeFile(this.snapshotPath(sha), "", { flag: "w" });
  }

  async read(sha: string): Promise<Result<GitObject, ObjectNotFoundError | ObjectDecodeError>> {
    if (!VALID_SHA.test(sha) || !(await this.has(sha))) {
      return Result.err(new ObjectNotFoundError({ sha, message: `object not found: ${sha}` }));
    }
    const bytes = await Result.tryPromise({
      try: async () => new Uint8Array(await readFile(this.objectPath(sha))),
      catch: (cause) =>
        new ObjectDecodeError({
          reason: "malformed-object",
          message: `failed to read object: ${sha}`,
          sha,
          cause,
        }),
    });
    if (bytes.isErr()) return Result.err(bytes.error);
    return this.decodeLooseObject(sha, bytes.value);
  }

  write(
    type: GitObjectType,
    content: Uint8Array,
  ): Promise<Result<string, PackParseError | ObjectDecodeError>> {
    return Promise.resolve(this.writeSync(type, content));
  }

  writeSync(
    type: GitObjectType,
    content: Uint8Array,
  ): Result<string, PackParseError | ObjectDecodeError> {
    const sha = sha1OfObject(type, content);
    if (sha.isErr()) return Result.err(sha.error);
    if (this.hasSync(sha.value)) return Result.ok(sha.value);

    const dir = `${this.objectsDir}/${sha.value.slice(0, 2)}`;
    const path = `${dir}/${sha.value.slice(2)}`;
    mkdirSync(dir, { recursive: true });
    const tmp = `${dir}/.${sha.value.slice(2)}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, deflateSync(frameObject(type, content)));
      try {
        renameSync(tmp, path);
      } catch (cause) {
        if (isAlreadyExists(cause)) return Result.ok(sha.value);
        throw cause;
      }
      return Result.ok(sha.value);
    } catch (cause) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // ignore best-effort temp cleanup
      }
      return Result.err(
        new ObjectDecodeError({
          reason: "malformed-object",
          message: `failed to write object: ${sha.value}`,
          sha: sha.value,
          cause,
        }),
      );
    }
  }

  private decodeLooseObject(
    sha: string,
    compressed: Uint8Array,
  ): Result<GitObject, ObjectDecodeError> {
    try {
      const inflated = new Uint8Array(inflateSync(compressed));
      const nul = inflated.indexOf(0);
      if (nul < 0) throw new Error("missing loose-object header terminator");
      const header = decoder.decode(inflated.subarray(0, nul));
      const match = /^(commit|tree|blob|tag) (\d+)$/.exec(header);
      if (!match) throw new Error(`invalid loose-object header: ${header}`);
      const type = match[1] as GitObjectType;
      if (!VALID_TYPES.has(type)) throw new Error(`invalid loose-object type: ${type}`);
      const content = inflated.subarray(nul + 1);
      const expectedLength = Number(match[2]);
      if (content.length !== expectedLength) {
        throw new Error(`object size mismatch: ${content.length} != ${expectedLength}`);
      }
      return Result.ok({ type, content });
    } catch (cause) {
      return Result.err(
        new ObjectDecodeError({
          reason: "malformed-object",
          message: `failed to decode object: ${sha}`,
          sha,
          cause,
        }),
      );
    }
  }
}

export function frameObject(type: GitObjectType, content: Uint8Array): Uint8Array {
  const header = encoder.encode(`${type} ${content.length}\0`);
  const framed = new Uint8Array(header.length + content.length);
  framed.set(header);
  framed.set(content, header.length);
  return framed;
}
