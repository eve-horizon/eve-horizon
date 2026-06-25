# Job-Token Path & Mount Scope Plan

> **Status**: Implemented and verified on local k3d (2026-05-11)
> **Filed**: 2026-05-11
> **Reviewed**: 2026-05-11 — source-backed corrections applied
> **Tracking**: `eve-horizon-xew1`
> **Scope**: Platform (eve-horizon) — auth, orchestrator, worker, agent-runtime, cloud-fs, workflows
> **Source**: External gap report ("Job tokens should carry path/mount scope, not just permission names"), verified against current `main`
> **Related**:
> - `docs/plans/workflow-env-overrides-plan.md` (precedent for workflow/step → child job propagation)
> - `docs/plans/agent-job-token-plan.md`
> - `docs/plans/agent-permissions-plan.md`
> - `docs/plans/unified-permissions-plan.md`

## Problem

The org filesystem already has a half-implemented per-job scope mechanism, but the **API authority** of the job token does not match the **on-disk view** it gets. Cross-project isolation in a single org is therefore convention, not enforcement.

### What works today

- `LoopService.deriveOrgFsMountContext(...)` (`apps/orchestrator/src/loop/loop.service.ts:284`) reduces a user's effective access bindings into an `OrgFsMountContext` with `allow_prefixes` / `read_only_prefixes`.
- `LoopService.resolveOrgFsMountContext(...)` (`apps/orchestrator/src/loop/loop.service.ts:3197`) calls `accessRoleQueries.listApplicableBindings(...)` for the **actor user** and feeds the result through `deriveOrgFsMountContext`.
- The result is attached to the invocation as `data.orgfs_mount` (`loop.service.ts:1933`).
- Both invoke paths (`apps/worker/src/invoke/invoke.service.ts:1126` and `apps/agent-runtime/src/invoke/invoke.service.ts:351`) call `materializeScopedOrgFsMount(...)` (`packages/shared/src/org-fs/org-fs-mount.ts:170`), which lays down a `<workspace>/.org` tree where allow-prefixes are symlinks back into `EVE_ORG_FS_ROOT` and read-only prefixes are copied with `chmod -w`.
- API endpoints on the org-fs and org-docs surfaces (`apps/api/src/org-fs-sync/org-fs-sync.controller.ts:144+`, `apps/api/src/org-documents/org-documents.controller.ts:102+`) call `ScopedAccessService.assert({ ..., resource: { type: 'orgfs' | 'orgdocs', id, action } })` so that **non-job** callers go through `AccessService.evaluatePrefixScope` (`apps/api/src/auth/access.service.ts:782`).

### Gap 1 — Job tokens have no `scope` claim

`mintJobToken` (`apps/api/src/auth/auth.service.ts:953`) signs only:

```ts
{ sub, user_id, org_id, project_id, job_id, permissions, agent_slug?, email?, exp, iat, type: 'job' }
```

No `scope` claim, and the internal mint endpoint (`apps/api/src/auth/auth.internal.controller.ts:45`) does not accept one. `verifyJobToken` (`auth.service.ts:992`) and `resolveJobTokenAuth` (`auth.service.ts:420`) do not surface one onto `AuthUser`.

### Gap 2 — `ScopedAccessService.can` short-circuits job tokens

`apps/api/src/auth/scoped-access.service.ts:34`:

```ts
if (params.user?.is_job_token && params.user.permissions) {
  return params.user.permissions.includes(params.permission);
}
```

Even when an org-fs / org-docs controller passes a `resource: { type: 'orgfs', id: '/groups/projects/project-B/secrets.yaml', action: 'write' }`, the check never reaches `AccessService.evaluatePrefixScope`. The job token's resource access is permission-name only.

Concretely, a `project-A` workflow step whose token has `orgfs:write` can today call:

```
POST /orgs/<org_id>/fs/upload?path=/groups/projects/project-B/secrets.yaml
```

and succeed, even though `materializeScopedOrgFsMount` would have refused to symlink `project-B` into its workspace.

### Gap 3 — There is no first-class per-job intended scope

`BUILT_IN_ROLE_SCOPE` (`apps/api/src/auth/access.service.ts:666`):

```ts
private static readonly BUILT_IN_ROLE_SCOPE: AccessBindingScope = {
  envdb:  { schemas: ['*'], tables: ['*'] },
  orgfs:  { allow_prefixes: ['*'] },
  orgdocs:{ allow_prefixes: ['*'] },
};
```

The API evaluator's non-job path expands built-in org/project roles through `collectUserGrants(...)` and gives owner/admin/member wildcard `orgfs` / `orgdocs` scope. That is correct for ordinary interactive callers.

The orchestrator mount path is different: `resolveOrgFsMountContext` calls `listApplicableBindings` for the **actor user**, and `listApplicableBindings` returns custom access-binding grants — not membership grants. Today that means:

- a member/admin with no custom access bindings gets `NO_ORG_FS_MOUNT`, so nothing is mounted even though their API permissions may allow broad orgfs/orgdocs access;
- a user with a custom binding scoped to `allow_prefixes: ['*']` gets the full org mounted;
- no workflow step can say "this job is for `project-A` — narrow the mount and token to `/groups/projects/project-A/**` even if the actor could see more."

