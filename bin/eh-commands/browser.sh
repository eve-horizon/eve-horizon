#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

source "$SCRIPT_DIR/_common.sh"
source "$SCRIPT_DIR/_config.sh"

show_help() {
  echo "Repo-pinned Playwright browser wrapper"
  echo ""
  echo "Usage: eh browser <subcommand> [args]"
  echo ""
  echo "Subcommands:"
  echo "  install [browser...]           Install Playwright browser binaries (default: chromium)"
  echo "  dashboard [url] [--no-auth]    Open headed Chromium with Eve auth injected"
  echo "  open [url] [playwright args]   Open a URL with persistent browser profile"
  echo "  codegen [url] [args]           Launch Playwright codegen with persistent profile"
  echo "  screenshot [url] [file] [args] Capture a screenshot, defaulting into tmp/"
  echo "  pdf [url] [file] [args]        Save a PDF, defaulting into tmp/"
  echo "  test [args]                    Run apps/dashboard Playwright tests"
  echo "  show-report [args]             Open Playwright HTML report"
  echo "  clean                          Remove tmp/playwright-browser artifacts"
  echo "  paths                          Show wrapper paths and defaults"
  echo ""
  echo "Defaults:"
  echo "  browser:        chromium"
  echo "  dashboard url:  http://dashboard.eve.lvh.me"
  echo "  eve api url:    ${EVE_API_URL:-http://api.eve.lvh.me}"
  echo "  profile:        tmp/playwright-browser/profile"
  echo "  screenshots:    tmp/playwright-browser/screenshots"
  echo "  codegen:        tmp/playwright-browser/codegen"
  echo ""
  echo "This command always uses the repo-pinned Playwright from apps/dashboard."
  echo "Use 'eh browser dashboard' for the fast local auth-aware loop."
}

PLAYWRIGHT_ROOT="$PROJECT_ROOT/tmp/playwright-browser"
PLAYWRIGHT_PROFILE_DIR="$PLAYWRIGHT_ROOT/profile"
PLAYWRIGHT_SCREENSHOT_DIR="$PLAYWRIGHT_ROOT/screenshots"
PLAYWRIGHT_CODEGEN_DIR="$PLAYWRIGHT_ROOT/codegen"
PLAYWRIGHT_PDF_DIR="$PLAYWRIGHT_ROOT/pdfs"
DEFAULT_BROWSER="${EVE_BROWSER_NAME:-chromium}"
DEFAULT_DASHBOARD_URL="${EVE_BROWSER_DASHBOARD_URL:-http://dashboard.eve.lvh.me}"
DEFAULT_API_URL="${EVE_API_URL:-http://api.eve.lvh.me}"

ensure_dirs() {
  mkdir -p \
    "$PLAYWRIGHT_ROOT" \
    "$PLAYWRIGHT_PROFILE_DIR" \
    "$PLAYWRIGHT_SCREENSHOT_DIR" \
    "$PLAYWRIGHT_CODEGEN_DIR" \
    "$PLAYWRIGHT_PDF_DIR"
}

playwright_exec() {
  exec pnpm --filter @eve/dashboard exec playwright "$@"
}

timestamp() {
  date -u +"%Y%m%d-%H%M%S"
}

slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's#https?://##g; s#[^a-z0-9]+#-#g; s#(^-|-$)##g'
}

has_output_flag() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      -o|--output|--output=*|--save-storage|--save-storage=*|--save-har|--save-har=*|--save-har-glob|--save-har-glob=*)
        return 0
        ;;
    esac
  done

  return 1
}

