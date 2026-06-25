#!/usr/bin/env bash
# Example external controller for orchestrator concurrency.
#
# Reads host metrics and adjusts orchestrator concurrency via the admin API.
# Run as a cron job or sidecar process.
#
# Usage:
#   ORCHESTRATOR_URL=http://localhost:4802 \
#   EVE_INTERNAL_API_KEY=your-key \
#   ./scripts/orchestrator-concurrency-controller.sh
#
# This is Phase 4 of the multi-job concurrency plan.
# Use this only if in-process tuning (Phase 3) is too coarse.

set -euo pipefail

# Configuration
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://localhost:4802}"
API_KEY="${EVE_INTERNAL_API_KEY:?EVE_INTERNAL_API_KEY must be set}"
CHECK_INTERVAL="${CHECK_INTERVAL:-30}"
MIN_CONCURRENCY="${MIN_CONCURRENCY:-1}"
MAX_CONCURRENCY="${MAX_CONCURRENCY:-8}"
CPU_HIGH_THRESHOLD="${CPU_HIGH_THRESHOLD:-80}"
CPU_LOW_THRESHOLD="${CPU_LOW_THRESHOLD:-50}"
MEM_HIGH_THRESHOLD="${MEM_HIGH_THRESHOLD:-85}"

# State tracking
CURRENT_LIMIT=""
LAST_CPU=0
LAST_MEM=0

get_status() {
  curl -sf \
    -H "x-internal-api-key: $API_KEY" \
    "$ORCHESTRATOR_URL/system/orchestrator/status"
}

set_concurrency() {
  local limit=$1
  curl -sf \
    -X POST \
    -H "x-internal-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"limit\": $limit}" \
    "$ORCHESTRATOR_URL/system/orchestrator/concurrency"
}

get_cpu_percent() {
  # Returns integer CPU percentage (0-100)
  if [[ -f /proc/stat ]]; then
    # Linux: read from /proc/stat
    local cpu_line
    cpu_line=$(grep '^cpu ' /proc/stat)

    # Parse: cpu user nice system idle iowait irq softirq
    read -r _ user nice system idle iowait irq softirq _ <<< "$cpu_line"

    local total=$((user + nice + system + idle + iowait + irq + softirq))
    local idle_time=$((idle + iowait))
    local busy=$((total - idle_time))

    # Calculate percentage
    if [[ $total -gt 0 ]]; then
      echo $((busy * 100 / total))
    else
      echo 0
    fi
  else
    # macOS: use sysctl for dev/testing
    # This gives a rough estimate using system load
    local load
    load=$(sysctl -n vm.loadavg | awk '{print $2}')
    local ncpu
    ncpu=$(sysctl -n hw.ncpu)

    # Convert load to percentage
    local percent
    percent=$(echo "$load $ncpu" | awk '{printf "%d", ($1 / $2) * 100}')

    # Cap at 100
    if [[ $percent -gt 100 ]]; then
      echo 100
    else
      echo "$percent"
    fi
  fi
}

get_memory_percent() {
  # Returns integer memory percentage (0-100)
  if [[ -f /proc/meminfo ]]; then
    # Linux: read from /proc/meminfo
    local mem_total mem_available
    mem_total=$(grep '^MemTotal:' /proc/meminfo | awk '{print $2}')
    mem_available=$(grep '^MemAvailable:' /proc/meminfo | awk '{print $2}')

    if [[ $mem_total -gt 0 ]]; then
      local used=$((mem_total - mem_available))
      echo $((used * 100 / mem_total))
    else
      echo 0
    fi
  else
    # macOS: use vm_stat
    local page_size
    page_size=$(pagesize)

    local vm_stat
    vm_stat=$(vm_stat)

    local pages_free pages_active pages_inactive pages_speculative pages_wired
    pages_free=$(echo "$vm_stat" | grep "Pages free:" | awk '{print $3}' | tr -d '.')
    pages_active=$(echo "$vm_stat" | grep "Pages active:" | awk '{print $3}' | tr -d '.')
    pages_inactive=$(echo "$vm_stat" | grep "Pages inactive:" | awk '{print $3}' | tr -d '.')
    pages_speculative=$(echo "$vm_stat" | grep "Pages speculative:" | awk '{print $3}' | tr -d '.')
    pages_wired=$(echo "$vm_stat" | grep "Pages wired down:" | awk '{print $4}' | tr -d '.')

    # Calculate used memory
    local pages_used=$((pages_active + pages_inactive + pages_wired))
    local pages_total=$((pages_used + pages_free + pages_speculative))

    if [[ $pages_total -gt 0 ]]; then
      echo $((pages_used * 100 / pages_total))
    else
      echo 0
    fi
  fi
}

