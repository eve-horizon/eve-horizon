#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Raw mutating kubectl usage is forbidden outside approved wrappers.
MUTATING_KUBECTL_PATTERN='^[[:space:]]*(?!#).*\bkubectl\b.*\b(?:apply|patch|delete|replace|create|run|scale|annotate|label|set|edit|autoscale|taint|cordon|uncordon|drain|rollout\b.*\b(?:restart|undo|pause|resume))\b'
APPROVED_WRAPPER_PATTERN='^bin/eh-commands/(_kube_guard|kubectl)\.sh$'

mapfile -t candidate_files < <(rg --files bin scripts .github/workflows | rg '\.(sh|bash|zsh|yml|yaml)$' || true)

if [[ ${#candidate_files[@]} -eq 0 ]]; then
  echo "kubectl context safety lint: no candidate files found."
  exit 0
fi

violations=0
for file in "${candidate_files[@]}"; do
  if [[ "$file" =~ $APPROVED_WRAPPER_PATTERN ]]; then
    continue
  fi

  matches="$(rg -n --pcre2 "$MUTATING_KUBECTL_PATTERN" "$file" || true)"
  if [[ -n "$matches" ]]; then
    ((violations += 1))
    echo "Unsafe mutating raw kubectl usage in $file:"
    echo "$matches"
    echo ""
  fi
done

if [[ $violations -gt 0 ]]; then
  echo "kubectl context safety lint failed."
  echo "Use ./bin/eh kubectl ... or guard through bin/eh-commands/_kube_guard.sh."
  exit 1
fi

echo "kubectl context safety lint passed."
