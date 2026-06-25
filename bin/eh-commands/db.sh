#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source configuration
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_common.sh"

COMPOSE_FILE="$PROJECT_ROOT/docker/compose/docker-compose.yml"
VOLUME_NAME="${EVE_INSTANCE}_db_data"

# ============================================================================
# Help
# ============================================================================

show_help() {
  echo "Database management"
  echo ""
  echo "Usage: eh db <subcommand>"
  echo ""
  echo "Subcommands:"
  echo "  migrate     Run database migrations"
  echo "  reset       Reset database to clean state (drops all data)"
  echo "  status      Show database connection status"
  echo ""
  echo "Reset options:"
  echo "  --force     Skip confirmation prompt"
  echo "  --test      Reset test database only (preserves dev database)"
}

# ============================================================================
# Helper Functions
# ============================================================================

wait_for_postgres() {
  for i in {1..30}; do
    if pg_isready -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# ============================================================================
# Commands
# ============================================================================

do_migrate() {
  cd "$PROJECT_ROOT"
  DATABASE_URL="postgres://${EVE_DB_USER}:${EVE_DB_PASSWORD}@localhost:$EVE_DB_PORT/${EVE_DB_NAME}" pnpm db:migrate
}

do_reset() {
  local force=false
  local test_only=false

  # Parse flags
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force|-f)
        force=true
        shift
        ;;
      --test|-t)
        test_only=true
        shift
        ;;
      *)
        echo "Unknown option: $1"
        exit 1
        ;;
    esac
  done

  echo -e "${YELLOW}Eve Horizon Database Reset ($EVE_INSTANCE)${NC}"
  echo ""

  if [[ "$test_only" == "true" ]]; then
    # Only reset test database (preserves dev database)
    echo -e "Resetting test database only: ${CYAN}$EVE_DB_NAME_TEST${NC}"
    echo ""

    if [[ "$force" != "true" ]]; then
      echo -e "${RED}WARNING: This will delete ALL data in the test database!${NC}"
      echo ""
      read -p "Are you sure? (type 'yes' to confirm): " confirm
      if [[ "$confirm" != "yes" ]]; then
        echo "Aborted."
        exit 1
      fi
      echo ""
    fi

    # Ensure postgres is running
    if ! pg_isready -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" >/dev/null 2>&1; then
      echo -e "${CYAN}Starting postgres...${NC}"
      docker compose -p "$EVE_INSTANCE" -f "$COMPOSE_FILE" up -d db
      sleep 3
    fi

    # Drop and recreate test database
    echo -e "${CYAN}Dropping test database...${NC}"
    PGPASSWORD="$EVE_DB_PASSWORD" psql -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" -d postgres -c \
      "DROP DATABASE IF EXISTS $EVE_DB_NAME_TEST" >/dev/null 2>&1

    echo -e "${CYAN}Creating test database...${NC}"
    PGPASSWORD="$EVE_DB_PASSWORD" psql -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" -d postgres -c \
      "CREATE DATABASE $EVE_DB_NAME_TEST" >/dev/null 2>&1

    # Run migrations on test database
    echo -e "${CYAN}Running migrations...${NC}"
    DATABASE_URL="postgres://${EVE_DB_USER}:${EVE_DB_PASSWORD}@localhost:$EVE_DB_PORT/${EVE_DB_NAME_TEST}" \
      pnpm --filter @eve/db migrate >/dev/null 2>&1

    echo ""
    echo -e "${GREEN}Test database reset complete!${NC}"
  else
    # Full reset (removes docker volume)
    echo -e "Full database reset: ${CYAN}$EVE_DB_NAME${NC} (removes docker volume)"
    echo ""

    if [[ "$force" != "true" ]]; then
      echo -e "${RED}WARNING: This will delete ALL data in the database!${NC}"
      echo ""
      read -p "Are you sure? (type 'yes' to confirm): " confirm
      if [[ "$confirm" != "yes" ]]; then
        echo "Aborted."
        exit 1
      fi
      echo ""
    fi

    # Stop dev services if running
    echo -e "${CYAN}Stopping services...${NC}"
    "$SCRIPT_DIR/dev.sh" stop --quiet 2>/dev/null || true

    # Stop docker containers
    docker compose -p "$EVE_INSTANCE" -f "$COMPOSE_FILE" down 2>/dev/null || true

    # Remove the database volume
    echo -e "${CYAN}Removing database volume...${NC}"
    docker volume rm "$VOLUME_NAME" 2>/dev/null || true
    docker volume rm "db_data" 2>/dev/null || true

    # Start just the database
    echo -e "${CYAN}Starting fresh database...${NC}"
    docker compose -p "$EVE_INSTANCE" -f "$COMPOSE_FILE" up -d db
    sleep 3

    # Wait for postgres to be ready
    echo -e "${CYAN}Waiting for postgres...${NC}"
    if ! wait_for_postgres; then
      echo -e "${RED}ERROR: Postgres failed to start${NC}"
      exit 1
    fi
    echo -e "Postgres: ${GREEN}ready${NC}"

    # Run migrations
    echo -e "${CYAN}Running migrations...${NC}"
    DATABASE_URL="postgres://${EVE_DB_USER}:${EVE_DB_PASSWORD}@localhost:$EVE_DB_PORT/${EVE_DB_NAME}" \
      pnpm --filter @eve/db migrate

    echo ""
    echo -e "${GREEN}Database reset complete!${NC}"
    echo ""
    echo -e "To start dev services: ${CYAN}./bin/eh dev start${NC}"
  fi
}

do_status() {
  echo "Database Status"
  echo "==============="
  echo ""
  echo "Configuration:"
  echo "  Host:     localhost:$EVE_DB_PORT"
  echo "  User:     $EVE_DB_USER"
  echo "  Dev DB:   $EVE_DB_NAME"
  echo "  Test DB:  $EVE_DB_NAME_TEST"
  echo ""

  if pg_isready -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" >/dev/null 2>&1; then
    echo -e "Connection: ${GREEN}Ready${NC}"

    # Check which databases exist
    echo ""
    echo "Databases:"
    if PGPASSWORD="$EVE_DB_PASSWORD" psql -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" -d postgres -tc \
      "SELECT 1 FROM pg_database WHERE datname = '$EVE_DB_NAME'" 2>/dev/null | grep -q 1; then
      echo -e "  $EVE_DB_NAME: ${GREEN}exists${NC}"
    else
      echo -e "  $EVE_DB_NAME: ${YELLOW}not created${NC}"
    fi

    if PGPASSWORD="$EVE_DB_PASSWORD" psql -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" -d postgres -tc \
      "SELECT 1 FROM pg_database WHERE datname = '$EVE_DB_NAME_TEST'" 2>/dev/null | grep -q 1; then
      echo -e "  $EVE_DB_NAME_TEST: ${GREEN}exists${NC}"
    else
      echo -e "  $EVE_DB_NAME_TEST: ${YELLOW}not created${NC}"
    fi
  else
    echo -e "Connection: ${RED}Not available${NC}"
    echo ""
    echo -e "Start postgres: ${CYAN}./bin/eh docker start${NC} or ${CYAN}./bin/eh dev start${NC}"
  fi
}

# ============================================================================
# Main
# ============================================================================

SUBCOMMAND="${1:-}"
shift || true

case "$SUBCOMMAND" in
  migrate)
    do_migrate
    ;;
  reset)
    do_reset "$@"
    ;;
  status)
    do_status
    ;;
  -h|--help|help|"")
    show_help
    ;;
  *)
    echo "Unknown subcommand: $SUBCOMMAND" >&2
    show_help
    exit 1
    ;;
esac
