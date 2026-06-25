#!/usr/bin/env bash
# Orphan Process Reaper for Eve Worker Container
#
# This script runs as a background daemon to periodically detect and kill
# orphaned processes that can accumulate and exhaust system resources.
#
# Orphaned processes occur when:
# - Agent jobs timeout and are killed, but their child processes survive
# - Claude/mclaude spawns subprocesses that outlive the parent
# - Hook scripts spawn background processes that don't terminate
#
# Detection strategy:
# - Find processes with PPID=1 (reparented to init after parent died)
# - Exclude essential system processes and the worker itself
# - Only kill processes older than a threshold (to avoid killing legitimate new processes)
#
# Usage:
#   orphan-reaper.sh start    # Start the reaper daemon
#   orphan-reaper.sh stop     # Stop the reaper daemon
#   orphan-reaper.sh status   # Show orphan count and details
#   orphan-reaper.sh kill     # Immediately kill all detected orphans

set -euo pipefail

# Configuration
REAPER_INTERVAL="${EVE_REAPER_INTERVAL:-60}"        # Check every N seconds
ORPHAN_AGE_THRESHOLD="${EVE_ORPHAN_AGE:-300}"       # Only kill processes older than N seconds
REAPER_LOG="${EVE_REAPER_LOG:-/tmp/orphan-reaper.log}"
REAPER_PID_FILE="/tmp/orphan-reaper.pid"

# Essential processes to never kill (patterns)
# Note: These match against full `ps -eo pid,ppid,etimes,comm,args` lines
# which have leading whitespace, so don't use ^ anchors
ESSENTIAL_PATTERNS=(
  "tini"
  "node dist/main.js"
  "orphan-reaper"
  "bash.*entrypoint"
  "/usr/bin/dumb-init"
  "sleep"              # Our own sleep calls
)

# Build grep pattern for essential processes
build_essential_pattern() {
  local pattern=""
  for p in "${ESSENTIAL_PATTERNS[@]}"; do
    if [[ -n "$pattern" ]]; then
      pattern="$pattern|$p"
    else
      pattern="$p"
    fi
  done
  echo "$pattern"
}

# Get current timestamp in seconds since epoch
now_seconds() {
  date +%s
}

# Get process start time in seconds since epoch
# Returns empty string if process doesn't exist
get_process_start_time() {
  local pid="$1"
  if [[ -f "/proc/$pid/stat" ]]; then
    # Get system boot time and process start time (in clock ticks)
    local boot_time
    boot_time=$(awk '/btime/ {print $2}' /proc/stat 2>/dev/null || echo "0")
    local start_ticks
    start_ticks=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || echo "0")
    local hz
    hz=$(getconf CLK_TCK 2>/dev/null || echo "100")

    if [[ "$boot_time" != "0" && "$start_ticks" != "0" ]]; then
      echo $((boot_time + start_ticks / hz))
    fi
  fi
}

# Get process age in seconds
get_process_age() {
  local pid="$1"
  local start_time
  start_time=$(get_process_start_time "$pid")
  if [[ -n "$start_time" ]]; then
    echo $(($(now_seconds) - start_time))
  else
    echo "0"
  fi
}

# Find orphaned processes (PPID=1, excluding essentials)
find_orphans() {
  local essential_pattern
  essential_pattern=$(build_essential_pattern)

  # Find all processes with PPID=1 (orphaned/reparented to init)
  # Exclude PID 1 itself and essential patterns
  ps -eo pid,ppid,etimes,comm,args --no-headers 2>/dev/null | \
    awk '$2 == 1 && $1 != 1' | \
    grep -vE "$essential_pattern" || true
}

# Count orphaned processes
count_orphans() {
  find_orphans | wc -l | tr -d ' '
}

# Get orphan details for status display
get_orphan_details() {
  local orphans
  orphans=$(find_orphans)

  if [[ -z "$orphans" ]]; then
    echo "No orphaned processes detected"
    return
  fi

  echo "Orphaned processes (PPID=1):"
  echo "PID     AGE(s)  COMMAND"
  echo "$orphans" | while read -r pid ppid etimes comm args; do
    printf "%-7s %-7s %s\n" "$pid" "$etimes" "$comm"
  done
}

# Kill orphaned processes older than threshold
kill_orphans() {
  local force="${1:-false}"
  local killed=0
  local skipped=0

  find_orphans | while read -r pid ppid etimes comm args; do
    # Check age threshold (etimes is elapsed time in seconds)
    if [[ "$force" == "true" ]] || [[ "$etimes" -gt "$ORPHAN_AGE_THRESHOLD" ]]; then
      echo "[$(date -Iseconds)] Killing orphan: PID=$pid, age=${etimes}s, cmd=$comm" >> "$REAPER_LOG"
      kill -9 "$pid" 2>/dev/null || true
      ((killed++)) || true
    else
      ((skipped++)) || true
    fi
  done

  echo "killed=$killed skipped=$skipped"
}

# Reaper daemon loop
run_daemon() {
  echo "[$(date -Iseconds)] Orphan reaper started (interval=${REAPER_INTERVAL}s, threshold=${ORPHAN_AGE_THRESHOLD}s)" >> "$REAPER_LOG"

  while true; do
    local count
    count=$(count_orphans)

    if [[ "$count" -gt 0 ]]; then
      echo "[$(date -Iseconds)] Found $count orphaned processes" >> "$REAPER_LOG"
      kill_orphans false >> "$REAPER_LOG" 2>&1
    fi

    sleep "$REAPER_INTERVAL"
  done
}

# Start daemon in background
start_daemon() {
  if [[ -f "$REAPER_PID_FILE" ]]; then
    local existing_pid
    existing_pid=$(cat "$REAPER_PID_FILE")
    if kill -0 "$existing_pid" 2>/dev/null; then
      echo "Reaper already running (PID: $existing_pid)"
      return 0
    fi
    rm -f "$REAPER_PID_FILE"
  fi

  run_daemon &
  local daemon_pid=$!
  echo "$daemon_pid" > "$REAPER_PID_FILE"
  echo "Orphan reaper started (PID: $daemon_pid)"
}

# Stop daemon
stop_daemon() {
  if [[ -f "$REAPER_PID_FILE" ]]; then
    local pid
    pid=$(cat "$REAPER_PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      echo "Orphan reaper stopped (PID: $pid)"
    fi
    rm -f "$REAPER_PID_FILE"
  else
    echo "Reaper not running"
  fi
}

# Show status
show_status() {
  local count
  count=$(count_orphans)

  echo "Orphan Reaper Status"
  echo "===================="

  if [[ -f "$REAPER_PID_FILE" ]]; then
    local pid
    pid=$(cat "$REAPER_PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "Daemon: running (PID: $pid)"
    else
      echo "Daemon: not running (stale PID file)"
    fi
  else
    echo "Daemon: not running"
  fi

  echo "Orphan count: $count"
  echo ""
  get_orphan_details
}

# Main
case "${1:-status}" in
  start)
    start_daemon
    ;;
  stop)
    stop_daemon
    ;;
  status)
    show_status
    ;;
  kill)
    echo "Force killing all orphaned processes..."
    kill_orphans true
    ;;
  daemon)
    # Run in foreground (for direct invocation)
    run_daemon
    ;;
  *)
    echo "Usage: $0 {start|stop|status|kill|daemon}"
    exit 1
    ;;
esac
