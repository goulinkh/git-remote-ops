# Project Instructions

## Testing

Run unit tests:

```bash
deno task test
```

Run integration tests against OCI-backed smart-HTTP Git servers:

```bash
bash testing/docker/build.sh
deno task test:integration
```

Integration profiles:

- `launchpad-turnip` — Ubuntu 20.04 / Git 2.25.x
- `github` — Ubuntu 24.04 / Git 2.43.x
- `gitlab` — Ubuntu 22.04 / Git 2.34.x
- `forgejo` — Alpine 3.20 / Git 2.45.x

OCI runtime selection lives in `testing/oci.ts`: prefer `podman`, fall back to `docker`, hard-fail
if neither exists on `PATH`.

Run all tests:

```bash
deno task test:all
```

Run format/lint/type checks:

```bash
deno task verify
```
