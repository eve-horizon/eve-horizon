# Unified Permission Model — Migration Plan

> Status: Draft
> Last Updated: 2026-02-08
>
> Replaces the dual auth model (RBAC roles for users + scopes for job tokens)
> with a single permission-based system. Roles map to permission sets.
> Job tokens carry explicit permissions. One guard, one decorator, one concept.
>
> Supersedes: `docs/plans/agent-job-token-plan.md` (Option B is subsumed here)

---

## Problem

Eve Horizon has three overlapping authorization mechanisms:

1. **RbacGuard + @RequireRole** — checks org/project membership role hierarchy
   (member < admin < owner). Only applies to user tokens. 13 endpoints use it.

2. **ScopeGuard + @RequireScope** — checks explicit scope strings on job tokens
   only. User tokens bypass it entirely. 20 endpoints use it.

3. **No protection** — 116 of 162 public endpoints have no authorization
   beyond authentication. Any bearer token holder can call them.

This creates problems:

- **Two mental models**: developers must understand both role-based and
  scope-based access. Job tokens and user tokens follow different code paths.
- **Inconsistent coverage**: most endpoints have no access control at all.
- **No CLI for role management**: org/project membership is managed through
  API calls or direct DB access. No `eve` CLI primitives for it.
- **No permission visibility**: users and agents can't see what they're
  allowed to do without trial and error.

---

## Design

### Core Concept

Every endpoint declares what **permission** it requires. Permissions are
resolved differently depending on who's calling:

| Caller | How permissions are resolved |
|--------|----------------------------|
| User token (context-bound) | Look up user's role in the target org/project, expand role to permission set |
| User token (context-free) | Use `member` baseline permissions |
| Job token | Explicit `permissions[]` array in the JWT |
| System admin (`is_admin`) | Bypass — all permissions granted |
| Internal service | `@Public()` + `x-eve-internal-token` — unchanged |

### Permission Naming

Convention: `{resource}:{action}`

Actions:

| Action | Semantics | HTTP methods |
|--------|-----------|-------------|
| `read` | View, list, follow, stream, diagnose | GET, SSE |
| `write` | Create, update, submit, deploy, invoke | POST, PATCH, PUT |
| `create` | Create new top-level resources (where create is a lower privilege than update) | POST |
| `admin` | Delete, manage membership, destructive operations | DELETE, ownership ops |

The `create` action exists only for `orgs` and `projects`, where any
authenticated user can create a new one but only admins/owners can update.

### Permission Inventory

```typescript
// ── Jobs ──────────────────────────────────────────────────
'jobs:read'           // list, show, tree, context, deps, attempts, result, wait, logs, stream
'jobs:write'          // create, update, submit, approve, reject, claim, release, add/remove deps
'jobs:admin'          // cancel, delete (future)

// ── Threads ───────────────────────────────────────────────
'threads:read'        // get thread, list messages
'threads:write'       // post message

// ── Projects ──────────────────────────────────────────────
'projects:read'       // list, show, manifest, agents, teams, routes, threads, schedules, releases, APIs
'projects:create'     // create, ensure
'projects:write'      // update, sync manifest, sync agents, create schedule, refresh API
'projects:admin'      // delete (future)

// ── Environments ──────────────────────────────────────────
'envs:read'           // list, show, health, diagnose, logs
'envs:write'          // create, update, deploy
'envs:admin'          // delete

// ── Env DB ────────────────────────────────────────────────
'envdb:read'          // schema, rls, list migrations
'envdb:write'         // sql, migrate

// ── Secrets ───────────────────────────────────────────────
'secrets:read'        // list, show (masked), validate, export
'secrets:write'       // create, update, ensure
'secrets:admin'       // delete

// ── Builds ────────────────────────────────────────────────
'builds:read'         // list specs, show, runs, artifacts, logs
'builds:write'        // create spec, create run, cancel

// ── Pipelines ─────────────────────────────────────────────
'pipelines:read'      // list, show, list runs, show run, logs, stream
'pipelines:write'     // create run, approve, cancel

// ── Workflows ─────────────────────────────────────────────
'workflows:read'      // list, show
'workflows:write'     // invoke

// ── Orgs ──────────────────────────────────────────────────
'orgs:read'           // list, show, list agents
'orgs:create'         // create, ensure
'orgs:write'          // update settings
'orgs:admin'          // add/remove/list members

// ── Integrations ──────────────────────────────────────────
'integrations:read'   // list integrations
'integrations:write'  // connect, test

// ── Events ────────────────────────────────────────────────
'events:read'         // list, show
'events:write'        // create

// ── Chat ──────────────────────────────────────────────────
'chat:write'          // route message, simulate

// ── System ────────────────────────────────────────────────
'system:read'         // status, envs, logs, pods, events, config
'system:admin'        // settings CRUD
```

