#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source configuration
source "$SCRIPT_DIR/_config.sh"

usage() {
  echo "Usage: eh test <subcommand> [options]"
  echo ""
  echo "Subcommands:"
  echo "  integration       Run integration tests (default suite)"
  echo "  scenarios-lint    Lint manual test scenarios for forbidden recipient patterns"
  echo ""
  echo "integration options:"
  echo "  --env dev|docker|stack   Execution environment (default: dev)"
  echo "  --target <pattern> Filter which tests run (default: test/integration)"
  echo "  --real             Use real harnesses instead of stubs (dev mode only)"
  echo "  --reset-db         Reset database before running (docker: removes volume)"
  echo "  --skip-lint        Skip the scenarios-lint preflight"
}

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

wait_for_db() {
  local host="$1"
  local port="$2"

  for _ in {1..30}; do
    if command -v pg_isready >/dev/null 2>&1; then
      if pg_isready -h "$host" -p "$port" -U "$EVE_DB_USER" >/dev/null 2>&1; then
        return 0
      fi
    else
      if nc -z "$host" "$port" >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 1
  done

  return 1
}

docker_ready() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

db_ready() {
  if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" >/dev/null 2>&1
    return $?
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z localhost "$EVE_DB_PORT" >/dev/null 2>&1
    return $?
  fi
  return 1
}

reset_test_db() {
  # Drop and recreate test database (preserves dev database)
  echo "Resetting test database ($EVE_DB_NAME_TEST)..."
  # Docker mode may already have services connected to eve_test; force-drop handles active sessions.
  if ! PGPASSWORD="$EVE_DB_PASSWORD" psql -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" -d postgres -c \
    "DROP DATABASE IF EXISTS $EVE_DB_NAME_TEST WITH (FORCE)" >/dev/null 2>&1; then
    # Fallback for Postgres variants that do not support WITH (FORCE).
    PGPASSWORD="$EVE_DB_PASSWORD" psql -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" -d postgres -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$EVE_DB_NAME_TEST' AND pid <> pg_backend_pid()" >/dev/null 2>&1
    PGPASSWORD="$EVE_DB_PASSWORD" psql -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" -d postgres -c \
      "DROP DATABASE IF EXISTS $EVE_DB_NAME_TEST" >/dev/null 2>&1
  fi
  PGPASSWORD="$EVE_DB_PASSWORD" psql -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" -d postgres -c \
    "CREATE DATABASE $EVE_DB_NAME_TEST" >/dev/null 2>&1
  echo "Test database reset complete"
}

ensure_test_db() {
  # Create test database if it doesn't exist
  PGPASSWORD="$EVE_DB_PASSWORD" psql -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" -d postgres -tc \
    "SELECT 1 FROM pg_database WHERE datname = '$EVE_DB_NAME_TEST'" 2>/dev/null | grep -q 1 || \
    PGPASSWORD="$EVE_DB_PASSWORD" psql -h localhost -p "$EVE_DB_PORT" -U "$EVE_DB_USER" -d postgres -c \
    "CREATE DATABASE $EVE_DB_NAME_TEST" >/dev/null 2>&1
}

command="${1:-}"
shift || true

SCENARIO_LINT="$PROJECT_ROOT/tests/scenario-lint/forbid-fake-recipients.sh"

run_scenario_lint() {
  # Fast, dependency-free preflight: forbid throwaway recipient patterns that
  # have historically polluted the @example.com SES sender reputation.
  if [[ -x "$SCENARIO_LINT" ]]; then
    echo "Running scenario lint..."
    if ! "$SCENARIO_LINT"; then
      echo "Scenario lint failed. Fix the offending recipients (or use SES simulator addresses)." >&2
      return 1
    fi
  fi
  return 0
}

case "$command" in
  integration)
    VITEST_CONFIG="vitest.integration.config.ts"
    ;;
  scenarios-lint)
    if [[ ! -x "$SCENARIO_LINT" ]]; then
      echo "Lint script not found or not executable: $SCENARIO_LINT" >&2
      exit 2
    fi
    exec "$SCENARIO_LINT" "$@"
    ;;
  *)
    usage
    exit 1
    ;;
esac

# Load .env.test for integration tests (provides auth keys, test secrets, etc.)
load_env_file "$PROJECT_ROOT/.env.test"

