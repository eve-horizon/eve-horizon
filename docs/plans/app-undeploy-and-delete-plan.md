# App Undeploy & Delete — Lifecycle Gaps

> Status: Plan
> Created: 2026-03-13
> Last Updated: 2026-03-13
> Relates to: [deployment.md](../system/deployment.md), [environments.md](../system/environments.md)

## Problem

Eve Horizon has a complete "create → deploy" lifecycle but an incomplete "undeploy → delete" lifecycle. Users can deploy apps but have limited ability to clean up after themselves:

1. **Environment delete** works end-to-end (K8s namespace + DB), but there's no way to **undeploy** an environment (take it offline) without permanently deleting it.
2. **Project delete** is soft-delete only, hidden behind `update --deleted=true` with no dedicated CLI command.
3. **Org delete** doesn't exist at all.
4. **Builds, releases, pipelines, agents, teams, threads** — none have delete operations.
5. **Database FK gaps**: 8 tables reference `projects(id)` without `ON DELETE CASCADE`, creating orphan risk.

This matters because:
- Users can't clean up resources they no longer need
- Abandoned deployments consume K8s resources indefinitely
- No way to satisfy data deletion requests (GDPR-style)
- Org admins have no cleanup tools for their tenancy

## Goals

1. **Undeploy without delete** — take an environment offline (tear down K8s) while preserving config for redeployment
2. **Dedicated `project delete`** — proper CLI command with cascading cleanup
3. **Org delete** — full tenancy teardown for org admins
4. **Build/release/pipeline cleanup** — prune historical records
5. **Agent/team/thread delete** — remove stale agent primitives
6. **Fix FK cascades** — ensure project hard-delete doesn't leave orphans

## Non-Goals

- **Multi-tenant data isolation** — that's access groups / RLS, not delete
- **Backup/restore** — snapshots before delete are nice-to-have, not in scope
- **Undo delete** — soft-delete provides a recovery window, but we're not building a trash/recycle bin UI
- **Usage record deletion** — billing records are retained for audit even after resource deletion

---

## Phase 1: Environment Undeploy (Separate from Delete)

**The gap**: Today, `eve env delete` is the only way to stop a running deployment. Users lose their environment config (variables, secrets bindings, release pointer) and must recreate from scratch to redeploy.

### Design

Add an `eve env undeploy` command that tears down K8s resources but keeps the environment record.

**New field on `environments` table:**

```sql
-- Migration: add_environment_deploy_status.sql
ALTER TABLE environments ADD COLUMN deploy_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE environments ADD CONSTRAINT environments_deploy_status_check
  CHECK (deploy_status IN ('unknown', 'deployed', 'undeployed', 'deploying', 'undeploying', 'failed'));
-- Existing rows default to 'unknown' and should be reconciled by a migration/sync job.
```

**API:**

```
POST /projects/{id}/envs/{name}/undeploy
```