**Total: 33 permissions.** Simple enough for an agent to reason about,
fine-grained enough to control job tokens properly.

### Role-to-Permission Mapping

```typescript
const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  // ── member ──────────────────────────────────────────────
  // Can read everything in scope. Can work with jobs and threads.
  // Can create new orgs and projects.
  member: [
    'jobs:read',        'jobs:write',
    'threads:read',     'threads:write',
    'projects:read',    'projects:create',
    'orgs:read',        'orgs:create',
    'envs:read',
    'envdb:read',
    'secrets:read',
    'builds:read',
    'pipelines:read',
    'workflows:read',
    'integrations:read',
    'events:read',
  ],

  // ── admin ───────────────────────────────────────────────
  // Everything member can do, plus write/manage operations.
  admin: [
    // ...all member permissions, plus:
    'projects:write',   'projects:admin',
    'envs:write',       'envs:admin',
    'envdb:write',
    'secrets:write',    'secrets:admin',
    'builds:write',
    'pipelines:write',
    'workflows:write',
    'orgs:write',
    'integrations:write',
    'events:write',
    'chat:write',
    'jobs:admin',
  ],

  // ── owner ───────────────────────────────────────────────
  // Everything admin can do, plus org-level management.
  owner: [
    // ...all admin permissions, plus:
    'orgs:admin',
  ],
};
```

Role inheritance is expanded at module init time, not per-request.
`system_admin` (the `is_admin` flag) bypasses all permission checks entirely.

### How Context Resolution Works

The PermissionGuard determines the user's role based on the request context:

```
Request to PATCH /orgs/:org_id
  → extract org_id from route params
  → look up user's role in that org → 'admin'
  → expand 'admin' → [...member perms, ...admin perms]
  → check: 'orgs:write' in expanded set? → yes → pass

Request to POST /orgs (no org_id in route)
  → no context extractable → use 'member' baseline
  → expand 'member' → [...member perms]
  → check: 'orgs:create' in member set? → yes → pass

Request with job token to GET /jobs/:job_id
  → is_job_token = true
  → check: 'jobs:read' in token.permissions? → yes → pass
```

---

## Infrastructure

### New Files

#### `apps/api/src/auth/permissions.ts`

Defines the permission constants, role-to-permission mapping, and the
`expandPermissions(role)` function.

```typescript
export const ROLE_PERMISSIONS = { ... };  // as above

// Expanded at init: admin includes all member perms, etc.
const EXPANDED: Map<string, Set<string>>;

export function expandPermissions(role: string): string[] { ... }
export function allPermissions(): string[] { ... }
```

#### `apps/api/src/auth/permission.decorator.ts`

Single decorator replacing both `@RequireRole` and `@RequireScope`:

```typescript
export const PERMISSION_KEY = 'required_permission';
export const RequirePermission = (...permissions: string[]) =>
  SetMetadata(PERMISSION_KEY, permissions);
```

Multiple permissions use **OR** semantics (any one suffices).

#### `apps/api/src/auth/permission.guard.ts`

Single guard replacing both `RbacGuard` and `ScopeGuard`:

