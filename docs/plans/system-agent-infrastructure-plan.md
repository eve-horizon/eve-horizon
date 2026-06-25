# System Agent Infrastructure: Tokens, Permissions, Event Fan-out

> Status: Plan
> Created: 2026-02-11
> Extracted from: `docs/plans/platform-agents.md` (Phases 1.3-1.4, 2)
>
> Dependencies:
> - `docs/plans/platform-primitives-plan.md` Epic 3 (System Scope) — `is_system` flag must exist
> - `docs/plans/platform-primitives-plan.md` Epic 1 (Cron Hardening) — atomic dedupe for fan-out events
>
> References:
> - `apps/api/src/auth/auth.internal.controller.ts` (job token minting)
> - `apps/api/src/system/system.controller.ts` (system endpoints)
> - `apps/orchestrator/src/events/` (event emission)
> - `packages/db/src/queries/events.ts` (event queries)

## Overview

Two epics that enable system-scoped agents to operate across the platform with elevated (but guarded) permissions.

1. **System Agent Tokens**: Elevated permission sets for system project jobs, with server-side allowlisting.
2. **Event Fan-out**: Cross-project routing so the system project becomes the single inbox for platform failure events.

---

## Epic 4: System Agent Tokens (Elevated Permissions + Guards)

**Goal**: Let agents running in the system project access platform APIs (`/system/*`, `/admin/*`) and operate across tenant project boundaries — with strict server-side guards.

### Current Behavior

- The worker mints a per-job token via `POST /internal/auth/mint-job-token` and writes it to `~/.eve/credentials.json` inside the harness HOME.
- The worker currently requests a fixed permission set: `jobs`, `threads`, `envdb`, `secrets`, `builds`, `pipelines` (read/write).
- `/system/*` endpoints require `RequirePermission('system:read')` but `SystemController.extractUser()` also enforces `org_admin` or `system_admin` roles via a `ForbiddenException` — blocking job tokens which have permissions but no roles.
- `/admin/*` endpoints (balance, usage, receipts, pricing) require `system_admin` role.

### Implementation

#### 1. Elevated permission set for system project jobs

When the worker mints a job token for a job whose project has `is_system = true`, request an expanded permission set:

| Permission | Purpose |
|-----------|---------|
| `system:read` | Access `/system/*` endpoints (status, pods, logs, jobs) |
| `jobs:admin` | Cross-project job create/cancel for remediation |
| `billing:read` | Access `/admin/*` balance/usage/receipts/pricing endpoints |
| `events:write` | Emit events into the system project |

Standard (non-system) project jobs continue to receive the current fixed permission set.

#### 2. Server-side allowlisting on `mint-job-token`

Update `apps/api/src/auth/auth.internal.controller.ts`:

- Accept the requested permission set from the worker.
- **Reject** elevated permissions (`system:read`, `jobs:admin`, `billing:read`) if the job's project does NOT have `is_system = true`.
- This is a server-side guard — even if the worker is compromised, it cannot mint elevated tokens for tenant projects.

#### 3. Cross-project access for system tokens

The auto-remediation agent needs to create replacement jobs and cancel jobs in *tenant* projects. System agent tokens must be allowed to call:

- `POST /projects/{tenant_project_id}/jobs` (create replacement job)
- `POST /projects/{tenant_project_id}/jobs/{id}/cancel` (cancel stuck/failed job)

