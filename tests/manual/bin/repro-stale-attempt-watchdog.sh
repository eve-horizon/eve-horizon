#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  repro-stale-attempt-watchdog.sh --project <project-id> [options]

Options:
  --project <id>              Eve project ID (required)
  --count <n>                 Number of jobs to create/claim (default: 10)
  --agent <id>                Agent ID used for claim (default: orchestrator)
  --pause-orchestrator        Scale orchestrator to 0 during job creation/claim, then restore
  --orchestrator-namespace    Namespace for orchestrator deployment (default: eve)
  --orchestrator-deployment   Deployment name (default: eve-orchestrator)
  --watch-timeout <seconds>   Max wait for watchdog recovery (default: 180)
  --poll-interval <seconds>   Poll interval while waiting (default: 2)
  --prefix <text>             Job title prefix (default: watchdog-repro)

Environment:
  EVE_API_URL                 Required (target Eve API)

Notes:
  - Jobs are created in backlog, moved to ready, then claimed manually. This
    produces deterministic running attempts without invoking any LLM harness.
  - For quick local runs, set low watchdog thresholds on orchestrator, e.g.:
      kubectl -n eve set env deploy/eve-orchestrator \
        EVE_ORCH_STALE_RUNNING_SECONDS=20 \
        EVE_ORCH_STALE_IDLE_SECONDS=20 \
        EVE_ORCH_TIMEOUT_GRACE_SECONDS=5
EOF
}

require_bin() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required tool: $name" >&2
    exit 1
  fi
}

PROJECT_ID=""
COUNT=10
AGENT_ID="orchestrator"
PAUSE_ORCHESTRATOR=false
ORCH_NAMESPACE="eve"
ORCH_DEPLOYMENT="eve-orchestrator"
WATCH_TIMEOUT=180
POLL_INTERVAL=2
PREFIX="watchdog-repro"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT_ID="${2:-}"
      shift 2
      ;;
    --count)
      COUNT="${2:-}"
      shift 2
      ;;
    --agent)
      AGENT_ID="${2:-}"
      shift 2
      ;;
    --pause-orchestrator)
      PAUSE_ORCHESTRATOR=true
      shift
      ;;
    --orchestrator-namespace)
      ORCH_NAMESPACE="${2:-}"
      shift 2
      ;;
    --orchestrator-deployment)
      ORCH_DEPLOYMENT="${2:-}"
      shift 2
      ;;
    --watch-timeout)
      WATCH_TIMEOUT="${2:-}"
      shift 2
      ;;
    --poll-interval)
      POLL_INTERVAL="${2:-}"
      shift 2
      ;;
    --prefix)
      PREFIX="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${EVE_API_URL:-}" ]]; then
  echo "EVE_API_URL is required" >&2
  exit 1
fi

if [[ -z "$PROJECT_ID" ]]; then
  echo "--project is required" >&2
  exit 1
fi

require_bin eve
require_bin jq

ORIGINAL_ORCH_REPLICAS=""
restore_orchestrator() {
  if [[ -n "$ORIGINAL_ORCH_REPLICAS" ]]; then
    kubectl -n "$ORCH_NAMESPACE" scale deploy/"$ORCH_DEPLOYMENT" --replicas="$ORIGINAL_ORCH_REPLICAS" >/dev/null
  fi
}

if [[ "$PAUSE_ORCHESTRATOR" == "true" ]]; then
  require_bin kubectl
  ORIGINAL_ORCH_REPLICAS="$(kubectl -n "$ORCH_NAMESPACE" get deploy "$ORCH_DEPLOYMENT" -o jsonpath='{.spec.replicas}')"
  if [[ -z "$ORIGINAL_ORCH_REPLICAS" ]]; then
    echo "Failed to read orchestrator replica count" >&2
    exit 1
  fi
  trap restore_orchestrator EXIT
  echo "Scaling $ORCH_DEPLOYMENT to 0 replicas for deterministic claim setup..."
  kubectl -n "$ORCH_NAMESPACE" scale deploy/"$ORCH_DEPLOYMENT" --replicas=0 >/dev/null
  kubectl -n "$ORCH_NAMESPACE" rollout status deploy/"$ORCH_DEPLOYMENT" --timeout=180s >/dev/null
fi

RUN_ID="$(date +%Y%m%d%H%M%S)"
declare -a JOB_IDS=()

echo "Creating and manually claiming $COUNT watchdog repro jobs in project $PROJECT_ID..."
for i in $(seq 1 "$COUNT"); do
  title="${PREFIX}-${RUN_ID}-${i}"
  job_json="$(eve job create --project "$PROJECT_ID" --phase backlog --description "$title" --json)"
  job_id="$(echo "$job_json" | jq -r '.id')"
  if [[ -z "$job_id" || "$job_id" == "null" ]]; then
    echo "Failed to create job for index $i" >&2
    echo "$job_json" >&2
    exit 1
  fi

  eve job update "$job_id" --phase ready --json >/dev/null
  if ! claim_output="$(eve job claim "$job_id" --agent "$AGENT_ID" --json 2>&1)"; then
    if grep -q "Job must be in 'ready' phase to claim (current: active)" <<<"$claim_output"; then
      # Orchestrator may claim immediately after ready transition.
      :
    else
      echo "Failed to claim job $job_id" >&2
      echo "$claim_output" >&2
      exit 1
    fi
  fi
  JOB_IDS+=("$job_id")
done

if [[ "$PAUSE_ORCHESTRATOR" == "true" ]]; then
  echo "Restoring $ORCH_DEPLOYMENT replicas to $ORIGINAL_ORCH_REPLICAS..."
  kubectl -n "$ORCH_NAMESPACE" scale deploy/"$ORCH_DEPLOYMENT" --replicas="$ORIGINAL_ORCH_REPLICAS" >/dev/null
  kubectl -n "$ORCH_NAMESPACE" rollout status deploy/"$ORCH_DEPLOYMENT" --timeout=180s >/dev/null
fi

echo "Claimed ${#JOB_IDS[@]} jobs. Waiting for watchdog recovery..."
deadline=$((SECONDS + WATCH_TIMEOUT))

while [[ $SECONDS -lt $deadline ]]; do
  active_count=0
  for job_id in "${JOB_IDS[@]}"; do
    phase="$(eve job show "$job_id" --json | jq -r '.phase')"
    if [[ "$phase" == "active" ]]; then
      active_count=$((active_count + 1))
    fi
  done

  if [[ $active_count -eq 0 ]]; then
    break
  fi

  sleep "$POLL_INTERVAL"
done

echo
echo "Recovery summary:"
failed=0
for job_id in "${JOB_IDS[@]}"; do
  show_json="$(eve job show "$job_id" --json)"
  attempts_json="$(eve job attempts "$job_id" --json)"
  phase="$(echo "$show_json" | jq -r '.phase')"
  close_reason="$(echo "$show_json" | jq -r '.close_reason // ""')"
  attempt_status="$(echo "$attempts_json" | jq -r '.attempts[0].status // "none"')"
  echo "  $job_id phase=$phase attempt=$attempt_status reason=\"${close_reason}\""

  if [[ "$phase" == "active" || "$attempt_status" == "running" ]]; then
    failed=1
  fi
done

if [[ $failed -ne 0 ]]; then
  echo
  echo "Watchdog repro FAILED: at least one job/attempt remained active/running." >&2
  exit 1
fi

echo
echo "Watchdog repro PASSED: all claimed attempts were recovered to terminal states."
