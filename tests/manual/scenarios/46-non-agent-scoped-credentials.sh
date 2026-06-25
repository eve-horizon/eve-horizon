#!/usr/bin/env bash
# Scenario 46 driver: validates that pipeline `script:` and `action: { type: run }`
# steps honour per-step `permissions:` declarations via the new `jobs.token_permissions`
# column + writeEveCredentials flow.
#
# Usage:
#   ./tests/manual/scenarios/46-non-agent-scoped-credentials.sh \
#     --org $ORG_ID --project $PROJECT_ID [--env local|staging] [--keep]
#
# Exits 0 when all five cases pass; non-zero otherwise. Emits one JSONL line
# per case to stdout.

set -euo pipefail

ORG_ID=""
PROJECT_ID=""
ENV_NAME="local"
KEEP_PROJECT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --org) ORG_ID="$2"; shift 2 ;;
    --project) PROJECT_ID="$2"; shift 2 ;;
    --env) ENV_NAME="$2"; shift 2 ;;
    --keep) KEEP_PROJECT=1; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$PROJECT_ID" ]]; then
  echo "--project is required" >&2
  exit 2
fi

case "$ENV_NAME" in
  local) export EVE_API_URL="${EVE_API_URL:-http://api.eve.lvh.me}" ;;
  staging) export EVE_API_URL="${EVE_API_URL:-https://api.eve.example.com}" ;;
  *) echo "Unknown --env: $ENV_NAME" >&2; exit 2 ;;
esac

CASES=(
  "positive-script-jobs:success"
  "negative-perm-script-jobs:success"   # the step itself exits 0 when it correctly observes a denial
  "backcompat-script-no-decl:success"
  "positive-action-run-jobs:success"
  "negative-perm-action-run-jobs:success"
)

REPO_TMP=$(mktemp -d)
trap '[[ -n "${REPO_TMP:-}" && -d "${REPO_TMP}" ]] && rm -rf "${REPO_TMP}"' EXIT

REPO_URL="https://github.com/eve-horizon/eve-horizon-fullstack-example"
echo "[driver] cloning $REPO_URL" >&2
git clone --depth 1 "$REPO_URL" "$REPO_TMP/repo" >&2

FIXTURE_DIR="$(cd "$(dirname "$0")" && pwd)/fixtures/non-agent-scope"
cp "$FIXTURE_DIR/manifest.yaml" "$REPO_TMP/repo/.eve/manifest.yaml"

echo "[driver] syncing fixture manifest" >&2
( cd "$REPO_TMP/repo" && eve project sync --project "$PROJECT_ID" --json >/dev/null )

REF=$(cd "$REPO_TMP/repo" && git rev-parse HEAD)

echo "[driver] running pipeline scope-test @ $REF" >&2
RUN_JSON=$(eve pipeline run scope-test --ref "$REF" --project "$PROJECT_ID" --json)
RUN_ID=$(echo "$RUN_JSON" | jq -r '.run.id // .id // empty')

if [[ -z "$RUN_ID" ]]; then
  echo "[driver] failed to create pipeline run" >&2
  echo "$RUN_JSON" >&2
  exit 1
fi

echo "[driver] run $RUN_ID launched; resolving step jobs by label" >&2

# Pipeline-run response shape varies; query the jobs table directly by the
# run label the expander attaches to every step job.
sleep 2
JOB_JSON=$(eve job list --project "$PROJECT_ID" --label "run:$RUN_ID" --json)

declare -A STEP_JOBS
while IFS=$'\t' read -r step_name job_id; do
  STEP_JOBS["$step_name"]="$job_id"
done < <(echo "$JOB_JSON" | jq -r '.jobs[]? | [.step_name, .id] | @tsv')

# Wait for every step job to reach a terminal phase (done or cancelled)
for entry in "${CASES[@]}"; do
  CASE="${entry%%:*}"
  JOB_ID="${STEP_JOBS[$CASE]:-}"
  if [[ -z "$JOB_ID" ]]; then
    echo "[driver] no job created for case $CASE" >&2
    continue
  fi
  echo "[driver] waiting on $CASE ($JOB_ID)" >&2
  eve job wait "$JOB_ID" --timeout 180 --quiet >/dev/null || true
done

echo
echo "Results:"
ALL_PASS=1
for entry in "${CASES[@]}"; do
  CASE="${entry%%:*}"
  EXPECT="${entry##*:}"
  JOB_ID="${STEP_JOBS[$CASE]:-}"
  if [[ -z "$JOB_ID" ]]; then
    printf '{"case": "%s", "expected": "%s", "actual": "missing", "pass": false, "job_id": null}\n' "$CASE" "$EXPECT"
    ALL_PASS=0
    continue
  fi
  PHASE=$(eve job show "$JOB_ID" --json | jq -r '.phase')
  CLOSE=$(eve job show "$JOB_ID" --json | jq -r '.close_reason // ""')
  ACTUAL="unknown"
  case "$PHASE" in
    done) ACTUAL="success" ;;
    cancelled) ACTUAL="failure" ;;
    *) ACTUAL="$PHASE" ;;
  esac
  PASS="false"
  if [[ "$ACTUAL" == "$EXPECT" ]]; then PASS="true"; else ALL_PASS=0; fi
  printf '{"case": "%s", "expected": "%s", "actual": "%s", "pass": %s, "job_id": "%s", "close_reason": %s}\n' \
    "$CASE" "$EXPECT" "$ACTUAL" "$PASS" "$JOB_ID" "$(echo "$CLOSE" | jq -Rs .)"
done

if [[ $ALL_PASS -eq 1 ]]; then
  exit 0
else
  exit 1
fi
