# CLI Debugging Guide

How to use the Eve CLI to debug the stack and running jobs.

## Quick Reference

```bash
# System health
eve system health                    # Check if API is up
eve system status                    # Full system status (when API endpoint exists)

# Job debugging
eve job show <id>                    # Basic job info
eve job show <id> --verbose          # With attempt details
eve job diagnose <id>                # Comprehensive debugging output

# Execution details
eve job attempts <id>                # List all attempts
eve job logs <id>                    # View attempt logs
eve job logs <id> --attempt 2        # Specific attempt logs
eve job result <id>                  # View result (text/json)
eve job result <id> --format full    # Full result with metadata
eve job receipt <id>                 # Cost + timing receipt (latest attempt)
eve job compare <id> 1 2             # Compare two attempts

# Real-time monitoring (NEW)
eve job wait <id> --verbose          # Wait with status updates
eve job watch <id>                   # Combined status + logs streaming
eve job follow <id>                  # Stream harness logs (SSE)
eve job runner-logs <id>             # Stream K8s runner pod logs

# Team coordination (NEW)
eve supervise <job-id>               # Long-poll child events
eve thread messages <thread-id>      # Inspect coordination thread
eve thread follow <thread-id>        # Follow coordination messages

# Org analytics (NEW)
eve analytics summary --org org_xxx
eve analytics jobs --org org_xxx --window 7d
eve analytics pipelines --org org_xxx --window 30d
eve analytics env-health --org org_xxx

# K8s quick access (NEW)
eve system logs api                  # Fetch API pod logs
eve system logs orchestrator         # Fetch orchestrator logs
eve system logs worker               # Fetch worker logs
eve system logs postgres             # Fetch postgres logs
eve system logs <service> --tail 50  # Last 50 lines only

# Deployed app observability
eve env logs <project> <env> api --follow --since 30
eve env logs <project> <env> api --filter req_id=req_01h... --filter level=error
eve env diagnose <project> <env> --request req_01h... --window 120 --json
eve traces query --project <project> --request-id req_01h... --json
```

## Debugging Workflows

### 1. Job Won't Start

Check if the job is in the right phase and not blocked:

```bash
# Check job state
eve job show <id> --verbose

# Check if blocked by dependencies
eve job dep list <id>

# Check ready jobs queue
eve job ready --project <project-id>
```

**Common causes:**
- Job phase is not `ready` (check with `job show`)
- Job is blocked by dependencies (check with `job dep list`)
- Orchestrator is not healthy (check with `system health`)

### 2. Job Failed

Use diagnose for comprehensive output:

```bash
eve job diagnose <id>
```

This shows:
- Job status and timeline
- Attempt history with durations
- Attempt error code when `result_json.error_code` is present
- Runtime toolchain metadata (`runtime_meta.toolchains`) for jobs with declared
  toolchains
- LLM routing metadata (direct vs bridge, bridge ID, protocol pair, effective base URL)
- Error messages from latest attempt
- Recent logs
- Diagnostic recommendations

For more log detail:

```bash
eve job logs <id> --attempt <N>
```

### 3. Job Stuck Active

```bash
eve job diagnose <id>
```

Look for:
- "Attempt running for Xs - may be stuck" warning
- Check if attempt has a running status but no progress

**Possible causes:**
- Harness (mclaude/zai) is hanging
- Worker crashed but didn't mark attempt failed
- Network issues between worker and API
- `attempt_init_timeout`: runtime did not acknowledge the claimed attempt
- `attempt_startup_timeout`: runtime accepted the attempt but never logged
  harness start

For toolchain-backed jobs, `eve job diagnose` also renders
`toolchain_unavailable` with the requested toolchain/image and the relevant
`EVE_TOOLCHAIN_*` registry/cache hints.

### 4. System Issues

```bash
# Quick health check
eve system health

# Check if API can reach database
# (health endpoint shows database status)
```

If API is unhealthy:
- Check API logs (`tail -f /tmp/eve-api.log` in dev)
- Verify database is running
- Check `EVE_API_URL` is set correctly

## Environment Setup

The CLI only needs one environment variable. Always check the current stack first:

```bash
./bin/eh status
export EVE_API_URL=http://api.eve.lvh.me
```

This is all the CLI ever needs. The API handles routing to internal services.

**Per-environment defaults:**
| Environment | EVE_API_URL |
|-------------|-------------|
| Dev | `http://localhost:4801` |
| Docker | `http://localhost:4801` |
| K8s | `http://api.eve.lvh.me` (Ingress) |

## Debugging in Different Environments

### Local Dev

```bash
# Start stack
./bin/eh start local

# Debug
EVE_API_URL=http://localhost:4801 eve job diagnose <id>

# View service logs directly
tail -f /tmp/eve-api.log
tail -f /tmp/eve-orchestrator.log
tail -f /tmp/eve-worker.log
```

### Docker Compose (quick dev loop)

```bash
# Start stack
./bin/eh start docker

# Debug (API exposed on localhost:4801)
EVE_API_URL=http://localhost:4801 eve job diagnose <id>

# View container logs
docker logs eve-api -f
docker logs eve-orchestrator -f
docker logs eve-worker -f
```

### Kubernetes (default runtime)

```bash
# Start stack
./bin/eh k8s start

# Use Ingress (no port-forwarding)
./bin/eh status
export EVE_API_URL=http://api.eve.lvh.me

# Debug
eve job diagnose <id>
```

Use `kubectl` only as a last resort when CLI output is insufficient.

## Deployed App Request Debugging

For a single request ID, start with the integrated request dump:

```bash
eve env diagnose <project> <env> --request <request-id> --window 120 --json
```

It combines matching service logs, K8s events near the request window, current
deploy metadata, optional manifest-declared audit-log rows, and trace spans when
the trace backend has data.