```typescript
@Injectable()
export class PermissionGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Skip if auth disabled, @Public, or system admin
    // 2. Read @RequirePermission from decorator
    // 3. If no decorator: user tokens pass, job tokens blocked
    // 4. Resolve effective permissions:
    //    - Job token: token.permissions[]
    //    - User token + context: role in org/project → expand
    //    - User token, no context: 'member' baseline
    // 5. Check: any required permission in effective set?
  }
}
```

### Modified Files

#### `apps/api/src/auth/rbac.service.ts`

Add two new methods that return the role instead of throwing:

```typescript
async getOrgRole(userId: string, orgId: string): Promise<MembershipRole | null>
async getProjectRole(userId: string, projectId: string): Promise<MembershipRole | null>
```

The existing `requireOrgRole` / `requireProjectRole` methods are kept for
the manual RBAC checks in threads.controller.ts (which will also be migrated).

#### `apps/api/src/auth/auth.service.ts`

- Rename `scopes` to `permissions` in `JobTokenPayload`
- Update `mintJobToken` params: `scopes` → `permissions`
- Update `verifyJobToken` to read `permissions` (with `scopes` fallback)
- Update `resolveJobTokenAuth` to set `permissions` on AuthUser
- Add `permissions?: string[]` to `AuthUser` type (rename from `scopes`)

#### `apps/api/src/auth/auth.module.ts`

- Remove `RbacGuard` and `ScopeGuard` from APP_GUARD
- Add `PermissionGuard` as APP_GUARD
- Register `AuthInternalController`

### Deleted Files

- `apps/api/src/auth/rbac.guard.ts`
- `apps/api/src/auth/rbac.decorator.ts`
- `apps/api/src/auth/scope.guard.ts`
- `apps/api/src/auth/scope.decorator.ts`

---

## CLI Primitives

### `eve auth whoami`

Shows current user identity and effective permissions.

```
$ eve auth whoami
User:    admin@example.com (usr_abc123)
Admin:   yes
Token:   user (expires 2026-02-09T18:00:00Z)

$ eve auth whoami --project my-project
User:    admin@example.com (usr_abc123)
Role:    admin (in project my-project)
Permissions:
  jobs:read, jobs:write, jobs:admin
  threads:read, threads:write
  projects:read, projects:create, projects:write, projects:admin
  envs:read, envs:write, envs:admin
  ... (31 total)
```

For job tokens:

```
$ eve auth whoami
User:    usr_abc123 (job token)
Job:     job_789
Project: proj_456
Permissions:
  jobs:read, jobs:write
  threads:read, threads:write
```

### `eve org members`

Manage org memberships.

```
$ eve org members                          # list members of current org
$ eve org members --org my-org             # list members of specific org
$ eve org members add alice@co.com --role admin
$ eve org members set alice@co.com --role member
$ eve org members remove alice@co.com
```

### `eve project members`

Manage project memberships.

```
$ eve project members                      # list members of current project
$ eve project members --project my-proj    # list members of specific project
$ eve project members add alice@co.com --role admin
$ eve project members set alice@co.com --role member
$ eve project members remove alice@co.com
```

### `eve auth permissions`

List all permissions and which roles grant them.

```
$ eve auth permissions
Permission          member  admin  owner
─────────────────────────────────────────
jobs:read           yes     yes    yes
jobs:write          yes     yes    yes
jobs:admin          -       yes    yes
threads:read        yes     yes    yes
threads:write       yes     yes    yes
projects:read       yes     yes    yes
projects:create     yes     yes    yes
projects:write      -       yes    yes
...
orgs:admin          -       -      yes
system:read         -       -      - (system admin only)
system:admin        -       -      - (system admin only)
```

### API Endpoints for CLI

The CLI commands above require these API endpoints:

