# Orchestrator Multi-Job Concurrency Plan

**Status:** Implemented
**Created:** 2026-01-30
**Updated:** 2026-01-30

## Goal

Allow each orchestrator replica to run multiple jobs concurrently with safe limits. Phase 1 focuses on fixed per-replica concurrency. Later phases add admin controls and optional self-tuning.

## Non-Goals

- Global concurrency cap across replicas (deferred).
- Self-tuning in phase 1.
- Changes to job lifecycle semantics or API contracts.

## Current State

- The loop claims one job, dispatches to the worker, and awaits completion inline.
- The orchestrator is effectively single-concurrency by implementation choice, not architectural limit.
- Relevant code lives in `apps/orchestrator/src/loop/loop.service.ts` and `apps/orchestrator/src/worker`.

## Proposed Model

- Track in-flight jobs per replica (job + pipeline run).
- Decouple claim/dispatch from completion wait so the loop schedules work quickly.
- Use a semaphore-like limiter to cap concurrent dispatches.
- Dispatch returns immediately; completion is handled by background tasks.
- Preserve gate acquisition and retry semantics under parallelism.
- Default concurrency stays at 1.

### Key Code Touchpoints

- `apps/orchestrator/src/loop/loop.service.ts` (loop, claim, process, shutdown)
- `apps/orchestrator/src/worker/worker.service.ts` (execution entrypoint)
- `packages/shared/src/config/schema.ts` (env config)
- `packages/db/src/queries/jobs.ts` (claim/release semantics)

### Design Notes / Guardrails

- The current `setInterval` loop can overlap ticks if a job takes >5s. With concurrency, make tick re-entrant safe (guard or move to `setTimeout` scheduling).
- Keep a single code path for job lifecycle updates (attempt completion, job phase, gate release) to avoid double-writes.
- All async dispatches must be wrapped so limiter tokens are released even when exceptions occur.
- Capture and log all promise rejections; no fire-and-forget without `.catch`.
- Ensure shutdown drains in-flight tasks or times out with clear logs.

## Configuration

- `ORCH_CONCURRENCY` (default `1`).
- Reserved for later phases: `ORCH_CONCURRENCY_MIN`, `ORCH_CONCURRENCY_MAX`, `ORCH_TUNER_ENABLED`.

## Implementation Plan

### Phase 1: Fixed Per-Replica Concurrency

1. Add config (safe-by-default):
   - Update `packages/shared/src/config/schema.ts` to include `ORCH_CONCURRENCY` with `z.coerce.number().default(1)` and a minimum guard (e.g. `>= 1`).
   - Ensure orchestrator reads config via `loadConfig()`; do not hardcode env lookups in the loop.
2. Add a small limiter utility:
   - New file suggestion: `apps/orchestrator/src/loop/limiter.ts`.
   - Provide `acquire()`, `release()`, `run(fn)`, and `drain({ timeoutMs })`.
   - Keep state: `limit`, `inFlight`, and a FIFO queue of pending resolvers.
   - `run(fn)` should `await acquire()`, `try/finally` release, and surface errors.
3. Refactor the loop into scheduler + worker:
   - Extract the existing job-processing logic into a `processJob(claimed)` method that returns a Promise.
   - Add `dispatchJob(claimed)` that:
     - Wraps `processJob` with the limiter.
     - Tracks the promise in an `inFlight` map keyed by job ID or attempt ID.
     - Logs start/finish and removes the entry in `finally`.
   - Keep the try/catch/finally semantics inside `processJob` so gate release and workspace cleanup remain centralized.
4. Make tick re-entrant safe:
   - Add `tickInProgress` guard, or convert to a `setTimeout` loop that awaits `tick()` before scheduling the next tick.
   - The tick should return quickly by only claiming/dispatching, not awaiting job completion.
5. Scheduler logic (safe, bounded):
   - While `limiter.hasCapacity()`:
     - Attempt to claim a pipeline run first **or** treat pipeline runs as just another dispatchable unit (pick one approach and document it).
     - If claim fails (no work), break.
     - Dispatch immediately and loop to fill capacity.
   - This ensures one tick can fill up to `ORCH_CONCURRENCY` slots without relying on overlapping intervals.
6. Shutdown handling:
   - Add `shuttingDown` flag set in `onModuleDestroy()`.
   - Stop scheduling new claims, clear the interval, and call `limiter.drain({ timeoutMs })`.
   - Log remaining in-flight tasks if timeout is reached.
7. Logging + metrics:
   - Log `dispatch` and `complete` with job ID, attempt ID, and current in-flight count.
   - If metrics are available later, expose `orchestrator.in_flight` and `orchestrator.concurrency_limit`.

#### Concrete Loop Refactor Sketch (Safe-First)

- Move the body of the current `tick()` (from claim through final cleanup) into `processJob`.
- `tick()` becomes:
  - Heartbeat + recovery checks.
  - A loop that claims work while capacity exists.
  - Dispatches async tasks and returns.
