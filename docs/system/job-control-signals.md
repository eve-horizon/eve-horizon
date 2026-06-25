# Job Control Signals

> Status: Current
> Last Updated: 2026-01-19

## Purpose

Define the JSON control envelope (`json-result`) used by harnesses to signal orchestration outcomes and summarize attempts.

## Current (Implemented)

- The worker extracts the **last** fenced `json-result` block from harness output and stores it as `job_attempts.result_json`.
- Orchestrator reads `result_json.eve.status` to drive job lifecycle actions:
  - `waiting`: attempt completes as `succeeded`, job is requeued to `ready`, assignee cleared, **no review submission**.
  - `success`: normal success path (review or done based on job settings).
  - `failed`: normal failure path (job marked failed/cancelled).
- If `waiting` is returned **without blockers**, the orchestrator applies a short backoff via `defer_until` and logs a warning to avoid tight reschedule loops.
- `result_json.eve.summary` (when present) is persisted to `job_attempts.result_summary` for quick visibility.

### Envelope Format

```json-result
{
  "eve": {
    "status": "waiting",
    "summary": "Spawned 3 child jobs and added waits_for relations",
    "reason": "Waiting on child jobs to complete"
  }
}
```

Only the `eve.status` and `eve.summary` fields are currently consumed by the platform. Additional fields are permitted but ignored unless explicitly implemented.

## Planned (Not Implemented)

- None.

## Legacy / Removed

- None.
