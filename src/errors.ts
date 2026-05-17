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
import { TaggedError } from "better-result";

/** Anything that goes wrong while parsing a packfile or applying a delta. */
export class PackParseError extends TaggedError("PackParseError")<{
  reason: string;
  message: string;
  offset?: number;
  cause?: unknown;
}>() {}

/** Raised when a commit/tree body fails structural validation. */
export class ObjectDecodeError extends TaggedError("ObjectDecodeError")<{
  reason: string;
  message: string;
  objectType?: string;
  sha?: string;
  cause?: unknown;
}>() {}

/** Malformed pkt-line framing (bad length prefix or truncation). */
export class PktLineError extends TaggedError("PktLineError")<{
  reason: string;
  message: string;
  offset?: number;
  cause?: unknown;
}>() {}

/** Server returned a `git-upload-pack` response we couldn't interpret. */
export class UploadPackError extends TaggedError("UploadPackError")<{
  reason: string;
  message: string;
  cause?: unknown;
}>() {}

/** Anything HTTP — network failure, non-2xx status, body-read error. */
export class TransportError extends TaggedError("TransportError")<{
  method: string;
  url: string;
  message: string;
  status?: number;
  statusText?: string;
  cause?: unknown;
}>() {}

/** The requested ref didn't appear in the server's advertisement. */
export class RefNotFoundError extends TaggedError("RefNotFoundError")<{
  ref: string;
  message: string;
}>() {}

/** An object referenced by sha wasn't present in the materialized store. */
export class ObjectNotFoundError extends TaggedError("ObjectNotFoundError")<{
  sha: string;
  message: string;
}>() {}

/** Tree-walk couldn't reach the requested path. */
export class PathNotFoundError extends TaggedError("PathNotFoundError")<{
  path: string;
  message: string;
  treeSha?: string;
}>() {}

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
