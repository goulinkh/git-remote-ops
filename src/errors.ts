import { TaggedError } from "better-result";

export class PackParseError extends TaggedError("PackParseError")<{
  reason: string;
  message: string;
  offset?: number;
  cause?: unknown;
}>() {}

export class ObjectDecodeError extends TaggedError("ObjectDecodeError")<{
  reason: string;
  message: string;
  objectType?: string;
  sha?: string;
  cause?: unknown;
}>() {}

export class PktLineError extends TaggedError("PktLineError")<{
  reason: string;
  message: string;
  offset?: number;
  cause?: unknown;
}>() {}

export class UploadPackError extends TaggedError("UploadPackError")<{
  reason: string;
  message: string;
  cause?: unknown;
}>() {}

export class TransportError extends TaggedError("TransportError")<{
  method: string;
  url: string;
  message: string;
  status?: number;
  statusText?: string;
  cause?: unknown;
}>() {}

export class RefNotFoundError extends TaggedError("RefNotFoundError")<{
  ref: string;
  message: string;
}>() {}

export class ObjectNotFoundError extends TaggedError("ObjectNotFoundError")<{
  sha: string;
  message: string;
}>() {}

export class PathNotFoundError extends TaggedError("PathNotFoundError")<{
  path: string;
  message: string;
  treeSha?: string;
}>() {}

export type GitRemoteOpsError =
  | PackParseError
  | ObjectDecodeError
  | PktLineError
  | UploadPackError
  | TransportError
  | RefNotFoundError
  | ObjectNotFoundError
  | PathNotFoundError;
