#!/usr/bin/env bash
set -euo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$repo_root"
runtime="$(deno eval --quiet 'import { ociCli } from "./testing/oci.ts"; console.log(await ociCli());')"

for profile in launchpad-turnip github gitlab forgejo; do
  "$runtime" build -t "git-server-$profile" -f "testing/docker/$profile/Dockerfile" "testing/docker"
done
