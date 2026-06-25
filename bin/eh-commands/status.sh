#!/usr/bin/env bash
# Eve Horizon status command - shows what's available and how to access it
# Agents should run this BEFORE any build/test activities
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Load configuration
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_mode.sh"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Helper to check if something is running
check_k3d_cluster() {
  # k3d cluster list shows "1/1" for healthy servers, not "running"
  # Check if cluster exists and has healthy servers (format: "eve-local   1/1   ...")
  if command -v k3d &>/dev/null && k3d cluster list 2>/dev/null | grep -qE "eve-local[[:space:]]+[0-9]+/[0-9]+"; then
    echo "running"
  else
    echo "stopped"
  fi
}

check_docker_compose() {
  if docker compose -p "$EVE_INSTANCE" ps 2>/dev/null | grep -q "Up"; then
    echo "running"
  else
    echo "stopped"
  fi
}

check_local_dev() {
  if pgrep -f "pnpm.*--filter.*@eve/api" &>/dev/null || \
     pgrep -f "node.*api/dist" &>/dev/null; then
    echo "running"
  else
    echo "stopped"
  fi
}

check_port_listening() {
  local port=$1
  if nc -z localhost "$port" 2>/dev/null; then
    echo "listening"
  else
    echo "not listening"
  fi
}

check_url_reachable() {
  local url=$1
  if curl -sf --connect-timeout 2 "$url/health" &>/dev/null; then
    echo "reachable"
  else
    echo "unreachable"
  fi
}

status_icon() {
  if [[ "$1" == "running" ]] || [[ "$1" == "listening" ]] || [[ "$1" == "reachable" ]]; then
    echo -e "${GREEN}✓${NC}"
  else
    echo -e "${RED}○${NC}"
  fi
}

# Count orphaned processes that can accumulate and kill the system
count_orphan_processes() {
  local count=0

  # Count orphaned nest.js watch processes
  local nest_orphans=$(pgrep -f "nest start --watch" 2>/dev/null | wc -l | tr -d ' ')
  count=$((count + nest_orphans))

  # Count orphaned claude processes spawned by worker
  local claude_orphans=$(ps -ef | awk '/node.*main.*worker/ {parent=$2} /claude/ && $3==parent {print $2}' 2>/dev/null | wc -l | tr -d ' ')
  count=$((count + claude_orphans))

  echo "$count"
}

get_orphan_details() {
  local nest_count=$(pgrep -f "nest start --watch" 2>/dev/null | wc -l | tr -d ' ')
  local claude_count=$(ps -ef | awk '/node.*main.*worker/ {parent=$2} /claude/ && $3==parent {print $2}' 2>/dev/null | wc -l | tr -d ' ')

  local details=""
  if [[ "$nest_count" -gt 0 ]]; then
    details="nest-watch: $nest_count"
  fi
  if [[ "$claude_count" -gt 0 ]]; then
    if [[ -n "$details" ]]; then
      details="$details, claude: $claude_count"
    else
      details="claude: $claude_count"
    fi
  fi
  echo "$details"
}

show_help() {
  echo "Show Eve Horizon environment status"
  echo ""
  echo "Usage: eh status [options]"
  echo ""
  echo "Options:"
  echo "  --json     Output as JSON (for programmatic use)"
  echo "  --help     Show this help"
  echo ""
  echo "This command shows:"
  echo "  - Current instance configuration"
  echo "  - What environments are running (k8s, docker, local)"
  echo "  - API URLs to use for each environment"
  echo "  - Multi-instance isolation status"
}

