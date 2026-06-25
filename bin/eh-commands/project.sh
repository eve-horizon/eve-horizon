#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

usage() {
  echo "Usage: eve project ensure --name <name> --repo-url <url> [--branch <branch>] [--org <org_id>] [--force] [--json]"
}

command="${1:-}"
shift || true

if [[ "$command" != "ensure" ]]; then
  usage
  exit 1
fi

OUTPUT_JSON=0
ORG_ID=""
NAME=""
REPO_URL=""
BRANCH="main"
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      OUTPUT_JSON=1
      shift
      ;;
    --org)
      ORG_ID="$2"
      shift 2
      ;;
    --name)
      NAME="$2"
      shift 2
      ;;
    --repo-url)
      REPO_URL="$2"
      shift 2
      ;;
    --branch)
      BRANCH="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$NAME" || -z "$REPO_URL" ]]; then
  usage
  exit 1
fi

ORG_ID="${ORG_ID:-$DEFAULT_ORG_ID}"
ORG_ID="$(normalize_org_id "$ORG_ID")"

require_bin curl
require_bin jq
require_api

if [[ "$FORCE" -eq 1 ]]; then
  payload=$(jq -n \
    --arg org_id "$ORG_ID" \
    --arg name "$NAME" \
    --arg repo_url "$REPO_URL" \
    --arg branch "$BRANCH" \
    '{org_id:$org_id,name:$name,repo_url:$repo_url,branch:$branch,force:true}')
else
  payload=$(jq -n \
    --arg org_id "$ORG_ID" \
    --arg name "$NAME" \
    --arg repo_url "$REPO_URL" \
    --arg branch "$BRANCH" \
    '{org_id:$org_id,name:$name,repo_url:$repo_url,branch:$branch}')
fi

response=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/projects/ensure" \
  -H "Content-Type: application/json" \
  -d "$payload")

http_code=$(echo "$response" | tail -n 1)
body=$(echo "$response" | sed '$d')

if [[ "$http_code" == "409" ]]; then
  die "Project $NAME already exists with different repo_url/branch"
fi

if ! echo "$body" | jq -e '.id' >/dev/null 2>&1; then
  die "Failed to ensure project: $body"
fi

if [[ "$OUTPUT_JSON" -eq 1 ]]; then
  echo "$body" | jq -c '{id,org_id,name,repo_url,branch}'
else
  project_id=$(echo "$body" | jq -r '.id')
  echo -e "${GREEN}✓ Project ready:${NC} $project_id ($NAME)"
fi
