#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source configuration
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_common.sh"

# ============================================================================
# Help
# ============================================================================

show_help() {
  echo "Authentication credential inspection"
  echo ""
  echo "Usage: eh auth <subcommand>"
  echo ""
  echo "Subcommands:"
  echo "  extract     Extract Claude and Codex credentials from host system"
  echo "  check       Check current authentication status"
  echo ""
  echo "Extract options:"
  echo "  --env       Output in .env format"
  echo "  --json      Output in JSON format"
  echo "  --claude    Extract only Claude credentials"
  echo "  --codex     Extract only Codex credentials"
  echo ""
  echo "To provision secrets for Eve, use the eve CLI:"
  echo "  eve secrets set CLAUDE_CODE_OAUTH_TOKEN <token> --org <id>"
  echo "  eve secrets set Z_AI_API_KEY <key> --org <id>"
  echo ""
  echo "Examples:"
  echo "  eh auth extract                 # Display credentials"
  echo "  eh auth extract --env           # Output for eval/copy"
  echo "  eh auth check                   # Show credential status"
}

# ============================================================================
# Extraction Functions
# ============================================================================

extract_macos() {
  # Find ALL Claude Code keychain entries and pick the one with longest expiry
  local best_creds=""
  local best_expiry=0

  # Get all keychain entry names matching "Claude Code-credentials*"
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue

    local creds
    creds=$(security find-generic-password -s "$entry" -w 2>/dev/null) || continue

    # Extract expiresAt from JSON
    local expiry
    expiry=$(echo "$creds" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('claudeAiOauth',{}).get('expiresAt',0))" 2>/dev/null) || continue

    # Convert to integer for comparison
    expiry=${expiry:-0}
    if [[ "$expiry" =~ ^[0-9]+$ ]] && (( expiry > best_expiry )); then
      best_expiry=$expiry
      best_creds="$creds"
    fi
  done < <(security dump-keychain 2>/dev/null | grep -o '"Claude Code-credentials[^"]*"' | tr -d '"' | sort -u)

  if [[ -n "$best_creds" ]]; then
    echo "$best_creds"
    return 0
  fi

  return 1
}

extract_linux() {
  # Linux credential storage locations to check
  local locations=(
    "$HOME/.claude/.credentials.json"
    "$HOME/.claude/credentials.json"
    "$HOME/.config/claude/credentials.json"
    "${XDG_CONFIG_HOME:-$HOME/.config}/claude/credentials.json"
  )

  for loc in "${locations[@]}"; do
    if [[ -f "$loc" ]]; then
      cat "$loc"
      return 0
    fi
  done

  # Check if using secret-tool (GNOME Keyring)
  if command -v secret-tool &>/dev/null; then
    local creds
    creds=$(secret-tool lookup service "Claude Code" 2>/dev/null) || true
    if [[ -n "$creds" ]]; then
      echo "$creds"
      return 0
    fi
  fi

  return 1
}

get_credentials_json() {
  local os="$(uname -s)"
  case "$os" in
    Darwin)
      extract_macos
      ;;
    Linux)
      extract_linux
      ;;
    *)
      echo "ERROR: Unsupported OS: $os" >&2
      return 1
      ;;
  esac
}

# ============================================================================
# Codex Extraction Functions
# ============================================================================