| CLI Command | API Endpoint | Permission |
|-------------|-------------|------------|
| `eve org members` | `GET /orgs/:org_id/members` | `orgs:admin` |
| `eve org members add` | `POST /orgs/:org_id/members` | `orgs:admin` |
| `eve org members set` | `PATCH /orgs/:org_id/members/:user_id` | `orgs:admin` |
| `eve org members remove` | `DELETE /orgs/:org_id/members/:user_id` | `orgs:admin` |
| `eve project members` | `GET /projects/:id/members` | `projects:write` |
| `eve project members add` | `POST /projects/:id/members` | `projects:write` |
| `eve project members set` | `PATCH /projects/:id/members/:user_id` | `projects:write` |
| `eve project members remove` | `DELETE /projects/:id/members/:user_id` | `projects:write` |
| `eve auth permissions` | `GET /auth/permissions` | `@Public()` (read-only info) |

Some of these endpoints already exist (`GET/POST /orgs/:org_id/members`).
Others need to be created (`PATCH/DELETE members`, project membership CRUD).

---

## Endpoint Migration

### Endpoints That Stay @Public (unchanged)

| Controller | Endpoint | Reason |
|-----------|----------|--------|
| Health | `GET /`, `GET /version` | Health check |
| Auth | `GET /auth/me`, `GET /bootstrap/status`, `POST /bootstrap`, `POST /challenge`, `POST /verify` | Auth flow |
| Auth Keys | `GET /.well-known/jwks.json` | JWKS |
| Harnesses | `GET /harnesses`, `GET /harnesses/:name` | Public info |
| Webhooks | `POST /integrations/github/events/:id`, `POST /integrations/slack/events/:id` | Webhook receivers |
| Internal | All `/internal/*` endpoints | Internal token auth |

### Full Endpoint → Permission Mapping

#### Jobs Controller

| Endpoint | Permission |
|----------|-----------|
| `POST /projects/:project_id/jobs` | `jobs:write` |
| `GET /projects/:project_id/jobs` | `jobs:read` |
| `GET /projects/:project_id/jobs/ready` | `jobs:read` |
| `GET /projects/:project_id/jobs/blocked` | `jobs:read` |
| `GET /jobs` (cross-project) | `jobs:admin` |
| `GET /jobs/:job_id` | `jobs:read` |
| `PATCH /jobs/:job_id` | `jobs:write` |
| `GET /jobs/:job_id/tree` | `jobs:read` |
| `GET /jobs/:job_id/context` | `jobs:read` |
| `GET /jobs/:job_id/dependencies` | `jobs:read` |
| `POST /jobs/:job_id/dependencies` | `jobs:write` |
| `DELETE /jobs/:job_id/dependencies/:id` | `jobs:write` |
| `POST /jobs/:job_id/claim` | `jobs:write` |
| `POST /jobs/:job_id/release` | `jobs:write` |
| `GET /jobs/:job_id/attempts` | `jobs:read` |
| `GET /jobs/:job_id/result` | `jobs:read` |
| `GET /jobs/:job_id/wait` | `jobs:read` |
| `GET /jobs/:job_id/attempts/:n/logs` | `jobs:read` |
| `GET /jobs/:job_id/attempts/:n/stream` | `jobs:read` |
| `GET /jobs/:job_id/stream` | `jobs:read` |
| `POST /jobs/:job_id/submit` | `jobs:write` |
| `POST /jobs/:job_id/approve` | `jobs:write` |
| `POST /jobs/:job_id/reject` | `jobs:write` |

#### Attempts Controller

| Endpoint | Permission |
|----------|-----------|
| `POST /projects/:id/jobs/:job_id/attempts` | `jobs:write` |
| `GET /projects/:id/jobs/:job_id/attempts` | `jobs:read` |
| `GET /projects/:id/jobs/:job_id/attempts/:n` | `jobs:read` |
| `POST /projects/:id/jobs/:job_id/attempts/:n/continue` | `jobs:write` |
| `GET /projects/:id/jobs/:job_id/attempts/:n/logs` | `jobs:read` |

#### Threads Controller

