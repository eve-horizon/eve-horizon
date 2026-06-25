#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PRIVATE_SKILLS_DIRNAME="private-skills"

source "$SCRIPT_DIR/_common.sh"

show_help() {
  echo "Skills manifest helper"
  echo ""
  echo "Usage: eh skills <subcommand>"
  echo ""
  echo "Subcommands:"
  echo "  install     Install skills from skills.txt"
  echo ""
  echo "Examples:"
  echo "  eh skills install"
}

expand_glob_pattern() {
  local pattern="$1"
  local base_pattern="${pattern%/*}"  # Remove trailing /* or /**
  local is_recursive=false
  local explicit_private=0

  case "$pattern" in
    *"/${PRIVATE_SKILLS_DIRNAME}/"*) explicit_private=1;;
    "${PRIVATE_SKILLS_DIRNAME}/"*) explicit_private=1;;
  esac

  if [[ "$pattern" == *"/**" ]]; then
    is_recursive=true
    base_pattern="${pattern%/**}"
  elif [[ "$pattern" == *"/*" ]]; then
    base_pattern="${pattern%/*}"
  fi

  # Resolve relative paths
  local search_root
  if [[ "$base_pattern" == ./* ]]; then
    search_root="$PROJECT_ROOT/${base_pattern:2}"
  elif [[ "$base_pattern" == /* ]]; then
    search_root="$base_pattern"
  elif [[ "$base_pattern" == ~* ]]; then
    search_root="${base_pattern/#\~/$HOME}"
  else
    search_root="$PROJECT_ROOT/$base_pattern"
  fi

  if [[ ! -d "$search_root" ]]; then
    echo "Warning: Glob pattern base directory not found: $search_root" >&2
    return
  fi

  # Find directories containing SKILL.md
  if $is_recursive; then
    find "$search_root" -name "SKILL.md" -type f 2>/dev/null | while read -r skill_md; do
      if [[ "$explicit_private" -eq 0 && "$skill_md" == *"/${PRIVATE_SKILLS_DIRNAME}/"* ]]; then
        continue
      fi
      dirname "$skill_md"
    done
  else
    # Depth-1: only direct children
    for dir in "$search_root"/*/; do
      if [[ "$explicit_private" -eq 0 && "$(basename "$dir")" == "$PRIVATE_SKILLS_DIRNAME" ]]; then
        continue
      fi
      if [[ -f "${dir}SKILL.md" ]]; then
        echo "${dir%/}"
      fi
    done
  fi
}

install_skills() {
  # Prefer eve CLI if available
  if command -v eve >/dev/null 2>&1; then
    (cd "$PROJECT_ROOT" && eve skills install)
    return
  fi

  # Fallback to skills CLI directly
  require_bin skills

  local agents=("claude-code" "codex" "gemini-cli" "pi")

  local skills_file="$PROJECT_ROOT/skills.txt"
  if [[ ! -f "$skills_file" ]]; then
    echo "No skills.txt found at $skills_file (skipping)"
    return 0
  fi

  local -a sources=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="$(echo "$line" | xargs)"
    [[ -z "$line" ]] && continue

    # Expand glob patterns
    if [[ "$line" == *"*"* ]]; then
      while IFS= read -r expanded; do
        [[ -n "$expanded" ]] && sources+=("$expanded")
      done < <(expand_glob_pattern "$line")
    else
      sources+=("$line")
    fi
  done < "$skills_file"

  if [[ ${#sources[@]} -eq 0 ]]; then
    echo "No skills listed in skills.txt (skipping)"
    return 0
  fi

  for source in "${sources[@]}"; do
    local resolved="$source"
    if [[ "$source" != .* && "$source" != /* && "$source" != ~* ]]; then
      if [[ -e "$PROJECT_ROOT/$source" ]]; then
        resolved="./$source"
        echo "Assuming local path; prefixing ./: $source -> $resolved"
      fi
    fi

    # Convert absolute path back to relative
    if [[ "$resolved" == "$PROJECT_ROOT/"* ]]; then
      resolved="./${resolved#$PROJECT_ROOT/}"
    fi

    echo "Installing skill source: $resolved"
    for agent in "${agents[@]}"; do
      (cd "$PROJECT_ROOT" && skills add "$resolved" -a "$agent" -y --all) || echo "Warning: failed to install $resolved for $agent"
    done
  done

  mkdir -p "$PROJECT_ROOT/.agents" "$PROJECT_ROOT/.claude"

  local agent_skills="$PROJECT_ROOT/.agents/skills"
  local claude_skills="$PROJECT_ROOT/.claude/skills"

  if [[ -L "$claude_skills" ]]; then
    local target
    target="$(readlink "$claude_skills" || true)"
    if [[ "$target" != "$agent_skills" && "$target" != "../.agents/skills" ]]; then
      rm -f "$claude_skills"
    fi
  fi

  if [[ ! -e "$claude_skills" ]]; then
    if ln -s "../.agents/skills" "$claude_skills" 2>/dev/null; then
      echo "Linked .claude/skills -> .agents/skills"
    fi
    return 0
  fi

  if [[ -L "$claude_skills" ]]; then
    return 0
  fi

  # Committed .claude/skills directory: overlay per-skill symlinks so it can see installed skills too.
  if [[ -d "$claude_skills" ]]; then
    mkdir -p "$agent_skills"
    for d in "$agent_skills"/*; do
      [[ -d "$d" ]] || continue
      local name
      name="$(basename "$d")"
      [[ -e "$claude_skills/$name" ]] && continue
      ln -s "../../.agents/skills/$name" "$claude_skills/$name" 2>/dev/null || true
    done
    return 0
  fi

  echo ".claude/skills exists; skipping symlink"
}

SUBCOMMAND="${1:-}"
case "$SUBCOMMAND" in
  install)
    shift
    install_skills "$@"
    ;;
  -h|--help|help|"")
    show_help
    ;;
  *)
    echo "Unknown subcommand: $SUBCOMMAND"
    echo ""
    show_help
    exit 1
    ;;
esac