extract_codex_credentials() {
  # Check both ~/.code/auth.json and ~/.codex/auth.json, pick longest expiry
  local best_source=""
  local best_expiry=0
  local best_api_key=""
  local best_access_token=""
  local best_email=""
  local best_plan=""

  for auth_file in "$HOME/.code/auth.json" "$HOME/.codex/auth.json"; do
    [[ -f "$auth_file" ]] || continue

    local api_key access_token expiry email plan
    api_key=$(python3 -c "import json; d=json.load(open('$auth_file')); v=d.get('OPENAI_API_KEY'); print(v if v else '')" 2>/dev/null) || true
    access_token=$(python3 -c "import json; d=json.load(open('$auth_file')); v=d.get('tokens',{}).get('access_token'); print(v if v else '')" 2>/dev/null) || true

    # Decode JWT to get expiry, email, and plan
    if [[ -n "$access_token" ]]; then
      read -r expiry email plan < <(python3 -c "
import json, base64, sys
token = '$access_token'
parts = token.split('.')
if len(parts) >= 2:
    payload = parts[1]
    padding = 4 - len(payload) % 4
    if padding != 4:
        payload += '=' * padding
    decoded = json.loads(base64.urlsafe_b64decode(payload))
    exp = decoded.get('exp', 0) * 1000  # Convert to ms
    email = decoded.get('https://api.openai.com/profile', {}).get('email', '')
    plan = decoded.get('https://api.openai.com/auth', {}).get('chatgpt_plan_type', '')
    print(exp, email, plan)
else:
    print('0', '', '')
" 2>/dev/null) || true
      expiry=${expiry:-0}
    else
      expiry=0
    fi

    # Pick this source if it has longer expiry
    if [[ "$expiry" =~ ^[0-9]+$ ]] && (( expiry > best_expiry )); then
      best_expiry=$expiry
      best_source="$auth_file"
      best_api_key="$api_key"
      best_access_token="$access_token"
      best_email="$email"
      best_plan="$plan"
    fi
  done

  if [[ -z "$best_api_key" && -z "$best_access_token" ]]; then
    return 1
  fi

  # Export for use by caller
  CODEX_SOURCE="${best_source/#$HOME/~}"
  CODEX_API_KEY="$best_api_key"
  CODEX_ACCESS_TOKEN="$best_access_token"
  CODEX_EMAIL="$best_email"
  CODEX_PLAN="$best_plan"

  # Read full auth.json for passing to container
  if [[ -n "$best_source" ]]; then
    local auth_json
    auth_json=$(cat "$best_source" 2>/dev/null | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)))" 2>/dev/null) || true
    if [[ -n "$auth_json" ]]; then
      CODEX_AUTH_JSON_B64=$(echo -n "$auth_json" | base64 | tr -d '\n')
    fi
  fi

  return 0
}

# ============================================================================
# Commands
# ============================================================================

