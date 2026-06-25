#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_kube_guard.sh"

current_context="$(eh_current_kube_context)"
if [[ -z "$current_context" ]]; then
  current_context="(none)"
fi

echo "Current context: ${current_context}"
echo "Expected local context: ${EH_LOCAL_KUBE_CONTEXT}"

if [[ "$current_context" == "$EH_STAGING_EKS_CONTEXT" ]]; then
  echo "WARNING: staging EKS context is active."
  eh_print_context_remediation
fi
