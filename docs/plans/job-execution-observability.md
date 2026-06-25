# Job Execution Observability Enhancement

**Status:** Shipped (a60c10a)
**Created:** 2026-01-19

## Problem

Job execution currently only logs harness JSONL output. Critical lifecycle events are lost:
- Workspace provisioning (git clone): logged to stdout only
- Hook execution (on-clone, on-acquire, etc): logged to stdout only
- Service provisioning (K8s pods): logged to stdout only
- Secret materialization: logged to stdout only

**Result:** `eve job logs` shows 2 entries for a job that took 4+ seconds, with no visibility into what actually happened during execution.

## Current State

The `execution_logs` table captures harness output but misses the full job lifecycle:

```
[11:33:02] skill-pack-check core_pack=e2e-core repo_pack=e2e-repo
[11:33:02] completed exitCode=0 durationMs=49
```

Where did the other 4 seconds go? Workspace clone, hooks, service provisioning - all invisible.

## Proposed Solution

Instrument the worker to persist lifecycle events to `execution_logs` table using the existing schema. No database migration required.

## Event Types

| Event Type | When | Metadata |
|------------|------|----------|
| `lifecycle_workspace_clone_start` | Before git clone/copy | repo_url, branch, is_local |
| `lifecycle_workspace_clone_end` | After clone completes | duration_ms, success, error |
| `lifecycle_hook_start` | Before running hook | hook_name |
| `lifecycle_hook_end` | After hook completes | hook_name, duration_ms, success, error |
| `lifecycle_hook_output` | Hook stdout/stderr | hook_name, stream, line |
| `lifecycle_service_provision_start` | Before K8s service | service_name, image |
| `lifecycle_service_provision_end` | After service ready | service_name, duration_ms, success, host, port |
| `lifecycle_secret_resolve_start` | Before resolving secrets | project_id |
| `lifecycle_secret_resolve_end` | After secrets resolved | duration_ms, resolved_count |
| `lifecycle_harness_start` | Before spawning harness | harness, permission, model |
| `lifecycle_harness_end` | After harness exits | duration_ms, exit_code |
| `lifecycle_runner_pod_start` | Before K8s runner pod | - |
| `lifecycle_runner_pod_end` | After runner pod ready | pod_name, namespace, duration_ms |

## Event Structure

All events share a common envelope:

```typescript
interface LifecycleEvent {
  ts: string;              // ISO timestamp
  phase: string;           // e.g., 'workspace_clone', 'hook', 'harness'
  action: 'start' | 'end' | 'log';
  duration_ms?: number;    // For 'end' events
  success?: boolean;       // For 'end' events
  error?: string;          // For failed 'end' events
  meta: Record<string, unknown>;  // Phase-specific metadata
}
```

## Files to Modify

### 1. Worker Instrumentation (Direct Path)

**File:** `apps/worker/src/invoke/invoke.service.ts`

Add helper method and instrument:
- `prepareWorkspace()` (lines 631-675) - clone start/end
- `runHook()` (lines 800-886) - hook start/end + stdout/stderr capture
- `provisionServices()` (lines 405-625) - service start/end
- `resolveSecrets()` (around line 677) - secret start/end
- `executeEveAgentCli()` (lines 1245-1414) - harness start/end

### 2. K8s Runner Instrumentation

**File:** `apps/worker/src/invoke/k8s-runner.ts`

Instrument:
- `runInvocationInK8s()` - runner pod start/end
- Pod creation, readiness wait, health check phases

### 3. Hook Output Capture

Modify `runHook()` to stream stdout/stderr instead of just capturing exit code:

```typescript
const hookProcess = spawn('bash', [hookPath], { ... });
hookProcess.stdout.on('data', (data) => {
  for (const line of data.toString().split('\n').filter(Boolean)) {
    this.logLifecycleEvent(attemptId, 'hook_output', 'log', {
      hook_name: hookName,
      stream: 'stdout',
      line,
    });
  }
});
```

### 4. CLI Display

**File:** `packages/cli/src/commands/job.ts`

Update `formatLogEntry()` to render lifecycle events with visual formatting.

### 5. Shared Types

**File:** `packages/shared/src/types/lifecycle.ts`

Export `LifecycleEvent` interface for type safety.

## Implementation Phases

### Phase 1: Core Infrastructure
1. Add `logLifecycleEvent` helper to InvokeService
2. Add LifecycleEvent type to shared package

### Phase 2: Direct Execution Path
3. Instrument `prepareWorkspace` - clone start/end
4. Instrument `runHook` - hook start/end + stdout/stderr capture
5. Instrument `resolveSecrets` - secret resolution
6. Instrument `executeEveAgentCli` - harness start/end
7. Instrument `provisionServices` - K8s service provisioning

### Phase 3: K8s Runner Path
8. Instrument `k8s-runner.ts` - runner pod lifecycle

### Phase 4: CLI Display
9. Update `formatLogEntry` for lifecycle events
10. Update `formatFollowLogLine` for SSE streaming
11. Add timeline view to `eve job diagnose`

### Phase 5: Testing
12. Test with stack E2E flow on K8s stack

## Expected Output

After implementation, `eve job logs <job_id>` will show:

```
[11:32:55] Creating runner pod...
[11:32:57] Runner pod ready (2100ms)
[11:32:58] Cloning file:///path/to/repo...
[11:32:59] Clone completed (1234ms)
[11:32:59] Running hook: on-clone...
[11:32:59]   > npm install
[11:33:00]   > added 150 packages in 1.2s
[11:33:00] Hook on-clone completed (890ms)
[11:33:00] Starting harness: mclaude
[11:33:02] event assistant message="Task completed successfully"
[11:33:02] Harness exited (code: 0) (2100ms)
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
