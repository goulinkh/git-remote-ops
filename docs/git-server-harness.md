<!-- Generated 2026-05-17 from approved plan for git smart-HTTP compatibility testing. Edit when harness design changes. -->

# git-server-harness

**Generated:** 2026-05-17 | **Scope:** integration test infrastructure | **Runtime:** OCI (`podman`
preferred, `docker` fallback)

## OVERVIEW

Integration harness for testing `RemoteGit` against smart-HTTP git servers across old and modern git
versions. Replaces single host `git http-backend` behavior with per-profile OCI containers running
distro-pinned git behind `nginx + fcgiwrap`.

Primary goal: catch git-version and platform-default differences that current local harness hides.

## STRUCTURE

```text
testing/
├── docker/
│   ├── _shared/
│   │   ├── nginx.conf              # Shared smart-HTTP CGI routing
│   │   └── entrypoint.sh           # Starts fcgiwrap + nginx
│   ├── launchpad-turnip/
│   │   └── Dockerfile              # Ubuntu 20.04, git 2.25.x
│   ├── github/
│   │   └── Dockerfile              # Ubuntu 24.04, git 2.43.x
│   ├── gitlab/
│   │   └── Dockerfile              # Ubuntu 22.04, git 2.34.x
│   ├── forgejo/
│   │   └── Dockerfile              # Alpine 3.20, git 2.45.x
│   └── build.sh                    # Builds all profile images via selected OCI runtime
├── oci.ts                          # Selects podman/docker, hard-fails if missing
├── containers.ts                   # Starts/stops profile containers
├── profiles.ts                     # Declarative compatibility profile matrix
├── repositories.ts                 # Creates deterministic repos and applies config
└── git_server.ts                   # Existing fast in-process harness, fast local

src/testing/integration/
└── remote_git.test.ts              # Runs RemoteGit behavior against all profiles
```

## WHERE TO LOOK

| Task                         | Location                                     | Notes                                      |
| ---------------------------- | -------------------------------------------- | ------------------------------------------ |
| Add platform profile         | `testing/profiles.ts`                        | Add one declarative matrix row             |
| Change git version           | `testing/docker/<profile>/Dockerfile`        | One Dockerfile per environment             |
| Change smart-HTTP routing    | `testing/docker/_shared/nginx.conf`          | Shared by all profile images               |
| Change container lifecycle   | `testing/containers.ts`                      | Run, port lookup, cleanup                  |
| Change OCI runtime detection | `testing/oci.ts`                             | Prefer podman, fallback docker, else throw |
| Change repo capabilities     | `testing/repositories.ts`                    | Apply `uploadpack.*` and protocol config   |
| Change integration coverage  | `src/testing/integration/remote_git.test.ts` | Probe/fetch primitive assertions           |
| Fast local HTTP smoke tests  | `testing/git_server.ts`                      | Uses host git only; not compatibility tier |

## CODE MAP

| Symbol / File                     | Type      | Role                                              |
| --------------------------------- | --------- | ------------------------------------------------- |
| `CompatibilityProfile`            | interface | Profile name, image tag, git config, expectations |
| `compatibilityProfiles`           | array     | Source of truth for test matrix                   |
| `createDeterministicRepo`         | fn        | Builds bare repo and applies profile config       |
| `ociCli`                          | fn        | Selects `podman` or `docker`                      |
| `startGitContainer`               | fn        | Starts profile server and returns repo URL        |
| `remote_git.test.ts` profile loop | test      | Exercises `RemoteGit` against each server         |

## PROFILE MATRIX

| Profile            | Base image     | Git target | `allowFilter` | `allowAnySHA1InWant` | `protocol.version` | `receivePack` |
| ------------------ | -------------- | ---------- | ------------- | -------------------- | ------------------ | ------------- |
| `launchpad-turnip` | `ubuntu:20.04` | 2.25.x     | false         | false                | 0                  | false         |
| `github`           | `ubuntu:24.04` | 2.43.x     | true          | true                 | 2                  | false         |
| `gitlab`           | `ubuntu:22.04` | 2.34.x     | true          | true                 | 2                  | false         |
| `forgejo`          | `alpine:3.20`  | 2.45.x     | true          | false                | 2                  | false         |

## CONVENTIONS

- **OCI runtime, not Docker API**: shell out to `podman` or `docker`; avoid daemon-specific features
- **Podman preferred**: detection order is `podman`, then `docker`
- **Hard fail on missing runtime**: no silent skip for integration tests
- **One Dockerfile per environment**: no single parameterized Dockerfile with `ARG BASE_IMAGE`
- **Shared assets only for identical files**: keep nginx and entrypoint in `_shared/`
- **Declarative profile matrix**: no per-profile branching inside tests
- **Repo config over test logic**: encode platform behavior via git config and image version
- **Temp repo mount**: host creates bare repo, container serves mounted `/srv/git`

## ANTI-PATTERNS

- **No parameterized Dockerfile** for all environments
- **No fallback to host git** in compatibility tests
- **No silent test skip** when `podman`/`docker` missing
- **No full GitLab/Forgejo installs** unless bug evidence proves wrapper behavior matters
- **No live internet platform tests** for default CI path
- **No capability-stripping proxy** as substitute for versioned git binaries

## UNIQUE STYLES

### Runtime Selection

Use one runtime selector everywhere container operations happen:

```ts
const oci = await ociCli();
await run([oci, "run", "-d", "-p", "0:80", imageTag]);
```

### Profile-Driven Repo Config

Repo creation should consume profile config directly:

```ts
await run(repo, ["git", "config", "uploadpack.allowFilter", String(profile.allowFilter)]);
await run(repo, [
  "git",
  "config",
  "uploadpack.allowAnySHA1InWant",
  String(profile.allowAnySHA1InWant),
]);
await run(repo, ["git", "config", "http.receivepack", String(profile.receivePack)]);
```

### Test Flow

Each profile test follows same path:

```text
make temp dir -> create deterministic repo -> start profile container -> run RemoteGit assertions -> cleanup
```

## TEST PATTERNS

- **Matrix loop**: one `it(profile.name, ...)` per `CompatibilityProfile`
- **Capability assertions**: verify `probe()` reports expected shallow/filter support
- **Behavior assertions**: verify `fetchCommit`, `fetchTree`, `fetchBlob`, and `getObject`
- **Cleanup in `finally`**: always remove container and temp dir
- **Negative runtime test**: missing OCI runtime should throw clear error

## COMMANDS

```bash
bash testing/docker/build.sh       # Build all profile images via podman/docker
pnpm test:integration              # Run smart-HTTP compatibility tests
pnpm test                          # Unit tests; should not require containers
pnpm test:all                      # Full suite
```

Manual profile check:

```bash
podman run --rm git-server-launchpad-turnip git --version
podman run -p 8080:80 git-server-launchpad-turnip
git clone http://127.0.0.1:8080/repo.git
```

Negative runtime check:

```bash
PATH=/tmp pnpm test:integration
```

## NOTES

- Launchpad-like profile targets Ubuntu 20.04 git 2.25.x behavior.
- GitHub profile approximates modern hosted GitHub with Ubuntu 24.04 git 2.43.x.
- GitLab profile approximates modern GitLab with Ubuntu 22.04 git 2.34.x.
- Forgejo profile approximates current lightweight forge behavior with Alpine 3.20 git 2.45.x.
- Existing `testing/git_server.ts` remains useful for cheap local smoke tests but does not validate
  cross-version compatibility.
