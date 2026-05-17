import { Result } from "better-result";
import type { GitRemoteOpsError } from "./errors.ts";
import { ObjectDecodeError, ObjectNotFoundError, RefNotFoundError } from "./errors.ts";
import { Logger } from "./logger.ts";
import type {
  CommitInfo,
  DiagnosticFn,
  FetchCommitOptions,
  GitObject,
  GitObjectMap,
  RemoteGitOptions,
  ServerProfile,
  TreeEntry,
} from "./types.ts";
import { parseCommit, parseTree } from "./objects/index.ts";
import { parsePackfile } from "./pack/index.ts";
import {
  buildFetchRequest,
  extractPack,
  parseRefAdvertisement,
  parseV2CapabilityAdvertisement,
} from "./protocol/index.ts";
import { getSmartHttp, postUploadPack } from "./transport.ts";

const DEFAULT_CAPS = [
  "multi_ack",
  "side-band-64k",
  "ofs-delta",
  "agent=git-remote-ops-deno/0.1",
];

function fail<T>(error: GitRemoteOpsError): Result<T, GitRemoteOpsError> {
  return Result.err<T, GitRemoteOpsError>(error);
}

function buildCaps(opts: { shallow?: boolean; filter?: boolean } = {}): string[] {
  return [
    ...DEFAULT_CAPS,
    ...(opts.shallow ? ["shallow"] : []),
    ...(opts.filter ? ["filter"] : []),
  ];
}

export class RemoteGit {
  readonly url: string;
  readonly logger: Logger;
  private profile: ServerProfile | null = null;
  private objects: GitObjectMap = new Map();
  private snapshotCommits = new Set<string>();
  private diagnostic?: DiagnosticFn;
  private transportLogger: Logger;
  private packLogger: Logger;

  constructor(url: string, options?: RemoteGitOptions) {
    this.url = url.replace(/\/+$/, "");
    this.diagnostic = options?.diagnostic;
    this.logger = options?.logger ??
      new Logger({
        level: options?.diagnostic ? "debug" : "silent",
        sink: options?.diagnostic,
      }, "client");
    this.transportLogger = this.logger.child("transport");
    this.packLogger = this.logger.child("pack");
  }

  async discover(): Promise<Result<ServerProfile, GitRemoteOpsError>> {
    this.logger.info(`discover ${this.url}`);
    const response = await getSmartHttp(this.url, "/info/refs?service=git-upload-pack", {
      logger: this.transportLogger,
    });
    if (response.isErr()) return fail(response.error);
    const parsed = parseRefAdvertisement(response.value.body);
    if (parsed.isErr()) return fail(parsed.error);

    let protocolVersion: 0 | 2 = 0;
    const capabilities = new Set(parsed.value.capabilities);
    const v2Response = await getSmartHttp(this.url, "/info/refs?service=git-upload-pack", {
      protocolVersion: 2,
      logger: this.transportLogger,
    });
    if (v2Response.isOk()) {
      const parsedV2 = parseV2CapabilityAdvertisement(v2Response.value.body);
      if (parsedV2.isOk() && parsedV2.value.has("version=2")) {
        protocolVersion = 2;
        for (const cap of parsedV2.value) capabilities.add(cap);
      }
    }

    this.profile = {
      url: this.url,
      refs: parsed.value.refs,
      advertisedCaps: capabilities,
      protocolVersion,
      supportsFilterBlobNone: false,
      supportsFilterTree0: false,
      supportsShallow: capabilities.has("shallow"),
      probed: false,
    };
    return Result.ok(this.profile);
  }

  async probe(verbose = false): Promise<Result<ServerProfile, GitRemoteOpsError>> {
    const profileResult = this.profile ? Result.ok(this.profile) : await this.discover();
    if (profileResult.isErr()) return fail(profileResult.error);
    const profile = profileResult.value;
    if (profile.probed) {
      return Result.ok(profile);
    }
    profile.supportsShallow = profile.advertisedCaps.has("shallow");
    const advertisesFilter = profile.advertisedCaps.has("filter");
    const targetSha = this.pickProbeSha(profile);
    if (targetSha.isErr()) return fail(targetSha.error);
    if (advertisesFilter) {
      await this.probeFilter(profile, targetSha.value, verbose);
    }
    profile.probed = true;
    return Result.ok(profile);
  }

  async lsRefs(): Promise<Result<Map<string, string>, GitRemoteOpsError>> {
    const profile = this.profile ? Result.ok(this.profile) : await this.discover();
    if (profile.isErr()) return fail(profile.error);
    return Result.ok(new Map(profile.value.refs));
  }

  async resolveRef(ref: string): Promise<Result<string, GitRemoteOpsError>> {
    const profile = this.profile ? Result.ok(this.profile) : await this.discover();
    if (profile.isErr()) return fail(profile.error);
    for (const candidate of [ref, `refs/heads/${ref}`, `refs/tags/${ref}`]) {
      const sha = profile.value.refs.get(candidate);
      if (sha) {
        return Result.ok(sha);
      }
    }
    if (/^[0-9a-f]{40}$/.test(ref)) {
      return Result.ok(ref);
    }
    return fail(new RefNotFoundError({ ref, message: `ref not found: ${ref}` }));
  }