ENV_TARGET="${EVE_INTEGRATION_ENV:-dev}"
USE_REAL_MCLAUDE="${EVE_INTEGRATION_USE_REAL_MCLAUDE:-false}"
RESET_DB="${EVE_INTEGRATION_RESET_DB:-false}"
DEFAULT_PROJECT_NAME="integration-project"
SKIP_LINT="${EVE_INTEGRATION_SKIP_LINT:-false}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_TARGET="$2"
      shift 2
      ;;
    --target)
      TEST_TARGET="$2"
      shift 2
      ;;
    --real)
      USE_REAL_MCLAUDE="true"
      shift
      ;;
    --reset-db)
      RESET_DB="true"
      shift
      ;;
    --skip-lint)
      SKIP_LINT="true"
      shift
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

# Run the scenario lint as a fast preflight before spinning up services. This is
# cheap (sub-second grep) and catches polluting recipient patterns before any
# real test run touches SES. Use --skip-lint to bypass for local-only loops.
if [[ "$SKIP_LINT" != "true" ]]; then
  if ! run_scenario_lint; then
    exit 1
  fi
fi

E2E_ROOT="$PROJECT_ROOT/tests/fixtures"
E2E_BIN="$E2E_ROOT/bin"

# Skills are now repo-only via OpenSkills (.agents/skills/)
if [[ "$ENV_TARGET" == "docker" ]]; then
  USE_REAL_MCLAUDE="true"
  DEFAULT_PROJECT_NAME="IntgProj"  # Short name for valid 4-8 char slug
  # Fixtures are copied to workspaces/fixtures which is mounted at /opt/eve/workspaces/fixtures
  export EVE_INTEGRATION_REPO_URL="${EVE_INTEGRATION_REPO_URL:-file:///opt/eve/workspaces/fixtures/e2e-project}"
fi

if [[ "$ENV_TARGET" == "stack" ]]; then
  USE_REAL_MCLAUDE="true"  # Stack mode (K8s) always uses real harnesses
  DEFAULT_PROJECT_NAME="IntgProj"
fi

export EVE_INTEGRATION_PROJECT_NAME="${EVE_INTEGRATION_PROJECT_NAME:-$DEFAULT_PROJECT_NAME}"

export EVE_INTEGRATION_USE_REAL_MCLAUDE="$USE_REAL_MCLAUDE"
export EVE_INTEGRATION_ENV="$ENV_TARGET"
if [[ "$ENV_TARGET" == "stack" ]]; then
  # Stack mode: worker routing is internal to k8s (orchestrator config)
  # Only set if explicitly overridden for debugging
  [[ -n "${WORKER_URL:-}" ]] && export WORKER_URL
  [[ -n "${EVE_WORKER_URLS:-}" ]] && export EVE_WORKER_URLS
else
  export WORKER_URL="http://localhost:$EVE_WORKER_PORT"
  export EVE_WORKER_URLS="default-worker=http://localhost:$EVE_WORKER_PORT"
  export WORKSPACE_ROOT="${WORKSPACE_ROOT:-/tmp/eve/workspaces}"
fi

if [[ "$ENV_TARGET" == "docker" ]]; then
  load_env_file "$PROJECT_ROOT/.env"
  load_env_file "$PROJECT_ROOT/system-secrets.env.local"
fi

if [[ -z "${EVE_SECRETS_MASTER_KEY:-}" ]]; then
  export EVE_SECRETS_MASTER_KEY="test-master-key"
fi

if [[ -z "${EVE_INTERNAL_API_KEY:-}" ]]; then
  export EVE_INTERNAL_API_KEY="test-internal-key"
fi

if [[ "$ENV_TARGET" == "dev" ]]; then
  if ! db_ready; then
    if ! docker_ready; then
      echo "Docker not available and Postgres not running; skipping tests." >&2
      exit 0
    fi
  fi
fi

if [[ "$ENV_TARGET" == "docker" ]]; then
  if ! docker_ready; then
    echo "Docker not available; skipping tests." >&2
    exit 0
  fi
fi

