# Activity-Based Job Timeouts

> Status: Idea
> Last Updated: 2026-01-28

## Summary

Replace hard job timeouts with activity-based detection. Jobs should be allowed to run for extended periods (up to 24 hours) as long as they show signs of progress. A job is "stuck" when it produces no log output for a configurable idle period.

## Problem

Current timeout model:
- Default: 1800 seconds (30 minutes) via `job.hints.timeout_seconds`
- Worker request timeout: 3600 seconds (1 hour) via `EVE_WORKER_REQUEST_TIMEOUT_MS`

This creates two problems:

1. **Long-running jobs get killed prematurely** - Complex agent work (large refactors, research, multi-file changes) can legitimately take hours. Hard timeouts force artificial limits.

2. **Stuck jobs waste resources** - A job that hangs early (e.g., waiting for user input that will never come) sits idle until the timeout expires, blocking gates and consuming resources.

## Proposal

Introduce two timeout concepts:

```yaml
# Job-level hints
hints:
  max_duration: 24h      # Absolute ceiling (safety net)
  idle_timeout: 5m       # Kill if no log output for this long
```

| Timeout | Purpose | Default |
|---------|---------|---------|
| `max_duration` | Hard limit - job cannot exceed this regardless of activity | 24h |
| `idle_timeout` | Stuck detection - job killed if no output for this period | 5m |

## What Counts as Activity?

The harness streams JSONL logs. Any log line resets the idle timer:

- Agent tool calls and results
- Thinking/reasoning output
- Status updates
- Error messages

**Exceptions** (do not reset timer):
- Heartbeat pings (if we add them)
- Internal framework noise

## Implementation Sketch

### Worker Side

```typescript
// In harness execution
class ActivityMonitor {
  private lastActivity: number = Date.now();
  private idleTimeoutMs: number;
  private maxDurationMs: number;
  private checkInterval: NodeJS.Timeout;

  onLogLine(line: string) {
    this.lastActivity = Date.now();
  }

  startMonitoring() {
    this.checkInterval = setInterval(() => {
      const idleMs = Date.now() - this.lastActivity;
      if (idleMs > this.idleTimeoutMs) {
        this.killJob('idle_timeout', `No activity for ${idleMs}ms`);
      }
    }, 10_000); // Check every 10s
  }
}
```

### Orchestrator Side

The orchestrator already tracks attempts. Add:

```typescript
// In attempt record
interface Attempt {
  // ... existing fields
  last_activity_at: Date;  // Updated by worker via API or log parsing
}
```

### Log-Based vs API-Based

**Option A: Log parsing (simpler)**
- Worker parses JSONL stream, updates `last_activity_at` locally
- No API calls needed
- Orchestrator trusts worker's timeout enforcement

**Option B: Heartbeat API (more robust)**
- Worker sends periodic heartbeats to orchestrator
- Orchestrator enforces timeout centrally
- More resilient to worker crashes

Recommendation: Start with Option A, add Option B if needed.

## HITL Review Considerations

When a job enters HITL review (`phase: review`):
- The job is waiting for human input
- Idle timeout should be **paused or extended**
- The human reviewer controls the timeline

Options:
1. **Pause idle timer during review** - Resume when human responds
2. **Use separate review timeout** - e.g., `review_timeout: 48h`
3. **No timeout during review** - Only `max_duration` applies

Recommendation: Pause idle timer during review phase.

## Job Type Defaults

Different job types have different activity patterns:

| Job Type | `idle_timeout` | `max_duration` | Rationale |
|----------|---------------|----------------|-----------|
| Agent (default) | 5m | 24h | Agents should be actively working |
| Pipeline step | 10m | 2h | Build/deploy steps can have quiet periods |
| Script | 30m | 4h | Scripts may have long-running processes |
| Action | 2m | 30m | Actions are quick, deterministic |

These are defaults; jobs can override via hints.

## Manifest Configuration

```yaml
# Project-level defaults in .eve/manifest.yaml
defaults:
  job_timeouts:
    idle_timeout: 5m
    max_duration: 24h
    review_timeout: 48h

# Pipeline-specific overrides
pipelines:
  full-deploy:
    steps:
      - type: build
        hints:
          idle_timeout: 15m  # Builds can be quiet
          max_duration: 1h
```

## CLI Visibility

```bash
# Show activity status
eve job show <id> --verbose
# Output includes:
#   Last Activity: 2m ago
#   Idle Timeout: 5m (3m remaining)
#   Max Duration: 24h (23h 45m remaining)

# Diagnose stuck job
eve job diagnose <id>
# Output includes activity timeline
```

## Migration Path

1. **Phase 1**: Add `idle_timeout` alongside existing `timeout_seconds`
   - `timeout_seconds` becomes alias for `max_duration`
   - Default `idle_timeout` = 5 minutes
   - Existing jobs continue working

2. **Phase 2**: Deprecate `timeout_seconds`
   - Warn when used
   - Auto-convert to `max_duration`

3. **Phase 3**: Remove `timeout_seconds`
   - Only `max_duration` and `idle_timeout` supported

## Open Questions

1. **Granularity of activity tracking** - Should we distinguish between "agent is thinking" vs "agent is executing tool"? Some tools (like large file reads) might be legitimately quiet.

2. **Network partitions** - If worker loses connection to orchestrator, how do we detect stuck jobs? Central heartbeat monitoring may be needed.

3. **Cost controls** - Long-running jobs consume API tokens. Should we add a `max_tokens` or `max_cost` limit alongside time limits?

4. **Notification on idle warning** - Should we alert before killing? e.g., "Job idle for 4m, will be killed in 1m"

## Related

- `docs/system/job-api.md` - Job hints and configuration
- `apps/orchestrator/src/loop/loop.service.ts` - Current timeout implementation
- `apps/orchestrator/src/worker/worker.client.ts` - Worker invocation with timeout