The gap is therefore not just wildcard role scope. It is the absence of a persisted, first-class **intended job scope** that both the workspace mount and the API token enforce.

### Gap 4 — `cloud_fs:*` is flat — no resource-type scope

- `permissionResourceType` (`apps/api/src/auth/access.service.ts:931`) only registers `orgfs:`, `orgdocs:`, `envdb:`.
- `AccessBindingScopeSchema` (`packages/shared/src/schemas/auth.ts:431`) has `orgfs` / `orgdocs` / `envdb` axes — no `cloud_fs`.
- `cloud_fs:*` (catalog at `packages/shared/src/permissions.ts:43`) is included in the `member` baseline (`cloud_fs:read`) and `admin` extra (`cloud_fs:write`, `cloud_fs:admin`) (`apps/api/src/auth/permissions.ts:39,61`).
- `CloudFsController` (`apps/api/src/cloud-fs/cloud-fs.controller.ts:33+`) gates by `@RequirePermission('cloud_fs:read' | 'cloud_fs:admin')` only — no `ScopedAccessService` call, no per-mount resource passed to the evaluator.
- The `cloud_fs_mounts` table (`packages/db/migrations/00082_cloud_fs_mounts.sql`) carries `project_id TEXT REFERENCES projects(id)`. The relationship a workflow needs (this job's `project_id` ↔ this mount's `project_id`) already exists in the data model — only the policy doesn't know about it.

Net effect: a token with `cloud_fs:read` can browse / search / download from **any mount in the org**, regardless of the mount's `project_id`. For an org that mounts one provider folder per business project, this is wide-open.

### Workarounds callers fall back to today

Three, all worse than fixing the platform:

1. **Per-project Eve project.** Strongest isolation; cost is a project-ID explosion (tens to hundreds of Eve projects per org) and operator workflows that "switch project" instead of "switch context within a project."
2. **CLI shims around `eve fs`, `eve docs`, `eve cloud-fs`.** Refuse paths outside the job's project prefix; restrict the agent's bash to those wrappers. Per-primitive overhead, and one `curl` against the API with `$EVE_JOB_TOKEN` defeats it. The token, not a wrapper, must be the authority.
3. **Per-project service principal.** Mint an `sp_*` per business project with scoped `orgfs` bindings; run jobs as that principal. Closer to right but: manual provisioning per project, loses actor-user audit trail, and `cloud_fs:*` is still flat.

## Goal

Make the **token claim** match the **on-disk mount** so per-job isolation is enforced at the API boundary, not at the filesystem boundary alone. Specifically:

1. Job tokens carry an explicit, optional `scope` claim — same shape as `AccessBindingScope`.
2. `ScopedAccessService.can` evaluates that scope against resource context for job tokens, using the existing `evaluatePrefixScope` / `evaluateEnvDbScope` / a new `evaluateCloudFsScope`.
3. The workflow invocation path persists a **per-job intended scope** from the workflow declaration, narrowed by the actor's effective authorization, and the orchestrator threads that persisted scope into both:
   - `data.orgfs_mount` (already wired) — drives `materializeScopedOrgFsMount`.
   - `mintJobToken({ ..., scope })` — drives `ScopedAccessService` at the API.
4. A new `cloud_fs` axis on `AccessBindingScope` carries `allow_mount_ids` (and matches by `project_id` for workflow-derived scope), so a job's `eve cloud-fs *` calls are confined to its mount(s).
5. Workflow and step YAML grow a `scope:` field (same shape) so the manifest is the source of truth for per-step isolation. Invocation requests may narrow but not widen.

## Non-Goals

- New permissions. The permission catalogue (`packages/shared/src/permissions.ts`) is untouched. Only `AccessBindingScope` and the evaluator gain a new axis.
- Re-architecting access groups. Group bindings continue to compose as today.
- Mounting *cloud-FS* into the workspace `.org` tree. Cloud FS stays an API-surface call; only `orgfs` is materialized on disk.
- Templating `scope` from workflow inputs (e.g. `scope.orgfs.allow_prefixes: ['/groups/projects/${inputs.project}/**']`). Out of scope here — file separately if needed. The first cut takes literal prefixes/mount-ids.
- An `eve job explain-scope` / dry-run endpoint. Useful, but follow-up.
- Adding the actor-user "upper bound" check for service-principal-launched workflows. Recommended (see Open Questions); behind a flag if controversial.
- Backfilling existing in-flight tokens. New tokens get a scope claim; old ones fall through to today's behavior.

## Implementation Plan

Eight phases. Phases 1–3 plus the required Phase 7 persistence close the orgfs/orgdocs gap end-to-end. Phases 4–5 extend the same model to `cloud_fs`. Phase 6 adds the manifest/invocation surface. Phase 8 documents shipped behavior.

**Ordering correction**: the `jobs.token_scope` persistence work in Phase 7 must land before any workflow/orchestrator code relies on a resolved scope surviving dispatch, retries, or delayed execution. In PR terms, include the nullable column and job query/schema plumbing in the first orgfs/orgdocs PR, then layer parsing and orchestration on top of it.

### Phase 1 — `scope` claim on job tokens

**Files**