| Endpoint | Permission |
|----------|-----------|
| `GET /threads/:thread_id` | `threads:read` |
| `POST /threads/:thread_id/messages` | `threads:write` |

Note: Remove the manual `rbacService.requireProjectRole` calls from the
handler methods — the PermissionGuard handles authorization now.

#### Projects Controller

| Endpoint | Permission |
|----------|-----------|
| `POST /projects` | `projects:create` |
| `POST /projects/ensure` | `projects:create` |
| `GET /projects` | `projects:read` |
| `GET /projects/:id` | `projects:read` |
| `PATCH /projects/:id` | `projects:write` |
| `POST /projects/:id/manifest` | `projects:write` |
| `POST /projects/:id/agents/sync` | `projects:write` |
| `GET /projects/:id/manifest` | `projects:read` |
| `POST /projects/:id/manifest/validate` | `projects:read` |
| `GET /projects/:id/agents` | `projects:read` |
| `GET /projects/:id/teams` | `projects:read` |
| `GET /projects/:id/routes` | `projects:read` |
| `GET /projects/:id/threads` | `projects:read` |
| `GET /projects/:id/schedules` | `projects:read` |
| `POST /projects/:id/schedules` | `projects:write` |
| `GET /projects/:id/releases/by-tag/:tag` | `projects:read` |

#### Project APIs Controller

| Endpoint | Permission |
|----------|-----------|
| `GET /projects/:id/apis` | `projects:read` |
| `GET /projects/:id/apis/:name` | `projects:read` |
| `GET /projects/:id/apis/:name/spec` | `projects:read` |
| `POST /projects/:id/apis/:name/refresh` | `projects:write` |

#### Environments Controller

| Endpoint | Permission |
|----------|-----------|
| `POST /projects/:id/envs` | `envs:write` |
| `GET /projects/:id/envs` | `envs:read` |
| `GET /projects/:id/envs/:name` | `envs:read` |
| `PUT /projects/:id/envs/:name` | `envs:write` |
| `DELETE /projects/:id/envs/:name` | `envs:admin` |
| `POST /projects/:id/envs/:name/deploy` | `envs:write` |
| `GET /projects/:id/envs/:name/services/:s/logs` | `envs:read` |
| `GET /projects/:id/envs/:name/health` | `envs:read` |
| `GET /projects/:id/envs/:name/diagnose` | `envs:read` |

#### Env DB Controller

| Endpoint | Permission |
|----------|-----------|
| `GET /projects/:id/envs/:name/db/schema` | `envdb:read` |
| `GET /projects/:id/envs/:name/db/rls` | `envdb:read` |
| `POST /projects/:id/envs/:name/db/sql` | `envdb:write` |
| `POST /projects/:id/envs/:name/migrate` | `envdb:write` |
| `GET /projects/:id/envs/:name/migrations` | `envdb:read` |

Note: Remove the manual job token checks in the env-db controller.
The PermissionGuard handles it now.

#### Secrets Controllers

**Project secrets** (`/projects/:project_id/secrets`):

| Endpoint | Permission |
|----------|-----------|
| `POST /` | `secrets:write` |
| `GET /` | `secrets:read` |
| `GET /:key` | `secrets:read` |
| `PATCH /:key` | `secrets:write` |
| `DELETE /:key` | `secrets:admin` |
| `POST /validate` | `secrets:read` |
| `POST /ensure` | `secrets:write` |
| `POST /export` | `secrets:read` |

**Org secrets** (`/orgs/:org_id/secrets`):

| Endpoint | Permission |
|----------|-----------|
| `POST /` | `secrets:write` |
| `GET /` | `secrets:read` |
| `GET /:key` | `secrets:read` |
| `PATCH /:key` | `secrets:write` |
| `DELETE /:key` | `secrets:admin` |

**System secrets** (`/system/secrets`):

