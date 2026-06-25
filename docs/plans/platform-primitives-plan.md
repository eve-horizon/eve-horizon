# Platform Primitives: Cron Hardening, Workflow Assignee, System Scope

> Status: Plan
> Created: 2026-02-11
> Extracted from: `docs/plans/platform-agents.md` (Phases 0, 1.1-1.2, 1.5)
>
> Dependencies: None — all three epics are independent and can proceed in parallel.
>
> References:
> - `apps/orchestrator/src/cron/cron-scheduler.service.ts` (cron implementation)
> - `packages/db/src/queries/events.ts` (event dedupe)
> - `apps/api/src/workflows/workflows.service.ts` (workflow invocation)
> - `packages/shared/src/schemas/agent-config.ts` (agent entry schema)

## Overview

Three independent primitives that are broadly useful across the platform — not specific to platform agents, but required before platform agents can be wired up.

1. **Cron + Schedules Hardening**: Make time-based triggers HA-safe and useful.
2. **Workflow Assignee + Overrides**: Let workflows create jobs assigned to specific agents.
3. **System Scope**: Introduce the concept of "system" orgs/projects with bootstrap tooling.

---

## Epic 1: Cron + Schedules Hardening

**Goal**: Make time-based activation reliable, HA-safe, and useful for any consumer (not just platform agents).

### Current State

Orchestrator already includes a cron scheduler (`apps/orchestrator/src/cron/cron-scheduler.service.ts`, wired via `CronModule`) that registers two kinds of timers at startup:

1. **Manifest cron triggers**: Scans latest manifests for `pipelines.*.trigger.cron.schedule` and `workflows.*.trigger.cron.schedule`, registers in-memory cron jobs, and emits `cron.tick` events with payload `{ schedule, trigger_name }`.
2. **DB schedules**: Loads enabled rows from `schedules` and registers in-memory cron jobs that emit events of `schedule.event_type`.

The `schedules` table (migration `00032_add_agent_runtime_primitives.sql`):