show_status() {
  local json_output="${1:-false}"

  # Gather status
  local k3d_status=$(check_k3d_cluster)
  local docker_status=$(check_docker_compose)
  local local_dev_status=$(check_local_dev)

  # Check URL reachability
  local k8s_api_reachable=$(check_url_reachable "http://api.eve.lvh.me")
  local docker_api_port=$(check_port_listening "$EVE_API_PORT")

  # Get current mode
  local current_mode=$(get_current_mode)
  local mode_started=$(get_mode_started_at)

  # Count orphaned processes
  local orphan_count=$(count_orphan_processes)

  if [[ "$json_output" == "true" ]]; then
    cat <<EOF
{
  "instance": {
    "name": "$EVE_INSTANCE",
    "base_port": $EVE_BASE_PORT,
    "k8s_owner": $EVE_K8S_OWNER,
    "staging_owner": $EVE_STAGING_OWNER,
    "staging_owner_repo": "$EVE_STAGING_OWNER_REPO",
    "staging_kubeconfig": "$EVE_STAGING_KUBECONFIG",
    "config_file": "$EVE_CONFIG_FILE"
  },
  "mode": {
    "current": "$current_mode",
    "started_at": "$mode_started"
  },
  "ports": {
    "api": $EVE_API_PORT,
    "orchestrator": $EVE_ORCHESTRATOR_PORT,
    "database": $EVE_DB_PORT,
    "worker": $EVE_WORKER_PORT,
    "agent_runtime": $EVE_AGENT_RUNTIME_PORT
  },
  "orphan_processes": {
    "count": $orphan_count,
    "warning": $([ "$orphan_count" -gt 0 ] && echo "true" || echo "false"),
    "cleanup_command": "./bin/eh stop"
  },
  "environments": {
    "k8s": {
      "status": "$k3d_status",
      "api_url": "http://api.eve.lvh.me",
      "api_reachable": $([ "$k8s_api_reachable" == "reachable" ] && echo "true" || echo "false")
    },
    "docker": {
      "status": "$docker_status",
      "api_url": "http://localhost:$EVE_API_PORT",
      "api_reachable": $([ "$docker_api_port" == "listening" ] && echo "true" || echo "false")
    },
    "local_dev": {
      "status": "$local_dev_status",
      "api_url": "http://localhost:$EVE_API_PORT"
    },
    "staging": {
      "api_url": "https://api.eve.example.com",
      "kubeconfig": "$EVE_STAGING_KUBECONFIG",
      "kubeconfig_exists": $([ -f "$EVE_STAGING_KUBECONFIG" ] && echo "true" || echo "false")
    }
  },
  "recommended_api_url": $([ "$k3d_status" == "running" ] && echo "\"http://api.eve.lvh.me\"" || echo "\"http://localhost:$EVE_API_PORT\"")
}
EOF
    return
  fi

  echo ""
  echo -e "${BOLD}Eve Horizon Status${NC}"
  echo "═══════════════════════════════════════════════════════════════════════"
  echo ""

  # Instance Configuration
  echo -e "${BOLD}Instance Configuration${NC}"
  echo -e "  Name:        ${CYAN}$EVE_INSTANCE${NC}"
  echo -e "  Base Port:   ${CYAN}$EVE_BASE_PORT${NC}"
  echo -e "  K8s Owner:   ${CYAN}$EVE_K8S_OWNER${NC}"
  echo -e "  Staging Owner: ${CYAN}$EVE_STAGING_OWNER${NC}"
  if [[ -n "$EVE_STAGING_OWNER_REPO" ]]; then
    echo -e "  Staging Repo:  ${CYAN}$EVE_STAGING_OWNER_REPO${NC}"
  else
    echo -e "  Staging Repo:  ${YELLOW}(unset)${NC}"
  fi
  if [[ -f "$EVE_STAGING_KUBECONFIG" ]]; then
    echo -e "  Staging Kubeconfig: ${CYAN}$EVE_STAGING_KUBECONFIG${NC}"
  else
    echo -e "  Staging Kubeconfig: ${YELLOW}$EVE_STAGING_KUBECONFIG (missing)${NC}"
  fi
  if [[ -f "$EVE_CONFIG_FILE" ]]; then
    echo -e "  Config:      ${CYAN}$EVE_CONFIG_FILE${NC}"
  else
    echo -e "  Config:      ${YELLOW}(using defaults - run ./bin/eh configure)${NC}"
  fi
  echo ""

  # Current Mode
  echo -e "${BOLD}Current Mode${NC}"
  if [[ "$current_mode" == "none" ]]; then
    echo -e "  Mode:        ${YELLOW}none${NC} (no services running)"
  else
    echo -e "  Mode:        ${GREEN}$current_mode${NC}"
    if [[ -n "$mode_started" ]]; then
      echo -e "  Started:     ${CYAN}$mode_started${NC}"
    fi
  fi
  echo ""

  # Orphaned Processes Check
  local orphan_count=$(count_orphan_processes)
  if [[ "$orphan_count" -gt 0 ]]; then
    local orphan_details=$(get_orphan_details)
    echo -e "${BOLD}⚠️  Orphaned Processes${NC}"
    echo -e "  Count:       ${RED}$orphan_count${NC} ($orphan_details)"
    echo ""
    echo -e "  ${RED}WARNING: Orphaned processes detected that can exhaust system resources.${NC}"
    echo -e "  ${YELLOW}Run this command to clean them up:${NC}"
    echo -e "    ${CYAN}./bin/eh stop${NC}"
    echo ""
    echo "───────────────────────────────────────────────────────────────────────"
    echo ""
  fi

  # Port Allocation
  echo -e "${BOLD}Port Allocation${NC} (for Docker Compose / Local Dev)"
  echo -e "  API:           localhost:${CYAN}$EVE_API_PORT${NC}"
  echo -e "  Orchestrator:  localhost:${CYAN}$EVE_ORCHESTRATOR_PORT${NC}"
  echo -e "  Database:      localhost:${CYAN}$EVE_DB_PORT${NC}"
  echo -e "  Worker:        localhost:${CYAN}$EVE_WORKER_PORT${NC}"
  echo -e "  Agent Runtime: localhost:${CYAN}$EVE_AGENT_RUNTIME_PORT${NC}"
  echo ""

  # Services Status (based on current mode)
  echo -e "${BOLD}Services${NC}"
  echo ""

  if [[ "$current_mode" == "local" ]]; then
    # Local mode: DB container + local node processes
    local db_icon=$(status_icon "$docker_status")
    local api_icon=$(status_icon "$(check_url_reachable "http://localhost:$EVE_API_PORT")")
    local orch_icon=$(status_icon "$(check_url_reachable "http://localhost:$EVE_ORCHESTRATOR_PORT")")
    local worker_icon=$(status_icon "$(check_url_reachable "http://localhost:$EVE_WORKER_PORT")")
    local runtime_icon=$(status_icon "$(check_url_reachable "http://localhost:$EVE_AGENT_RUNTIME_PORT")")

    echo -e "  DB (container):       $db_icon"
    echo -e "  API (local):          $api_icon http://localhost:$EVE_API_PORT"
    echo -e "  Orchestrator (local): $orch_icon http://localhost:$EVE_ORCHESTRATOR_PORT"
    echo -e "  Worker (local):       $worker_icon http://localhost:$EVE_WORKER_PORT"
    echo -e "  Agent Runtime (local): $runtime_icon http://localhost:$EVE_AGENT_RUNTIME_PORT"
    echo ""
    echo -e "  Logs: ${CYAN}tail -f /tmp/eve-*.log${NC}"

  elif [[ "$current_mode" == "docker" ]]; then
    # Docker mode: all containers
    local api_icon=$(status_icon "$(check_url_reachable "http://localhost:$EVE_API_PORT")")
    local orch_icon=$(status_icon "$(check_url_reachable "http://localhost:$EVE_ORCHESTRATOR_PORT")")
    local worker_icon=$(status_icon "$(check_url_reachable "http://localhost:$EVE_WORKER_PORT")")
    local runtime_icon=$(status_icon "$(check_url_reachable "http://localhost:$EVE_AGENT_RUNTIME_PORT")")

    echo -e "  DB (container):           ${GREEN}✓${NC}"
    echo -e "  API (container):          $api_icon http://localhost:$EVE_API_PORT"
    echo -e "  Orchestrator (container): $orch_icon http://localhost:$EVE_ORCHESTRATOR_PORT"
    echo -e "  Worker (container):       $worker_icon http://localhost:$EVE_WORKER_PORT"
    echo -e "  Agent Runtime (container): $runtime_icon http://localhost:$EVE_AGENT_RUNTIME_PORT"
    echo ""
    echo -e "  Logs: ${CYAN}./bin/eh docker logs${NC}"

  else
    # No mode active - show available environments
    echo -e "  ${YELLOW}No local/docker mode active${NC}"
  fi
  echo ""

  # K8s Stack (separate from mode)
  local k3d_icon=$(status_icon "$k3d_status")
  echo -e "${BOLD}K8s Stack${NC} (separate from local/docker mode)"
  echo -e "  Cluster:     $k3d_icon eve-local ($k3d_status)"
  if [[ "$k3d_status" == "running" ]]; then
    local api_icon=$(status_icon "$k8s_api_reachable")
    echo -e "  API:         $api_icon http://api.eve.lvh.me"
  fi
  echo ""

  # Staging Environment (static info)
  echo -e "${BOLD}Staging Environment${NC}"
  echo -e "  API:         https://api.eve.example.com"
  echo -e "  Kubeconfig:  $EVE_STAGING_KUBECONFIG"
  echo ""

  # Multi-Instance Info
  echo -e "${BOLD}Multi-Instance Isolation${NC}"
  echo "  This instance uses unique ports and Docker namespace to allow"
  echo "  multiple repo checkouts to run integration tests in parallel."
  echo ""
  echo "  To configure a different instance:"
  echo -e "    ${CYAN}./bin/eh configure --instance eh2 --base-port 4900${NC}"
  echo ""

  # Sister Repos
  echo -e "${BOLD}Sister Repositories${NC}"
  local example_repo="../eve-horizon-fullstack-example"
  local skillpacks_repo="../eve-skillpacks"

  if [[ -d "$REPO_ROOT/$example_repo" ]]; then
    echo -e "  eve-horizon-fullstack-example:  ${GREEN}✓ found${NC}"
  else
    echo -e "  eve-horizon-fullstack-example:  ${YELLOW}○ not found at $example_repo${NC}"
  fi

  if [[ -d "$REPO_ROOT/$skillpacks_repo" ]]; then
    echo -e "  eve-skillpacks:                 ${GREEN}✓ found${NC}"
  else
    echo -e "  eve-skillpacks:                 ${YELLOW}○ not found at $skillpacks_repo${NC}"
  fi
  echo ""

  # Quick Summary
  echo -e "${BOLD}Quick Commands${NC}"
  echo -e "  ${CYAN}./bin/eh start local${NC}      # Hot-reload development"
  echo -e "  ${CYAN}./bin/eh start docker${NC}     # Containerized stack"
  echo -e "  ${CYAN}./bin/eh stop${NC}             # Stop current mode"
  echo -e "  ${CYAN}./bin/eh k8s deploy${NC}       # Deploy to k8s stack"
  echo -e "  ${CYAN}./bin/eh test integration${NC} # Run integration tests"
  echo ""
  echo "───────────────────────────────────────────────────────────────────────"

  # Recommended API URL based on current state
  if [[ "$k3d_status" == "running" ]]; then
    echo -e "${BOLD}Recommended:${NC} export EVE_API_URL=${GREEN}http://api.eve.lvh.me${NC}"
  elif [[ "$current_mode" == "local" || "$current_mode" == "docker" ]]; then
    echo -e "${BOLD}Recommended:${NC} export EVE_API_URL=${GREEN}http://localhost:$EVE_API_PORT${NC}"
  else
    echo -e "${YELLOW}No environment running. Start one with:${NC}"
    echo -e "  ${CYAN}./bin/eh start local${NC}                        # Hot-reload dev"
    echo -e "  ${CYAN}./bin/eh start docker${NC}                       # Containerized stack"
    echo -e "  ${CYAN}./bin/eh k8s start && ./bin/eh k8s deploy${NC}   # K8s stack"
  fi
  echo ""

  # K8s ownership reminder
  echo "───────────────────────────────────────────────────────────────────────"
  if [[ "$EVE_K8S_OWNER" == "true" ]]; then
    echo -e "${GREEN}IMPORTANT: You are the K8s owner.${NC}"
    echo "  You CAN freely: rebuild images, redeploy, restart k8s services."
    echo "  No approval needed for k8s operations."
  else
    echo -e "${YELLOW}IMPORTANT: You are NOT the K8s owner.${NC}"
    echo "  You CAN: run jobs, run tests, use the CLI against the stack."
    echo "  You CANNOT: rebuild, redeploy, or restart k8s without approval."
    echo "  To become owner: ./bin/eh configure --k8s-owner"
  fi
  echo ""

  echo "───────────────────────────────────────────────────────────────────────"
  if [[ "$EVE_STAGING_OWNER" == "true" ]]; then
    echo -e "${GREEN}IMPORTANT: You are the Staging owner.${NC}"
    if [[ -n "$EVE_STAGING_OWNER_REPO" ]]; then
      echo "  Owner repo: $EVE_STAGING_OWNER_REPO"
    fi
    echo "  You CAN: tag release-v* and run staging kubectl commands."
  else
    echo -e "${YELLOW}IMPORTANT: You are NOT the Staging owner.${NC}"
    if [[ -n "$EVE_STAGING_OWNER_REPO" ]]; then
      echo "  Owner repo: $EVE_STAGING_OWNER_REPO"
    fi
    echo "  Avoid tagging release-v* or staging kubectl without approval."
    echo "  To become owner: ./bin/eh configure --staging-owner"
  fi
  echo ""
}

# Main
case "${1:-}" in
  --help|-h)
    show_help
    exit 0
    ;;
  --json)
    show_status true
    ;;
  *)
    show_status false
    ;;
esac
