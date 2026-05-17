export type GitObjectType = "commit" | "tree" | "blob" | "tag";

export interface GitObject {
  type: GitObjectType;
  content: Uint8Array;
}

export type GitObjectMap = Map<string, GitObject>;

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface CommitInfo {
  tree: string;
  parent?: string;
  author?: string;
  committer?: string;
}

export interface FetchCommitOptions {
  depth?: number;
  filter?: string;
  parseFull?: boolean;
}

export interface ServerProfile {
  url: string;
  refs: Map<string, string>;
  advertisedCaps: Set<string>;
  protocolVersion: 0 | 2;
  supportsFilterBlobNone: boolean;
  supportsFilterTree0: boolean;
  supportsShallow: boolean;
  probed: boolean;
}

export interface RemoteGitOptions {
  diagnostic?: DiagnosticFn;
  logger?: import("./logger.ts").Logger;
}

export type DiagnosticFn = (message: string) => void;

export interface PktLine {
  offset: number;
  payload: Uint8Array | null;
}

export interface ReadResult<T> {
  value: T;
  offset: number;
}

export interface PackObjectHeader {
  type: number;
  size: number;
  offset: number;
}

export interface ParsedRefAdvertisement {
  refs: Map<string, string>;
  capabilities: Set<string>;
}

export interface SidebandData {
  pack: Uint8Array;
  progress: Uint8Array;
  errors: Uint8Array;
}

export interface FetchRequestOptions {
  wants: string[];
  caps: string[];
  depth?: number;
  filterSpec?: string;
  protocolVersion?: 0 | 2;
}

export interface HttpTransportResponse {
  body: Uint8Array;
  status: number;
}

export interface GitProtocolOptions {
  protocolVersion?: 0 | 2;
}
