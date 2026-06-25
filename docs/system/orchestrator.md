# Orchestrator

> Status: Current
> Last Updated: 2026-06-03
> Purpose: Document concurrency control, admin APIs, and tuning behavior for the orchestrator.

## Responsibilities

- Claims ready jobs and dispatches them to workers.
- Enforces job gates and dependency order.
- Routes pipeline triggers into job graphs.
- Applies concurrency limits per orchestrator replica.

## Concurrency Control (Current)

Each orchestrator replica runs a concurrency limiter. This controls how many jobs
are dispatched in parallel by that replica.

Key settings:
- `ORCH_LOOP_INTERVAL_MS` (default: `5000`)
- `ORCH_CONCURRENCY` (default: `4`)
- `ORCH_CONCURRENCY_MIN` / `ORCH_CONCURRENCY_MAX` (tuner bounds)

Behavior:
- Claims are decoupled from dispatch; each dispatch reserves a slot.
- Slots are released when dispatch finishes or is force-recovered.
- Ticks are serialized (no overlapping claim loops) to avoid double-claim races.
- Dispatch completion requests an immediate follow-up tick when capacity is free.
- Cancelled jobs are treated as terminal and unblock dependents.
- Gate-blocked jobs are requeued with defer backoff to avoid rapid
  claim/fail loops while an environment or branch lock is occupied.

## Auto-Tuner (Current)

Optional resource-aware tuning adjusts concurrency within min/max bounds.

Key settings:
- `ORCH_TUNER_ENABLED`
- `ORCH_TUNER_INTERVAL_MS`
- `ORCH_TUNER_CPU_THRESHOLD`
- `ORCH_TUNER_MEMORY_THRESHOLD`

When enabled, the tuner reads cgroup metrics and nudges concurrency up/down based
on CPU/memory pressure.

## Attempt Recovery (Current)

The orchestrator runs recovery loops to prevent stuck `active` jobs with
`running` attempts.

Recovery paths:
- `recoverCompletedAttempts`: finalizes attempts that already emitted a
  completion event but were never closed.
- `recoverAttemptInitTimeouts`: fails running attempts that were claimed but
  never reached runtime acceptance (`execution_started_at IS NULL`) within the
  init window.
- `recoverAttemptStartupTimeouts`: fails accepted attempts that never emitted
  `lifecycle_harness_start` within the startup window.
- `recoverStaleRunningAttempts`: watchdog that fails attempts that exceed
  timeout/grace or remain idle past stale thresholds.
- `recoverOrphanedJobs` (startup): resets orphaned active jobs from previous
  orchestrator instances and releases gate locks.

Key settings:
- `EVE_ORCH_RECOVERY_INTERVAL_TICKS` (default `1`): interval for completed-attempt recovery.
- `EVE_ORCH_STALE_RECOVERY_INTERVAL_TICKS` (default `1`): interval for stale-attempt watchdog.
- `EVE_ORCH_ATTEMPT_INIT_TIMEOUT_SECONDS` (default `300`): claim-to-runtime-acceptance bound.
- `EVE_ORCH_ATTEMPT_STARTUP_TIMEOUT_SECONDS` (default `600`): runtime-acceptance-to-harness-start bound.
- `EVE_ORCH_STALE_RUNNING_SECONDS` (default `900`): minimum runtime before idle-stale recovery.
- `EVE_ORCH_STALE_IDLE_SECONDS` (default `900`): required no-progress window for idle-stale recovery.
- `EVE_ORCH_TIMEOUT_GRACE_SECONDS` (default `30`): extra grace after `hints.timeout_seconds`.
- `EVE_ORCH_ATTEMPT_STALE_MINUTES` (default `5`): startup orphan recovery cutoff.

Watchdog failures complete the running attempt, mark the job failed, emit
`system.job.failed`, release gates/dispatch slots, and try to close a workflow
root parent. The durable code is stored in `attempt.result_json.error_code` and
rendered by `eve job diagnose`:

- `attempt_init_timeout`
- `attempt_startup_timeout`
- `attempt_timeout`
- `attempt_stale`

## Admin API (Internal)

Endpoints:

```
GET  /system/orchestrator/status
POST /system/orchestrator/concurrency
```

Authentication:
- Requires `EVE_INTERNAL_API_KEY` via internal auth guard.

Example:

```bash
curl -H "x-eve-internal-token: $EVE_INTERNAL_API_KEY" \
  $EVE_API_URL/system/orchestrator/status

curl -X POST -H "x-eve-internal-token: $EVE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"limit":4}' \
  $EVE_API_URL/system/orchestrator/concurrency
```

## CLI (Internal)

```bash
eve system orchestrator status
eve system orchestrator set-concurrency <n>
```

## Related

- [Pipelines](./pipelines.md)
- [Environment Gating](./environment-gating.md)
- [Job API](./job-api.md)
