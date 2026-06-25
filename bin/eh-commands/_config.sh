#!/usr/bin/env bash
# Eve Horizon instance configuration loader
# Sources defaults or reads from .eve-horizon.yaml
# Exports: EVE_INSTANCE, EVE_BASE_PORT, EVE_API_PORT, EVE_ORCHESTRATOR_PORT, EVE_WORKER_PORT, EVE_AGENT_RUNTIME_PORT, EVE_DB_PORT, EVE_K8S_OWNER, EVE_STAGING_OWNER, EVE_STAGING_OWNER_REPO, EVE_STAGING_KUBECONFIG

CONFIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PROJECT_ROOT="$(cd "$CONFIG_DIR/../.." && pwd)"
CONFIG_FILE="$CONFIG_PROJECT_ROOT/.eve-horizon.yaml"

# Defaults (save original env values to detect if they were set externally)
_EVE_K8S_OWNER_EXTERNAL="${EVE_K8S_OWNER:-}"
_EVE_STAGING_OWNER_EXTERNAL="${EVE_STAGING_OWNER:-}"
_EVE_STAGING_OWNER_REPO_EXTERNAL="${EVE_STAGING_OWNER_REPO:-}"
_EVE_STAGING_KUBECONFIG_EXTERNAL="${EVE_STAGING_KUBECONFIG:-}"

EVE_INSTANCE="${EVE_INSTANCE:-eh}"
EVE_BASE_PORT="${EVE_BASE_PORT:-4800}"
EVE_K8S_OWNER="${EVE_K8S_OWNER:-false}"
EVE_STAGING_OWNER="${EVE_STAGING_OWNER:-false}"
EVE_STAGING_OWNER_REPO="${EVE_STAGING_OWNER_REPO:-}"
EVE_STAGING_KUBECONFIG="${EVE_STAGING_KUBECONFIG:-}"

# Read config file if exists (simple YAML parsing)
if [[ -f "$CONFIG_FILE" ]]; then
  # Parse instance: value
  if grep -q "^instance:" "$CONFIG_FILE" 2>/dev/null; then
    file_instance=$(grep "^instance:" "$CONFIG_FILE" | sed 's/^instance:[[:space:]]*//' | tr -d '"' | tr -d "'")
    if [[ -n "$file_instance" ]]; then
      EVE_INSTANCE="${EVE_INSTANCE:-$file_instance}"
      # Only use file value if env var not set
      [[ -z "${EVE_INSTANCE_FROM_ENV:-}" ]] && EVE_INSTANCE="$file_instance"
    fi
  fi

  # Parse base_port: value
  if grep -q "^base_port:" "$CONFIG_FILE" 2>/dev/null; then
    file_port=$(grep "^base_port:" "$CONFIG_FILE" | sed 's/^base_port:[[:space:]]*//' | tr -d '"' | tr -d "'")
    if [[ -n "$file_port" ]]; then
      EVE_BASE_PORT="${EVE_BASE_PORT:-$file_port}"
      # Only use file value if env var not set
      [[ -z "${EVE_BASE_PORT_FROM_ENV:-}" ]] && EVE_BASE_PORT="$file_port"
    fi
  fi

  # Parse k8s_owner: value (true/false - designates which instance owns the k8s cluster)
  if grep -q "^k8s_owner:" "$CONFIG_FILE" 2>/dev/null; then
    file_k8s_owner=$(grep "^k8s_owner:" "$CONFIG_FILE" | sed 's/^k8s_owner:[[:space:]]*//' | tr -d '"' | tr -d "'")
    if [[ -n "$file_k8s_owner" ]]; then
      # Only use file value if env var not explicitly set externally
      [[ -z "$_EVE_K8S_OWNER_EXTERNAL" ]] && EVE_K8S_OWNER="$file_k8s_owner"
    fi
  fi

  # Parse staging_owner: value (true/false - designates which repo owns staging)
  if grep -q "^staging_owner:" "$CONFIG_FILE" 2>/dev/null; then
    file_staging_owner=$(grep "^staging_owner:" "$CONFIG_FILE" | sed 's/^staging_owner:[[:space:]]*//' | tr -d '"' | tr -d "'")
    if [[ -n "$file_staging_owner" ]]; then
      [[ -z "$_EVE_STAGING_OWNER_EXTERNAL" ]] && EVE_STAGING_OWNER="$file_staging_owner"
    fi
  fi

  # Parse staging_owner_repo: value (path to repo that owns staging)
  if grep -q "^staging_owner_repo:" "$CONFIG_FILE" 2>/dev/null; then
    file_staging_owner_repo=$(grep "^staging_owner_repo:" "$CONFIG_FILE" | sed 's/^staging_owner_repo:[[:space:]]*//' | tr -d '"' | tr -d "'")
    if [[ -n "$file_staging_owner_repo" ]]; then
      [[ -z "$_EVE_STAGING_OWNER_REPO_EXTERNAL" ]] && EVE_STAGING_OWNER_REPO="$file_staging_owner_repo"
    fi
  fi

  # Parse staging_kubeconfig: value
  if grep -q "^staging_kubeconfig:" "$CONFIG_FILE" 2>/dev/null; then
    file_staging_kubeconfig=$(grep "^staging_kubeconfig:" "$CONFIG_FILE" | sed 's/^staging_kubeconfig:[[:space:]]*//' | tr -d '"' | tr -d "'")
    if [[ -n "$file_staging_kubeconfig" ]]; then
      [[ -z "$_EVE_STAGING_KUBECONFIG_EXTERNAL" ]] && EVE_STAGING_KUBECONFIG="$file_staging_kubeconfig"
    fi
  fi
