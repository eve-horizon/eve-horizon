# Job Execution Observability and CLI-First Debugging Plan

**Status:** Shipped (a60c10a; collapsed with v1)
**Created:** 2026-01-19
**Updated:** 2026-01-19

## Goal

Make job execution debuggable end-to-end using the CLI as the primary gateway. Capture lifecycle timing and errors for both execution paths (direct worker invoke and K8s runner pods) with minimal moving parts. Preserve the current API/CLI contract and avoid schema changes.

## Principles

- **CLI-first**: Every signal must surface in `eve job logs`, `eve job follow`, and `eve job diagnose`.
- **API-only gateway**: CLI talks only to API; no direct access to worker/runner logs required for core debugging.
- **Minimal moving parts**: Prefer existing `execution_logs` storage and structured lifecycle events.
- **Pre-MVP simplicity**: No feature flags, no optional modes in core flows.
- **Dual runtime**: Works for local (direct worker invoke) and k3d/K8s runner pods.

## Current State

`execution_logs` captures harness JSONL output only. Worker lifecycle events (clone, hooks, secrets, services, runner pod readiness) are not persisted, making failures opaque unless you tail worker/runner logs directly.

## Proposed Observability Model

Persist lifecycle events into `execution_logs` using structured JSON content. This makes the CLI authoritative for debugging while keeping storage and streaming unchanged.

### Event Envelope

```typescript
interface LifecycleEvent {
  ts: string;              // ISO timestamp
  phase: string;           // workspace | hook | secrets | services | harness | runner
  action: 'start' | 'end' | 'log';
  duration_ms?: number;    // For end events
  success?: boolean;       // For end events
  error?: string;          // For failed end events
  meta: Record<string, unknown>;
}
```

### Event Types (Execution Logs)

Use `type = lifecycle_<phase>_<action>` and `content = LifecycleEvent`.

| Phase | Start | End | Log | Notes |
| --- | --- | --- | --- | --- |
| workspace | clone start | clone end | - | repo_url (redacted), branch, is_local |
| hook | hook start | hook end | hook output | hook_name, stream, line |
| secrets | resolve start | resolve end | - | resolved_count |
| services | provision start | provision end | - | service_name, image, host, port |
| harness | start | end | - | harness, permission, model, exit_code |
| runner | pod start | pod ready end | - | pod_name, namespace |

## CLI-First Debugging Surface

The CLI already streams and lists logs. Update formatting to recognize lifecycle events and render:

- **`eve job logs`**: show timed steps with durations and errors
- **`eve job follow`**: stream lifecycle logs with compact labels
- **`eve job diagnose`**: add a simple timeline summary derived from lifecycle events

No new API endpoints. No schema changes.

## Open Source Observability Tools (Minimal Integration)

The core plan does **not** require external tooling. However, two small integrations can materially improve debugging without complexity:

1. **Structured JSON logs to stdout** in worker and runner (already happening in many places). This allows:
   - **Local**: `jq`/`rg` filtering during dev
   - **K8s**: `kubectl logs` with consistent formats

2. **OpenTelemetry (OTEL) tracing for worker** as a follow-on (optional, deferred):
   - Emit spans for clone/hook/services/harness in worker only.
   - Export to local OTEL collector (optional), but keep runtime operational without it.
   - Use OTEL only when debugging deeper cross-service issues; do not gate functionality.

**Recommendation:** implement lifecycle logs now; revisit OTEL after first deployment if debugging gaps remain. Avoid bundling Grafana/Loki/Prometheus stacks pre-MVP.

## Files to Change

- `apps/worker/src/invoke/invoke.service.ts`
  - Add lifecycle log helper and instrumentation for direct path
- `apps/worker/src/invoke/k8s-runner.ts`
  - Instrument runner pod lifecycle events
- `packages/cli/src/commands/job.ts`
  - Format lifecycle events in logs/follow/diagnose
- `packages/shared/src/types`
  - Add `LifecycleEvent` type and helpers

## Implementation Plan

### Phase 1: Common Lifecycle Logging

1. Add `LifecycleEvent` type in `packages/shared/src/types/lifecycle.ts`.
2. Add `logLifecycleEvent(attemptId, phase, action, meta, opts?)` helper in `InvokeService`.
3. Ensure `execution_logs` inserts are used for lifecycle logs (no schema change).

**Rationale:** Establish a single logging contract used by both execution paths.

### Phase 2: Direct Worker Path Instrumentation

Instrument in `apps/worker/src/invoke/invoke.service.ts`:

- `prepareWorkspace()`
  - `workspace clone start/end`
  - include duration and redacted repo URL
- `runHook()`
  - `hook start/end` with duration, success, error
  - stream `hook output` (stdout/stderr) as lifecycle logs
- `resolveSecrets()`
  - `secrets resolve start/end` with count
- `provisionServices()`
  - `services provision start/end` per service with timing and host/port
- `executeEveAgentCli()`
  - `harness start/end` with exit code and duration

**Rationale:** covers the entire direct path without external tooling.

### Phase 3: K8s Runner Path Instrumentation

Instrument in `apps/worker/src/invoke/k8s-runner.ts`:

- `runInvocationInK8s()`
  - `runner pod start` before manifest apply
  - `runner pod ready end` after readiness wait
  - include pod name, namespace, duration

**Rationale:** gives parity with direct path and explains K8s wait time.

### Phase 4: CLI Formatting and Debug View

Update `packages/cli/src/commands/job.ts`:

- `formatLogEntry()`
  - Detect `type` prefix `lifecycle_` and render human-readable steps
- `formatFollowLogLine()`
  - Compact lifecycle output with timing and errors
- `job diagnose`
  - Add a timeline summary built from lifecycle `start/end` pairs

**Rationale:** CLI remains the main gateway for debugging; no new endpoints.

### Phase 5: Validation

- Run `./bin/eh test integration` (fast local path)
- Run `./bin/eh k8s deploy` and `./bin/eh test e2e --env stack` (full path)
- Verify lifecycle logs show full timeline and clear failure points

## Expected Output

After implementation, `eve job logs <job_id>` will show:

```
[12:00:01] Creating runner pod...
[12:00:03] Runner pod ready (2100ms)
[12:00:03] Cloning file:///path/to/repo...
[12:00:05] Clone completed (1850ms)
[12:00:05] Running hook: on-clone
[12:00:05]   > npm install
[12:00:06] Hook on-clone completed (890ms)
[12:00:06] Starting harness: mclaude
[12:00:08] Harness exited (0) (2100ms)
```

## Backward Compatibility

- Existing `type` values (`event`, `system`, `system_error`) unchanged
- Log query APIs unchanged
- SSE streaming format unchanged
- Old CLI versions will ignore new event types (graceful degradation)

## No Schema Changes Required

The existing `execution_logs` table supports this:

- `type` field: use `lifecycle_<phase>_<action>`
- `content` field: JSONB for structured metadata

## Scope

This covers both execution paths:

- **Direct execution**: Worker runs harness directly (Docker/local dev)
- **K8s runner**: Worker spawns runner pod which calls back to `/invoke`

Both paths will emit lifecycle events to the same `execution_logs` table.