adjust_concurrency() {
  local cpu=$1
  local mem=$2
  local current=$3
  local new_limit=$current

  # Decision logic: scale down if either resource is high
  if [[ $cpu -ge $CPU_HIGH_THRESHOLD ]] || [[ $mem -ge $MEM_HIGH_THRESHOLD ]]; then
    if [[ $current -gt $MIN_CONCURRENCY ]]; then
      new_limit=$((current - 1))
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) High resource usage (CPU: ${cpu}%, Mem: ${mem}%) - decreasing concurrency: $current -> $new_limit"
    fi
  # Scale up if both resources are low and we have headroom
  elif [[ $cpu -lt $CPU_LOW_THRESHOLD ]] && [[ $mem -lt $MEM_HIGH_THRESHOLD ]] && [[ $current -lt $MAX_CONCURRENCY ]]; then
    new_limit=$((current + 1))
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Low resource usage (CPU: ${cpu}%, Mem: ${mem}%) - increasing concurrency: $current -> $new_limit"
  fi

  echo "$new_limit"
}

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

# Startup
log "Orchestrator concurrency controller started"
log "URL: $ORCHESTRATOR_URL"
log "Check interval: ${CHECK_INTERVAL}s"
log "Concurrency range: $MIN_CONCURRENCY - $MAX_CONCURRENCY"
log "CPU thresholds: low=$CPU_LOW_THRESHOLD%, high=$CPU_HIGH_THRESHOLD%"
log "Memory threshold: high=$MEM_HIGH_THRESHOLD%"
log ""

# Main loop
while true; do
  # Get current orchestrator status
  if ! status=$(get_status 2>&1); then
    log "ERROR: Failed to get orchestrator status: $status"
    sleep "$CHECK_INTERVAL"
    continue
  fi

  # Parse current limit and in-flight
  current_limit=$(echo "$status" | grep -o '"limit":[0-9]*' | cut -d: -f2)
  in_flight=$(echo "$status" | grep -o '"inFlight":[0-9]*' | cut -d: -f2)

  if [[ -z "$current_limit" ]]; then
    log "ERROR: Could not parse concurrency limit from status"
    sleep "$CHECK_INTERVAL"
    continue
  fi

  # Read host metrics
  cpu=$(get_cpu_percent)
  mem=$(get_memory_percent)

  # Log current state (only if changed or every 5 minutes)
  if [[ "$current_limit" != "$CURRENT_LIMIT" ]] || [[ $(($(date +%s) % 300)) -eq 0 ]]; then
    log "Status: limit=$current_limit, in-flight=$in_flight, CPU=${cpu}%, Mem=${mem}%"
  fi

  # Store current limit
  CURRENT_LIMIT=$current_limit
  LAST_CPU=$cpu
  LAST_MEM=$mem

  # Decide if adjustment is needed
  new_limit=$(adjust_concurrency "$cpu" "$mem" "$current_limit")

  # Apply change if needed
  if [[ "$new_limit" != "$current_limit" ]]; then
    if result=$(set_concurrency "$new_limit" 2>&1); then
      log "Successfully set concurrency to $new_limit"
    else
      log "ERROR: Failed to set concurrency: $result"
    fi
  fi

  sleep "$CHECK_INTERVAL"
done
