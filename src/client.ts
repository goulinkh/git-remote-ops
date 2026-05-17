import { Result } from "better-result";
import type { GitRemoteOpsError } from "./errors.ts";
import { ObjectDecodeError, ObjectNotFoundError, RefNotFoundError } from "./errors.ts";
import type {
  CommitInfo,
  DiagnosticFn,
  FileEntry,
  GitObject,
  GitObjectMap,
  GrepMatch,
  GrepOptions,
  RemoteGitOptions,
  ServerProfile,
} from "./types.ts";
import { parseCommit, resolvePathToBlob, walkTree } from "./objects/index.ts";
import { parsePackfile } from "./pack/index.ts";
import { buildFetchRequest, extractPack, parseRefAdvertisement } from "./protocol/index.ts";
import { getSmartHttp, postUploadPack } from "./transport.ts";
import { matchesGlob } from "./utils/glob.ts";

const decoder = new TextDecoder();

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
  private profile: ServerProfile | null = null;
  private objects: GitObjectMap = new Map();
  private snapshotCommits = new Set<string>();
  private diagnostic?: DiagnosticFn;

  constructor(url: string, options?: RemoteGitOptions) {
    this.url = url.replace(/\/+$/, "");
    this.diagnostic = options?.diagnostic;
  }

  async discover(): Promise<Result<ServerProfile, GitRemoteOpsError>> {
    const response = await getSmartHttp(this.url, "/info/refs?service=git-upload-pack");
    if (response.isErr()) return fail(response.error);
    const parsed = parseRefAdvertisement(response.value.body);
    if (parsed.isErr()) return fail(parsed.error);
    this.profile = {
      url: this.url,
      refs: parsed.value.refs,
      advertisedCaps: parsed.value.capabilities,
      supportsFilterBlobNone: false,
      supportsFilterTree0: false,
      supportsShallow: false,
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
    if (!profile.supportsFilterBlobNone) {
      await this.probeShallow(profile, targetSha.value, verbose);
    }
    profile.probed = true;
    return Result.ok(profile);
  }

  async lsRefs(): Promise<Result<Map<string, string>, GitRemoteOpsError>> {
    const profile = this.profile ? Result.ok(this.profile) : await this.discover();
    if (profile.isErr()) return fail(profile.error);
    return Result.ok(new Map(profile.value.refs));
  }

  private async loadCommit(
    ref: string,
  ): Promise<
    Result<{ profile: ServerProfile; objects: GitObjectMap; commit: CommitInfo }, GitRemoteOpsError>
  > {
    const profile = this.profile ? Result.ok(this.profile) : await this.probe();
    if (profile.isErr()) return fail(profile.error);
    const commitSha = await this.resolveRef(ref);
    if (commitSha.isErr()) return fail(commitSha.error);
    const filter = profile.value.supportsFilterBlobNone ? "blob:none" : undefined;
    const objects = await this.fetchObjects([commitSha.value], 1, filter);
    if (objects.isErr()) return fail(objects.error);
    const object = requiredObject(objects.value, commitSha.value);
    if (object.isErr()) return fail(object.error);
    const commit = parseCommit(object.value.content);
    if (commit.isErr()) return fail(commit.error);
    return Result.ok({ profile: profile.value, objects: objects.value, commit: commit.value });
  }

  async listFiles(ref = "HEAD", pathPrefix = ""): Promise<Result<FileEntry[], GitRemoteOpsError>> {
    const loaded = await this.loadCommit(ref);
    if (loaded.isErr()) return fail(loaded.error);
    const prefix = pathPrefix.replace(/^\/+|\/+$/g, "");
    const files = walkTree(loaded.value.objects, loaded.value.commit.tree);
    if (files.isErr()) return fail(files.error);
    return Result.ok(
      prefix
        ? files.value.filter((file) => file.path === prefix || file.path.startsWith(`${prefix}/`))
        : files.value,
    );
  }

  async readFile(path: string, ref = "HEAD"): Promise<Result<Uint8Array, GitRemoteOpsError>> {
    const loaded = await this.loadCommit(ref);
    if (loaded.isErr()) return fail(loaded.error);
    const blobSha = resolvePathToBlob(loaded.value.objects, loaded.value.commit.tree, path);
    if (blobSha.isErr()) return fail(blobSha.error);
    if (loaded.value.profile.supportsFilterBlobNone) {
      const fetched = await this.fetchObjects([blobSha.value]);
      if (fetched.isErr()) return fail(fetched.error);
    }
    const object = requiredObject(this.objects, blobSha.value);
    if (object.isErr()) return fail(object.error);
    return Result.ok(object.value.content);
  }

  async grep(
    pattern: string | RegExp,
    options: GrepOptions = {},
  ): Promise<Result<GrepMatch[], GitRemoteOpsError>> {
    const loaded = await this.loadCommit(options.ref ?? "HEAD");
    if (loaded.isErr()) return fail(loaded.error);
    const regex = typeof pattern === "string"
      ? Result.try({
        try: () => new RegExp(pattern, options.ignoreCase ? "i" : ""),
        catch: (cause) =>
          new ObjectDecodeError({
            reason: "invalid-grep-pattern",
            message: `invalid grep pattern: ${pattern}`,
            cause,
          }),
      })
      : Result.ok(pattern);
    if (regex.isErr()) return fail(regex.error);
    let entries = walkTree(loaded.value.objects, loaded.value.commit.tree);
    if (entries.isErr()) return fail(entries.error);
    if (options.pathGlob) {
      entries = Result.ok(
        entries.value.filter((entry) => matchesGlob(entry.path, options.pathGlob!)),
      );
    }
    if (loaded.value.profile.supportsFilterBlobNone) {
      const blobs = entries.value.map((entry) => entry.sha);
      if (blobs.length > 0) {
        this.log(`grep: fetching ${blobs.length} blobs after path filtering`);
        const fetched = await this.fetchObjects(blobs);
        if (fetched.isErr()) return fail(fetched.error);
      }
    }
    const maxMatches = options.maxMatches ?? 100;
    const matches: GrepMatch[] = [];
    for (const entry of entries.value) {
      const object = this.objects.get(entry.sha);
      if (!object || object.type !== "blob") {
        continue;
      }
      matches.push(
        ...grepBlob(entry.path, object.content, regex.value, maxMatches - matches.length),
      );
      if (matches.length >= maxMatches) {
        break;
      }
    }
    return Result.ok(matches);
  }

  private async resolveRef(ref: string): Promise<Result<string, GitRemoteOpsError>> {
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

  private async fetchObjects(
    wants: string[],
    depth?: number,
    filterSpec?: string,
  ): Promise<Result<GitObjectMap, GitRemoteOpsError>> {
    const normalized = this.normalizeWants(wants, depth, filterSpec);
    if (normalized.length === 0) {
      return Result.ok(this.objects);
    }
    const pack = await this.fetchPack(normalized, depth, filterSpec);
    if (pack.isErr()) return fail(pack.error);
    const parsed = parsePackfile(pack.value);
    if (parsed.isErr()) return fail(parsed.error);
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

  private async probeShallow(
    profile: ServerProfile,
    sha: string,
    verbose: boolean,
  ): Promise<void> {
    const depth = profile.supportsShallow ? 1 : undefined;
    const pack = await this.fetchPack([sha], depth, undefined, buildCaps({ shallow: !!depth }));
    if (pack.isErr()) {
      if (verbose) this.log(`shallow probe failed: ${pack.error}`);
      return;
    }
    profile.supportsShallow = true;
  }

  private async fetchPack(
    wants: string[],
    depth?: number,
    filterSpec?: string,
    caps?: string[],
  ): Promise<Result<Uint8Array, GitRemoteOpsError>> {
    const requestCaps = caps ?? buildCaps({
      shallow: depth !== undefined,
      filter: filterSpec !== undefined,
    });
    const body = buildFetchRequest({ wants, caps: requestCaps, depth, filterSpec });
    if (body.isErr()) return fail(body.error);
    const response = await postUploadPack(this.url, body.value);
    if (response.isErr()) return fail(response.error);
    const pack = extractPack(response.value.body, this.diagnostic);
    if (pack.isErr()) return fail(pack.error);
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

function grepBlob(path: string, content: Uint8Array, regex: RegExp, limit: number): GrepMatch[] {
  if (limit <= 0 || content.subarray(0, 8192).includes(0)) {
    return [];
  }
  const lines = decoder.decode(content).split("\n");
  const matches: GrepMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matches.push({ path, lineNumber: i + 1, line: lines[i] });
      if (matches.length >= limit) {
        break;
      }
    }
  }
  return matches;
}