- This keeps existing behavior when `ORCH_CONCURRENCY=1` and reduces risk.

### Phase 2: Admin Controls (API + CLI)

1. Admin-only API endpoints:
   - `GET /system/orchestrator/status` (limit, in-flight, uptime, last change).
   - `POST /system/orchestrator/concurrency` (set runtime limit).
2. CLI commands:
   - `eve system orchestrator status`
   - `eve system orchestrator set-concurrency <n>`
3. Runtime overrides are in-memory; restart resets to config.

### Phase 3: Self-Tuning (Cgroup Metrics)

1. Read CPU and memory usage from cgroups.
2. Tuner loop adjusts concurrency within min/max bounds:
   - Increase when CPU and memory are well below thresholds and backlog exists.
   - Decrease when CPU or memory is saturated.
3. Expose tuning status in the status endpoint and CLI.

### Phase 4: External Controller (Optional)

1. Scheduled process or operator uses host metrics to adjust concurrency.
2. Controller drives changes through the admin API.
3. Use this only if in-process tuning is too coarse.

## Safety and Correctness

- Gate acquisition must be safe under parallel claims (avoid stampedes).
- Ensure one dispatch per job attempt (track by attempt ID in `inFlight`).
- If dispatch fails before attempt creation, release the job for retry.
- On orchestrator restart, recovery logic should requeue or reconcile in-flight jobs.
- Avoid duplicate tick scheduling (overlapping intervals) so claims stay bounded.
- Prefer explicit `finally` blocks for: limiter token release, gate release, and workspace cleanup.

## Testing Plan

- Unit tests for limiter behavior and in-flight bookkeeping.
- Orchestrator loop test: set `ORCH_CONCURRENCY=2`, enqueue 2+ jobs, and assert two dispatches occur without waiting for the first to finish.
- Integration test that runs two jobs in parallel and validates gate correctness (env gate + branch gate).
- Regression test for cancellation and retry while jobs are in-flight.
- Shutdown test: ensure `onModuleDestroy()` drains or logs timeout without hanging.

## Rollout

- Default `ORCH_CONCURRENCY=1`.
- Enable in a single environment at `2`, observe metrics, then expand.
- Roll back instantly by setting back to `1`.

## Implementation Safety Checklist

- `tick()` cannot overlap or stack up (guard or awaited loop).
- Every dispatched job has exactly one `completeAttempt()` call and one `markJobDone/Failed()` call.
- Every gate acquisition has a corresponding release on all exit paths.
- Limiter tokens are released even if `processJob` throws.
- No unhandled promise rejections from dispatches.
- Logs include job ID + attempt ID for start/finish so tracing is easy.

## Open Questions

- None for phase 1. Revisit defaults and min/max after measurements.

## Implementation Summary

All four phases have been implemented:

### Phase 1: Fixed Per-Replica Concurrency
- Added `ConcurrencyLimiter` utility with semaphore-based concurrency control
- Refactored `LoopService` to support multiple in-flight jobs
- Implemented graceful shutdown with timeout for pending jobs
- Added metrics: `orchestrator.in_flight` and `orchestrator.concurrency_limit`
- Configuration via `ORCH_CONCURRENCY` (default: 1)

### Phase 2: Admin Controls
- Created `SystemController` with admin API endpoints:
  - `GET /system/orchestrator/status` - returns current limit, in-flight count, and uptime
  - `POST /system/orchestrator/concurrency` - sets runtime concurrency limit
- Protected with `InternalApiKeyGuard` requiring `EVE_INTERNAL_API_KEY`
- Runtime changes persist until orchestrator restart

### Phase 3: Self-Tuning
- Implemented `ConcurrencyTuner` with cgroup-based metrics
- Reads CPU and memory from `/sys/fs/cgroup` (Linux containers)
- Auto-adjusts concurrency within `ORCH_CONCURRENCY_MIN` and `ORCH_CONCURRENCY_MAX`
- Configuration:
  - `ORCH_TUNER_ENABLED` (default: false)
  - `ORCH_TUNER_INTERVAL_MS` (default: 30000)
  - Thresholds for CPU and memory scaling decisions
- Tuner status exposed in admin API

### Phase 4: External Controller
- Created example script at `scripts/orchestrator-concurrency-controller.sh`
- Demonstrates host-level metric collection and API-driven adjustments
- Supports both Linux and macOS for development/testing
- Use when in-process tuning is insufficient or when integrating with external monitoring

### Key Files
- `apps/orchestrator/src/loop/concurrency-limiter.ts` - Semaphore implementation
- `apps/orchestrator/src/loop/loop.service.ts` - Refactored loop with concurrent job handling
- `apps/orchestrator/src/loop/concurrency-tuner.ts` - Self-tuning logic
- `apps/orchestrator/src/system/system.controller.ts` - Admin API
- `scripts/orchestrator-concurrency-controller.sh` - External controller example
