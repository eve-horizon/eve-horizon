#!/usr/bin/env bash
# Unified start command for Eve Horizon
# Usage: eh start <local|docker> [options]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_common.sh"
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_mode.sh"

COMPOSE_DEPS="$PROJECT_ROOT/docker/compose/docker-compose.deps.yml"
COMPOSE_FULL="$PROJECT_ROOT/docker/compose/docker-compose.yml"
SYSTEM_SECRETS="$PROJECT_ROOT/system-secrets.env.local"

# ============================================================================
# Help
# ============================================================================

show_help() {
  echo "Start Eve Horizon services"
  echo ""
  echo "Usage: eh start <mode> [options]"
  echo ""
  echo "Modes:"
  echo "  local   Start DB container + local node services (hot-reload)"
  echo "  docker  Start full containerized stack"
  echo ""
  echo "Options:"
  echo "  --test      Use test database (local mode only)"
  echo "  --no-build  Skip rebuilding containers (docker mode only)"
  echo "  --reset-db  Reset database before starting"
  echo ""
  echo "Note: Starting a different mode will stop the current one first."
  echo ""
  echo "Examples:"
  echo "  eh start local         # Hot-reload development"
  echo "  eh start docker        # Containerized stack for testing"
  echo "  eh start local --test  # Use test database"
}

# ============================================================================
# Helper Functions
# ============================================================================

load_env_for_compose() {
  if [[ -f "$PROJECT_ROOT/.env" ]]; then
    set -a
    source "$PROJECT_ROOT/.env"
    set +a
  fi
  if [[ -f "$SYSTEM_SECRETS" ]]; then
    set -a
    source "$SYSTEM_SECRETS"
    set +a
  fi
}

wait_for_db() {
  local max_attempts=30
  local attempt=1
  while [[ $attempt -le $max_attempts ]]; do
    if pg_isready -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    ((attempt++))
  done
  return 1
}

ensure_database() {
  local db_name="$1"
  PGPASSWORD="$EVE_DB_PASSWORD" psql -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" -d postgres -tc \
    "SELECT 1 FROM pg_database WHERE datname = '$db_name'" 2>/dev/null | grep -q 1 || \
    PGPASSWORD="$EVE_DB_PASSWORD" psql -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" -d postgres -c \
    "CREATE DATABASE $db_name" >/dev/null 2>&1
}

run_migrations() {
  echo -e "  Migrations: ${YELLOW}running...${NC}"
  DATABASE_URL="postgres://$EVE_DB_USER:$EVE_DB_PASSWORD@localhost:$EVE_DB_PORT/$1" \
    pnpm --filter @eve/db migrate >/dev/null 2>&1
  echo -e "  Migrations: ${GREEN}done${NC}"
}

build_shared() {
  echo -e "  Shared build: ${YELLOW}running...${NC}"
  pnpm --filter @eve/shared build >/dev/null 2>&1
  pnpm --filter @eve/db build >/dev/null 2>&1
  pnpm --filter @eve/eve-agent-cli build >/dev/null 2>&1
  pnpm --filter @eve-horizon/cli build >/dev/null 2>&1
  echo -e "  Shared build: ${GREEN}done${NC}"
}


kill_orphans() {
  # Kill orphaned nest.js watch processes
  if pgrep -f "nest start --watch" >/dev/null 2>&1; then
    pkill -f "nest start --watch" 2>/dev/null || true
  fi
}