if [[ "$ENV_TARGET" == "stack" ]]; then
  # Stack mode uses k8s Ingress (no port-forward needed)
  # Unconditionally set - override any .env.test defaults for stack mode
  export EVE_API_URL="http://api.eve.lvh.me"

  # FAIL FAST: Verify stack is healthy before running tests
  echo "Preflight check: verifying k8s stack health..."

  # Check k3d cluster is running
  if ! command -v k3d &>/dev/null || ! k3d cluster list 2>/dev/null | grep -qE "eve-local[[:space:]]+[0-9]+/[0-9]+"; then
    echo "ERROR: k3d cluster 'eve-local' is not running" >&2
    echo "  Run: ./bin/eh k8s start && ./bin/eh k8s deploy" >&2
    exit 1
  fi

  # Check API is reachable (5 second timeout)
  if ! curl -sf --connect-timeout 5 "$EVE_API_URL/health" &>/dev/null; then
    echo "ERROR: API not reachable at $EVE_API_URL" >&2
    echo "  Check: kubectl -n eve get pods" >&2
    echo "  Logs:  kubectl -n eve logs deployment/eve-api --tail=50" >&2
    exit 1
  fi

  echo "  ✓ k3d cluster running"
  echo "  ✓ API healthy at $EVE_API_URL"
  if [[ -z "${EVE_INTEGRATION_REPO_URL:-}" ]]; then
    export EVE_INTEGRATION_REPO_URL="https://github.com/eve-horizon/eve-horizon"
  fi
fi

if [[ "$USE_REAL_MCLAUDE" != "true" ]]; then
  export PATH="$E2E_BIN:$PATH"
  export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-stub}"
  export Z_AI_API_KEY="${Z_AI_API_KEY:-stub}"
  export GEMINI_API_KEY="${GEMINI_API_KEY:-stub}"
  export OPENAI_API_KEY="${OPENAI_API_KEY:-stub}"
  echo "Using stub harnesses (set EVE_INTEGRATION_USE_REAL_MCLAUDE=true or --real for real harnesses)"
else
  echo "Using real harnesses (tests will auto-skip harnesses without auth)"

  # Check for Claude credentials from host if not in env
  if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    # Try the extraction script which handles both file and Keychain
    EXTRACT_SCRIPT="$SCRIPT_DIR/auth.sh"
    CREDS_OUTPUT=$("$EXTRACT_SCRIPT" extract --env 2>/dev/null || true)
    if [[ -n "$CREDS_OUTPUT" ]]; then
      eval "$CREDS_OUTPUT"
      if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
        export CLAUDE_CODE_OAUTH_TOKEN
        export CLAUDE_OAUTH_REFRESH_TOKEN="${CLAUDE_OAUTH_REFRESH_TOKEN:-}"
        export CLAUDE_OAUTH_EXPIRES_AT="${CLAUDE_OAUTH_EXPIRES_AT:-}"
        if [[ "$(uname -s)" == "Darwin" ]]; then
          echo "  → Claude: loaded OAuth from macOS Keychain"
        else
          echo "  → Claude: loaded OAuth from credentials file"
        fi
      fi
    fi
  else
    echo "  → Claude: using env var"
  fi

  # Check for Codex/Code credentials from host if not in env
  if [[ -z "${OPENAI_API_KEY:-}" && -z "${CODEX_OAUTH_ACCESS_TOKEN:-}" && -z "${CODEX_AUTH_JSON:-}" ]]; then
    CODE_AUTH_FILE="$HOME/.code/auth.json"
    CODEX_AUTH_FILE="$HOME/.codex/auth.json"
    AUTH_FILE=""
    [[ -f "$CODE_AUTH_FILE" ]] && AUTH_FILE="$CODE_AUTH_FILE"
    [[ -z "$AUTH_FILE" && -f "$CODEX_AUTH_FILE" ]] && AUTH_FILE="$CODEX_AUTH_FILE"
    if [[ -n "$AUTH_FILE" ]]; then
      # Try API key first (check it's not null)
      API_KEY=$(jq -r 'if .OPENAI_API_KEY != null then .OPENAI_API_KEY else empty end' "$AUTH_FILE" 2>/dev/null || true)
      if [[ -n "$API_KEY" ]]; then
        export OPENAI_API_KEY="$API_KEY"
        echo "  → Codex/Code: loaded API key from $AUTH_FILE"
      else
        # Pass entire auth.json as base64 for full OAuth support (including refresh)
        export CODEX_AUTH_JSON=$(base64 < "$AUTH_FILE")
        export CODEX_AUTH_JSON_B64="$CODEX_AUTH_JSON"  # Alias for docker-compose
        echo "  → Codex/Code: loaded auth.json from $AUTH_FILE (base64)"
      fi
    fi
  else
    echo "  → Codex/Code: using env var"
  fi

  # Report auth status
  [[ -n "${Z_AI_API_KEY:-}" ]] && echo "  → Z.ai: using env var"
  [[ -n "${GOOGLE_API_KEY:-}${GEMINI_API_KEY:-}" ]] && echo "  → Gemini: using env var"