- Calls worker `/environments/delete` to tear down K8s namespace (same as today's delete path)
- Sets `deploy_status = 'undeployed'` and `current_release_id = NULL`
- Does NOT delete the environment record
- Returns 200 with updated environment

**CLI:**

```bash
eve env undeploy <name> [--project=<id>] [--force]
# Confirmation: "This will take the 'test' environment offline. Redeploy with: eve env deploy ..."
```

**Deploy behavior change**: `eve env deploy` should check `deploy_status` and work regardless of current state (idempotent).

### Files to Change

| File | Change |
|------|--------|
| `packages/db/migrations/00XXX_add_env_deploy_status.sql` | New migration |
| `apps/api/src/environments/environments.controller.ts` | Add `POST :name/undeploy` endpoint |
| `apps/api/src/environments/environments.service.ts` | Add `undeploy()` method (reuse `teardownEnvironmentDeployment`) |
| `packages/shared/src/schemas/environments.ts` | Add `deploy_status` to schema |
| `packages/cli/src/commands/env.ts` | Add `undeploy` subcommand |
| `packages/db/src/repositories/environments.repository.ts` | Update for new field |

---

## Phase 2: Dedicated Project Delete

**The gap**: No `eve project delete` command. Users must know the incantation `eve project update <id> --deleted=true`. No hard-delete. No cascading K8s cleanup.

### Design

Add `eve project delete` that:
1. Undeploys all environments (Phase 1's undeploy, not just DB delete)
2. Soft-deletes the project (`deleted_at` timestamp)
3. With `--hard` flag: physically deletes all records (admin only)

**API:**

```
DELETE /projects/{id}
  ?hard=true    — hard delete (requires org admin)
  ?force=true   — continue on partial failures
```

**CLI:**

```bash
eve project delete <project> [--hard] [--force]
# Confirmation lists: N environments, N agents, N builds, N releases to be affected
```

**Cascade sequence (hard delete):**

1. Undeploy all environments (K8s teardown)
2. Delete all environments (triggers managed DB cleanup)
3. Clean up non-cascading or audit-retained tables as needed after FK migration
4. Delete project record (remaining CASCADE/SET NULL FKs handle the rest)

### FK Cascade Fix Migration

Tables referencing `projects(id)` **without** `ON DELETE CASCADE` that need fixing:

```sql
-- Migration: fix_project_cascade_deletes.sql

-- These block hard-delete today. Add CASCADE or SET NULL as appropriate.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_project_id_fkey,
  ADD CONSTRAINT jobs_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE pipeline_runs DROP CONSTRAINT IF EXISTS pipeline_runs_project_id_fkey,
  ADD CONSTRAINT pipeline_runs_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE releases DROP CONSTRAINT IF EXISTS releases_project_id_fkey,
  ADD CONSTRAINT releases_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE build_specs DROP CONSTRAINT IF EXISTS build_specs_project_id_fkey,
  ADD CONSTRAINT build_specs_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_project_id_fkey,
  ADD CONSTRAINT events_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE managed_db_tenants DROP CONSTRAINT IF EXISTS managed_db_tenants_project_id_fkey,
  ADD CONSTRAINT managed_db_tenants_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ingest_records DROP CONSTRAINT IF EXISTS ingest_records_project_id_fkey,
  ADD CONSTRAINT ingest_records_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

-- Nullable FKs — SET NULL on delete (audit trail / org-scoped records)
ALTER TABLE usage_records DROP CONSTRAINT IF EXISTS usage_records_project_id_fkey,
  ADD CONSTRAINT usage_records_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE org_documents DROP CONSTRAINT IF EXISTS org_documents_project_id_fkey,
  ADD CONSTRAINT org_documents_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE webhook_subscriptions DROP CONSTRAINT IF EXISTS webhook_subscriptions_project_id_fkey,
  ADD CONSTRAINT webhook_subscriptions_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE managed_db_snapshots DROP CONSTRAINT IF EXISTS managed_db_snapshots_project_id_fkey,
  ADD CONSTRAINT managed_db_snapshots_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
```

### Files to Change

| File | Change |
|------|--------|
| `packages/db/migrations/00XXX_fix_project_cascade_deletes.sql` | FK cascade migration |
| `apps/api/src/projects/projects.controller.ts` | Add `DELETE /:project_id` endpoint |
| `apps/api/src/projects/projects.service.ts` | Add `delete()` with soft/hard modes |
| `packages/cli/src/commands/project.ts` | Add `delete` subcommand |

---

## Phase 3: Org Delete

**The gap**: Orgs are permanent. No delete at all.

### Design

Add `eve org delete` that cascades through all org resources. Org delete is a heavyweight operation — it destroys an entire tenancy.

**API:**

```
DELETE /orgs/{org_id}
  ?hard=true    — hard delete (requires system admin)
  ?force=true   — continue on partial failures
```

**CLI:**

```bash
eve org delete <org> [--hard] [--force]
# Confirmation: "This will delete org 'my-org' with N projects, N members, N agents. Type org slug to confirm:"
```

**Cascade sequence:**

1. Delete all projects (Phase 2's delete, which undeploys all envs)
2. Remove org memberships, access groups, role bindings
3. Clean up org-scoped records: agents, teams, integrations, chat routes, fs objects, documents, secrets
4. Soft-delete org (`deleted_at`) — or hard-delete with `--hard`

**Soft delete** sets `deleted_at` and makes the org invisible in listings. Hard delete physically removes the record (all children already CASCADE'd).

### Files to Change

| File | Change |
|------|--------|
| `apps/api/src/orgs/orgs.controller.ts` | Add `DELETE /:org_id` endpoint |
| `apps/api/src/orgs/orgs.service.ts` | Add `delete()` with cascade through projects |
| `packages/cli/src/commands/org.ts` | Add `delete` subcommand |

---

## Phase 4: Resource Cleanup (Builds, Releases, Agents, Threads)

**The gap**: Historical records accumulate forever. No pruning.

### Design

Add delete commands for individual resources and bulk cleanup:

**Individual deletes:**

```bash
eve build delete <build-id>              # Delete build spec + all runs/artifacts
eve release delete <tag> [--project=]    # Delete release record
eve agent delete <slug> [--project=]     # Delete agent config + routes
eve team delete <slug> [--project=]      # Delete team + routes
eve thread delete <id>                   # Delete thread + messages
eve pipeline delete <name> [--project=]  # Delete pipeline def + run history
```

**Bulk prune (keep last N):**

```bash
eve build prune [--keep=10] [--project=]    # Delete old build runs, keep latest N
eve release prune [--keep=5] [--project=]   # Delete old releases, keep latest N
```

### API Endpoints

| Endpoint | Method | Permission |
|----------|--------|------------|
| `/projects/{id}/envs/{name}/undeploy` | POST | `envs:admin` |
| `/projects/{id}/builds/{build_id}` | DELETE | `builds:admin` |
| `/projects/{id}/releases/{tag}` | DELETE | `releases:admin` |
| `/projects/{id}/agents/{slug}` | DELETE | `agents:admin` |
| `/projects/{id}/teams/{slug}` | DELETE | `agents:admin` |
| `/projects/{id}/threads/{id}` | DELETE | `threads:admin` |
| `/projects/{id}/pipelines/{name}` | DELETE | `pipelines:admin` |
| `/projects/{id}/builds/prune` | POST | `builds:admin` |
| `/projects/{id}/releases/prune` | POST | `releases:admin` |

### Files to Change

| File | Change |
|------|--------|
| `apps/api/src/builds/builds.controller.ts` | Add DELETE + prune endpoints |
| `apps/api/src/builds/builds.service.ts` | Add `delete()`, `prune()` |
| `apps/api/src/releases/releases.controller.ts` | Add DELETE endpoint |
| `apps/api/src/releases/releases.service.ts` | Add `delete()` |
| `apps/api/src/agents/agents.controller.ts` | Add DELETE endpoint |
| `apps/api/src/agents/agents.service.ts` | Add `delete()` |
| `apps/api/src/teams/teams.controller.ts` | Add DELETE endpoint |
| `apps/api/src/threads/threads.controller.ts` | Add DELETE endpoint |
| `apps/api/src/pipelines/pipelines.controller.ts` | Add DELETE endpoint |
| `packages/cli/src/commands/build.ts` | Add `delete`, `prune` subcommands |
| `packages/cli/src/commands/release.ts` | Add `delete`, `prune` subcommands |
| `packages/cli/src/commands/agents.ts` | Add `delete` subcommand |
| `packages/cli/src/commands/thread.ts` | Add `delete` subcommand |
| `packages/cli/src/commands/pipeline.ts` | Add `delete` subcommand |

---

## Implementation Order

| Phase | Priority | Effort | Dependencies |
|-------|----------|--------|--------------|
| Phase 1: Env Undeploy | P1 | Small | None |
| Phase 2: Project Delete | P1 | Medium | Phase 1 (undeploy before delete) |
| Phase 3: Org Delete | P2 | Medium | Phase 2 (delete projects first) |
| Phase 4: Resource Cleanup | P3 | Medium | None (independent) |

Phases 1-2 are the critical user-facing gaps. Phase 3 is needed for multi-tenant hygiene. Phase 4 is operational cleanup.

---

## Verification Plan

### Unit Tests

Each phase adds tests for:
- Service-level delete/undeploy logic
- Cascade behavior (dependent records cleaned up)
- Permission checks (`*:admin` required for destructive ops)
- Force mode (continues on partial failures)
- Idempotency (deleting already-deleted resource returns 404 or 204)
- Confirmation safeguards (production env requires `--danger-delete-production`)

### Integration Tests (`./bin/eh test integration`)

**New test file: `tests/integration/lifecycle/delete-lifecycle.spec.ts`**

```
Scenario: Full create → deploy → undeploy → redeploy → delete lifecycle
  1. Create project + environment
  2. Deploy a release to the environment
  3. Verify environment is accessible
  4. Undeploy → verify K8s resources torn down, env record persists
  5. Redeploy → verify environment comes back
  6. Delete environment → verify record gone
  7. Delete project (hard) → verify all children gone
  8. Verify no orphaned records in DB
```

**New test file: `tests/integration/lifecycle/org-delete.spec.ts`**

```
Scenario: Org cascade delete
  1. Create org with 2 projects, each with environments, agents, builds
  2. Deploy environments
  3. Delete org (hard, force)
  4. Verify all projects, environments, agents, builds removed
  5. Verify K8s namespaces torn down
  6. Verify no orphaned DB records
```

### Local k3d Stack Verification

**New manual test scenario: `tests/manual/scenarios/09-undeploy-and-delete/`**

Run against the local k3d stack to verify real K8s teardown:

```bash
# 0. Verify stack is healthy
./bin/eh status
eve system health --json

# 1. Set up test resources
eve org ensure "delete-test-org" --slug delete-test-org --json
eve project ensure --name "DeleteTest" --slug dtest \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example --branch main

# 2. Deploy an environment
eve env deploy dtest test --tag local
# Wait for deployment
eve env show dtest test --json  # Verify deploy_status = 'deployed'

# 3. Test undeploy (Phase 1)
eve env undeploy test --project dtest
eve env show dtest test --json  # Verify deploy_status = 'undeployed', record exists
kubectl get ns | grep delete-test  # Verify namespace gone

# 4. Test redeploy after undeploy
eve env deploy dtest test --tag local
eve env show dtest test --json  # Verify deploy_status = 'deployed' again

# 5. Test project delete (Phase 2)
eve project delete dtest --hard --force
eve project list --json  # Verify project gone
kubectl get ns | grep delete-test  # Verify all namespaces gone

# 6. Test org delete (Phase 3)
eve org delete delete-test-org --hard --force
eve org list --json  # Verify org gone

# 7. Verify no DB orphans (via API)
# All child records should be CASCADE-deleted
```

**Scenario pass criteria:**
- Environment undeploy tears down K8s namespace but preserves DB record
- Redeploy works after undeploy without recreating environment
- Project hard-delete cascades to all children (envs, jobs, builds, releases, agents)
- Org hard-delete cascades through all projects
- No FK constraint violations during any delete operation
- Force mode allows partial failures (e.g., K8s unreachable) without blocking DB cleanup

---

## Documentation Updates

### eve-horizon-docs (`website/`)

Update the public documentation site:

| File | Change |
|------|--------|
| `website/docs/guides/environments.md` | Add "Undeploying" and "Deleting" sections |
| `website/docs/reference/cli-commands.md` | Add `env undeploy`, `project delete`, `org delete`, `build delete/prune`, `release delete/prune`, `agent delete`, `team delete`, `thread delete`, `pipeline delete` |
| `website/docs/operations/deployment.md` | Add teardown/cleanup procedures |
| `website/docs/operations/troubleshooting.md` | Add "Cleaning up orphaned resources" section |

### eve-skillpacks (`../eve-skillpacks`)

Update the agent-facing reference docs:

| File | Change |
|------|--------|
| `eve-work/eve-read-eve-docs/references/cli.md` | Add all new delete/undeploy/prune commands |
| `eve-work/eve-read-eve-docs/references/deploy-debug.md` | Add undeploy workflow and delete troubleshooting |
| `eve-work/eve-read-eve-docs/references/overview.md` | Update lifecycle diagram to include undeploy → delete |
| `eve-work/eve-read-eve-docs/references/builds-releases.md` | Add build/release delete and prune commands |
| `eve-work/eve-read-eve-docs/references/agents-teams.md` | Add agent/team/thread delete commands |
| `eve-work/eve-read-eve-docs/references/pipelines-workflows.md` | Add pipeline delete command |

### eve-horizon internal docs

| File | Change |
|------|--------|
| `docs/system/deployment.md` | Add undeploy flow, deploy_status field |
| `docs/system/environments.md` | Document env lifecycle states |
| `CLAUDE.md` | Update "Current State" to note delete lifecycle completion |

---

## Security Considerations

1. **Permission escalation**: Soft-delete actions use resource-level `*:admin` scopes. Hard/project delete requires org admin scope; org hard-delete requires `system_admin`.
2. **Confirmation gates**: Production environments require `--danger-delete-production`. Org delete requires typing the slug to confirm.
3. **Audit trail**: Soft-delete preserves records for audit. Hard-delete is irreversible — log the operation to events table before executing.
4. **Force mode safety**: Force continues past failures but still respects permission checks. It does NOT bypass confirmation.
5. **Managed DB teardown**: Environment undeploy does NOT destroy managed databases (they persist independently). Only env delete triggers DB tenant cleanup.

---

## Open Questions

1. **Should undeploy also remove managed DB tenants?** Current design says no — databases persist independently. But should there be an `--include-db` flag?
2. **Soft-delete recovery window**: Should soft-deleted projects/orgs auto-purge after N days? Or require explicit `--hard` forever?
3. **Build artifact cleanup**: Deleting build records doesn't remove images from the container registry (GHCR). Should we add registry cleanup too?
4. **Job history**: When a project is deleted, should completed job logs be preserved in an archive, or deleted with everything else?