  async fetchCommit(
    ref: string,
    options: FetchCommitOptions = {},
  ): Promise<Result<{ commit: CommitInfo; sha: string }, GitRemoteOpsError>> {
    const profile = this.profile ? Result.ok(this.profile) : await this.discover();
    if (profile.isErr()) return fail(profile.error);
    const commitSha = await this.resolveRef(ref);
    if (commitSha.isErr()) return fail(commitSha.error);
    const depth = options.depth !== undefined && profile.value.supportsShallow
      ? options.depth
      : undefined;
    const filter = options.filter !== undefined && profile.value.advertisedCaps.has("filter")
      ? options.filter
      : undefined;
    if (options.filter !== undefined && filter === undefined) {
      this.logger.info(
        `server does not advertise object filters; fetching without ${options.filter}`,
      );
    }
    const objects = await this.fetchObjects(
      [commitSha.value],
      depth,
      filter,
      options.parseFull === true,
    );
    if (objects.isErr()) return fail(objects.error);
    const object = requiredObject(objects.value, commitSha.value);
    if (object.isErr()) return fail(object.error);
    if (object.value.type !== "commit") {
      return fail(
        new ObjectDecodeError({
          reason: "unexpected-object-type",
          message: `object is not a commit: ${commitSha.value}`,
          objectType: object.value.type,
          sha: commitSha.value,
        }),
      );
    }
    const commit = parseCommit(object.value.content);
    if (commit.isErr()) return fail(commit.error);
    return Result.ok({ commit: commit.value, sha: commitSha.value });
  }

  async fetchBlob(sha: string): Promise<Result<Uint8Array, GitRemoteOpsError>> {
    const profile = this.profile ? Result.ok(this.profile) : await this.discover();
    if (profile.isErr()) return fail(profile.error);
    const objects = await this.fetchObjects([sha]);
    if (objects.isErr()) return fail(objects.error);
    const object = requiredObject(objects.value, sha);
    if (object.isErr()) return fail(object.error);
    if (object.value.type !== "blob") {
      return fail(
        new ObjectDecodeError({
          reason: "unexpected-object-type",
          message: `object is not a blob: ${sha}`,
          objectType: object.value.type,
          sha,
        }),
      );
    }
    return Result.ok(object.value.content);
  }

  async fetchTreeForCommit(
    ref: string,
    options: FetchCommitOptions = {},
  ): Promise<
    Result<{ commit: CommitInfo; commitSha: string; entries: TreeEntry[] }, GitRemoteOpsError>
  > {
    const commit = await this.fetchCommit(ref, { ...options, parseFull: true });
    if (commit.isErr()) return fail(commit.error);
    const treeObject = this.objects.get(commit.value.commit.tree);
    if (!treeObject) {
      return fail(
        new ObjectNotFoundError({
          sha: commit.value.commit.tree,
          message: `tree ${commit.value.commit.tree} not present in snapshot pack`,
        }),
      );
    }
    if (treeObject.type !== "tree") {
      return fail(
        new ObjectDecodeError({
          reason: "unexpected-object-type",
          message: `object is not a tree: ${commit.value.commit.tree}`,
          objectType: treeObject.type,
          sha: commit.value.commit.tree,
        }),
      );
    }
    const entries = parseTree(treeObject.content);
    if (entries.isErr()) return fail(entries.error);
    return Result.ok({
      commit: commit.value.commit,
      commitSha: commit.value.sha,
      entries: entries.value,
    });
  }

  async fetchTree(sha: string): Promise<Result<TreeEntry[], GitRemoteOpsError>> {
    const profile = this.profile ? Result.ok(this.profile) : await this.discover();
    if (profile.isErr()) return fail(profile.error);
    const objects = await this.fetchObjects([sha]);
    if (objects.isErr()) return fail(objects.error);
    const object = requiredObject(objects.value, sha);
    if (object.isErr()) return fail(object.error);
    if (object.value.type !== "tree") {
      return fail(
        new ObjectDecodeError({
          reason: "unexpected-object-type",
          message: `object is not a tree: ${sha}`,
          objectType: object.value.type,
          sha,
        }),
      );
    }
    const tree = parseTree(object.value.content);
    if (tree.isErr()) return fail(tree.error);
    return Result.ok(tree.value);
  }

