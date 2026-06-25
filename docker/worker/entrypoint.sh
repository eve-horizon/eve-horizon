#!/usr/bin/env bash
set -euo pipefail

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

  if command -v "$name" >/dev/null 2>&1; then
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
    }
  else
    "${timeout_prefix[@]}" "${command_prefix[@]}" quick --provider "$provider" --name "$name" --yes --no-tui || {
      echo "WARNING: Failed to install cc-mirror variant $name — continuing without it" >&2
    }
  fi
}

# Extend PATH with any mounted toolchains
if [ -n "${EVE_TOOLCHAIN_PATHS:-}" ]; then
  export PATH="${EVE_TOOLCHAIN_PATHS}:${PATH}"
fi

# Extend PATH with image-based app CLIs (injected via init containers)
if [ -n "${EVE_APP_CLI_PATHS:-}" ]; then
  export PATH="${EVE_APP_CLI_PATHS}:${PATH}"
fi

# Source per-toolchain env.sh files (sets JAVA_HOME, RUSTUP_HOME, etc.)
for tc_dir in /opt/eve/toolchains/*/; do
  if [ -f "${tc_dir}env.sh" ]; then
    . "${tc_dir}env.sh"
  fi
done

# Ensure workspace directory exists with proper permissions
if [[ -n "${WORKSPACE_ROOT:-}" ]]; then
  mkdir -p "$WORKSPACE_ROOT" 2>/dev/null || true
fi

preflight_check
ensure_env_aliases
ensure_variant "mclaude" "mirror" ""
ensure_variant "zai" "zai" "${Z_AI_API_KEY:-}"
write_claude_credentials
write_codex_credentials

# Start orphan reaper daemon if enabled (default: enabled)
# The reaper periodically detects and kills orphaned processes that can
# accumulate when agent jobs timeout or are killed, exhausting system resources.
if [[ "${EVE_ORPHAN_REAPER:-true}" == "true" ]]; then
  if command -v orphan-reaper >/dev/null 2>&1; then
    orphan-reaper start >&2
  fi
fi

exec "$@"
