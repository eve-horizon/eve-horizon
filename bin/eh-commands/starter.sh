#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

source "$SCRIPT_DIR/_common.sh"

STARTER_REPO="${STARTER_REPO:-$PROJECT_ROOT/../eve-horizon-starter}"
STARTER_GITHUB="https://github.com/eve-horizon/eve-horizon-starter"

show_help() {
  echo "Eve Horizon Starter Template"
  echo ""
  echo "The starter template lives in a sister repo:"
  echo "  Local:  $STARTER_REPO"
  echo "  GitHub: $STARTER_GITHUB"
  echo ""
  echo "Usage: eh starter <command>"
  echo ""
  echo "Commands:"
  echo "  info     Show starter repo location and status"
  echo "  open     Open starter repo in browser"
  echo "  clone    Clone starter repo to current directory"
  echo ""
  echo "Examples:"
  echo "  eh starter info"
  echo "  eh starter clone my-new-project"
}

do_info() {
  echo -e "${CYAN}Eve Horizon Starter Template${NC}"
  echo ""
  echo "GitHub: $STARTER_GITHUB"
  echo ""

  if [[ -d "$STARTER_REPO" ]]; then
    echo -e "${GREEN}✓ Local sister repo found: $STARTER_REPO${NC}"
    echo ""
    echo "Contents:"
    ls -la "$STARTER_REPO" | head -15
  else
    echo -e "${YELLOW}! Local sister repo not found at: $STARTER_REPO${NC}"
    echo ""
    echo "Clone it with:"
    echo "  git clone $STARTER_GITHUB $STARTER_REPO"
  fi
}

do_open() {
  echo "Opening $STARTER_GITHUB..."
  if command -v open >/dev/null 2>&1; then
    open "$STARTER_GITHUB"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$STARTER_GITHUB"
  else
    echo "Cannot open browser. Visit: $STARTER_GITHUB"
  fi
}

do_clone() {
  local target="${1:-eve-horizon-starter}"

  if [[ -d "$target" ]]; then
    die "Directory already exists: $target"
  fi

  echo -e "${CYAN}Cloning starter template to $target...${NC}"
  git clone "$STARTER_GITHUB" "$target"
  echo ""
  echo -e "${GREEN}✓ Starter cloned to $target${NC}"
  echo ""
  echo "Next steps:"
  echo "  cd $target"
  echo "  ./bin/install-skills.sh"
  echo "  claude  # or your AI coding agent"
}

# Main
SUBCOMMAND="${1:-}"
shift || true

case "$SUBCOMMAND" in
  info)
    do_info
    ;;
  open)
    do_open
    ;;
  clone)
    do_clone "$@"
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