  getObject(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  private async fetchObjects(
    wants: string[],
    depth?: number,
    filterSpec?: string,
    parseFull = false,
  ): Promise<Result<GitObjectMap, GitRemoteOpsError>> {
    const normalized = this.normalizeWants(wants, depth, filterSpec);
    if (normalized.length === 0) {
      return Result.ok(this.objects);
    }
    this.logger.debug(
      `fetchObjects wants=${normalized.length} depth=${depth ?? "-"} filter=${filterSpec ?? "-"}`,
    );
    const pack = await this.fetchPack(normalized, depth, filterSpec);
    if (pack.isErr()) return fail(pack.error);
    const parseStart = performance.now();
    const targets = !parseFull && normalized.length === 1 ? new Set(normalized) : undefined;
    const parsed = parsePackfile(pack.value, targets);
    const parseMs = performance.now() - parseStart;
    if (parsed.isErr()) return fail(parsed.error);
    const counts = countByType(parsed.value);
    this.packLogger.recordPack({
      bytes: pack.value.length,
      durationMs: parseMs,
      byType: counts,
    });
    this.packLogger.debug(
      `parsed ${parsed.value.size} objects (${counts.commit}c/${counts.tree}t/${counts.blob}b/${counts.tag}T) in ${
        parseMs.toFixed(1)
      }ms`,
    );
    for (const [sha, object] of parsed.value) {
      this.objects.set(sha, object);
    }
    if (depth === 1 && filterSpec === undefined) {
      for (const sha of normalized) this.snapshotCommits.add(sha);
    }
    return Result.ok(this.objects);
  }

  private async probeFilter(
    profile: ServerProfile,
    sha: string,
    verbose: boolean,
  ): Promise<void> {
    const caps = buildCaps({ shallow: true, filter: true });

    const blobNonePack = await this.fetchPack([sha], 1, "blob:none", caps);
    if (blobNonePack.isErr()) {
      if (verbose) this.log(`filter blob:none probe failed: ${blobNonePack.error}`);
    } else {
      const parsed = parsePackfile(blobNonePack.value);
      if (parsed.isErr()) {
        if (verbose) this.log(`filter blob:none probe failed: ${parsed.error}`);
      } else {
        const counts = countByType(parsed.value);
        if (verbose) this.log(`filter blob:none probe: ${counts.tree} trees, ${counts.blob} blobs`);
        profile.supportsFilterBlobNone = counts.blob === 0 ||
          counts.blob < Math.floor(counts.tree / 4);
      }
    }

    const tree0Pack = await this.fetchPack([sha], 1, "tree:0", caps);
    if (tree0Pack.isErr()) {
      if (verbose) this.log(`filter tree:0 probe failed: ${tree0Pack.error}`);
    } else {
      const parsed = parsePackfile(tree0Pack.value);
      if (parsed.isErr()) {
        if (verbose) this.log(`filter tree:0 probe failed: ${parsed.error}`);
      } else {
        const counts = countByType(parsed.value);
        profile.supportsFilterTree0 = counts.tree === 0;
      }
    }
  }

  private async fetchPack(
    wants: string[],
    depth?: number,
    filterSpec?: string,
    caps?: string[],
  ): Promise<Result<Uint8Array, GitRemoteOpsError>> {
    const protocolVersion = this.profile?.protocolVersion ?? 0;
    const requestCaps = caps ?? buildCaps({
      shallow: depth !== undefined,
      filter: filterSpec !== undefined,
    });
    const body = buildFetchRequest({
      wants,
      caps: requestCaps,
      depth,
      filterSpec,
      protocolVersion,
    });
    if (body.isErr()) return fail(body.error);
    const response = await postUploadPack(this.url, body.value, {
      protocolVersion,
      logger: this.transportLogger,
    });
    if (response.isErr()) return fail(response.error);
    const pack = extractPack(response.value.body, this.diagnostic);
    if (pack.isErr()) return fail(pack.error);
    this.packLogger.debug(`extracted pack: ${pack.value.length}B`);
    return Result.ok(pack.value);
  }

  private normalizeWants(wants: string[], depth?: number, filterSpec?: string): string[] {
    if (depth === 1 && filterSpec === undefined) {
      return wants.every((want) => this.snapshotCommits.has(want)) ? [] : wants;
    }
    return wants.filter((want) => !this.objects.has(want));
  }

  private pickProbeSha(profile: ServerProfile): Result<string, GitRemoteOpsError> {
    for (const ref of ["HEAD", "refs/heads/main", "refs/heads/master"]) {
      const sha = profile.refs.get(ref);
      if (sha) return Result.ok(sha);
    }
    const next = profile.refs.values().next();
    if (!next.done) return Result.ok(next.value);
    return fail(new ObjectNotFoundError({ sha: "", message: "no refs available for probe" }));
  }

  private log(message: string): void {
    this.diagnostic?.(message);
  }
}

function requiredObject(objects: GitObjectMap, sha: string): Result<GitObject, GitRemoteOpsError> {
  const object = objects.get(sha);
  if (!object) {
    return fail(new ObjectNotFoundError({ sha, message: `object not found: ${sha}` }));
  }
  return Result.ok(object);
}

function countByType(objects: GitObjectMap): Record<"commit" | "tree" | "blob" | "tag", number> {
  const counts = { commit: 0, tree: 0, blob: 0, tag: 0 };
  for (const obj of objects.values()) counts[obj.type]++;
  return counts;
}
