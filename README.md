# git-remote-ops

Read-only Git remote operations over smart HTTP.

Fetch commit metadata, trees, file lists, or blobs from a remote Git repository without cloning and without shelling out to `git`.

## Install

```bash
npm install git-remote-ops
```

Run CLI without installing into project:

```bash
npx git-remote-ops --help
```

## CLI

Every command needs `--store-dir`. Reuse same directory to avoid re-downloading objects.

```bash
git-remote-ops --store-dir /tmp/git-remote-ops-cache ls-refs https://github.com/owner/repo.git
```

```bash
git-remote-ops --store-dir /tmp/git-remote-ops-cache \
  cat-commit https://github.com/owner/repo.git --ref main
```

```bash
git-remote-ops --store-dir /tmp/git-remote-ops-cache \
  list-files https://github.com/owner/repo.git --ref main
```

```bash
git-remote-ops --store-dir /tmp/git-remote-ops-cache \
  cat-blob https://github.com/owner/repo.git <blob-sha> > file.bin
```

Commands:

```text
probe       <url>
ls-refs     <url>
cat-commit  <url> [--ref HEAD] [--depth 1] [--filter blob:none | --no-filter]
cat-tree    <url> [--ref HEAD] [--depth 1] [--filter blob:none | --no-filter] [--tree-sha <sha>]
list-files  <url> [--ref HEAD] [--depth 1] [--filter blob:none | --no-filter] [--details]
cat-blob    <url> <blob-sha>
```

See [`docs/cli.md`](docs/cli.md) for full CLI reference.

## API

```ts
import { RemoteGit } from "git-remote-ops";

const git = new RemoteGit("https://github.com/owner/repo.git", {
  storeDir: "/tmp/git-remote-ops-cache",
});

const commit = await git.fetchCommit("HEAD", {
  depth: 1,
  filter: "blob:none",
});
if (commit.isErr()) throw commit.error;

const tree = await git.fetchTree(commit.value.commit.tree);
if (tree.isErr()) throw tree.error;

console.log(tree.value);
```

```ts
const files = await git.fetchTreeForCommit("main", {
  depth: 1,
  filter: "blob:none",
});

if (files.isOk()) {
  for (const entry of files.value.entries) {
    console.log(entry.mode, entry.sha, entry.name);
  }
}
```

```ts
const blob = await git.fetchBlob("<blob-sha>");
if (blob.isOk()) {
  await writeFile("file.bin", blob.value);
}
```

Core methods:

```ts
await git.probe();
await git.lsRefs();
await git.resolveRef(ref);
await git.fetchCommit(ref, options?);
await git.fetchTree(treeSha);
await git.fetchTreeForCommit(ref, options?);
await git.fetchBlob(blobSha);
await git.getObject(sha);
```

All public methods return `Result<T, GitRemoteOpsError>` from `better-result`.

## Cache

`storeDir` persists fetched Git objects. Reuse it across calls or CLI runs.

## Limits

Fetch only. No push, checkout, ref writes, or full clone management.

## License

MIT. See [`LICENSE`](LICENSE).
