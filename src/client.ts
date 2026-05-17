/**
 * @module client
 *
 * High-level read-only Git remote client. {@link RemoteGit} composes the
 * transport, protocol, and pack layers behind a small surface: discover a
 * server, ask for commits/trees/blobs, get them back as decoded objects.
 *
 * The client caches a single {@link ServerProfile}; objects are stored in the
 * caller-supplied loose-object directory and deduped across calls by SHA.
 */
import { Result } from "better-result";
import type { GitRemoteOpsError } from "./errors.ts";
import {
  ObjectDecodeError,
  ObjectNotFoundError,
  PackParseError,
  RefNotFoundError,
} from "./errors.ts";
import { Logger } from "./logger.ts";
import type {
  CommitInfo,
  DiagnosticFn,
  FetchCommitOptions,
  GitObject,
  GitObjectType,
  PackParseScope,
  RemoteGitOptions,
  ServerProfile,
  TreeEntry,
} from "./types.ts";
import { parseCommit, parseTree } from "./objects/index.ts";
import { type ParsedPackfile, parsePackfile } from "./pack/index.ts";
import {
  buildFetchRequest,
  extractPackToFile,
  parseRefAdvertisement,
  parseV2CapabilityAdvertisement,
} from "./protocol/index.ts";
import { LooseObjectStore } from "./store.ts";
import { getSmartHttp, postUploadPack } from "./transport.ts";

/**
 * Capabilities offered on every v0 fetch unless overridden. `shallow` and
 * `filter` are appended dynamically when the corresponding feature is in use.
 *
 * - `multi_ack`: lets the server send `ACK` continuations while we're
 *   negotiating wants. Required by some servers even on a `done` short-circuit.
 * - `side-band-64k`: turns on the channel-multiplexed response framing
 *   ({@link demuxSideband} expects this).
 * - `ofs-delta`: allows the more compact offset-based delta encoding.
 * - `agent=…`: identification string, mirrored into v2's `agent=` header.
 */
const DEFAULT_CAPS = [
  "multi_ack",
  "side-band-64k",
  "ofs-delta",
  "agent=git-remote-ops-deno/0.1",
];

type PackFile = { path: string; length: number };

const TREE_RETAIN_TYPES: ReadonlySet<GitObjectType> = new Set(["commit", "tree"]);

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

/**
 * Read-only Git remote client over smart HTTP.
 *
 * One instance corresponds to one upstream `url`. Reuse it across operations
 * so the cached profile and object store can do their job; throw it away
 * when you're done with that remote.
 */
export class RemoteGit {
  readonly url: string;
  readonly logger: Logger;
  private profile: ServerProfile | null = null;
  private store: LooseObjectStore;
  private diagnostic?: DiagnosticFn;
  private transportLogger: Logger;
  private packLogger: Logger;

  /**
   * @param url Base repository URL (e.g. `https://github.com/owner/repo.git`).
   *   Trailing slashes are stripped.
   * @param options Required object store directory plus optional logger / diagnostic sink. When no
   *   logger is given, a silent logger is used. Passing `diagnostic` alone gets you a `debug` logger.
   */
  constructor(url: string, options: RemoteGitOptions) {
    this.url = url.replace(/\/+$/, "");
    this.store = new LooseObjectStore(options.storeDir);
    this.diagnostic = options.diagnostic;
    this.logger = options.logger ??
      new Logger({
        level: options.diagnostic ? "debug" : "silent",
        sink: options.diagnostic,
      }, "client");
    this.transportLogger = this.logger.child("transport");
    this.packLogger = this.logger.child("pack");
  }

  /**
   * Fetch and cache the server's ref/capability advertisement.
   *
   * Issues both a v0/v1 GET and a v2 GET. The v0 response is the source of
   * truth for refs and base capabilities; if the v2 response advertises
   * `version=2`, those caps are merged in and `protocolVersion` flips to 2.
   * Subsequent client calls hit the cached profile until `discover()` runs again.
   */
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

  /**
   * Confirm what the server *actually* honours, not just what it advertises.
   *
   * Some servers advertise `filter` but ignore it; others advertise `shallow`
   * but reject deepen requests. We send minimal-cost shallow fetches with
   * `blob:none` and `tree:0` filters and look at the returned pack to decide.
   * Sets `supportsFilterBlobNone` / `supportsFilterTree0` on the cached profile.
   *
   * @param verbose Emit raw probe outcomes through {@link RemoteGitOptions.diagnostic}.
   */
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

