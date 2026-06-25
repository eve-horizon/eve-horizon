#!/usr/bin/env bash
# Unified stop command for Eve Horizon
# Usage: eh stop [options]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_common.sh"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_mode.sh"

COMPOSE_DEPS="$PROJECT_ROOT/docker/compose/docker-compose.deps.yml"
COMPOSE_FULL="$PROJECT_ROOT/docker/compose/docker-compose.yml"

# ============================================================================
# Help
# ============================================================================

show_help() {
  echo "Stop Eve Horizon services"
  echo ""
  echo "Usage: eh stop [options]"
  echo ""
  echo "Options:"
  echo "  --all     Also remove database volume (full reset)"
  echo "  --quiet   Suppress output"
  echo ""
  echo "Stops whatever mode is currently running (local or docker)."
}

# ============================================================================
# Stop Functions
# ============================================================================

kill_orphans() {
  # Kill orphaned nest.js watch processes
  if pgrep -f "nest start --watch" >/dev/null 2>&1; then
    pkill -f "nest start --watch" 2>/dev/null || true
  fi

  # Kill orphaned claude processes spawned by worker
  orphaned=$(ps -ef | awk '/node.*main.*worker/ {parent=$2} /claude/ && $3==parent {print $2}' 2>/dev/null || true)
  if [[ -n "$orphaned" ]]; then
    echo "$orphaned" | xargs kill -9 2>/dev/null || true
  fi
}

stop_local_services() {
  local quiet="${1:-false}"

  [[ "$quiet" != "true" ]] && echo -e "${YELLOW}Stopping local services...${NC}"

  # Kill by saved PIDs first
  if [[ -f "$EVE_PID_FILE" ]]; then
    while IFS='=' read -r service pid; do
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        [[ "$quiet" != "true" ]] && echo -e "  $service (PID $pid): ${RED}stopping${NC}"
        kill "$pid" 2>/dev/null || true
      fi
    done < "$EVE_PID_FILE"
    clear_pids
  fi

  # Kill by ports as backup
  for port in "$EVE_API_PORT" "$EVE_ORCHESTRATOR_PORT" "$EVE_WORKER_PORT" "$EVE_AGENT_RUNTIME_PORT"; do
    pids=$(lsof -ti:"$port" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      [[ "$quiet" != "true" ]] && echo -e "  Port $port: ${RED}killing${NC}"
      echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
  done

  kill_orphans

  [[ "$quiet" != "true" ]] && echo -e "  Local services: ${GREEN}stopped${NC}"
}

stop_deps_containers() {
  local quiet="${1:-false}"
  local remove_volumes="${2:-false}"

  [[ "$quiet" != "true" ]] && echo -e "${YELLOW}Stopping dependency containers...${NC}"

  if [[ "$remove_volumes" == "true" ]]; then
    docker compose -p "$EVE_INSTANCE" -f "$COMPOSE_DEPS" down -v 2>/dev/null || true
    [[ "$quiet" != "true" ]] && echo -e "  Containers + volumes: ${GREEN}removed${NC}"
  else
    docker compose -p "$EVE_INSTANCE" -f "$COMPOSE_DEPS" down 2>/dev/null || true
    [[ "$quiet" != "true" ]] && echo -e "  Containers: ${GREEN}stopped${NC}"
  fi
}

stop_docker_stack() {
  local quiet="${1:-false}"
  local remove_volumes="${2:-false}"

  [[ "$quiet" != "true" ]] && echo -e "${YELLOW}Stopping docker stack...${NC}"

  if [[ "$remove_volumes" == "true" ]]; then
    docker compose -p "$EVE_INSTANCE" -f "$COMPOSE_FULL" down -v 2>/dev/null || true
    [[ "$quiet" != "true" ]] && echo -e "  Stack + volumes: ${GREEN}removed${NC}"
  else
    docker compose -p "$EVE_INSTANCE" -f "$COMPOSE_FULL" down 2>/dev/null || true
    [[ "$quiet" != "true" ]] && echo -e "  Stack: ${GREEN}stopped${NC}"
  fi
}

verify_ports_free() {
  local quiet="${1:-false}"
  local all_clear=true

  [[ "$quiet" != "true" ]] && echo -e "${YELLOW}Verifying ports are free...${NC}"
  sleep 1

  for port in "$EVE_API_PORT" "$EVE_ORCHESTRATOR_PORT" "$EVE_WORKER_PORT" "$EVE_AGENT_RUNTIME_PORT" "$EVE_DB_PORT"; do
    if lsof -ti:"$port" >/dev/null 2>&1; then
      [[ "$quiet" != "true" ]] && echo -e "  Port $port: ${RED}still in use${NC}"
      all_clear=false
    else
      [[ "$quiet" != "true" ]] && echo -e "  Port $port: ${GREEN}free${NC}"
    fi
  done

  $all_clear
}

# ============================================================================
# Main
# ============================================================================

remove_volumes=false
quiet=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all|-a) remove_volumes=true; shift ;;
    --quiet|-q) quiet=true; shift ;;
    --help|-h) show_help; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

current_mode=$(get_current_mode)

if [[ "$quiet" != "true" ]]; then
  echo ""
  echo -e "${CYAN}Stopping Eve Horizon ($EVE_INSTANCE)${NC}"
  echo "═══════════════════════════════════════════════════"
  echo ""
  if [[ "$current_mode" != "none" ]]; then
    echo -e "  Current mode: ${CYAN}$current_mode${NC}"
  else
    echo -e "  Current mode: ${YELLOW}none (cleaning up anyway)${NC}"
  fi
  echo ""
fi

case "$current_mode" in
  local)
    stop_local_services "$quiet"
    stop_deps_containers "$quiet" "$remove_volumes"
    ;;
  docker)
    stop_docker_stack "$quiet" "$remove_volumes"
    ;;
  none)
    # Clean up anyway in case of stale processes
    stop_local_services "$quiet"
    stop_deps_containers "$quiet" "$remove_volumes"
    stop_docker_stack "$quiet" "$remove_volumes"
    ;;
esac

# Clear mode
set_current_mode "none"

# Verify
if [[ "$quiet" != "true" ]]; then
  echo ""
  if verify_ports_free "$quiet"; then
    echo ""
    echo -e "${GREEN}Eve Horizon stopped${NC}"
  else
    echo ""
    echo -e "${RED}Some ports still in use - may need manual intervention${NC}"
    exit 1
  fi
  echo ""
fi