| Endpoint | Permission |
|----------|-----------|
| `POST /` | `system:admin` |
| `GET /` | `system:admin` |
| `GET /:key` | `system:admin` |
| `PATCH /:key` | `system:admin` |
| `DELETE /:key` | `system:admin` |

**User secrets** (`/users/:user_id/secrets`):

These are self-scoped (user can only access their own). Keep as
authenticated-only, no @RequirePermission needed. The service layer
enforces `request.user.user_id === params.user_id`.

#### Builds Controller

| Endpoint | Permission |
|----------|-----------|
| `POST /projects/:id/builds` | `builds:write` |
| `GET /projects/:id/builds` | `builds:read` |
| `GET /builds/:build_id` | `builds:read` |
| `POST /builds/:build_id/runs` | `builds:write` |
| `GET /builds/:build_id/runs` | `builds:read` |
| `GET /builds/:build_id/artifacts` | `builds:read` |
| `GET /builds/:build_id/logs` | `builds:read` |
| `POST /builds/:build_id/cancel` | `builds:write` |

#### Pipelines Controller

| Endpoint | Permission |
|----------|-----------|
| `GET /projects/:id/pipelines` | `pipelines:read` |
| `GET /projects/:id/pipelines/:name` | `pipelines:read` |

#### Pipeline Expander Controller

| Endpoint | Permission |
|----------|-----------|
| `POST /projects/:id/pipelines/:name/runs` | `pipelines:write` |
| `GET /projects/:id/runs/:runId` | `pipelines:read` |
| `GET /projects/:id/runs/:runId/jobs` | `pipelines:read` |

#### Pipeline Runs Controller

| Endpoint | Permission |
|----------|-----------|
| `POST /projects/:id/pipelines/:name/run` | `pipelines:write` |
| `GET /projects/:id/pipelines/:name/runs` | `pipelines:read` |
| `GET /projects/:id/pipelines/:name/runs/:runId` | `pipelines:read` |
| `POST /pipeline-runs/:runId/approve` | `pipelines:write` |
| `POST /pipeline-runs/:runId/cancel` | `pipelines:write` |
| `GET /pipeline-runs/:runId/stream` | `pipelines:read` |
| `GET /pipeline-runs/:runId/steps/:name/stream` | `pipelines:read` |
| `GET /pipeline-runs/:runId/logs` | `pipelines:read` |

#### Workflows Controller

| Endpoint | Permission |
|----------|-----------|
| `GET /projects/:id/workflows` | `workflows:read` |
| `GET /projects/:id/workflows/:name` | `workflows:read` |
| `POST /projects/:id/workflows/:name/invoke` | `workflows:write` |

#### Orgs Controller

| Endpoint | Permission |
|----------|-----------|
| `POST /orgs` | `orgs:create` |
| `POST /orgs/ensure` | `orgs:create` |
| `GET /orgs` | `orgs:read` |
| `GET /orgs/:org_id` | `orgs:read` |
| `GET /orgs/:org_id/agents` | `orgs:read` |
| `PATCH /orgs/:org_id` | `orgs:write` |
| `POST /orgs/:org_id/members` | `orgs:admin` |
| `GET /orgs/:org_id/members` | `orgs:admin` |

#### Org Integrations Controller

| Endpoint | Permission |
|----------|-----------|
| `GET /orgs/:org_id/integrations` | `integrations:read` |
| `POST /orgs/:org_id/integrations/slack/connect` | `integrations:write` |
| `POST /orgs/:org_id/integrations/:id/test` | `integrations:write` |

#### Agent Runtime Controller

| Endpoint | Permission |
|----------|-----------|
| `GET /orgs/:org_id/agent-runtime/status` | `orgs:read` |

#### Events Controller

| Endpoint | Permission |
|----------|-----------|
| `POST /projects/:id/events` | `events:write` |
| `GET /projects/:id/events` | `events:read` |
| `GET /projects/:id/events/:eventId` | `events:read` |

#### Chat Controller