  /** Return a snapshot of the advertised refs (name → sha). Triggers `discover()` if needed. */
  async lsRefs(): Promise<Result<Map<string, string>, GitRemoteOpsError>> {
    const profile = this.profile ? Result.ok(this.profile) : await this.discover();
    if (profile.isErr()) return fail(profile.error);
    return Result.ok(new Map(profile.value.refs));
  }

  /**
   * Resolve `ref` to a 40-char hex sha against the cached advertisement.
   *
   * Tries the literal name, then `refs/heads/<ref>`, then `refs/tags/<ref>`.
   * A 40-char hex input is accepted as-is even when it isn't in the ad — the
   * server may still serve it as a `want`.
   */
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

  /**
   * Fetch and decode a single commit reachable from `ref`.
   *
   * `options.depth` defaults to deep fetch; pass `1` for a snapshot. Filters
   * are silently dropped if the server doesn't support them — we log an
   * info-level message in that case.
   */
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
    const fetched = await this.fetchObjects(
      [commitSha.value],
      depth,
      filter,
      options.parseScope ?? "target",
    );
    if (fetched.isErr()) return fail(fetched.error);
    const object = await this.requiredObject(commitSha.value);
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

  /** Fetch a blob by sha and return its raw contents. */
  async fetchBlob(sha: string): Promise<Result<Uint8Array, GitRemoteOpsError>> {
    const profile = this.profile ? Result.ok(this.profile) : await this.discover();
    if (profile.isErr()) return fail(profile.error);
    const fetched = await this.fetchObjects([sha]);
    if (fetched.isErr()) return fail(fetched.error);
    const object = await this.requiredObject(sha);
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

  /**
   * Fetch the commit at `ref` *and* its root tree from a single snapshot pack.
   *
   * Uses tree retention so the tree object — which the commit references but
   * doesn't `want` directly — ends up in the local object store without blobs.
   */
  async fetchTreeForCommit(
    ref: string,
    options: FetchCommitOptions = {},
  ): Promise<
    Result<{ commit: CommitInfo; commitSha: string; entries: TreeEntry[] }, GitRemoteOpsError>
  > {
    const commit = await this.fetchCommit(ref, { ...options, parseScope: "trees" });
    if (commit.isErr()) return fail(commit.error);
    const treeObject = await this.requiredObject(commit.value.commit.tree);
    if (treeObject.isErr()) return fail(treeObject.error);
    if (treeObject.value.type !== "tree") {
      return fail(
        new ObjectDecodeError({
          reason: "unexpected-object-type",
          message: `object is not a tree: ${commit.value.commit.tree}`,
          objectType: treeObject.value.type,
          sha: commit.value.commit.tree,
        }),
      );
    }
    const entries = parseTree(treeObject.value.content);
    if (entries.isErr()) return fail(entries.error);
    return Result.ok({
      commit: commit.value.commit,
      commitSha: commit.value.sha,
      entries: entries.value,
    });
  }

  /** Fetch and decode a single tree by sha. */
  async fetchTree(sha: string): Promise<Result<TreeEntry[], GitRemoteOpsError>> {
    const profile = this.profile ? Result.ok(this.profile) : await this.discover();
    if (profile.isErr()) return fail(profile.error);
    const fetched = await this.fetchObjects([sha]);
    if (fetched.isErr()) return fail(fetched.error);
    const object = await this.requiredObject(sha);
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

  /** Look up an already-materialized object by sha. Does not fetch on miss. */
  async getObject(sha: string): Promise<GitObject | undefined> {
    const object = await this.store.read(sha);
    return object.isOk() ? object.value : undefined;
  }

  private async requiredObject(sha: string): Promise<Result<GitObject, GitRemoteOpsError>> {
    const object = await this.store.read(sha);
    if (object.isErr()) return fail(object.error);
    return object;
  }

  private async fetchObjects(
    wants: string[],
    depth?: number,
    filterSpec?: string,
    parseScope: PackParseScope = "target",
  ): Promise<Result<number, GitRemoteOpsError>> {
    const normalized = await this.normalizeWants(wants, depth, filterSpec);
    if (normalized.length === 0) return Result.ok(0);
    this.logger.debug(
      `fetchObjects wants=${normalized.length} depth=${depth ?? "-"} filter=${filterSpec ?? "-"}`,
    );
    const pack = await this.fetchPack(normalized, depth, filterSpec);
    if (pack.isErr()) return fail(pack.error);
    const parseStart = performance.now();
    const targets = parseScope === "target" && normalized.length === 1
      ? new Set(normalized)
      : undefined;
    const retainTypes = parseScope === "trees" ? TREE_RETAIN_TYPES : undefined;
    const parsed = await this.parsePackFile(pack.value, { targets, retainTypes }, (sha, object) => {
      const written = this.store.writeSync(object.type, object.content);
      if (written.isErr()) {
        return Result.err(
          new PackParseError({
            reason: "store-write-failed",
            message: `failed to write object ${sha}`,
            cause: written.error,
          }),
        );
      }
      return Result.ok(undefined);
    });
    const parseMs = performance.now() - parseStart;
    if (parsed.isErr()) return fail(parsed.error);
    const counts = parsed.value.stats.byType;
    this.packLogger.recordPack({
      bytes: pack.value.length,
      durationMs: parseMs,
      byType: counts,
    });
    this.packLogger.debug(
      `parsed ${parsed.value.stats.materialized} objects, retained ${parsed.value.stats.retained} (${counts.commit}c/${counts.tree}t/${counts.blob}b/${counts.tag}T) in ${
        parseMs.toFixed(1)
      }ms`,
    );
    if (depth === 1 && filterSpec === undefined) {
      for (const sha of normalized) await this.store.markSnapshot(sha);
    }
    return Result.ok(parsed.value.stats.retained);
  }

  private async parsePackFile(
    pack: PackFile,
    options?: Parameters<typeof parsePackfile>[1],
    sink?: Parameters<typeof parsePackfile>[2],
  ): Promise<Result<ParsedPackfile, GitRemoteOpsError>> {
    try {
      const packBytes = await Deno.readFile(pack.path);
      return parsePackfile(packBytes, options, sink);
    } catch (cause) {
      return fail(
        new PackParseError({
          reason: "pack-read-failed",
          message: `failed to read pack file: ${pack.path}`,
          cause,
        }),
      );
    } finally {
      await removeIfExists(pack.path);
    }
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
      const parsed = await this.parsePackFile(blobNonePack.value);
      if (parsed.isErr()) {
        if (verbose) this.log(`filter blob:none probe failed: ${parsed.error}`);
      } else {
        const counts = parsed.value.stats.byType;
        if (verbose) this.log(`filter blob:none probe: ${counts.tree} trees, ${counts.blob} blobs`);
        profile.supportsFilterBlobNone = counts.blob === 0 ||
          counts.blob < Math.floor(counts.tree / 4);
      }
    }

    const tree0Pack = await this.fetchPack([sha], 1, "tree:0", caps);
    if (tree0Pack.isErr()) {
      if (verbose) this.log(`filter tree:0 probe failed: ${tree0Pack.error}`);
    } else {
      const parsed = await this.parsePackFile(tree0Pack.value);
      if (parsed.isErr()) {
        if (verbose) this.log(`filter tree:0 probe failed: ${parsed.error}`);
      } else {
        const counts = parsed.value.stats.byType;
        profile.supportsFilterTree0 = counts.tree === 0;
      }
    }
  }

  private async fetchPack(
    wants: string[],
    depth?: number,
    filterSpec?: string,
    caps?: string[],
  ): Promise<Result<PackFile, GitRemoteOpsError>> {
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
    const rawPath = this.store.incomingPath(".raw");
    const packPath = this.store.incomingPath(".pack");
    const response = await postUploadPack(this.url, body.value, rawPath, {
      protocolVersion,
      logger: this.transportLogger,
    });
    if (response.isErr()) return fail(response.error);
    const pack = await extractPackToFile(response.value.path, packPath, this.diagnostic);
    await removeIfExists(response.value.path);
    if (pack.isErr()) {
      await removeIfExists(packPath);
      return fail(pack.error);
    }
    this.packLogger.debug(`extracted pack: ${pack.value}B`);
    return Result.ok({ path: packPath, length: pack.value });
  }

  private async normalizeWants(
    wants: string[],
    depth?: number,
    filterSpec?: string,
  ): Promise<string[]> {
    if (depth === 1 && filterSpec === undefined) {
      const present = await Promise.all(wants.map((want) => this.store.hasSnapshot(want)));
      return present.every(Boolean) ? [] : wants;
    }
    const present = await Promise.all(wants.map((want) => this.store.has(want)));
    return wants.filter((_, index) => !present[index]);
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

async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
}
