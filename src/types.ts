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

export interface FileEntry {
  mode: string;
  path: string;
  sha: string;
}

export interface CommitInfo {
  tree: string;
  parent?: string;
  author?: string;
  committer?: string;
}

export interface ServerProfile {
  url: string;
  refs: Map<string, string>;
  advertisedCaps: Set<string>;
  supportsFilterBlobNone: boolean;
  supportsFilterTree0: boolean;
  supportsShallow: boolean;
  probed: boolean;
}

export interface RemoteGitOptions {
  diagnostic?: DiagnosticFn;
}

export type DiagnosticFn = (message: string) => void;

export interface GrepOptions {
  ref?: string;
  pathGlob?: string;
  maxMatches?: number;
  ignoreCase?: boolean;
}

export interface GrepMatch {
  path: string;
  lineNumber: number;
  line: string;
}

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
}

export interface HttpTransportResponse {
  body: Uint8Array;
  status: number;
}
