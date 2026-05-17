/**
 * @module git-remote-ops
 *
 * Public entry point. Re-exports the {@link RemoteGit} client, the
 * {@link Logger}, every {@link GitRemoteOpsError} subclass, and the shared
 * type vocabulary. The CLI ships separately under `./cli`.
 */
export { RemoteGit } from "./client.js";
export { Logger, NULL_LOGGER } from "./logger.js";
export { LooseObjectStore } from "./store.js";
export type { LoggerOptions, LogLevel, Metrics } from "./logger.js";
export {
  ObjectDecodeError,
  ObjectNotFoundError,
  PackParseError,
  PathNotFoundError,
  PktLineError,
  RefNotFoundError,
  TransportError,
  UploadPackError,
} from "./errors.js";
export type { GitRemoteOpsError } from "./errors.js";
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
} from "./types.js";