| Endpoint | Permission |
|----------|-----------|
| `POST /projects/:id/chat/route` | `chat:write` |
| `POST /projects/:id/chat/simulate` | `chat:write` |

#### System Controller

| Endpoint | Permission |
|----------|-----------|
| `GET /system/status` | `system:read` |
| `GET /system/envs` | `system:read` |
| `GET /system/logs/:service` | `system:read` |
| `GET /system/pods` | `system:read` |
| `GET /system/events` | `system:read` |
| `GET /system/config` | `system:read` |
| `GET /system/settings` | `system:admin` |
| `GET /system/settings/:key` | `system:admin` |
| `PUT /system/settings/:key` | `system:admin` |

Note: Remove the manual role extraction logic from the system controller.
The PermissionGuard handles it now. `system:read` is in the `admin` set
(org admins can see system status). `system:admin` requires `is_admin`.

#### Auth Controller

| Endpoint | Permission |
|----------|-----------|
| `POST /auth/identities` | (authenticated-only, no permission needed) |
| `POST /auth/mint` | (keep manual admin check — supports org/project admin) |

---

## Job Token Integration

### Default Agent Permissions

```typescript
export const DEFAULT_AGENT_PERMISSIONS = [
  'jobs:read',
  'jobs:write',
  'threads:read',
  'threads:write',
  'envdb:read',
  'secrets:read',
  'builds:read',
  'pipelines:read',
] as const;
```

This gives agents the same access as a `member` minus org/project
management. Specific job types can request more:

| Job type | Additional permissions |
|----------|----------------------|
| Deployment job | `envs:write`, `envdb:write` |
| Build job | `builds:write` |
| Pipeline orchestrator | `pipelines:write` |

### Token Minting

The `mintJobToken` method is called by the worker via the internal API:

```
POST /internal/auth/mint-job-token
{
  "job_id": "job_789",
  "permissions": ["jobs:read", "jobs:write", "threads:read", "threads:write"]
}
```

The API looks up the job record for `created_by`, `org_id`, `project_id`.
Returns a JWT with `type: 'job'` and explicit `permissions[]` array.

### Credential Delivery

