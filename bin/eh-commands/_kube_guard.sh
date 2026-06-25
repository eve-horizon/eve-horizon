#!/usr/bin/env bash

EH_LOCAL_KUBE_CONTEXT="k3d-eve-local"
# Production/staging EKS context to guard against accidental kubectl use.
# Set EH_STAGING_EKS_CONTEXT in your environment to your cluster's context ARN.
EH_STAGING_EKS_CONTEXT="${EH_STAGING_EKS_CONTEXT:-}"

eh_current_kube_context() {
  kubectl config current-context 2>/dev/null || true
}

eh_print_context_remediation() {
  echo "Remediation:"
  echo "  kubectl config use-context ${EH_LOCAL_KUBE_CONTEXT}"
  echo "  or use the safe wrapper:"
  echo "  ./bin/eh kubectl <args>"
}

eh_assert_k3d_context_or_die() {
  local current_context
  current_context="$(eh_current_kube_context)"

  if [[ -z "$current_context" ]]; then
    echo "Error: no active kube context is configured."
    eh_print_context_remediation
    exit 1
  fi

  if [[ "$current_context" == "$EH_LOCAL_KUBE_CONTEXT" ]]; then
    return 0
  fi

  if [[ "$current_context" == "$EH_STAGING_EKS_CONTEXT" ]]; then
    echo "Error: refusing to run mutating kubectl commands against staging context:"
    echo "  ${EH_STAGING_EKS_CONTEXT}"
    eh_print_context_remediation
    exit 1
  fi

  echo "Error: active kube context is '${current_context}', expected '${EH_LOCAL_KUBE_CONTEXT}'."
  eh_print_context_remediation
  exit 1
}

eh_block_context_override() {
  local args=("$@")
  local i=0

  while [[ $i -lt ${#args[@]} ]]; do
    local arg="${args[$i]}"

    if [[ "$arg" == "--context" ]]; then
      if (( i + 1 >= ${#args[@]} )); then
        echo "Error: --context requires a value."
        exit 1
      fi
      local value="${args[$((i + 1))]}"
      if [[ "$value" != "$EH_LOCAL_KUBE_CONTEXT" ]]; then
        echo "Error: context override is blocked. Allowed context: ${EH_LOCAL_KUBE_CONTEXT}"
        exit 1
      fi
      ((i += 2))
      continue
    fi

    if [[ "$arg" == --context=* ]]; then
      local value="${arg#--context=}"
      if [[ "$value" != "$EH_LOCAL_KUBE_CONTEXT" ]]; then
        echo "Error: context override is blocked. Allowed context: ${EH_LOCAL_KUBE_CONTEXT}"
        exit 1
      fi
    fi

    ((i += 1))
  done
}

eh_kubectl_local() {
  eh_block_context_override "$@"
  command kubectl --context "$EH_LOCAL_KUBE_CONTEXT" "$@"
}