fi

# Calculate derived ports (contiguous from base, workers in dynamic range)
# Default base is 4800 (K8s uses Ingress on port 80, no conflict)
# API:          base + 1  (4801)
# Orchestrator: base + 2  (4802)
# Database:     base + 3  (4803)
# Worker 1:     base + 11 (4811)
# Agent Runtime: base + 12 (4812)
EVE_API_PORT=$((EVE_BASE_PORT + 1))
EVE_ORCHESTRATOR_PORT=$((EVE_BASE_PORT + 2))
EVE_DB_PORT=$((EVE_BASE_PORT + 3))
EVE_WORKER_PORT=$((EVE_BASE_PORT + 11))
EVE_AGENT_RUNTIME_PORT=$((EVE_BASE_PORT + 12))

# Database credentials (can be overridden via .env or system-secrets.env.local)
EVE_DB_USER="${EVE_DB_USER:-eve}"
EVE_DB_PASSWORD="${EVE_DB_PASSWORD:-eve}"
EVE_DB_NAME="${EVE_DB_NAME:-eve}"
EVE_DB_NAME_TEST="${EVE_DB_NAME_TEST:-eve_test}"

# Docker compose project name
export COMPOSE_PROJECT_NAME="$EVE_INSTANCE"

# Export all variables
export EVE_INSTANCE
export EVE_BASE_PORT
export EVE_API_PORT
export EVE_ORCHESTRATOR_PORT
export EVE_DB_PORT
export EVE_WORKER_PORT
export EVE_AGENT_RUNTIME_PORT
export EVE_DB_USER
export EVE_DB_PASSWORD
export EVE_DB_NAME
export EVE_DB_NAME_TEST
export EVE_K8S_OWNER
export EVE_STAGING_OWNER
export EVE_STAGING_OWNER_REPO
export EVE_STAGING_KUBECONFIG
export EVE_CONFIG_FILE="$CONFIG_FILE"

# Helper function to show current config
eve_show_config() {
  echo "Eve Horizon Configuration"
  echo "========================="
  echo "Instance:     $EVE_INSTANCE"
  echo "Base Port:    $EVE_BASE_PORT"
  echo "K8s Owner:    $EVE_K8S_OWNER"
  echo "Staging Owner:$EVE_STAGING_OWNER"
  if [[ -n "$EVE_STAGING_OWNER_REPO" ]]; then
    echo "Staging Repo: $EVE_STAGING_OWNER_REPO"
  else
    echo "Staging Repo: (unset)"
  fi
  echo "Staging Kubeconfig: $EVE_STAGING_KUBECONFIG"
  echo ""
  echo "Computed Ports:"
  echo "  API:          $EVE_API_PORT"
  echo "  Orchestrator: $EVE_ORCHESTRATOR_PORT"
  echo "  Database:     $EVE_DB_PORT"
  echo "  Worker:       $EVE_WORKER_PORT"
  echo "  Agent Runtime:$EVE_AGENT_RUNTIME_PORT"
  echo ""
  echo "Database:"
  echo "  User:         $EVE_DB_USER"
  echo "  Password:     ****"
  echo "  Dev DB:       $EVE_DB_NAME"
  echo "  Test DB:      $EVE_DB_NAME_TEST"
  echo ""
  if [[ -f "$CONFIG_FILE" ]]; then
    echo "Config file: $CONFIG_FILE"
  else
    echo "Config file: (using defaults)"
  fi
}
