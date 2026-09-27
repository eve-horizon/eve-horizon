#!/usr/bin/env bash
set -euo pipefail

registry=ghcr.io/eve-horizon/eve-horizon
source_url=https://github.com/eve-horizon/eve-horizon

release_die() { echo "release gate: $*" >&2; exit 1; }
release_version() {
  local value=$1
  [[ $value =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || release_die "invalid version: $value"
}
release_ref() {
  local kind=$1 name=$2 version=$3
  release_version "$version"
  case "$kind:$name" in
    service:api|service:sso|service:gateway|service:agent-runtime|service:orchestrator|service:worker|service:dashboard) printf '%s/%s:%s\n' "$registry" "$name" "$version" ;;
    toolchain:python|toolchain:media|toolchain:rust|toolchain:java|toolchain:kotlin|toolchain:browser) printf '%s/toolchain-%s:%s\n' "$registry" "$name" "$version" ;;
    *) release_die "unknown release image $kind:$name" ;;
  esac
}
release_native() {
  [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || release_die 'native Linux x86_64 host required'
  local daemon
  daemon=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')
  [[ $daemon == linux/amd64 || $daemon == linux/x86_64 ]] || release_die "native AMD64 Docker daemon required: $daemon"
}
release_image_id() { docker image inspect --format '{{.Id}}' "$1"; }
release_image_platform() {
  [[ $(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$1") == linux/amd64 ]] || release_die "non-AMD64 image: $1"
}
release_check_tag_absent() {
  local ref=$1 output
  if output=$(docker buildx imagetools inspect "$ref" 2>&1); then
    release_die "version already exists: $ref"
  fi
  # Only a registry's explicit missing-manifest response may allow publication.
  if ! grep -Eiq 'manifest unknown|not found|name unknown|404' <<<"$output"; then
    release_die "cannot prove unused version $ref: $output"
  fi
}