do_extract() {
  local format=""
  local extract_claude=true
  local extract_codex=true

  # Parse flags
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --env)
        format="env"
        shift
        ;;
      --json)
        format="json"
        shift
        ;;
      --claude)
        extract_codex=false
        shift
        ;;
      --codex)
        extract_claude=false
        shift
        ;;
      *)
        echo "Unknown option: $1" >&2
        exit 1
        ;;
    esac
  done

  local claude_extracted=false
  local codex_extracted=false
  local claude_token="" claude_expiry="" claude_subscription=""

  # Extract Claude credentials
  if [[ "$extract_claude" == "true" ]]; then
    local creds_json
    if creds_json=$(get_credentials_json 2>/dev/null); then
      claude_token=$(echo "$creds_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('claudeAiOauth',{}).get('accessToken',''))" 2>/dev/null) || true
      claude_expiry=$(echo "$creds_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('claudeAiOauth',{}).get('expiresAt',''))" 2>/dev/null) || true
      claude_subscription=$(echo "$creds_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('claudeAiOauth',{}).get('subscriptionType',''))" 2>/dev/null) || true
      if [[ -n "$claude_token" ]]; then
        claude_extracted=true
      fi
    fi
  fi

  # Extract Codex credentials
  if [[ "$extract_codex" == "true" ]]; then
    if extract_codex_credentials 2>/dev/null; then
      codex_extracted=true
    fi
  fi

  # Check if we got anything
  if [[ "$claude_extracted" == "false" && "$codex_extracted" == "false" ]]; then
    echo "ERROR: Could not find any credentials" >&2
    [[ "$extract_claude" == "true" ]] && echo "  Claude: Run 'claude login' to authenticate" >&2
    [[ "$extract_codex" == "true" ]] && echo "  Codex: Run 'code auth' to authenticate" >&2
    exit 1
  fi

  # Output format
  case "$format" in
    env)
      if [[ "$claude_extracted" == "true" ]]; then
        echo "# Claude OAuth Credentials (extracted $(date -Iseconds))"
        echo "# Subscription: $claude_subscription"
        echo "CLAUDE_CODE_OAUTH_TOKEN=$claude_token"
        echo "CLAUDE_OAUTH_EXPIRES_AT=$claude_expiry"
        echo ""
      fi
      if [[ "$codex_extracted" == "true" ]]; then
        echo "# Codex OAuth Credentials (extracted $(date -Iseconds))"
        echo "# Source: $CODEX_SOURCE"
        [[ -n "$CODEX_API_KEY" ]] && echo "OPENAI_API_KEY=$CODEX_API_KEY"
        [[ -n "$CODEX_AUTH_JSON_B64" ]] && echo "CODEX_AUTH_JSON_B64=$CODEX_AUTH_JSON_B64"
      fi
      ;;
    json)
      echo "{"
      local first=true
      if [[ "$claude_extracted" == "true" ]]; then
        echo "  \"claudeAiOauth\": {"
        echo "    \"accessToken\": \"$claude_token\","
        echo "    \"expiresAt\": \"$claude_expiry\","
        echo "    \"subscriptionType\": \"$claude_subscription\""
        echo -n "  }"
        first=false
      fi
      if [[ "$codex_extracted" == "true" ]]; then
        [[ "$first" == "false" ]] && echo ","
        echo "  \"codex\": {"
        echo "    \"source\": \"$CODEX_SOURCE\","
        [[ -n "$CODEX_API_KEY" ]] && echo "    \"apiKey\": \"$CODEX_API_KEY\","
        echo "    \"hasAuthJson\": $([[ -n "$CODEX_AUTH_JSON_B64" ]] && echo "true" || echo "false")"
        echo -n "  }"
      fi
      echo ""
      echo "}"
      ;;
    *)
      echo "Extracted Credentials"
      echo "====================="
      echo ""
      if [[ "$claude_extracted" == "true" ]]; then
        echo "Claude:"
        echo "  Subscription: $claude_subscription"
        echo "  Expires: $claude_expiry"
        echo "  Token: ${claude_token:0:20}...${claude_token: -10}"
      else
        [[ "$extract_claude" == "true" ]] && echo -e "Claude: ${YELLOW}Not found${NC}"
      fi
      echo ""
      if [[ "$codex_extracted" == "true" ]]; then
        echo "Codex:"
        echo "  Source: $CODEX_SOURCE"
        [[ -n "$CODEX_EMAIL" ]] && echo "  Email: $CODEX_EMAIL"
        [[ -n "$CODEX_PLAN" ]] && echo "  Plan: $CODEX_PLAN"
        [[ -n "$CODEX_API_KEY" ]] && echo "  API Key: ${CODEX_API_KEY:0:10}...${CODEX_API_KEY: -5}"
        [[ -n "$CODEX_AUTH_JSON_B64" ]] && echo "  Auth JSON: (base64 encoded)"
      else
        [[ "$extract_codex" == "true" ]] && echo -e "Codex: ${YELLOW}Not found${NC}"
      fi
      echo ""
      echo "To provision these for Eve, use:"
      echo "  eve secrets set CLAUDE_CODE_OAUTH_TOKEN <token> --org <id>"
      echo "  eve secrets set Z_AI_API_KEY <key> --org <id>"
      ;;
  esac
}

do_check() {
  echo "Authentication Status"
  echo "====================="
  echo ""

  # Check Claude credentials
  echo "Claude:"
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    echo -e "  ${GREEN}ANTHROPIC_API_KEY set in environment${NC}"
  else
    echo -e "  ${YELLOW}Not in environment${NC}"
  fi

  echo ""
  echo "Codex/Code:"
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    echo -e "  ${GREEN}OPENAI_API_KEY set in environment${NC}"
  else
    echo -e "  ${YELLOW}Not in environment${NC}"
  fi

  echo ""
  echo "To check Eve-managed secrets:"
  echo "  eve secrets list --org <id>"
  echo "  eve secrets list --system"
}

# ============================================================================
# Main
# ============================================================================

SUBCOMMAND="${1:-}"
shift || true

case "$SUBCOMMAND" in
  extract)
    do_extract "$@"
    ;;
  check)
    do_check
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