**Approach**: System project tokens (identified by `is_system` on the token's project) are implicitly allowed cross-project access on allowlisted endpoints. This mirrors how `is_system` works as an escape hatch elsewhere. No new permission dimension needed.

Implementation: In the project-scoped auth middleware, when the token's project has `is_system = true` and the token carries `jobs:admin`, bypass the project ID match check for job endpoints.

#### 4. Make `/system/*` and `/admin/*` usable from job tokens

**`/system/*`**: Update `SystemController.extractUser()` so job tokens carrying `system:read` bypass the `org_admin`/`system_admin` role check.

**`/admin/*`**: Update admin controllers (balance, usage, receipts, pricing) to accept job tokens carrying `billing:read` alongside the existing `system_admin` role check.

Future: Add `domains:manage` permission for the infra provisioner (see DNS plan). Not needed in this epic.

### Security Notes

- `is_system` validation happens server-side at token minting time — the worker doesn't self-certify.
- Elevated permissions are an explicit, auditable allowlist — not blanket admin access.
- Cross-project access is limited to specific endpoints (job create/cancel), not all project resources.
- The `is_system` flag itself is protected (see Platform Primitives plan, Epic 3 guards).

### Tests

- Integration: System agent job token can call `eve system status` (job token path through `/system/*`).
- Integration: System agent job token can call `eve admin balance show` (job token path through `/admin/*`).
- Integration: System agent job token can create a job in a tenant project.
- Integration: System agent job token can cancel a job in a tenant project.
- Unit: `mint-job-token` rejects `system:read` for non-system project jobs.
- Unit: `mint-job-token` rejects `jobs:admin` for non-system project jobs.
- Unit: `mint-job-token` rejects `billing:read` for non-system project jobs.
- Integration: Standard project job token cannot access `/system/*` or `/admin/*`.

---

## Epic 5: Event Fan-out (Cross-Project Routing)

**Goal**: Make platform failure events visible to the system project so event-driven remediation workflows can trigger.

### Problem

Trigger matching loads the manifest for `event.project_id`. A central `eve-platform/platform-ops` project will not see tenant-project failure events because those events belong to the tenant's project scope.

### Current State

Already emitted by the orchestrator:

- `system.job.failed` — payload: `{ job_id, attempt_id, run_id, step_name, execution_type, action_type, error_message, error_code, exit_code }`
- `system.pipeline.failed` — payload: `{ run_id, pipeline_name, env_name, git_sha, error_message, error_code }`

These events are sufficient for the first remediation workflows.

### Implementation

**Approach**: Fan-out a small allowlist of `source=system` failure events into the system project.

#### 1. Fan-out rules

When a system failure event is written to a tenant project:
- Create a second event row in the system project with the same `type` and `source`.
- Copy the original payload and add origin metadata:
  - `origin_project_id`: the tenant project that owns the failure
  - `origin_org_id`: the tenant org
  - `origin_event_id`: the original event ID (for traceability)
- Use a distinct dedupe namespace: `dedupe_key: fanout:{original_dedupe_key}`.
- **Guard**: If the origin project is already `is_system = true`, do NOT fan-out (prevents loops).

#### 2. Resolve system project ID

Use the system project resolution utility from Platform Primitives Epic 3:
- Look up `(org.slug = 'eve-platform', project.slug = 'platform-ops')`.
- Cache the result.
- If no system project exists (not bootstrapped yet), skip fan-out silently.

#### 3. Implementation location

In the orchestrator's `emitJobFailureEvent` and `emitPipelineFailureEvent` methods:
- After writing the origin event, check if a system project exists.
- If yes, and if the origin project is not `is_system`, write the fan-out event.
- Uses the atomic dedupe from Platform Primitives Epic 1 (`UNIQUE (project_id, dedupe_key)`) so fan-out remains HA-safe under concurrent orchestrators.

#### 4. Event allowlist (MVP)

Start with just two event types:
- `system.job.failed`
- `system.pipeline.failed`

Do NOT fan-out all events — keep the blast radius small. Additional event types can be added later as platform agents need them.

### Manifest trigger reminder

`trigger.system.event` expects the suffix (e.g., `job.failed`), not the full `system.job.failed`. So the system project manifest would declare:

```yaml
workflows:
  remediate-job-failed:
    assignee: auto_remediation
    trigger:
      system:
        event: job.failed
```

### Tests

- Integration: Tenant `system.job.failed` inserts a second event in the system project with origin fields.
- Integration: Fan-out event in system project triggers a workflow with `trigger.system.event: job.failed`.
- Integration: Dedupe prevents duplicate fan-out events under concurrent orchestrators.
- Integration: Events from `is_system` projects are NOT fanned out (no loops).
- Integration: Fan-out is silently skipped if no system project exists.

---

## Dependency Graph

```
Platform Primitives E1 (Cron Hardening)  ──→  Epic 5 (atomic dedupe reused)
Platform Primitives E3 (System Scope)    ──→  Epic 4 (is_system flag)
                                         ──→  Epic 5 (system project resolution)

Epic 4 (Tokens) ──┐
Epic 5 (Fan-out) ──┼──→  Platform Ops Agent Pack (separate plan)
```

Epic 4 and Epic 5 are independent of each other but both depend on System Scope (E3). They can proceed in parallel once E3 lands.
