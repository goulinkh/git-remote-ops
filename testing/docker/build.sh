#!/usr/bin/env bash
set -euo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$repo_root"
if command -v podman >/dev/null 2>&1; then
  runtime=podman
elif command -v docker >/dev/null 2>&1; then
  runtime=docker
else
  echo "No OCI runtime found on PATH. Install podman or docker." >&2
  exit 1
fi

for profile in launchpad-turnip github gitlab forgejo; do
  "$runtime" build -t "git-server-$profile" -f "testing/docker/$profile/Dockerfile" "testing/docker"
done