```sql
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  cron TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Gaps

1. **HA/idempotency**: Each orchestrator replica emits cron events; `eventQueries.create` dedupe is best-effort (check-then-insert) without a DB uniqueness constraint.
2. **Schedule payload passthrough**: Schedule ticks currently ignore `schedules.payload_json`, so schedules cannot drive manifest cron triggers (missing `trigger_name`).
3. **Reload behavior**: Cron jobs are registered only at orchestrator startup; manifest changes and new schedules require restart.
4. **Validation/guardrails**: No minimum interval enforcement or cron syntax validation.

### Implementation

#### 1. Atomic event dedupe

The current index is non-unique on `(dedupe_key)` only (migration `00014`). Add a partial unique index:

```sql
-- Migration: 00042_harden_cron_dedupe.sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe_unique
  ON events (project_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
```

Update `eventQueries.create` (in `packages/db/src/queries/events.ts`) to use `INSERT ... ON CONFLICT (project_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING` so concurrent schedulers cannot double-insert.

#### 2. Merge `payload_json` for schedule ticks

In `CronSchedulerService.handleScheduleTick`, build the event payload as:

```typescript
const payload = {
  schedule: schedule.cron,
  schedule_id: schedule.id,
  ...schedule.payload_json,
};
```

This lets schedule rows drive manifest cron triggers by setting `event_type: cron.tick` and `payload_json: { trigger_name: "<workflow-or-pipeline-name>" }`.

#### 3. Reload strategy (MVP)

MVP: Document "restart orchestrator after manifest sync / schedule changes". This is already the operational pattern.

Future: Add an internal "reload cron" hook that diffs and updates registered jobs (out of scope for this epic).

#### 4. Schedule validation

Add validation in the API schedule creation endpoint:
- Validate cron syntax (reject invalid expressions).
- Reject schedules more frequent than once per minute.
- Optional: add a `timezone` column; current implementation uses UTC.

### Tests

- Integration: Manifest cron trigger emits `cron.tick` and routes to a workflow.
- Integration: Schedule row with `event_type=cron.tick` + `payload.trigger_name` routes to workflow.
- Concurrency: Two scheduler instances do not create duplicate events (unique index enforced).
- Validation: Schedule creation rejects invalid cron expressions and sub-minute intervals.

---

## Epic 2: Workflow Assignee + Overrides

**Goal**: Let workflow definitions specify which agent should execute the resulting job. Pure primitive — useful for any agent-targeted workflow.

### Current State

`WorkflowsService.invoke()` (`apps/api/src/workflows/workflows.service.ts`, line ~129) creates jobs with:
- `assignee: null` (hardcoded)
- `title: "[Workflow] ${name}"` (hardcoded, lines 123-124)
- `description: "Workflow invocation: ${name}"` (hardcoded)

The job claiming path for assigned agents (`claimNextAssignedJob` in `packages/db/src/queries/jobs.ts`) already exists and filters for `assignee IS NOT NULL` + `execution_type = 'agent'`, so no changes needed on the claiming side.

### Implementation

#### 1. Add optional fields to workflow definitions

In the manifest schema, add optional fields:

```yaml
workflows:
  system-health-check:
    assignee: system_health      # Agent slug — job.assignee is set to this
    title: "System Health Check"
    description: "Run the system-health skill and emit a report."
```

#### 2. Update `WorkflowsService.invoke()`

When `definition.assignee` is present, set `job.assignee = definition.assignee` and `job.execution_type = 'agent'`.

When `definition.title` or `definition.description` are present, use them instead of the hardcoded defaults. Fallback stays `[Workflow] ${name}` / `Workflow invocation: ${name}`.

#### 3. Schema validation

Add `assignee`, `title`, and `description` as optional string fields in the workflow definition schema (wherever manifest workflows are validated).

### Tests

- Integration: Workflow with `assignee` produces a job with that `assignee` and `execution_type = 'agent'`.
- Integration: Assigned job gets claimed via `claimNextAssignedJob`.
- Integration: Workflow without `assignee` continues to produce jobs with `assignee: null` (backward compat).
- Unit: Title/description overrides are applied when present, defaults used when absent.

---

## Epic 3: System Scope (org/project flags + bootstrap)

**Goal**: Introduce the concept of "system" orgs and projects, with a bootstrap command to create the platform operations project.

### Implementation

#### 1. Database migration

```sql
-- Migration: 00043_add_system_scope.sql
ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;
```

Note: Migration numbering may need adjustment — check current highest migration number. `00005_add_system_scope.sql` already exists (adds `'system'` to secrets scope enum) — this migration is for org/project-level system flags.

#### 2. Bootstrap CLI command

Add `eve admin bootstrap-platform` that:
1. Creates org `eve-platform` with `is_system = true` (idempotent — skip if exists).
2. Creates project `platform-ops` under that org with `is_system = true` (idempotent).
3. Returns the org ID and project ID.

Implementation: admin API endpoint (`POST /admin/bootstrap-platform`, system_admin only) + CLI wrapper.

#### 3. System project resolution utility

Add a utility function that resolves the system project ID:
- Look up by `(org.slug = 'eve-platform', project.slug = 'platform-ops')`.
- Cache the result (it never changes at runtime).
- Used by event fan-out (see `system-agent-infrastructure-plan.md`) and potentially other system-scoped features.

#### 4. Guards

- **Exclude `is_system` from user-facing DTOs**: Org and project create/update endpoints must not accept `is_system` in the request body.
- **Not exposed in public API responses**: `is_system` is an infrastructure concern, not visible to users.
- **Only settable via bootstrap or direct DB access**: No user-facing API can set these flags.

### Tests

- Integration: `eve admin bootstrap-platform` creates org + project with `is_system = true`.
- Integration: Running bootstrap twice is idempotent (no error, no duplicate).
- Integration: User-facing org/project create ignores `is_system` even if provided.
- Unit: System project resolution utility returns correct ID.
- Unit: System project resolution caches the result.

---

## Parallelization

All three epics are independent:

```
Epic 1 (Cron Hardening)      ──→  done
Epic 2 (Workflow Assignee)   ──→  done
Epic 3 (System Scope)        ──→  feeds into System Agent Infrastructure plan
```

Epic 1 and Epic 2 are quick wins with minimal risk. Epic 3 is the foundation for everything system-scoped.