kill_local_services() {
  # Kill services by saved PIDs
  if [[ -f "$EVE_PID_FILE" ]]; then
    while IFS='=' read -r service pid; do
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
      fi
    done < "$EVE_PID_FILE"
    clear_pids
  fi

  # Kill by ports as backup
  for port in "$EVE_API_PORT" "$EVE_ORCHESTRATOR_PORT" "$EVE_WORKER_PORT" "$EVE_AGENT_RUNTIME_PORT"; do
    pids=$(lsof -ti:"$port" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
  done

  kill_orphans
}

wait_for_healthy() {
  echo ""
  echo -e "${YELLOW}Waiting for services...${NC}"

  local deadline=$((SECONDS + 60))
  local api_healthy=false
  local orchestrator_healthy=false
  local worker_healthy=false
  local agent_runtime_healthy=false

  while [[ $SECONDS -lt $deadline ]]; do
    if [[ "$api_healthy" == "false" ]] && curl -sf "http://localhost:$EVE_API_PORT/health" >/dev/null 2>&1; then
      echo -e "  API:          ${GREEN}healthy${NC}"
      api_healthy=true
    fi

    if [[ "$orchestrator_healthy" == "false" ]] && curl -sf "http://localhost:$EVE_ORCHESTRATOR_PORT/health" >/dev/null 2>&1; then
      echo -e "  Orchestrator: ${GREEN}healthy${NC}"
      orchestrator_healthy=true
    fi

    if [[ "$worker_healthy" == "false" ]] && curl -sf "http://localhost:$EVE_WORKER_PORT/health" >/dev/null 2>&1; then
      echo -e "  Worker:       ${GREEN}healthy${NC}"
      worker_healthy=true
    fi

    if [[ "$agent_runtime_healthy" == "false" ]] && curl -sf "http://localhost:$EVE_AGENT_RUNTIME_PORT/health" >/dev/null 2>&1; then
      echo -e "  Agent Runtime:${GREEN}healthy${NC}"
      agent_runtime_healthy=true
    fi

    if [[ "$api_healthy" == "true" && "$orchestrator_healthy" == "true" && "$worker_healthy" == "true" && "$agent_runtime_healthy" == "true" ]]; then
      return 0
    fi

    sleep 1
  done

  [[ "$api_healthy" == "true" ]] || echo -e "  API:          ${RED}not responding${NC}"
  [[ "$orchestrator_healthy" == "true" ]] || echo -e "  Orchestrator: ${RED}not responding${NC}"
  [[ "$worker_healthy" == "true" ]] || echo -e "  Worker:       ${RED}not responding${NC}"
  [[ "$agent_runtime_healthy" == "true" ]] || echo -e "  Agent Runtime:${RED}not responding${NC}"
  return 1
}

# ============================================================================
# Local Mode
# ============================================================================

do_start_local() {
  local use_test_db=false
  local reset_db=false

  # Parse flags
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --test|-t) use_test_db=true; shift ;;
      --reset-db) reset_db=true; shift ;;
      *) echo "Unknown option: $1"; exit 1 ;;
    esac
  done

  echo ""
  echo -e "${CYAN}Starting Eve Horizon (local mode)${NC}"
  echo "═══════════════════════════════════════════════════"
  echo ""

  # Clean up any existing processes
  kill_local_services

  # Determine database
  if [[ "$use_test_db" == "true" ]]; then
    local db_name="$EVE_DB_NAME_TEST"
    export DATABASE_URL="postgres://$EVE_DB_USER:$EVE_DB_PASSWORD@localhost:$EVE_DB_PORT/$EVE_DB_NAME_TEST"
  else
    local db_name="$EVE_DB_NAME"
    export DATABASE_URL="postgres://$EVE_DB_USER:$EVE_DB_PASSWORD@localhost:$EVE_DB_PORT/$EVE_DB_NAME"
  fi

  export API_PORT="$EVE_API_PORT"
  export ORCHESTRATOR_PORT="$EVE_ORCHESTRATOR_PORT"
  export WORKER_PORT="$EVE_WORKER_PORT"
  export AGENT_RUNTIME_PORT="$EVE_AGENT_RUNTIME_PORT"
  export EVE_API_URL="${EVE_API_URL:-http://localhost:$EVE_API_PORT}"
  export EVE_WORKER_URLS="default-worker=http://localhost:$EVE_WORKER_PORT"
  export EVE_AGENT_RUNTIME_URL="http://localhost:$EVE_AGENT_RUNTIME_PORT"
  export WORKSPACE_ROOT="/tmp/eve/workspaces"
  export ORCH_LOOP_INTERVAL_MS="${ORCH_LOOP_INTERVAL_MS:-1000}"
  export EVE_WORKER_POLL_INTERVAL_MS="${EVE_WORKER_POLL_INTERVAL_MS:-1000}"
  export EVE_AGENT_RUNTIME_POLL_INTERVAL_MS="${EVE_AGENT_RUNTIME_POLL_INTERVAL_MS:-200}"

  local preserved_internal_api_key="${EVE_INTERNAL_API_KEY:-}"
  local preserved_github_webhook_secret="${EVE_GITHUB_WEBHOOK_SECRET:-}"

  # Step 1: Start DB container
  echo -e "${YELLOW}[1/5] Starting database...${NC}"
  load_env_for_compose
  if [[ -n "$preserved_internal_api_key" ]]; then
    export EVE_INTERNAL_API_KEY="$preserved_internal_api_key"
  fi
  if [[ -n "$preserved_github_webhook_secret" ]]; then
    export EVE_GITHUB_WEBHOOK_SECRET="$preserved_github_webhook_secret"
  fi
  docker compose -p "$EVE_INSTANCE" -f "$COMPOSE_DEPS" up -d
  if ! wait_for_db; then
    echo -e "  Database: ${RED}failed to start${NC}"
    exit 1
  fi
  echo -e "  Database: ${GREEN}ready${NC}"
  echo ""

  # Step 2: Reset database if requested
  if [[ "$reset_db" == "true" ]]; then
    echo -e "${YELLOW}[2/5] Resetting database...${NC}"
    PGPASSWORD="$EVE_DB_PASSWORD" psql -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" -d postgres -c \
      "DROP DATABASE IF EXISTS $db_name" >/dev/null 2>&1
    echo -e "  Database: ${GREEN}reset${NC}"
  else
    echo -e "${YELLOW}[2/5] Checking database...${NC}"
  fi
  ensure_database "$db_name"
  echo -e "  Database ($db_name): ${GREEN}ready${NC}"
  echo ""

  # Step 3: Run migrations
  echo -e "${YELLOW}[3/5] Running migrations...${NC}"
  run_migrations "$db_name"
  echo ""

  # Step 4: Build shared packages
  echo -e "${YELLOW}[4/5] Building shared packages...${NC}"
  build_shared
  echo ""

  # Step 5: Start services
  echo -e "${YELLOW}[5/5] Starting services...${NC}"

  pnpm --filter @eve/api dev > /tmp/eve-api.log 2>&1 &
  save_pid "api" "$!"
  echo -e "  API:          ${GREEN}started${NC} (PID: $!)"

  pnpm --filter @eve/orchestrator dev > /tmp/eve-orchestrator.log 2>&1 &
  save_pid "orchestrator" "$!"
  echo -e "  Orchestrator: ${GREEN}started${NC} (PID: $!)"

  pnpm --filter @eve/worker start:dev > /tmp/eve-worker.log 2>&1 &
  save_pid "worker" "$!"
  echo -e "  Worker:       ${GREEN}started${NC} (PID: $!)"

  pnpm --filter @eve/agent-runtime dev > /tmp/eve-agent-runtime.log 2>&1 &
  save_pid "agent-runtime" "$!"
  echo -e "  Agent Runtime:${GREEN}started${NC} (PID: $!)"

  # Wait for health and update mode
  if wait_for_healthy; then
    set_current_mode "local"
    echo ""
    echo "═══════════════════════════════════════════════════"
    echo -e "${GREEN}Eve Horizon is ready (local mode)${NC}"
    echo ""
    echo "  API:          http://localhost:$EVE_API_PORT"
    echo "  Orchestrator: http://localhost:$EVE_ORCHESTRATOR_PORT"
    echo "  Worker:       http://localhost:$EVE_WORKER_PORT"
    echo "  Agent Runtime:http://localhost:$EVE_AGENT_RUNTIME_PORT"
    echo "  Logs:         tail -f /tmp/eve-*.log"
    echo ""
    echo -e "  ${BOLD}export EVE_API_URL=http://localhost:$EVE_API_PORT${NC}"
    echo ""
  else
    echo -e "${RED}Some services failed to start. Check logs: /tmp/eve-*.log${NC}"
    exit 1
  fi
}

