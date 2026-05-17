/**
 * @module errors
 *
 * Tagged error classes returned (never thrown) from every public function.
 *
 * Each class wraps `better-result`'s `TaggedError` so failures carry a
 * narrowable `_tag` field plus structured context (offsets, sha, http
 * status, etc.). The {@link GitRemoteOpsError} union sweeps them up for
 * `Result<T, GitRemoteOpsError>` return types throughout the public API.
 *
 * A `cause` field, when present, is the underlying thrown value preserved
 * for `Error.cause`-style chaining.
 */
import { TaggedError, type TaggedErrorClass } from "better-result";

const PackParseErrorBase: TaggedErrorClass<"PackParseError", {
  reason: string;
  message: string;
  offset?: number;
  cause?: unknown;
}> = TaggedError("PackParseError")();

/** Anything that goes wrong while parsing a packfile or applying a delta. */
export class PackParseError extends PackParseErrorBase {}

const ObjectDecodeErrorBase: TaggedErrorClass<"ObjectDecodeError", {
  reason: string;
  message: string;
  objectType?: string;
  sha?: string;
  cause?: unknown;
}> = TaggedError("ObjectDecodeError")();

/** Raised when a commit/tree body fails structural validation. */
export class ObjectDecodeError extends ObjectDecodeErrorBase {}

const PktLineErrorBase: TaggedErrorClass<"PktLineError", {
  reason: string;
  message: string;
  offset?: number;
  cause?: unknown;
}> = TaggedError("PktLineError")();

/** Malformed pkt-line framing (bad length prefix or truncation). */
export class PktLineError extends PktLineErrorBase {}

const UploadPackErrorBase: TaggedErrorClass<"UploadPackError", {
  reason: string;
  message: string;
  cause?: unknown;
}> = TaggedError("UploadPackError")();

/** Server returned a `git-upload-pack` response we couldn't interpret. */
export class UploadPackError extends UploadPackErrorBase {}

const TransportErrorBase: TaggedErrorClass<"TransportError", {
  method: string;
  url: string;
  message: string;
  status?: number;
  statusText?: string;
  cause?: unknown;
}> = TaggedError("TransportError")();

/** Anything HTTP — network failure, non-2xx status, body-read error. */
export class TransportError extends TransportErrorBase {}

const RefNotFoundErrorBase: TaggedErrorClass<"RefNotFoundError", {
  ref: string;
  message: string;
}> = TaggedError("RefNotFoundError")();

/** The requested ref didn't appear in the server's advertisement. */
export class RefNotFoundError extends RefNotFoundErrorBase {}

const ObjectNotFoundErrorBase: TaggedErrorClass<"ObjectNotFoundError", {
  sha: string;
  message: string;
}> = TaggedError("ObjectNotFoundError")();

/** An object referenced by sha wasn't present in the materialized store. */
export class ObjectNotFoundError extends ObjectNotFoundErrorBase {}

const PathNotFoundErrorBase: TaggedErrorClass<"PathNotFoundError", {
  path: string;
  message: string;
  treeSha?: string;
}> = TaggedError("PathNotFoundError")();

/** Tree-walk couldn't reach the requested path. */
export class PathNotFoundError extends PathNotFoundErrorBase {}

/** Discriminated union of every error this library returns. */
export type GitRemoteOpsError =
  | PackParseError
  | ObjectDecodeError
  | PktLineError
  | UploadPackError
  | TransportError
  | RefNotFoundError
  | ObjectNotFoundError
  | PathNotFoundError;
