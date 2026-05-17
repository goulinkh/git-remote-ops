/**
 * @module git-remote-ops
 *
 * Public entry point. Re-exports the {@link RemoteGit} client, the
 * {@link Logger}, every {@link GitRemoteOpsError} subclass, and the shared
 * type vocabulary. The CLI ships separately under `./cli`.
 */
export { RemoteGit } from "./client.ts";
export { Logger, NULL_LOGGER } from "./logger.ts";
export type { LoggerOptions, LogLevel, Metrics } from "./logger.ts";
export {
  ObjectDecodeError,
  ObjectNotFoundError,
  PackParseError,
  PathNotFoundError,
  PktLineError,
  RefNotFoundError,
  TransportError,
  UploadPackError,
} from "./errors.ts";
export type { GitRemoteOpsError } from "./errors.ts";
export type {
  CommitInfo,
  DiagnosticFn,
  FetchCommitOptions,
  GitObject,
  GitObjectMap,
  GitObjectType,
  RemoteGitOptions,
  ServerProfile,
  TreeEntry,
} from "./types.ts";
