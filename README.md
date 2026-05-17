# Testing

## Unit tests

Run parser/object/protocol tests:

```bash
deno task test
```

## Integration tests

Integration tests run `RemoteGit` against OCI-backed smart-HTTP Git servers for:

- `launchpad-turnip` — Ubuntu 20.04 / Git 2.25.x
- `github` — Ubuntu 24.04 / Git 2.43.x
- `gitlab` — Ubuntu 22.04 / Git 2.34.x
- `forgejo` — Alpine 3.20 / Git 2.45.x

Build test images first:

```bash
bash testing/docker/build.sh
```

Then run integration tests:

```bash
deno task test:integration
```

`testing/oci.ts` chooses `podman` first, then `docker`. If neither is on `PATH`, integration tests
fail with install guidance.

## Full test run

Run all Deno tests:

```bash
deno task test:all
```

Run format/lint/type checks:

```bash
deno task verify
```
