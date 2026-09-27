#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/release/common.sh
source "$(dirname "$0")/common.sh"
[[ $# -eq 1 ]] || release_die 'usage: validate-tag.sh service|toolchain'
kind=$1
case "$kind" in
  service)
    [[ ${GITHUB_EVENT_NAME:-} == push ]] || release_die 'publication requires tag push'
    [[ ${GITHUB_REF:-} == refs/tags/release-v* ]] || release_die 'wrong service tag'
    version=${GITHUB_REF#refs/tags/release-v}
    ;;
  toolchain)
    [[ ${GITHUB_EVENT_NAME:-} == push ]] || release_die 'publication requires tag push'
    [[ ${GITHUB_REF:-} == refs/tags/toolchain-images/v* ]] || release_die 'wrong toolchain tag'
    version=${GITHUB_REF#refs/tags/toolchain-images/v}
    [[ $version == "$(cat docker/toolchains/release-version.txt)" ]] || release_die 'toolchain tag does not match release-version.txt'
    ;;
  *) release_die "unknown release kind $kind" ;;
esac
release_version "$version"
echo "$version"