open_url_with_defaults() {
  local url="$DEFAULT_DASHBOARD_URL"
  if [[ $# -gt 0 && "$1" != -* ]]; then
    url="$1"
    shift
  fi

  ensure_dirs
  playwright_exec open --browser "$DEFAULT_BROWSER" --user-data-dir "$PLAYWRIGHT_PROFILE_DIR" "$@" "$url"
}

codegen_with_defaults() {
  local url="$DEFAULT_DASHBOARD_URL"
  if [[ $# -gt 0 && "$1" != -* ]]; then
    url="$1"
    shift
  fi

  local -a args=("$@")
  if ! has_output_flag "${args[@]}"; then
    local stem
    stem="$(slugify "$url")"
    [[ -n "$stem" ]] || stem="dashboard"
    local output="$PLAYWRIGHT_CODEGEN_DIR/${stem}-$(timestamp).spec.ts"
    echo "Writing codegen output to $output"
    args=(--output "$output" "${args[@]}")
  fi

  ensure_dirs
  playwright_exec codegen --browser "$DEFAULT_BROWSER" --user-data-dir "$PLAYWRIGHT_PROFILE_DIR" "${args[@]}" "$url"
}

screenshot_with_defaults() {
  local url="$DEFAULT_DASHBOARD_URL"
  if [[ $# -gt 0 && "$1" != -* ]]; then
    url="$1"
    shift
  fi

  local filename=""
  if [[ $# -gt 0 && "$1" != -* ]]; then
    filename="$1"
    shift
  fi

  if [[ -z "$filename" ]]; then
    local stem
    stem="$(slugify "$url")"
    [[ -n "$stem" ]] || stem="dashboard"
    filename="$PLAYWRIGHT_SCREENSHOT_DIR/${stem}-$(timestamp).png"
    echo "Writing screenshot to $filename"
  fi

  ensure_dirs
  playwright_exec screenshot --browser "$DEFAULT_BROWSER" "$@" "$url" "$filename"
}

pdf_with_defaults() {
  local url="$DEFAULT_DASHBOARD_URL"
  if [[ $# -gt 0 && "$1" != -* ]]; then
    url="$1"
    shift
  fi

  local filename=""
  if [[ $# -gt 0 && "$1" != -* ]]; then
    filename="$1"
    shift
  fi

  if [[ -z "$filename" ]]; then
    local stem
    stem="$(slugify "$url")"
    [[ -n "$stem" ]] || stem="dashboard"
    filename="$PLAYWRIGHT_PDF_DIR/${stem}-$(timestamp).pdf"
    echo "Writing PDF to $filename"
  fi

  ensure_dirs
  playwright_exec pdf --browser "$DEFAULT_BROWSER" "$@" "$url" "$filename"
}

dashboard_with_auth() {
  ensure_dirs
  exec pnpm --filter @eve/dashboard exec node "$PROJECT_ROOT/apps/dashboard/scripts/eh-browser-dashboard.mjs" \
    --profile "$PLAYWRIGHT_PROFILE_DIR" \
    --default-url "$DEFAULT_DASHBOARD_URL" \
    --default-api-url "$DEFAULT_API_URL" \
    "$@"
}

if [[ $# -eq 0 ]]; then
  show_help
  exit 1
fi

case "${1:-}" in
  -h|--help|help)
    show_help
    exit 0
    ;;
esac

require_bin pnpm
SUBCOMMAND="$1"
shift

case "$SUBCOMMAND" in
  install)
    ensure_dirs
    if [[ $# -eq 0 ]]; then
      playwright_exec install chromium
    fi
    playwright_exec install "$@"
    ;;
  dashboard)
    dashboard_with_auth "$@"
    ;;
  open)
    open_url_with_defaults "$@"
    ;;
  codegen)
    codegen_with_defaults "$@"
    ;;
  screenshot)
    screenshot_with_defaults "$@"
    ;;
  pdf)
    pdf_with_defaults "$@"
    ;;
  test)
    ensure_dirs
    playwright_exec test "$@"
    ;;
  clean)
    rm -rf "$PLAYWRIGHT_ROOT"
    echo "Removed $PLAYWRIGHT_ROOT"
    ;;
  paths)
    ensure_dirs
    cat <<EOF
browser:      $DEFAULT_BROWSER
dashboard:    $DEFAULT_DASHBOARD_URL
eve api:      $DEFAULT_API_URL
profile:      $PLAYWRIGHT_PROFILE_DIR
screenshots:  $PLAYWRIGHT_SCREENSHOT_DIR
codegen:      $PLAYWRIGHT_CODEGEN_DIR
pdfs:         $PLAYWRIGHT_PDF_DIR
EOF
    ;;
  *)
    ensure_dirs
    playwright_exec "$SUBCOMMAND" "$@"
    ;;
esac
