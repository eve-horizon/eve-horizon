#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_kube_guard.sh"

show_help() {
  echo "Safe kubectl passthrough (local k3d only)"
  echo ""
  echo "Usage: eh kubectl <kubectl-args>"
  echo ""
  echo "Examples:"
  echo "  eh kubectl get pods -n eve"
  echo "  eh kubectl logs -n eve deployment/eve-api --tail=50"
  echo ""
  echo "Context is always forced to: ${EH_LOCAL_KUBE_CONTEXT}"
}

if [[ $# -eq 0 ]]; then
  show_help
  exit 1
fi

eh_block_context_override "$@"
eh_kubectl_local "$@"
