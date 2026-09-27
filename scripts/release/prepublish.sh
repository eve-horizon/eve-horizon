#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/release/common.sh
source "$(dirname "$0")/common.sh"
[[ $# -eq 2 ]] || release_die 'usage: prepublish.sh service|toolchain version'
kind=$1 version=$2
if [[ $kind == service ]]; then
  names=(api sso gateway agent-runtime orchestrator worker dashboard)
elif [[ $kind == toolchain ]]; then
  names=(python media rust java kotlin browser)
else
  release_die "unknown release kind $kind"
fi
for name in "${names[@]}"; do
  release_check_tag_absent "$(release_ref "$kind" "$name" "$version")"
done
echo "all ${#names[@]} versioned tags are unused"
