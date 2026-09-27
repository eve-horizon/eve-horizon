#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/release/common.sh
source "$(dirname "$0")/common.sh"
[[ $# -eq 3 ]] || release_die 'usage: gate.sh service|toolchain version artifact-root'
kind=$1 version=$2 root=$3
release_version "$version"
release_native
if [[ $kind == service ]]; then
  toolchain_version=$(cat docker/toolchains/release-version.txt)
  release_version "$toolchain_version"
  for name in worker agent-runtime; do
    bash scripts/release/image.sh load service "$name" "$version" "$root/$name"
  done
  for name in python browser; do
    ref=$(release_ref toolchain "$name" "$toolchain_version")
    docker pull "$ref"
    resolved=$(docker image inspect --format '{{index .RepoDigests 0}}' "$ref")
    [[ $resolved == "${ref%:*}@sha256:"* ]] || release_die "unresolved toolchain digest: $ref => $resolved"
    docker pull "$resolved"
    [[ $(release_image_id "$resolved") == "$(release_image_id "$ref")" ]] || release_die 'toolchain digest and tag differ'
    if [[ $name == python ]]; then python_ref=$resolved; else browser_ref=$resolved; fi
    echo "qualified toolchain source $resolved id=$(release_image_id "$resolved")"
  done
  worker_ref=$(release_ref service worker "$version")
  agent_ref=$(release_ref service agent-runtime "$version")
elif [[ $kind == toolchain ]]; then
  [[ $version == "$(cat docker/toolchains/release-version.txt)" ]] || release_die 'toolchain tag must match release-version.txt'
  for name in python browser; do
    bash scripts/release/image.sh load toolchain "$name" "$version" "$root/$name"
  done
  python_ref=$(release_ref toolchain python "$version")
  browser_ref=$(release_ref toolchain browser "$version")
  worker_ref=eve-horizon/worker:toolchain-release-gate
  agent_ref=eve-horizon/agent-runtime:toolchain-release-gate
  docker buildx build --platform linux/amd64 -f apps/worker/Dockerfile --target base -t "$worker_ref" --load .
  docker buildx build --platform linux/amd64 -f apps/agent-runtime/Dockerfile --target production -t "$agent_ref" --load .
else
  release_die "unknown gate kind $kind"
fi
EVE_BROWSER_PYTHON_IMAGE="$python_ref" \
EVE_BROWSER_BROWSER_IMAGE="$browser_ref" \
EVE_BROWSER_WORKER_IMAGE="$worker_ref" \
EVE_BROWSER_AGENT_RUNTIME_IMAGE="$agent_ref" \
EVE_BROWSER_PYTHON_ID="$(release_image_id "$python_ref")" \
EVE_BROWSER_BROWSER_ID="$(release_image_id "$browser_ref")" \
EVE_BROWSER_WORKER_ID="$(release_image_id "$worker_ref")" \
EVE_BROWSER_AGENT_RUNTIME_ID="$(release_image_id "$agent_ref")" \
  docker/toolchains/browser/test-runtime.sh
