#!/bin/bash
set -euo pipefail

# This script runs with the worker's full environment (every platform secret).
# Job code shares the worker's UID and can write $HOME, /opt/eve and anything
# else the worker can, and it can force a container restart. So until it hands
# over to the service, this script runs only root-installed programs: its own
# commands resolve through a root-owned PATH, and it never sources files a job
# could have written. The original PATH is restored for the service, whose
# harnesses need ~/.local/bin; the service runs its own helpers from a trusted
# PATH (packages/shared/src/process-isolation.ts).
SERVICE_JOB_PATH="$PATH"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

write_claude_credentials() {
  # Claude auth is handled via CLAUDE_CODE_OAUTH_TOKEN env var (the CI auth path).
  # No credentials file needed — the worker passes the env var directly to each
  # harness process, avoiding race conditions between concurrent jobs.
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "Claude auth: ANTHROPIC_API_KEY set" >&2
  elif [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    echo "Claude auth: CLAUDE_CODE_OAUTH_TOKEN set (env var)" >&2
  else
    echo "Claude auth: no credentials found (set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)" >&2
  fi
}

write_codex_credentials() {
  # Write to both ~/.code (Every Code) and ~/.codex (OpenAI Codex)
  # NOTE: Access token only - refresh not supported (re-auth with 'code auth' when expired)
  local code_home="${CODEX_HOME:-$HOME/.code}"
  local codex_home="$HOME/.codex"

  write_auth_to_dir() {
    local dir="$1"
    local auth_file="$dir/auth.json"
    mkdir -p "$dir"

    if [[ -n "${CODEX_AUTH_JSON:-}" ]]; then
      echo "$CODEX_AUTH_JSON" | base64 --decode > "$auth_file"
      chmod 600 "$auth_file" 2>/dev/null || true
      echo "Wrote auth.json to $auth_file from CODEX_AUTH_JSON" >&2
      return 0
    fi

    if [[ -z "${CODEX_OAUTH_ACCESS_TOKEN:-}" ]]; then
      return 1
    fi

    local json
    json='{"tokens":{"access_token":"'"$CODEX_OAUTH_ACCESS_TOKEN"'"'

    if [[ -n "${CODEX_OAUTH_ID_TOKEN:-}" ]]; then
      json+=',"id_token":"'"$CODEX_OAUTH_ID_TOKEN"'"'
    fi

    if [[ -n "${CODEX_OAUTH_ACCOUNT_ID:-}" ]]; then
      json+=',"account_id":"'"$CODEX_OAUTH_ACCOUNT_ID"'"'
    fi

    json+='}}'

    printf '%s' "$json" > "$auth_file"
    chmod 600 "$auth_file" 2>/dev/null || true
    echo "Wrote auth.json to $auth_file" >&2
    return 0
  }

  # Write to ~/.code for Every Code CLI
  write_auth_to_dir "$code_home" || true
  # Write to ~/.codex for OpenAI Codex CLI
  write_auth_to_dir "$codex_home" || true
}

preflight_check() {
  # For backwards compatibility: use WORKSPACE_ROOT if EVE_WORKSPACE_ROOT is not set
  if [[ -z "${EVE_WORKSPACE_ROOT:-}" && -n "${WORKSPACE_ROOT:-}" ]]; then
    export EVE_WORKSPACE_ROOT="$WORKSPACE_ROOT"
  fi

  # Define required writable paths
  local required_paths=(
    "/opt/eve/workspaces"
    "/opt/eve/cache"
    "/opt/eve/state"
    "/opt/eve/toolchains"
    "$HOME/.config"
    "$HOME/.cache"
    "$HOME/.npm"
    "$HOME/.local"
    "$HOME/.claude"
    "$HOME/.cc-mirror"
    "$HOME/.code"
    "$HOME/.codex"
  )

  # If EVE_WORKSPACE_ROOT is set and differs from default, add it to required paths
  if [[ -n "${EVE_WORKSPACE_ROOT:-}" && "$EVE_WORKSPACE_ROOT" != "/opt/eve/workspaces" ]]; then
    mkdir -p "$EVE_WORKSPACE_ROOT" 2>/dev/null || {
      echo "ERROR: Failed to create EVE_WORKSPACE_ROOT directory: $EVE_WORKSPACE_ROOT" >&2
      exit 1
    }
    required_paths+=("$EVE_WORKSPACE_ROOT")
  fi

  # Check each required path
  for path in "${required_paths[@]}"; do
    if [[ ! -d "$path" ]]; then
      echo "ERROR: Required path does not exist and cannot be created: $path" >&2
      exit 1
    fi

    if [[ ! -w "$path" ]]; then
      echo "ERROR: Required path is not writable: $path" >&2
      exit 1
    fi
  done

  echo "Preflight check passed: all required paths are writable" >&2
}

ensure_env_aliases() {
  # Alias ZAI_API_KEY -> Z_AI_API_KEY for compatibility
  if [[ -z "${Z_AI_API_KEY:-}" && -n "${ZAI_API_KEY:-}" ]]; then
    export Z_AI_API_KEY="$ZAI_API_KEY"
  fi
}

ensure_variant() {
  local name="$1"
  local provider="$2"
  local api_key="$3"

  # Existence check only (nothing is executed), so the job PATH is fine here.
  if PATH="$SERVICE_JOB_PATH" command -v "$name" >/dev/null 2>&1; then
    return 0
  fi

  if [[ "$provider" == "zai" && -z "$api_key" ]]; then
    echo "Z_AI_API_KEY not set; skipping zai variant install" >&2
    return 0
  fi

  echo "Installing cc-mirror variant: $name ($provider)" >&2
  local command_prefix=()
  if command -v cc-mirror >/dev/null 2>&1; then
    command_prefix=(cc-mirror)
  else
    command_prefix=(npx --yes cc-mirror)
  fi

  local timeout_prefix=()
  if command -v timeout >/dev/null 2>&1; then
    timeout_prefix=(timeout "${EVE_CC_MIRROR_SETUP_TIMEOUT:-20s}")
  fi

  if [[ -n "$api_key" ]]; then
    "${timeout_prefix[@]}" "${command_prefix[@]}" quick --provider "$provider" --name "$name" --api-key "$api_key" --yes --no-tui || {
      echo "WARNING: Failed to install cc-mirror variant $name — continuing without it" >&2
      return 0
    }
  else
    "${timeout_prefix[@]}" "${command_prefix[@]}" quick --provider "$provider" --name "$name" --yes --no-tui || {
      echo "WARNING: Failed to install cc-mirror variant $name — continuing without it" >&2
      return 0
    }
  fi
  echo "Installed cc-mirror variant: $name" >&2
}

# The image bakes the harness variants in. Anything still missing (a custom
# image, or zai once Z_AI_API_KEY is provided) is installed in the background:
# a network install must not hold up the service, its probes or a runner pod.
# The double fork hands the installer to tini (PID 1), which reaps it.
install_missing_variants_in_background() {
  ( {
      ensure_variant "mclaude" "mirror" ""
      ensure_variant "zai" "zai" "${Z_AI_API_KEY:-}"
    } & )
}

# docker/worker/entrypoint.test.sh sources this file for its functions only.
if [[ "${EVE_ENTRYPOINT_FUNCTIONS_ONLY:-}" == "1" ]]; then
  return 0
fi

# Ensure workspace directory exists with proper permissions
if [[ -n "${WORKSPACE_ROOT:-}" ]]; then
  mkdir -p "$WORKSPACE_ROOT" 2>/dev/null || true
fi

preflight_check
ensure_env_aliases
install_missing_variants_in_background
write_claude_credentials
write_codex_credentials

# Start orphan reaper daemon if enabled (default: enabled)
# The reaper periodically detects and kills orphaned processes that can
# accumulate when agent jobs timeout or are killed, exhausting system resources.
if [[ "${EVE_ORPHAN_REAPER:-true}" == "true" ]]; then
  if [[ -x /usr/local/bin/orphan-reaper ]]; then
    # The reaper outlives this script as an ordinary (dumpable) process with the
    # worker's UID, so job code could read its /proc/<pid>/environ. Start it with
    # only what it needs, never the worker's secrets. $$ is the PID the service
    # will run as after `exec`; the reaper never kills it.
    env -i PATH="$PATH" HOME="$HOME" EVE_REAPER_SERVICE_PID="$$" \
      ${EVE_REAPER_INTERVAL:+EVE_REAPER_INTERVAL="$EVE_REAPER_INTERVAL"} \
      ${EVE_ORPHAN_AGE:+EVE_ORPHAN_AGE="$EVE_ORPHAN_AGE"} \
      ${EVE_REAPER_LOG:+EVE_REAPER_LOG="$EVE_REAPER_LOG"} \
      /usr/local/bin/orphan-reaper start >&2
  fi
fi

# Hand over to the service with the original PATH.
export PATH="$SERVICE_JOB_PATH"

# Runner pods only: toolchains and app CLIs copied in by init containers. A
# runner pod runs one job and never restarts (restartPolicy: Never), so these
# files are read before any job code has run. In the long-lived worker,
# /opt/eve/toolchains is a job-writable cache and is never sourced here; jobs
# get toolchain env from ensureToolchains instead.
if [[ "${EVE_RUNNER_SELF_TERMINATE:-}" == "1" ]]; then
  if [ -n "${EVE_TOOLCHAIN_PATHS:-}" ]; then
    export PATH="${EVE_TOOLCHAIN_PATHS}:${PATH}"
  fi
  if [ -n "${EVE_APP_CLI_PATHS:-}" ]; then
    export PATH="${EVE_APP_CLI_PATHS}:${PATH}"
  fi
  # Sets JAVA_HOME, RUSTUP_HOME, etc.
  for tc_dir in /opt/eve/toolchains/*/; do
    if [ -f "${tc_dir}env.sh" ]; then
      . "${tc_dir}env.sh"
    fi
  done
fi

exec "$@"