The worker (or runner pod's invoke service) writes credentials before
harness execution:

1. Call `POST /internal/auth/mint-job-token` with job ID and permissions
2. Write `$HOME/.eve/credentials.json`:
   ```json
   { "tokens": { "https://api.eve.example.com": { "access_token": "...", "token_type": "bearer" } } }
   ```
3. Add `EVE_API_URL` to harness env (not a secret, safe to forward)
4. Add `EVE_PARENT_JOB_ID` to harness env (from job record's `parent_id`)

The Eve CLI resolves auth from: flags > `EVE_API_URL` env > `.eve/profile.yaml`.
Token from `$HOME/.eve/credentials.json`. No code changes needed in the CLI.

---

## Implementation Sequence

### Phase 1: Permission Infrastructure

Create the three new files + modify rbac.service.ts:

1. `apps/api/src/auth/permissions.ts` — constants, role mapping, expansion
2. `apps/api/src/auth/permission.decorator.ts` — `@RequirePermission`
3. `apps/api/src/auth/permission.guard.ts` — `PermissionGuard`
4. Add `getOrgRole` / `getProjectRole` to `rbac.service.ts`

Register `PermissionGuard` in auth.module.ts **alongside** old guards.
Both old and new guards run. Nothing breaks because no endpoints use
`@RequirePermission` yet.

### Phase 2: Migrate All Endpoints

For each controller (25 controllers, ~162 endpoints):

1. Replace `@RequireRole(role)` with `@RequirePermission(permission)`
2. Replace `@RequireScope(scope)` with `@RequirePermission(permission)`
3. Add `@RequirePermission` to previously unprotected endpoints
4. Remove manual RBAC checks from handler methods where the guard handles it

This is mechanical work — the mapping table above is the spec.

### Phase 3: Remove Old Guards

1. Remove `RbacGuard` and `ScopeGuard` from `APP_GUARD` in auth.module.ts
2. Delete `rbac.guard.ts`, `rbac.decorator.ts`, `scope.guard.ts`, `scope.decorator.ts`
3. Remove imports of deleted decorators from all controllers

### Phase 4: Rename scopes → permissions in Job Tokens

1. Update `JobTokenPayload`: `scopes` → `permissions` (keep `scopes` as fallback)
2. Update `mintJobToken` params: `scopes` → `permissions`
3. Update `verifyJobToken` to read `permissions` (with `scopes` fallback)
4. Update `resolveJobTokenAuth` to map to `permissions` on AuthUser
5. Update the internal `mint-job-token` endpoint body schema
6. Rename `AuthUser.scopes` → `AuthUser.permissions`

### Phase 5: Worker Credential Delivery

1. Create `apps/worker/src/api-client/auth-client.ts` — calls `mint-job-token`
2. Wire credential writing into `invoke.service.ts` before harness execution
3. Add `EVE_API_URL` and `EVE_PARENT_JOB_ID` to `env-builder.ts`
4. Add `parent_id` to `HarnessEnvParams` interface

### Phase 6: Membership API + CLI

1. Add `PATCH /orgs/:org_id/members/:user_id` — update role
2. Add `DELETE /orgs/:org_id/members/:user_id` — remove member
3. Add project membership CRUD endpoints:
   - `GET /projects/:id/members`
   - `POST /projects/:id/members`
   - `PATCH /projects/:id/members/:user_id`
   - `DELETE /projects/:id/members/:user_id`
4. Add `GET /auth/permissions` — list all permissions and role mapping
5. Implement CLI commands: `eve org members`, `eve project members`,
   `eve auth permissions`, enhance `eve auth whoami`

---

## Testing Plan

### Unit Tests

1. `permissions.ts`: role expansion produces correct permission sets
2. `permission.guard.ts`:
   - User token + project context → resolves role → checks permission
   - User token + no context → uses member baseline
   - Job token → checks explicit permissions
   - Job token + no decorator → blocked
   - System admin → always passes
   - @Public → always passes
3. `auth.service.ts`: `mintJobToken` produces JWT with `permissions` field
4. `auth.service.ts`: `verifyJobToken` reads `permissions` (and `scopes` fallback)

### Integration Tests

5. Auth guard resolves `AuthUser` from job tokens with permissions
6. PermissionGuard allows/denies based on role-derived permissions
7. PermissionGuard allows/denies job tokens based on explicit permissions
8. Worker mints token → writes credentials → harness can call `eve auth whoami`
9. Agent token cannot access endpoints outside its permission set
10. Agent token cannot access jobs in other projects (RBAC still applies)
11. Membership CRUD endpoints work for org and project level

### Manual Verification

12. Run a staging job that calls `eve job create` from within harness
13. Verify `eve auth whoami` shows correct permissions
14. Verify `eve org members` and `eve project members` CLI commands work
15. Verify `eve auth permissions` displays the role-permission matrix

---

## Open Questions

1. **Caching**: Should we cache the role→permission expansion per request?
   The expansion is cheap (map lookup + set union), so probably not needed.
   But the DB lookup for membership role could benefit from a short TTL cache.

2. **Permission granularity for approve/reject**: Should `jobs:write` cover
   approve and reject, or should there be a separate `jobs:review` permission?
   Leaning toward: keep it in `jobs:write` for now, split later if needed.

3. **Cross-project job listing**: `GET /jobs` (listAll) requires `jobs:admin`.
   Should there be a way for members to list their own jobs across projects?
   Possible solution: `GET /jobs?mine=true` that filters by `created_by`
   and only requires `jobs:read`.

4. **System controller context**: The system controller endpoints like
   `GET /system/status` currently check for `org_admin` or `system_admin`.
   In the new model, `system:read` is not in any role set — only system
   admins can access it. Should org admins still see system status?
   If yes, add `system:read` to the `admin` role permissions.