# ============================================================================
# Docker Mode
# ============================================================================

do_start_docker() {
  local no_build=false
  local reset_db=false

  # Parse flags
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-build) no_build=true; shift ;;
      --reset-db) reset_db=true; shift ;;
      *) echo "Unknown option: $1"; exit 1 ;;
    esac
  done

  echo ""
  echo -e "${CYAN}Starting Eve Horizon (docker mode)${NC}"
  echo "═══════════════════════════════════════════════════"
  echo ""

  # Step 1: Reset if requested
  if [[ "$reset_db" == "true" ]]; then
    echo -e "${YELLOW}[1/4] Resetting database...${NC}"
    load_env_for_compose
    docker compose -p "$EVE_INSTANCE" -f "$COMPOSE_FULL" down -v 2>/dev/null || true
    echo -e "  Database: ${GREEN}reset${NC}"
    echo ""
  fi

  # Step 2: Check credentials
  echo -e "${YELLOW}[2/4] Checking authentication...${NC}"
  "$SCRIPT_DIR/../eh" auth check || true
  echo ""

  # Step 3: Start containers
  echo -e "${YELLOW}[3/4] Starting containers...${NC}"
  echo "  Ports: API=$EVE_API_PORT, Orchestrator=$EVE_ORCHESTRATOR_PORT, DB=$EVE_DB_PORT, Worker=$EVE_WORKER_PORT, AgentRuntime=$EVE_AGENT_RUNTIME_PORT"
  load_env_for_compose
  if [[ "$no_build" == "true" ]]; then
    docker compose -p "$EVE_INSTANCE" -f "$COMPOSE_FULL" up -d
  else
    docker compose -p "$EVE_INSTANCE" -f "$COMPOSE_FULL" up -d --build
  fi
  echo ""

  # Step 4: Wait for database and run migrations
  echo -e "${YELLOW}[4/4] Waiting for database...${NC}"
  if ! wait_for_db; then
    echo -e "  Database: ${RED}failed to start${NC}"
    exit 1
  fi
  echo -e "  Database: ${GREEN}ready${NC}"
  run_migrations "$EVE_DB_NAME"
  echo ""

  # Update mode and show success
  set_current_mode "docker"
  echo "═══════════════════════════════════════════════════"
  echo -e "${GREEN}Eve Horizon is ready (docker mode)${NC}"
  echo ""
  echo "  API:          http://localhost:$EVE_API_PORT"
  echo "  Orchestrator: http://localhost:$EVE_ORCHESTRATOR_PORT"
  echo "  Database:     localhost:$EVE_DB_PORT"
  echo ""
  echo -e "  ${BOLD}export EVE_API_URL=http://localhost:$EVE_API_PORT${NC}"
  echo ""
}

# ============================================================================
# Main
# ============================================================================

MODE="${1:-}"
shift || true

if [[ -z "$MODE" ]]; then
  echo -e "${RED}Error: Mode required${NC}"
  echo ""
  show_help
  exit 1
fi

case "$MODE" in
  local)
    # Check if different mode is running
    current=$(get_current_mode)
    if [[ "$current" != "none" && "$current" != "local" ]]; then
      echo -e "${YELLOW}Stopping current mode ($current) first...${NC}"
      "$SCRIPT_DIR/stop.sh"
    fi
    do_start_local "$@"
    ;;
  docker)
    # Check if different mode is running
    current=$(get_current_mode)
    if [[ "$current" != "none" && "$current" != "docker" ]]; then
      echo -e "${YELLOW}Stopping current mode ($current) first...${NC}"
      "$SCRIPT_DIR/stop.sh"
    fi
    do_start_docker "$@"
    ;;
  --help|-h|help)
    show_help
    ;;
  *)
    echo -e "${RED}Error: Unknown mode '$MODE'${NC}"
    echo ""
    show_help
    exit 1
    ;;
esac
