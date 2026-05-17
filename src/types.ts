/**
 * @module types
 *
 * Public and internal type vocabulary. Anything that crosses a module
 * boundary lives here so dependents don't end up importing each other's
 * implementation files just to name a shape.
 */

/** Git's four loose-object kinds. */
export type GitObjectType = "commit" | "tree" | "blob" | "tag";

/** A reconstructed object: its kind plus its uncompressed body. */
export interface GitObject {
  type: GitObjectType;
  content: Uint8Array;
}

/** In-memory object map used by parser and tree helper APIs. */
export type GitObjectMap = Map<string, GitObject>;

/** One entry in a tree object. `sha` is hex SHA-1. */
export interface TreeEntry {
  /** Octal mode string as it appears in the tree (`"100644"`, `"40000"`, …). */
  mode: string;
  /** Entry name — last path component only. */
  name: string;
  /** Hex SHA-1 of the referenced blob or subtree. */
  sha: string;
}

/** The interesting headers from a commit object. */
export interface CommitInfo {
  /** Hex SHA-1 of the root tree. */
  tree: string;
  /** First parent only; merge commits' additional parents are dropped. */
  parent?: string;
  /** Raw `author` line (name, email, timestamp), unparsed. */
  author?: string;
  /** Raw `committer` line, unparsed. */
  committer?: string;
}

export type PackParseScope = "target" | "trees" | "all";

/** Knobs accepted by {@link RemoteGit.fetchCommit} and friends. */
export interface FetchCommitOptions {
  /** Shallow-clone depth. Server must advertise `shallow`; otherwise ignored. */
  depth?: number;
  /** Object filter spec (`"blob:none"`, `"tree:0"`, …). Ignored if unsupported. */
  filter?: string;
  /** Parser retention mode. `trees` keeps commits and trees while skipping blobs. */
  parseScope?: PackParseScope;
}

/** Cached server capability profile, populated by `discover()` + `probe()`. */
export interface ServerProfile {
  url: string;
  refs: Map<string, string>;
  advertisedCaps: Set<string>;
  /** 0 = legacy/v1, 2 = protocol v2. */
  protocolVersion: 0 | 2;
  /** Filter probe result for `blob:none` (set by {@link RemoteGit.probe}). */
  supportsFilterBlobNone: boolean;
  /** Filter probe result for `tree:0`. */
  supportsFilterTree0: boolean;
  /** Whether `shallow` appeared in the advertisement. */
  supportsShallow: boolean;
  /** Set to `true` after a successful probe so we don't re-run probes. */
  probed: boolean;
}

/** Constructor options for {@link RemoteGit}. */
export interface RemoteGitOptions {
  /** Directory where loose objects and transient pack files are stored. */
  storeDir: string;
  /** Optional callback for low-level diagnostic strings (e.g. server stderr). */
  diagnostic?: DiagnosticFn;
  /** Inject a configured {@link Logger}; otherwise one is built from `diagnostic`. */
  logger?: import("./logger.js").Logger;
}

/** Sink for free-form diagnostic strings. */
export type DiagnosticFn = (message: string) => void;

/** One decoded pkt-line. `payload === null` marks a flush/delim/response-end. */
export interface PktLine {
  /** Byte offset of the byte just after this frame. */
  offset: number;
  /** Payload bytes (subarray view into the source buffer), or `null` for control. */
  payload: Uint8Array | null;
}

/** Generic `value + cursor advance` carrier returned by streaming readers. */
export interface ReadResult<T> {
  value: T;
  offset: number;
}

/** One decoded pack object header. `type` is a pack type code, not a string. */
export interface PackObjectHeader {
  type: number;
  size: number;
  offset: number;
}

/** Output of {@link parseRefAdvertisement}. */
export interface ParsedRefAdvertisement {
  refs: Map<string, string>;
  capabilities: Set<string>;
}

/** Channel-segregated outputs from sideband demultiplexing. */
export interface SidebandData {
  pack: Uint8Array;
  progress: Uint8Array;
  errors: Uint8Array;
}

/** Inputs to {@link buildFetchRequest}. */
export interface FetchRequestOptions {
  wants: string[];
  caps: string[];
  depth?: number;
  filterSpec?: string;
  protocolVersion?: 0 | 2;
}

/** What the transport layer returns to the protocol layer. */
export interface HttpTransportResponse {
  body: Uint8Array;
  status: number;
}

/** What streaming transport returns after writing a response to disk. */
export interface HttpFileTransportResponse {
  path: string;
  length: number;
  status: number;
}

/** Mixed into transport options; controls the `Git-Protocol` header. */
export interface GitProtocolOptions {
  protocolVersion?: 0 | 2;
}