For live or narrower log inspection:

```bash
eve env logs <project> <env> <service> --follow --since 30
eve env logs <project> <env> <service> --grep <request-id>
eve env logs <project> <env> <service> --filter req_id=<request-id> --filter level=error
eve env logs <project> <env> <service> --filter req.path=/api/items --follow
```

Trace lookup is available without AWS console access:

```bash
eve traces query --project <project> --request-id <request-id> --json
eve traces query --project <project> --service <service> --since 5m --error
```

## Common Error Messages

| Error | Meaning | Fix |
|-------|---------|-----|
| "OAuth token has expired", `apiKeySource: none`, or 401 | Claude auth invalid/not honored | Run `eve auth verify --harness claude --project <id> --json`, inspect `claude_auth_selected` / `claude_auth_failed`, then regenerate with `claude setup-token` if needed |

| "git clone failed" | Can't access repo | Check GITHUB_TOKEN secret is set |
| "Service X ready check failed" | Service provisioning issue | Check .eve/manifest.yaml (services), container logs |
| "Orchestrator restarted while attempt was running" | Job orphaned on restart | Job will auto-retry (recovery feature) |

## Real-time Debugging (While Job Runs)

The biggest debugging pain point is waiting for timeouts when errors have already occurred. Here's how to see what's happening in real-time:

### Quick Command: Watch Everything

```bash
# In terminal 1: Watch job status (polls every 5s)
watch -n 5 'eve job show <id> --verbose 2>&1 | head -30'

# In terminal 2: Stream logs (if harness is running)
eve job follow <id>

# In terminal 3 (k8s only): Watch runner pod
kubectl -n eve logs -f -l job-id=<id> 2>/dev/null || \
  kubectl -n eve logs -f $(kubectl -n eve get pods -o name | grep runner | head -1)
```

### K8s Runtime: Runner Pod Logs

Runner pods contain the actual execution - harness startup, repo clone, and execution. These logs often show errors before they appear in job status.

```bash
# List runner pods (includes completed ones briefly)
kubectl -n eve get pods | grep runner

# Stream runner pod logs (real-time errors)
kubectl -n eve logs -f eve-runner-<attempt-id>-<hash>

# If pod name unknown, find by job ID
kubectl -n eve get pods -l job-id=<job-id>

# Get orchestrator logs (sees worker timeouts)
kubectl -n eve logs -f deployment/eve-orchestrator --tail=50

# Get worker logs (sees runner pod creation)
kubectl -n eve logs -f deployment/eve-worker --tail=50
```

### Docker Runtime: Container Logs

```bash
# Orchestrator (sees job claiming, worker invocation)
docker logs -f eve-orchestrator

# Worker (sees runner execution)
docker logs -f eve-worker
```

### Stream Execution Logs (SSE)

The `follow` command streams JSONL logs from harness execution:

```bash
# Stream logs as they happen
eve job follow <id>

# Stream specific attempt
eve job follow <id> --attempt 2
```

**Note:** `follow` only shows harness output (mclaude/zai). Startup errors (clone, workspace, auth) appear in orchestrator/worker/runner logs, not here.

### Auth / Secrets Failures

If you see clone errors or missing-token errors:

```bash
eve secrets show GITHUB_TOKEN --project <proj_id>
eve secrets list --project <proj_id>
```

Then check orchestrator/worker logs for `[resolveSecrets]` warnings and verify
`EVE_INTERNAL_API_KEY` and `EVE_SECRETS_MASTER_KEY` are set for the API/worker.

### Improved Wait (Show Progress)

Instead of silent waiting, check status periodically:

```bash
# Poll job status while waiting (shows errors immediately)
while true; do
  eve job show <id> --verbose 2>&1 | grep -E '(Phase|Status|error|Error|failed)'
  sleep 5
done &

# Then wait
eve job wait <id> --timeout 900

# Kill the background poller
kill %1
```

### Parallel Debugging Script

Save this as `debug-job.sh`:

```bash
#!/bin/bash
# debug-job.sh <job-id>
JOB_ID=${1:?Usage: debug-job.sh <job-id>}

echo "=== Job Status ==="
eve job show $JOB_ID --verbose

echo ""
echo "=== Orchestrator (last 20 lines) ==="
kubectl -n eve logs deployment/eve-orchestrator --tail=20 2>/dev/null || \
  docker logs eve-orchestrator --tail=20 2>/dev/null || \
  echo "(not available)"

echo ""
echo "=== Worker (last 20 lines) ==="
kubectl -n eve logs deployment/eve-worker --tail=20 2>/dev/null || \
  docker logs eve-worker --tail=20 2>/dev/null || \
  echo "(not available)"

echo ""
echo "=== Runner Pods ==="
kubectl -n eve get pods 2>/dev/null | grep -E "runner|NAME" || \
  echo "(k8s only)"
```

## CLI Improvements (Implemented)

| Command | Description | Status |
|---------|-------------|--------|
| `eve job wait --verbose` | Show status changes while waiting | ✓ Implemented |
| `eve job watch` | Combined status + logs streaming | ✓ Implemented |
| `eve job runner-logs` | Stream runner pod logs (k8s) | ✓ Implemented |
| `eve system logs <service>` | Quick k8s log access | ✓ Implemented |

## Tips

1. **Start with `diagnose`** - it gives the most context in one command
2. **Check `--verbose` output** - shows attempt exit codes and durations
3. **API is the gateway** - if `system health` fails, nothing else will work
4. **Logs are per-attempt** - specify `--attempt N` if debugging a specific retry
5. **For k8s: check runner pods first** - errors often appear there before job status updates
6. **Run parallel terminals** - one for status polling, one for logs streaming