fi

if [[ "$ENV_TARGET" == "dev" ]]; then
  # Keep integration timing deterministic even when local dev defaults are tuned
  # aggressively for interactive latency.
  export ORCH_LOOP_INTERVAL_MS="${ORCH_LOOP_INTERVAL_MS:-5000}"
  export EVE_WORKER_POLL_INTERVAL_MS="${EVE_WORKER_POLL_INTERVAL_MS:-5000}"
  export EVE_AGENT_RUNTIME_POLL_INTERVAL_MS="${EVE_AGENT_RUNTIME_POLL_INTERVAL_MS:-500}"

  # Stop any existing services
  "$SCRIPT_DIR/stop.sh" --quiet || true

  # Reset test database if requested (before starting services)
  if [[ "$RESET_DB" == "true" ]]; then
    # Ensure postgres is running first
    if ! db_ready; then
      if docker_ready; then
        docker compose -p "$EVE_INSTANCE" -f "$PROJECT_ROOT/docker/compose/docker-compose.deps.yml" up -d
        sleep 3
      fi
    fi
    if db_ready; then
      reset_test_db
    fi
  fi

  "$SCRIPT_DIR/start.sh" local --test
elif [[ "$ENV_TARGET" == "docker" ]]; then
  mkdir -p "$PROJECT_ROOT/workspaces"

  # Copy test fixtures to workspaces so they're accessible inside containers
  # (workspaces is mounted at /opt/eve/workspaces in the worker container)
  if [[ -d "$PROJECT_ROOT/tests/fixtures/repos" ]]; then
    mkdir -p "$PROJECT_ROOT/workspaces/fixtures"
    cp -r "$PROJECT_ROOT/tests/fixtures/repos/e2e-project" "$PROJECT_ROOT/workspaces/fixtures/" 2>/dev/null || true
  fi

  # Load credentials for docker compose
  if [[ -f "$PROJECT_ROOT/system-secrets.env.local" ]]; then
    set -a
    source "$PROJECT_ROOT/system-secrets.env.local"
    set +a
  fi

  # Stop containers
  docker compose -p "$EVE_INSTANCE" -f "$PROJECT_ROOT/docker/compose/docker-compose.yml" down --remove-orphans

  # Override DATABASE_URL for containers to use test database
  export DATABASE_URL="postgres://${EVE_DB_USER}:${EVE_DB_PASSWORD}@db:5432/${EVE_DB_NAME_TEST}"
  docker compose -p "$EVE_INSTANCE" -f "$PROJECT_ROOT/docker/compose/docker-compose.yml" up -d --build
  if ! wait_for_db "localhost" "$EVE_DB_PORT"; then
    echo "Database failed to become ready on localhost:$EVE_DB_PORT" >&2
    exit 1
  fi

  # Reset test database if requested (preserves dev database)
  if [[ "$RESET_DB" == "true" ]]; then
    reset_test_db
  fi

  # Ensure test database exists and run migrations
  ensure_test_db
  DATABASE_URL="postgres://${EVE_DB_USER}:${EVE_DB_PASSWORD}@localhost:$EVE_DB_PORT/${EVE_DB_NAME_TEST}" \
    pnpm --filter @eve/db migrate >/dev/null 2>&1
elif [[ "$ENV_TARGET" == "stack" ]]; then
  echo "Using existing stack at $EVE_API_URL"
fi

# Export API URL for tests to use
export EVE_API_URL="${EVE_API_URL:-http://localhost:$EVE_API_PORT}"
READY=0
for i in {1..30}; do
  if curl -s "$EVE_API_URL/health" | grep -q "ok"; then
    READY=1
    break
  fi
  sleep 1
done

if [[ "$READY" -ne 1 ]]; then
  echo "API failed to become ready at $EVE_API_URL" >&2
  exit 1
fi

cd "$PROJECT_ROOT"
pnpm --filter @eve/shared build
pnpm --filter @eve/api exec vitest run -c "$VITEST_CONFIG" ${TEST_TARGET:-}