- `apps/api/src/auth/auth.service.ts` — `mintJobToken`, `verifyJobToken`, `JobTokenPayload`, `AuthUser`, `resolveJobTokenAuth`
- `apps/api/src/auth/auth.internal.controller.ts` — `POST /internal/auth/mint-job-token`
- `packages/shared/src/api-client/auth-client.ts` — `mintJobToken` REST wrapper
- `packages/shared/src/invoke/eve-credentials.ts` — `resolveInvocationJobToken` already takes `permissions?`; extend signature to take `scope?`
- `apps/api/src/auth/auth.controller.spec.ts` — `/auth/me` payload (job token)
- New unit tests: `auth.service.job-token.spec.ts`

**Changes**

1. Extend `JobTokenPayload` (`auth.service.ts:107`):
   ```ts
   export interface JobTokenPayload {
     // ...existing...
     scope?: AccessBindingScope;
   }
   ```
2. Extend `mintJobToken` (`auth.service.ts:953`) to accept and sign `scope`:
   ```ts
   mintJobToken(params: {
     userId; orgId; projectId; jobId;
     permissions: string[];
     scope?: AccessBindingScope;
     ttlSeconds?; agentSlug?;
   }): string
   ```
   Include the scope in the JWT payload only if non-empty.
3. Extend `verifyJobToken` to round-trip `scope` (validate against `AccessBindingScopeSchema` — fail closed if malformed).
4. Extend `AuthUser` (`auth.service.ts:73-105`) with `scope?: AccessBindingScope` and surface it in `resolveJobTokenAuth` (`auth.service.ts:420`).
5. Update `AuthInternalController.mintJobToken` (`auth.internal.controller.ts:45`) to accept an optional `scope` in the request body, validated by `AccessBindingScopeSchema`.
   - Keep the existing `scopes?: string[]` legacy alias for permission names. Use singular `scope?: AccessBindingScope` for the new resource scope claim to avoid colliding with that legacy field.
6. Update the shared REST wrapper `mintJobToken` (`packages/shared/src/api-client/auth-client.ts:93`) to forward `scope`.
7. Extend `resolveInvocationJobToken` / `writeEveCredentials` (`packages/shared/src/invoke/eve-credentials.ts`) to thread `scope` through to the mint call. Add a small `getInvocationJobScope(invocation)` helper that reads `invocation.data.__eve_job_scope`, validates it with `AccessBindingScopeSchema`, and fails closed (no mint) on malformed data.
8. Snapshot tests proving:
   - A scope-less mint produces the same token shape as today (back-compat).
   - A mint with `scope: { orgfs: { allow_prefixes: ['/groups/projects/project-A/**'] } }` round-trips through verify.
   - Malformed scope is rejected by mint and verify.

### Phase 2 — `ScopedAccessService.can` honours the job-token scope

**Files**

- `apps/api/src/auth/scoped-access.service.ts`
- `apps/api/src/auth/access.service.ts` — export a thin `evaluateScope` entry point usable from `ScopedAccessService` (currently private)
- `apps/api/src/auth/scoped-access.service.spec.ts`

**Changes**

1. Promote `AccessService.evaluateScope` to a public method (or add a public façade), since `ScopedAccessService` now needs to evaluate scope without going through the full grant-collection path.
2. Replace the short-circuit at `scoped-access.service.ts:34`:
   ```ts
   if (params.user?.is_job_token && params.user.permissions) {
     if (!params.user.permissions.includes(params.permission)) {
       return false;
     }
     // Backwards compatibility: old job tokens without a scope claim keep
     // today's permission-name-only behavior.
     if (!params.user.scope) {
       return true;
     }
     const scopeEval = this.accessService.evaluateScope(
       params.user.scope,
       params.permission,
       params.resource,
     );
     return !scopeEval.scope_required || scopeEval.scope_matched;
   }
   ```
3. **Backwards-compat rule**: when `params.user.scope` is `undefined`, fall through to today's permission-only behavior. Only tokens minted with `scope` are downscoped.
4. Tests:
   - Job token with `permissions: ['orgfs:write']` and **no** `scope` allows a write to `/groups/projects/project-B/...` (today's behavior preserved).
   - Job token with `permissions: ['orgfs:write']` and `scope: { orgfs: { allow_prefixes: ['/groups/projects/project-A/**'] } }` allows write to `/groups/projects/project-A/foo` and **denies** write to `/groups/projects/project-B/foo`.
   - Same for `orgdocs`.
   - Non-resource permissions still allow the call when the permission name matches (e.g. `jobs:read`).

### Phase 3 — Orchestrator declares per-job scope; mount + token agree

**Files**

- `apps/orchestrator/src/loop/loop.service.ts` — `resolveOrgFsMountContext`, dispatch path
- `packages/shared/src/api-client/auth-client.ts` — already updated in Phase 1
- `apps/agent-runtime/src/invoke/invoke.service.ts` and `apps/worker/src/invoke/invoke.service.ts` — these call `writeEveCredentials` via shared `eve-credentials.ts`; minimal change here
- New unit tests on `LoopService` scope derivation

**Changes**

1. Where invocation is built (`loop.service.ts:1933`), derive `data.orgfs_mount` and `data.__eve_job_scope` from the persisted `job.token_scope` when present. Do not make workflow parsing a responsibility of the orchestrator dispatch loop. Concretely:
   ```ts
   const { orgfsMount, tokenScope } = await this.resolveJobScope(job, project.org_id);
   invocationData.orgfs_mount = orgfsMount;
   if (tokenScope) invocationData.__eve_job_scope = tokenScope; // forwarded to mintJobToken
   ```
2. `resolveJobScope` does two things:
   - Reads the persisted `job.token_scope` when present. This is the workflow invocation path's intended scope.
   - Falls back to today's `resolveOrgFsMountContext` only when `job.token_scope` is null, preserving existing unscoped behavior.
   - The workflow invocation path, not the orchestrator, computes the upper-bound intersection before persisting `job.token_scope`. If the actor is a service principal, use the same subset check unless an explicit configuration flag is added (Open Question — see below).
3. The shared `writeEveCredentials` path (`packages/shared/src/invoke/eve-credentials.ts`) already mints the token at spawn time using `data.__eve_job_token` if set, otherwise calling `/internal/auth/mint-job-token`. Extend the spawn-time mint call to pass `scope` derived from `invocation.data.__eve_job_scope`.
4. Audit emit: when scope is set on a token, log a one-line `job.token.scope` event with the prefixes/mount-ids granted, so we can verify in `eve job diagnose`.
5. Tests:
   - Member-with-no-bindings actor + a workflow declaring `scope.orgfs.allow_prefixes: ['/groups/projects/project-A/**']`: today produces `NO_ORG_FS_MOUNT` (effectively empty); with this change, produces the workflow-declared scope (because the actor's *membership* expansion already permits `orgfs:write` — see Open Questions on whether we use the **membership** or the **bindings** as the upper bound).
   - Admin actor + workflow scope `['/groups/projects/project-A/**']`: per-job scope is exactly that, not `['*']`.
   - No workflow scope declared: behaviour unchanged from today.

### Phase 4 — `cloud_fs` axis on `AccessBindingScope` + evaluator

**Files**

- `packages/shared/src/schemas/auth.ts` — `AccessScopeCloudFsSchema`, `AccessBindingScopeSchema`
- `apps/api/src/auth/access.service.ts` — `permissionResourceType`, new `evaluateCloudFsScope`, `AccessResourceType`
- `apps/api/src/auth/access.service.ts` — `BUILT_IN_ROLE_SCOPE` gains `cloud_fs: { allow_mount_ids: ['*'] }` so existing owner/admin/member behavior is unchanged.
- `apps/api/src/cloud-fs/cloud-fs.controller.ts` — adopt `ScopedAccessService.assert({ resource: { type: 'cloud_fs', id: mountId, action } })` on all per-mount routes
- `apps/api/src/cloud-fs/cloud-fs.module.ts` — import `AuthModule` (or otherwise provide `ScopedAccessService` via the existing auth module export)
- `apps/api/src/cloud-fs/cloud-fs.service.ts` — `listMounts`, `browse`, and `search` need scoped-mount selection/filtering so a scoped caller sees only mounts in `allow_mount_ids` (return `[]` for list rather than 403; for optional-mount `browse`/`search`, choose the first allowed mount rather than the first org-level mount).
- `apps/api/src/auth/scoped-access.service.ts` — extend `ScopedResourceContext.type` to include `'cloud_fs'`
- Tests: `access.service.cloud-fs-scope.spec.ts`, controller tests for forbidden-when-scoped, list-filtered-when-scoped.

**Schema delta**:

```ts
// packages/shared/src/schemas/auth.ts
export const AccessScopeCloudFsSchema = z.object({
  allow_mount_ids: z.array(z.string()).optional(),
}).strict();

export const AccessBindingScopeSchema = z.object({
  orgfs: AccessScopePrefixesSchema.optional(),
  orgdocs: AccessScopePrefixesSchema.optional(),
  envdb: AccessScopeEnvDbSchema.optional(),
  cloud_fs: AccessScopeCloudFsSchema.optional(),
}).strict();
```

**Evaluator**:

```ts
private evaluateCloudFsScope(
  scope: AccessBindingScope['cloud_fs'] | undefined,
  resource?: AccessResourceContext,
): ScopeEvaluation {
  const allow = scope?.allow_mount_ids ?? [];
  if (allow.length === 0) {
    return { scope_required: true, scope_matched: false, reason: 'missing cloud_fs.allow_mount_ids' };
  }
  if (!resource) {
    return { scope_required: true, scope_matched: true, reason: 'cloud_fs scope present' };
  }
  if (resource.type !== 'cloud_fs') {
    return { scope_required: true, scope_matched: false, reason: `resource type ${resource.type} does not match cloud_fs` };
  }
  if (allow.includes('*') || allow.includes(resource.id)) {
    return { scope_required: true, scope_matched: true, reason: `mount ${resource.id} in cloud_fs scope` };
  }
  return { scope_required: true, scope_matched: false, reason: `mount ${resource.id} outside cloud_fs scope` };
}
```

**Controller adoption** — inject `@Req() request: { user?: AuthUser }` anywhere the controller calls `ScopedAccessService.assert`. Every route with `:mount_id` in its path passes `resource: { type: 'cloud_fs', id: mountId, action: 'read' | 'write' | 'admin' }`.

The current controller uses `cloud_fs:admin` for mount create/update/delete plus upload/folder creation, and `cloud_fs:read` for browse/get/download/search. Preserve those permission strings in this plan; changing upload/folder creation to `cloud_fs:write` is a separate permission semantics cleanup. The resource action can still be `write`/`admin` for diagnostics, but the permission string must match the existing decorator unless this plan explicitly broadens scope.

The `GET /orgs/:org_id/cloud-fs/mounts` list route filters server-side to the allowed set (or returns the full set when no scope is present) — same pattern as `org-fs-sync.controller.ts:208-238` does for `orgfs` link listing. The optional-mount `GET /browse` and `GET /search` routes must not default to an out-of-scope org mount for scoped job tokens; when `mount_id` is omitted, resolve the first allowed mount or return 404/403 consistently.

**BUILT_IN_ROLE_SCOPE** — add `cloud_fs: { allow_mount_ids: ['*'] }` so org owner/admin/member keep wide-open access. Existing behavior preserved by default.

### Phase 5 — Job tokens carry `cloud_fs` scope when the job has a project

**Files**

- `apps/orchestrator/src/loop/loop.service.ts` — `resolveOrgFsScope` becomes `resolveJobScope` and returns `{ orgfsMount, tokenScope }` where `tokenScope` is the full `AccessBindingScope`
- `apps/api/src/cloud-fs/cloud-fs.service.ts` — service helper to list `cloud_fs_mounts` ids for a given `(org_id, project_id)`

**Changes**

1. Default behavior: a job for `project_id = proj_xxx` gets `tokenScope.cloud_fs.allow_mount_ids = <mount IDs where cloud_fs_mounts.project_id = proj_xxx OR cloud_fs_mounts.project_id IS NULL (org-level mounts)>`.
   - The DB helper already exists as `cloudFsMountQueries.listByProject(orgId, projectId)`; add an API/orchestrator-facing service wrapper only if injecting the DB query directly would cross module boundaries awkwardly.
2. Workflow-declared `scope.cloud_fs.allow_mount_ids` (Phase 6) overrides the default; invocation requests may narrow further.
3. When `tokenScope.cloud_fs` is set, it appears in the JWT and `ScopedAccessService` enforces it.

This is the minimum mechanism to confine an agent to its project's mount(s) without per-project service principals.

### Phase 6 — Manifest surface: `workflow.scope` / `workflow.step.scope`

**Files**

- `packages/shared/src/schemas/workflow.ts` — extend `WorkflowInvokeRequestSchema` with `scope?: AccessBindingScopeSchema`
- `packages/shared/src/schemas/pipeline.ts` — extend `PipelineDefinitionSchema` and `PipelineStepSchema` with `scope?: AccessBindingScopeSchema`
- `apps/api/src/workflows/workflows.service.ts` — analogue of `parseEnvOverrides` / `mergeStepEnvOverrides` for `scope`. Merge semantics: **intersect**, not union.
- `apps/api/src/workflows/workflows.controller.ts` — permission gate for request-supplied scope (see below)
- Step job persistence — persist the resolved per-step scope onto `jobs.token_scope` (Phase 7; include this before or with Phase 6) so the orchestrator can read it back at dispatch time without re-parsing the workflow.

**Merge semantics**

- For `orgfs` / `orgdocs`: intersect prefixes (path-pattern intersection — only keep prefixes that match both workflow and step layers). If the intersection is empty, the step's scope is empty and the job will mount nothing / call no orgfs APIs — fail closed.
- For `cloud_fs.allow_mount_ids`: set intersection.
- For `envdb`: intersect schemas/tables.
- Invocation request may narrow but never widen — reject a request whose scope is not a subset of the merged workflow/step scope.

**Permission gate for request-supplied scope**

- Mirror `workflow-env-overrides-plan.md`: request-supplied `scope` requires `jobs:harness_override` (or equivalent — bikeshed before shipping; see Open Questions). Without this, any caller could narrow scope arbitrarily and confuse the workflow's intent. Narrowing is generally safe, but we treat it as a privileged operation for symmetry.
- Manifest-declared `scope` is validated at sync time and persisted on the workflow definition; no new permission required beyond `projects:write`.

### Phase 7 — Persistence & propagation through retries

**Files**

- `packages/db/migrations/00096_jobs_token_scope.sql` (new if no newer migration has appeared) — `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS token_scope JSONB`. Comment: "Per-job token scope claim; null = no narrowing (today's behavior)."
- `packages/db/src/queries/jobs.ts` — persist/read `token_scope`
- `packages/shared/src/schemas/job.ts` — extend `JobResponseSchema`
- `apps/api/src/workflows/workflows.service.ts` — set `token_scope` on step jobs; retry already copies columns from source — extend it
- `apps/orchestrator/src/loop/loop.service.ts` — read `job.token_scope` at dispatch and pass to `mintJobToken`

**Important**: do not store `token_scope` only in `hints`. Hints are intentionally loose scheduling metadata; the token scope is an authorization input and needs a typed schema path, explicit DB column, retry copy, API response visibility, and diagnostics.

**Retry semantics**: `workflow retry --failed` and `--from-step` copy `token_scope` verbatim from the source step job. Same precedent as `env_overrides` (`workflow-env-overrides-plan.md` Phase 3).

### Phase 8 — Documentation

- `docs/system/auth.md` — describe `AccessBindingScope.cloud_fs` and the job-token `scope` claim
- `docs/system/pipelines.md` and `docs/system/manifest.md` — workflow `scope` block grammar
- `docs/system/job-cli.md` — note that `eve workflow run --scope-mount=<id>` is **not** in scope yet (file separately)
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/manifest.md`
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/secrets-auth.md`
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/pipelines-workflows.md`

Do not update skillpack docs before behavior ships.

## Acceptance Criteria

The implementation is shippable when:

- A workflow YAML declaring per-step `scope.orgfs.allow_prefixes: ['/groups/projects/project-A/**']` produces step jobs whose persisted `token_scope` reflects that.
- A job token minted for such a step carries `scope.orgfs.allow_prefixes: ['/groups/projects/project-A/**']` in the JWT.
- `POST /orgs/:org_id/fs/upload?path=/groups/projects/project-B/x.yaml` with that token returns **403 `resource_access_denied`** (today: 200/201).
- `POST /orgs/:org_id/fs/upload?path=/groups/projects/project-A/x.yaml` with the same token still succeeds.
- The on-disk `.org` tree mounted by `materializeScopedOrgFsMount` contains only the scoped subtree.
- Same end-to-end for `orgdocs:read/write` against `POST /orgs/:org_id/docs`.
- `cloud_fs:*` calls against a mount-id outside the job's `scope.cloud_fs.allow_mount_ids` return 403; mount listing returns only allowed mounts.
- A job token minted **without** a `scope` claim behaves exactly as it does today (backwards-compat).
- `eve workflow retry --failed` on a scoped workflow reproduces the same scope on retry jobs.
- `eve manifest validate` rejects unsupported scope shapes (e.g. `scope.cloud_fs.allow_mount_ids: '*'` written as a string instead of array).
- `eve job diagnose <id>` includes the resolved `token_scope` (redaction not required — it's not secret).
- `cloud_fs_mounts.project_id` continues to be optional (org-level mounts still work; jobs whose `token_scope.cloud_fs` includes org-level mount IDs can access them).
- `eve access explain --user <id> --permission orgfs:write --resource /groups/projects/project-A/x.yaml` continues to work for non-job-token users; the job-token scope path is documented separately.

## Test Plan

### Unit

- `AccessBindingScopeSchema` accepts/rejects the new `cloud_fs` axis (Phase 4).
- `evaluateCloudFsScope` covers: empty allow list, wildcard, exact match, miss, type mismatch.
- `mintJobToken`/`verifyJobToken` round-trip `scope` (Phase 1).
- `ScopedAccessService.can` for `is_job_token` covers: no scope (today's behavior), `orgfs` allow-prefix match/miss, `orgdocs` allow-prefix match/miss, `cloud_fs` allow-mount-ids match/miss, `envdb` scope match/miss, non-resource permission (e.g. `jobs:read`) ignores scope.
- Workflow-step `scope` parsing + merge (intersect) covers: workflow-only, step-only, invocation-only, all three, empty intersection.

### API/service

- `org-fs-sync.controller.ts` write endpoints: job token with scope is denied for out-of-scope paths (new), allowed for in-scope (today preserved).
- `org-documents.controller.ts` write endpoints: same.
- `cloud-fs.controller.ts` browse/upload/download/search: job token with `allow_mount_ids: [mountA]` cannot reach `mountB`; list endpoint returns only `[mountA]`.
- Workflow invoke validates body scope through `ZodValidationPipe`; controller rejects scope that is not a subset of the merged workflow/step scope.
- Workflow retry preserves `token_scope` on retry jobs.
- Internal event-triggered workflow invoke (no actor user) still applies manifest-declared scope.

### Orchestrator/runtime

- Workflow invocation computes `tokenScope = workflow_scope ∩ actor_upper_bound`, persists it on the step job, and the orchestrator consumes that persisted value at dispatch.
- The same scope flows into `data.orgfs_mount` (mount narrowing) and `mintJobToken({ scope })` (API narrowing). A diff test verifies they are derived from one object.
- A scope-bearing token passed via `EVE_JOB_TOKEN` reaches the API and is enforced.

### CLI / manual

- `tests/manual/scenarios/43-job-token-scope.md` (new):
  1. Two projects in one org (`proj_a`, `proj_b`), each with a subtree under `/groups/projects/<slug>/`.
  2. Run a workflow on `proj_a` that includes a step with `scope.orgfs.allow_prefixes: ['/groups/projects/proj-a/**']`.
  3. Inside the step (via `eve api call` or `eve fs upload`), upload to `/groups/projects/proj-a/ok.txt` — **expect 200**.
  4. From the same step, attempt to upload to `/groups/projects/proj-b/x.txt` — **expect 403 `resource_access_denied`**.
  5. Confirm `<workspace>/.org` shows only `proj-a/` symlinked; `proj-b/` is absent.
  6. Cloud-FS version: two mounts (one per project); job token scoped to mount-A cannot browse mount-B.

### Integration

- `./bin/eh test integration` covers the API permission paths.
- A focused integration test exercises `mintJobToken({ scope })` → `verifyJobToken` → controller `assert` end-to-end.

### Verification on local k3d

- 2026-05-11 local k3d verification:
  - `./bin/eh k8s start` started `eve-local`; `kubectl config use-context k3d-eve-local` was required because the active context was not local.
  - `./bin/eh k8s deploy` rebuilt/imported 7 local images, applied the local overlay, ran `eve-db-migrate`, bootstrapped auth, restarted services, and completed all rollouts.
  - `EVE_API_URL=http://api.eve.lvh.me eve system health --json` returned `{"status":"ok","database":"connected",...}` outside the sandbox; direct `curl` to `http://api.eve.lvh.me/health` and `Host: api.eve.lvh.me` also returned HTTP 200.
  - Pods were healthy in namespace `eve`; `eve-db-migrate-*` and `auth-db-bootstrap-*` were `Completed`.
  - A local smoke workflow `scoped-token-smoke` was synced to project `proj_example` with step scope `orgfs.allow_prefixes: ['/groups/projects/proj-a/**']`.
  - Invoking it created root job `jtsmoke-ad75d494` with `token_scope: null` and step job `jtsmoke-ad75d494.1` with `token_scope: {"orgfs":{"allow_prefixes":["/groups/projects/proj-a/**"]}}`.
  - The step job cancelled because this local stack had no valid LLM harness credentials (`zai`, `claude`, `codex`, `gemini` all missing credentials). That limits the live `.org` workspace mount check, but the persisted job scope path is verified.
  - A scoped job token minted inside the local API pod with `scope.orgfs.allow_prefixes: ['/groups/projects/proj-a/**']` enforced API resource access:
    - allowed read under `/groups/projects/proj-a/ok.txt` reached storage and returned `404 resource_not_found` because the object was absent, not `403`.
    - denied read under `/groups/projects/proj-b/x.txt` returned `403 resource_access_denied`.
    - allowed write under `/groups/projects/proj-a/scope-smoke` reached the org-fs service and returned `404 fs_device_not_found` because the test used a fake device, not `403`.
    - denied write under `/groups/projects/proj-b/scope-smoke` returned `403 resource_access_denied`.
  - Cloud-FS mount-scope behavior is covered by controller/unit tests; no local cloud provider mounts were configured, so the optional manual mount scenario was not run.

## Backwards Compatibility

This is additive:

- `scope` claim is optional on `mintJobToken`. Tokens without it preserve today's permission-name-only behavior.
- `AccessBindingScope.cloud_fs` is optional; `BUILT_IN_ROLE_SCOPE` adds `cloud_fs: { allow_mount_ids: ['*'] }` so owner/admin/member behave identically to today.
- `jobs.token_scope` is a nullable JSONB column; existing rows stay null.
- Workflow YAML without a `scope` block continues to produce jobs with `token_scope: null`.
- `cloud_fs` controller endpoints become resource-aware only when called with a scoped token; user tokens without `cloud_fs` scope continue through the unscoped path.

Risk surfaces:

- **Cloud FS controller now consults `ScopedAccessService`** even for non-scoped callers. Today it gates only on `@RequirePermission(...)`. The change is functionally identical for those callers, but we still need to verify the user-token path explicitly. Cover with controller-level tests.
- **Built-in role scope** gains a `cloud_fs` field. Tests must confirm owners/admins/members keep wide access.

## Estimated Size

Suggested PR split:

1. **Phases 1–3 plus minimal Phase 7 persistence (orgfs/orgdocs end-to-end).** Schema + auth.service + scoped-access.service + `jobs.token_scope` plumbing + orchestrator + tests. Largest piece because it touches the critical token path. Ship this alone and the gap is closed for `orgfs`/`orgdocs`.
2. **Phase 4 (cloud_fs evaluator + controller adoption).** Self-contained; depends on (1).
3. **Phase 5 (orchestrator default cloud_fs scope from project_id).** Depends on (2).
4. **Phase 6 (workflow manifest surface).** Depends on (1)–(5). Same shape as `workflow-env-overrides-plan.md` Phase 3; uses the persistence already added in (1).
5. **Phase 8 (docs).** Last.

Total expected size: medium-to-large. Each split is independently shippable and testable.

## Impact If Filled

- Cross-project isolation becomes a platform property, not a convention. Agent prompt drift, prompt injection, or buggy CLI use cannot cross project boundaries.
- A single concurrent-multi-project org no longer needs a per-project Eve project explosion to achieve isolation.
- `materializeScopedOrgFsMount` stops being only-half-the-answer. The on-disk mount and the API authority agree because they are derived from the same scope object.
- Removes the motivation for CLI shims around `eve fs` / `eve cloud-fs` whose only purpose is refusing out-of-scope paths.
- Cloud FS becomes safe for orgs that mount many provider folders — today the choice is "all jobs see every mount" or "one mount per org."
- Foundation for a follow-up `eve job explain-scope` debugging command.

## References

| File | Why |
| --- | --- |
| `apps/api/src/auth/auth.service.ts:953` | `mintJobToken` — add `scope` claim |
| `apps/api/src/auth/auth.service.ts:992` | `verifyJobToken` — round-trip `scope` |
| `apps/api/src/auth/auth.service.ts:107` | `JobTokenPayload` — add `scope?` |
| `apps/api/src/auth/auth.service.ts:73` | `AuthUser` — add `scope?` |
| `apps/api/src/auth/auth.service.ts:420` | `resolveJobTokenAuth` — surface `scope` on `AuthUser` |
| `apps/api/src/auth/auth.internal.controller.ts:45` | `mint-job-token` route — accept `scope` |
| `apps/api/src/auth/scoped-access.service.ts:34` | Short-circuit to replace with scope-aware evaluation |
| `apps/api/src/auth/access.service.ts:666` | `BUILT_IN_ROLE_SCOPE` — add `cloud_fs: { allow_mount_ids: ['*'] }` |
| `apps/api/src/auth/access.service.ts:754` | `evaluateScope` — promote to public or expose façade |
| `apps/api/src/auth/access.service.ts:782` | `evaluatePrefixScope` — already correct |
| `apps/api/src/auth/access.service.ts:931` | `permissionResourceType` — register `cloud_fs:*` |
| `packages/shared/src/schemas/auth.ts:431` | `AccessBindingScopeSchema` — add `cloud_fs` axis |
| `packages/shared/src/permissions.ts:43` | `cloud_fs:*` permission catalogue (no change needed) |
| `apps/api/src/cloud-fs/cloud-fs.controller.ts:22-216` | Adopt `ScopedAccessService` with `resource: { type: 'cloud_fs', id: mountId }` |
| `apps/api/src/cloud-fs/cloud-fs.service.ts:34` | `listMounts` — service-side filter for scoped callers |
| `apps/api/src/cloud-fs/cloud-fs.service.ts:307` | Provider/token resolution unchanged |
| `apps/orchestrator/src/loop/loop.service.ts:284` | `deriveOrgFsMountContext` — reuse for upper-bound |
| `apps/orchestrator/src/loop/loop.service.ts:1933` | Invocation build site — attach `__eve_job_scope` to `invocation.data` |
| `apps/orchestrator/src/loop/loop.service.ts:3197` | `resolveOrgFsMountContext` — extend to also return token scope |
| `apps/worker/src/invoke/invoke.service.ts:1126` | Already calls `materializeScopedOrgFsMount` — no functional change |
| `apps/agent-runtime/src/invoke/invoke.service.ts:351` | Same |
| `packages/shared/src/org-fs/org-fs-mount.ts:170` | `materializeScopedOrgFsMount` — unchanged |
| `packages/shared/src/api-client/auth-client.ts:93` | `mintJobToken` REST wrapper — forward `scope` |
| `packages/shared/src/invoke/eve-credentials.ts:45` | `resolveInvocationJobToken` — accept `scope` |
| `packages/db/migrations/00082_cloud_fs_mounts.sql` | Existing `cloud_fs_mounts.project_id` column (reuse for default scope) |
| `apps/api/src/workflows/workflows.service.ts:533-654` | `parseEnvOverrides` / `mergeStepEnvOverrides` — precedent for `parseScope` / `mergeStepScope` |
| `packages/shared/src/schemas/workflow.ts:24` | `WorkflowInvokeRequestSchema` — add `scope?` |
| `packages/shared/src/schemas/pipeline.ts` | `PipelineDefinitionSchema` / `PipelineStepSchema` — add `scope?` |
| `docs/plans/workflow-env-overrides-plan.md` | Format and propagation precedent |

## Open Questions

1. **Upper-bound source.** Should the workflow invocation path's "actor's effective scope" upper bound be:
   - the actor's **access-binding scope** (what `listApplicableBindings` returns today — narrow), or
   - the actor's **effective permission set including role expansion** (which today implies `['*']` for any org member, defeating the upper bound)?
   - Recommendation: use binding scope when the actor has any custom binding; otherwise fall back to role-derived scope but treat workflow-declared scope as authoritative. Confirm with the eve-horizon team before shipping (3).
2. **Service-principal-launched workflows.** When the actor is a service principal with `orgfs.allow_prefixes: ['*']`, do we still enforce the upper bound? Recommended: yes, with an explicit per-org config flag to allow widening for trusted SPs. Default closed.
3. **Permission for request-supplied scope.** Workflow invoke `scope` narrowing requires `jobs:harness_override`? Or always allowed because narrowing is safe? (`workflow-env-overrides-plan.md` requires the override permission for symmetry with direct jobs.) Recommend matching that precedent.
4. **`eve job explain-scope` / dry-run.** Should we ship a tiny CLI helper that prints the resolved per-job scope without invoking the job? Useful for debugging multi-project workflows; could fold into `eve job diagnose <id>` instead. Out of scope for this plan but worth filing.
5. **Manifest sync validation.** Should `eve manifest validate` walk the `cloud_fs_mounts` table to confirm `scope.cloud_fs.allow_mount_ids` references real mounts? Probably yes when called with `--strict`.
6. **`scope` templating.** First cut takes literal prefixes / mount-ids. Workflow YAML often wants `'/groups/projects/${inputs.project}/**'` — file a follow-up plan rather than coupling templating to this gap.
7. **`cloud_fs` mount-id wildcards.** Do we support `allow_mount_ids: ['proj_a/*']` (all mounts attached to a project)? The data model already carries `cloud_fs_mounts.project_id`, so a `cloud_fs.allow_project_ids` alternative might be cleaner than enumerating mount IDs. Bikeshed before committing.
