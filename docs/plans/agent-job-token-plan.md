# Agent Job Token — Historical Implementation Plan

> Status: **Historical / superseded**. The core agent job-token capability has
> shipped; do not implement the detailed design below as-is.
> Last Reviewed: 2026-05-15
> Last Updated: 2026-05-15
>
> This plan's Option B (extend job token with project scope) has been
> subsumed into the unified permissions model, which replaced the dual
> RBAC/scopes model with `permissions[]` plus `@RequirePermission`.
> The later `docs/plans/job-token-path-and-mount-scope-plan.md` extended
> this with optional resource scope and was implemented/verified on
> 2026-05-11.
>
> Current source of truth:
> - `docs/system/auth.md` — current job-token claims and optional resource scope
> - `docs/system/workflows.md` and `docs/system/manifest.md` — workflow `scope`
>   blocks and `jobs.token_scope`
> - `docs/plans/unified-permissions-plan.md` — original migration design for
>   the permission guard model
> - `docs/plans/job-token-path-and-mount-scope-plan.md` — implemented follow-up
>   for path/mount resource scope
> - `docs/plans/non-agent-job-scoped-credentials-plan.md` — proposed follow-up
>   that extends the same `permissions[]` + `scope` model to non-agent
>   (`script:` / `action: { type: run }`) execution paths
>
> Original purpose: Give agents running inside job harnesses authenticated
> access to the Eve API via the standard Eve CLI.
>
> Depends on: `docs/plans/agent-harness-tool-home-auth-plan.md` (per-job
> tool home concept). This plan defines the **token minting and delivery**
> mechanism; tool-home-auth defines the **file layout and sandboxing**.

---

## Current Implementation Snapshot

Reviewed against current `main` on 2026-05-15:

- `apps/api/src/auth/auth.service.ts` accepts `type: 'job'` tokens in the
  standard authorization path. Job-token `AuthUser` objects carry
  `is_job_token`, `job_id`, `project_id`, explicit `permissions[]`, optional
  `scope`, and optional `agent_slug`.
- `apps/api/src/auth/auth.internal.controller.ts` exposes
  `POST /internal/auth/mint-job-token`. The request body uses
  `permissions?: string[]`; `scopes?: string[]` is only a legacy alias.
  `scope?: AccessBindingScope` is the resource-scope claim.
- `apps/api/src/auth/permission.guard.ts` is the single public endpoint guard.
  Job, service, and service-principal tokens must hit endpoints with
  `@RequirePermission(...)`; undecorated endpoints are blocked for those token
  types.
- `apps/api/src/auth/scoped-access.service.ts` enforces optional resource
  scope for job tokens on org-fs, org-docs, env DB, and cloud-fs calls. Tokens
  without `scope` keep legacy permission-name-only behavior.
- `packages/shared/src/invoke/eve-credentials.ts` mints/resolves the job token
  and writes `~/.eve/credentials.json` inside the job home. Both worker and
  agent-runtime also expose the token as `EVE_JOB_TOKEN`.
- `packages/shared/src/harnesses/env-builder.ts` injects non-secret
  `EVE_API_URL` and `EVE_PARENT_JOB_ID` into the sanitized harness env.
- Workflow and step `scope` blocks are persisted on `jobs.token_scope`; the
  orchestrator threads the same value into `data.orgfs_mount` and
  `data.__eve_job_scope` so the workspace `.org` mount and minted token agree.
- **Known asymmetry (tracked separately):** only the agent execution path
  (`apps/agent-runtime/src/invoke/invoke.service.ts`) reads
  `access.permissions` and `__eve_job_scope` and forwards them to
  `writeEveCredentials`. The script executor
  (`apps/worker/src/script-executor/script-executor.service.ts`) still mints
  with a hard-coded `SCRIPT_JOB_PERMISSIONS` constant and ignores
  `jobs.token_scope`; `action: { type: run }` jobs receive no
  `EVE_JOB_TOKEN` or `~/.eve/credentials.json` at all. Closing this is the
  scope of `docs/plans/non-agent-job-scoped-credentials-plan.md`, not this
  plan.

## Resolved Decisions

1. Permission names are `permissions[]`, not `scopes[]`.
2. Resource narrowing is the singular `scope` claim with `AccessBindingScope`
   shape.
3. Endpoint authorization uses `@RequirePermission` / `PermissionGuard`; the
   `@RequireScope` / `ScopeGuard` design below is obsolete.
4. Agent-job defaults now come from `DEFAULT_AGENT_PERMISSIONS` in
   `packages/shared/src/permissions.ts`, including `jobs:write` rather than the
   old split `jobs:create` / `jobs:update` names.
5. Token TTL defaults to 8 hours in the shared mint client and is capped at 24
   hours by `AuthService.mintJobToken`.
6. `EVE_API_URL` is injected into the harness env; repos do not need to rely on
   `.eve/profile.yaml` for agent CLI access.
7. `EVE_PARENT_JOB_ID` is injected when a parent exists.

## Historical Problem (Resolved)

The Eve CLI is intended as a first-class tool for agents. The
orchestration skill already uses `eve job create`, `eve job current`,
`eve job dep add`, etc. from within harness execution. But today:

1. The harness env is sanitized — `EVE_API_URL` and `EVE_INTERNAL_API_KEY`
   are on the runner pod but **not forwarded** to the harness process.
2. `$HOME/.eve/credentials.json` is **never populated** inside runner pods.
3. The CLI can resolve `api_url` from `.eve/profile.yaml` in the repo,
   but has no auth token to authenticate requests.

Result: any Eve CLI call from within a harness gets a 401 on auth-enabled
stacks. The orchestration skill is broken on staging/production.

---

## Historical Auth Primitives (Outdated Snapshot)

This section reflects the February 2026 pre-implementation state. Current code
uses `permissions[]` for permission names and optional singular `scope` for
resource scope.

### Token Types

| Type | Claims | TTL | Used By | Auth Guard |
|------|--------|-----|---------|------------|
| `user` | `sub`, `email`, `orgs[]`, `type: 'user'` | configurable (default 1 day) | CLI login, `/auth/mint` | Standard `AuthGuard` via `verifyAuthorizationHeader` |
| `job` | `user_id`, `org_id`, `scopes[]`, `type: 'job'` | 24h hard-coded | Environment DB access only | **Not** handled by standard `AuthGuard` — separate `verifyJobToken` path |

### Minting Paths

| Path | Who can call | What it does |
|------|-------------|--------------|
| `POST /auth/mint` | Admin or org/project admin | Creates user if needed, upserts membership, returns `type: 'user'` token |
| `authService.mintJobToken()` | Internal (code only) | Returns `type: 'job'` JWT — not exposed as API endpoint |
| `authService.mintUserToken()` | Internal (code only) | Returns `type: 'user'` JWT for a known user |

### Internal API Key

Worker and orchestrator use `x-eve-internal-token` header with
`EVE_INTERNAL_API_KEY` for `/internal/*` endpoints. This is a shared
secret, not a JWT. **Not suitable for agent access** (no scoping, no
identity, no audit trail).

---

## Historical Options

### Option A: Mint a User Token for the Job Owner

The worker calls an internal endpoint to mint a `type: 'user'` token
for the user who owns the job. Write it to `$HOME/.eve/credentials.json`.

**How it works:**
1. Worker resolves the job's `created_by` user ID from the job record.
2. Worker calls `authService.mintUserToken(userId, email, ttl)` directly
   (it runs in the same process as the auth service in local dev) or
   calls `POST /internal/auth/mint-for-job` on the API.
3. Token written to tool home's `$HOME/.eve/credentials.json`.
4. CLI picks it up through existing credential resolution.

**Token claims:**
```json
{
  "sub": "usr_abc123",
  "email": "admin@example.com",
  "orgs": [{"id": "org_xyz", "role": "admin"}],
  "type": "user",
  "iat": 1738972800,
  "exp": 1739059200
}
```

**Pros:**
- Zero auth guard changes — user tokens already work everywhere.
- Agent acts as the job owner — RBAC just works.
- Simplest implementation (~30 lines).

**Cons:**
- Agent has **full user permissions** — can access any project the user
  can access, not just the job's project. Violates least privilege.
- No way to audit "this was an agent action" vs "this was a human action"
  — same token type, same claims.
- If the user's org memberships change mid-job, the token still has
  the old claims (minor — 24h TTL mitigates).

**Estimated scope:** ~30 lines worker, ~10 lines internal endpoint.

---

### Option B: Extend Job Token with Project Scope (Recommended)

Extend the existing `type: 'job'` token to include `project_id` and
`job_id` claims. Teach the auth guard to accept job tokens for
standard API endpoints (not just `/internal/*`).

**How it works:**
1. Worker calls `authService.mintJobToken(...)` with enriched claims.
2. Token written to tool home's `$HOME/.eve/credentials.json`.
3. Auth guard detects `type: 'job'` and resolves an `AuthUser` with
   the job owner's identity + explicit scope restrictions.
4. RBAC checks apply normally, but scoped to the job's project.

**Token claims:**
```json
{
  "type": "job",
  "sub": "usr_abc123",
  "user_id": "usr_abc123",
  "org_id": "org_xyz",
  "project_id": "proj_456",
  "job_id": "job_789",
  "scopes": [
    "jobs:read",
    "jobs:create",
    "jobs:update",
    "threads:read",
    "threads:write",
    "context:read"
  ],
  "iat": 1738972800,
  "exp": 1739059200
}
```

**Pros:**
- **Least privilege**: Agent can only access the job's project, only
  perform scoped actions. Even if the token leaks, blast radius is
  limited.
- **Auditable**: `type: 'job'` + `job_id` claim makes it clear this
  is an agent action. Log enrichment is trivial.
- **Extensible**: Scopes can grow as we add coordination features
  (`threads:write`, `supervise:read`, etc.) without changing the
  token format.
- Builds on existing `mintJobToken` / `verifyJobToken` code.
- Token lifetime naturally tied to job lifetime.

**Cons:**
- Auth guard needs to learn about `type: 'job'` tokens (~40 lines).
- Scope enforcement needs a lightweight check per endpoint (~20 lines
  of middleware or decorator).
- Slightly more complex than Option A.

**Estimated scope:** ~40 lines auth guard, ~20 lines scope middleware,
~30 lines worker minting, ~10 lines internal endpoint.

---

### Option C: Dedicated Agent Token Type

Create a new `type: 'agent'` token with rich claims about the agent's
identity, capabilities, and context.

**Token claims:**
```json
{
  "type": "agent",
  "sub": "usr_abc123",
  "agent_id": "agt_lead_reviewer",
  "org_id": "org_xyz",
  "project_id": "proj_456",
  "job_id": "job_789",
  "attempt_id": "att_012",
  "capabilities": ["jobs", "threads", "context", "supervise"],
  "iat": 1738972800,
  "exp": 1739059200
}
```

**Pros:**
- Most semantically precise — the token says exactly what it is.
- Agent identity tracked at the token level.
- Could support capability-based access (not just scope strings).

**Cons:**
- New token type = new mint function + new verify function + new
  auth guard path + new types. More surface area.
- Agent identity is already tracked via `EVE_AGENT_ID` env var and
  job metadata — duplicating it in the token adds marginal value.
- Over-engineered for the immediate need.

**Estimated scope:** ~100 lines auth service, ~40 lines auth guard,
~30 lines worker, new types.

---

### Option D: Forward `EVE_INTERNAL_API_KEY` to Harness

Add `EVE_INTERNAL_API_KEY` to the harness env allowlist. Teach the
CLI to use `x-eve-internal-token` header when this env var is present.

**Pros:**
- Minimal code change (~5 lines env builder, ~10 lines CLI).
- Works immediately.

**Cons:**
- **All agents share the same key** — no per-job scoping, no identity.
- Internal API key grants access to **all internal endpoints** including
  secrets resolution, event emission, etc. Massive blast radius.
- If any agent leaks the key (prompt injection, log exposure), the
  entire internal API surface is compromised.
- Violates the security model that the secret hardening work is trying
  to establish.

**Not recommended.** Listed for completeness.

---

## Historical Recommendation: Option B

Option B gives us least-privilege, auditability, and extensibility
while building on existing code. The implementation is modest (~100
lines total) and the auth guard change is clean.

Option A is a reasonable stepping stone if we want to unblock agents
faster — but we'd want to migrate to Option B before production use.

---

## Historical Detailed Design (Option B)

### 1. Enrich `mintJobToken`

Extend the existing method signature:

```typescript
mintJobToken(params: {
  userId: string;
  orgId: string;
  projectId: string;
  jobId: string;
  scopes: string[];
  ttlSeconds?: number;  // default: 24h or job timeout
}): string
```

Add `sub`, `project_id`, and `job_id` claims to the JWT payload.
Keep `type: 'job'` (no new token type).

### 2. Default Scopes

Define a standard set of scopes for agent jobs:

```typescript
const AGENT_JOB_DEFAULT_SCOPES = [
  'jobs:read',       // eve job current, eve job show, eve job list
  'jobs:create',     // eve job create (child jobs)
  'jobs:update',     // eve job dep add, eve job submit
  'threads:read',    // eve thread messages
  'threads:write',   // eve thread post
  'context:read',    // eve job context
  'events:read',     // eve supervise (reads events)
] as const;
```

Scopes follow a `resource:action` pattern. Start minimal; add more
as coordination features land.

### 3. Auth Guard Extension

In `auth.guard.ts`, after extracting the bearer token:

```typescript
// Try user token first (existing path)
// If verification fails with "Token subject missing", try job token
const claims = this.verifyToken(token);
if (claims.type === 'job') {
  request.user = this.resolveJobTokenUser(claims);
  request.jobTokenScopes = claims.scopes;
} else {
  request.user = await this.resolveUserTokenUser(claims);
}
```

The `resolveJobTokenUser` maps job token claims to an `AuthUser`:

```typescript
private resolveJobTokenUser(claims: JobTokenPayload): AuthUser {
  return {
    user_id: claims.user_id ?? claims.sub,
    role: 'member',
    org_id: claims.org_id,
    // Flag for audit logging
    is_job_token: true,
    job_id: claims.job_id,
  };
}
```

### 4. Scope Enforcement

Two approaches (pick one):

**4a. Decorator-based (explicit):**

```typescript
@RequireScope('threads:write')
@Post('threads/:id/messages')
async postMessage(...) { ... }
```

A `ScopeGuard` reads `request.jobTokenScopes` and checks the required
scope. User tokens (no scopes) pass through. Job tokens must have
the declared scope.

**4b. Convention-based (implicit):**

Map HTTP method + path prefix to scopes automatically:

| Method | Path prefix | Required scope |
|--------|-------------|---------------|
| GET | `/jobs/*` | `jobs:read` |
| POST | `/jobs` | `jobs:create` |
| PATCH/PUT | `/jobs/*` | `jobs:update` |
| GET | `/threads/*/messages` | `threads:read` |
| POST | `/threads/*/messages` | `threads:write` |

Convention-based is less flexible but requires no per-endpoint
annotation. **Recommend starting with 4a** for explicitness, then
consider 4b if annotation fatigue becomes an issue.

### 5. Worker: Mint and Write Token

In `invoke.service.ts`, after resolving the job context but before
launching the harness:

```typescript
// Mint a job-scoped token for agent CLI access
const agentToken = this.authService.mintJobToken({
  userId: job.created_by,
  orgId: job.org_id,
  projectId: job.project_id,
  jobId: job.id,
  scopes: AGENT_JOB_DEFAULT_SCOPES,
  ttlSeconds: job.hints?.timeout_seconds ?? 86400,
});

// Write to tool home credentials file
const eveCredsDir = path.join(homeDir, '.eve');
await fs.mkdir(eveCredsDir, { recursive: true });
const credsPayload = {
  tokens: {
    [apiUrl]: {
      access_token: agentToken,
      token_type: 'bearer',
    },
  },
};
await fs.writeFile(
  path.join(eveCredsDir, 'credentials.json'),
  JSON.stringify(credsPayload, null, 2),
  { mode: 0o600 },
);
```

The key in the `tokens` map is the API URL (matching the CLI's
`toAuthKey` function — the URL with trailing slashes stripped).

### 6. Expose API URL to Harness

Two options:

**6a. Add `EVE_API_URL` to harness env allowlist:**

Simple. Just add it to `ALLOWED_SYSTEM_ENV_KEYS` in `env-builder.ts`.
It's not a secret — it's a URL. The sanitized env already includes
non-secret metadata like `EVE_JOB_ID` and `EVE_PROJECT_ID`.

**6b. Rely on `.eve/profile.yaml` in repo:**

Already works for repos that have it (like this one). But not all
repos will have a profile.yaml. Less reliable.

**Recommend 6a.** `EVE_API_URL` is not a secret. Adding it to the
allowlist is one line and makes the CLI work reliably in all repos.

### 7. Expose Parent Job ID

Add `EVE_PARENT_JOB_ID` to the harness env (populated from the job
record). Agents need this to derive coordination thread keys
(`coord:job:{parent_job_id}`).

---

## Historical Implementation Sequence

### Step 1: Enrich `mintJobToken` (~20 lines)

- Add `projectId`, `jobId`, optional `ttlSeconds` params.
- Add `sub`, `project_id`, `job_id` to JWT payload.
- Update `verifyJobToken` to validate new fields.
- Update `JobTokenPayload` type.

### Step 2: Auth guard learns job tokens (~40 lines)

- In `verifyAuthorizationHeader`: detect `type: 'job'` and return
  an `AuthUser` with `is_job_token` flag.
- Add `@RequireScope()` decorator + `ScopeGuard`.
- Annotate the endpoints agents need: jobs CRUD, threads CRUD,
  job context.

### Step 3: Worker mints token + writes credentials (~30 lines)

- In `executeEveAgentCli` (or harness setup path): mint the job
  token and write `$HOME/.eve/credentials.json`.
- Add `EVE_API_URL` and `EVE_PARENT_JOB_ID` to harness env allowlist.

### Step 4: Verify end-to-end

- Manual test: run a job that calls `eve job current --json` and
  `eve auth whoami` from within the harness.
- Verify token scopes are enforced (e.g., agent can't call
  `/auth/mint`).
- Verify audit logs show `is_job_token` + `job_id`.

---

## Historical Scope Inventory

Initial scopes for agent coordination:

| Scope | Permits | Used by |
|-------|---------|---------|
| `jobs:read` | `GET /jobs/:id`, `GET /jobs/:id/context` | `eve job current`, `eve job show` |
| `jobs:create` | `POST /projects/:id/jobs` | `eve job create` |
| `jobs:update` | `PATCH /jobs/:id`, `POST /jobs/:id/relations` | `eve job dep add`, `eve job submit` |
| `threads:read` | `GET /threads/:id/messages` | `eve thread messages` |
| `threads:write` | `POST /threads/:id/messages` | `eve thread post` |
| `context:read` | `GET /jobs/:id/context` | `eve job context` (also covered by `jobs:read`) |
| `events:read` | `GET /jobs/:id/supervise` | `eve supervise` |

Future scopes (add when features land):

| Scope | Permits |
|-------|---------|
| `threads:create` | Create new threads (if agents need this) |
| `files:read` | Read workspace files via API (if needed) |
| `secrets:read` | Read project secrets (restricted) |

---

## Historical Security Considerations

1. **Token lifetime**: Tie to job timeout (`hints.timeout_seconds`)
   with a hard cap of 24h. Short-lived tokens limit blast radius.

2. **Project scoping**: The auth guard should verify that API requests
   target the token's `project_id`. An agent with a token for
   `proj_A` should not be able to read jobs in `proj_B`.

3. **No privilege escalation**: Job tokens have `role: 'member'`.
   They cannot mint new tokens, manage org memberships, or access
   admin endpoints.

4. **Audit trail**: Log `is_job_token`, `job_id`, and `agent_id` on
   all API requests made with job tokens. This creates a clear audit
   trail distinguishing human actions from agent actions.

5. **Token rotation**: If a job runs longer than the token TTL, the
   CLI should get a 401 and the agent should fail gracefully. We
   don't implement refresh for job tokens — the job timeout should
   always be shorter than the token TTL.

6. **Credential file permissions**: Write `credentials.json` with
   mode `0o600`. The tool-home auth plan's sandbox ensures agents
   can read this file but it's not in the workspace (so the agent
   can't read it via file tools in the future hardened model).

---

## Historical Testing Plan

1. **Unit**: `mintJobToken` produces valid JWT with all expected claims.
2. **Unit**: `verifyJobToken` accepts enriched tokens, rejects expired.
3. **Unit**: Auth guard resolves `AuthUser` from job tokens.
4. **Unit**: `ScopeGuard` allows/denies based on declared scopes.
5. **Integration**: Worker mints token, writes credentials, harness
   process can call `eve auth whoami` successfully.
6. **Integration**: Agent token cannot access endpoints outside its
   scope (e.g., `POST /auth/mint` returns 403).
7. **Integration**: Agent token cannot access jobs in other projects.
8. **Manual**: Run a staging job that uses `eve job create` from
   within the harness. Verify it works end-to-end.

---

## Historical Open Questions (Resolved)

1. **`EVE_API_URL` as env var vs profile.yaml**: Should we rely on
   `.eve/profile.yaml` or add `EVE_API_URL` to the harness env? Both
   work. Env var is more explicit and works in repos without profile.
   Current resolution: `EVE_API_URL` is injected by
   `buildSanitizedHarnessEnv`.

2. **Token TTL tied to job timeout**: Should the token expire exactly
   when the job times out, or have a buffer? Proposal: `max(job_timeout,
   1h)` with a hard cap of 24h.
   Current resolution: the shared mint client defaults to 8h and
   `AuthService.mintJobToken` caps TTL at 24h.

3. **Scopes on existing endpoints**: Many existing endpoints (jobs CRUD,
   threads CRUD) have no scope annotations today. Should we add the
   `@RequireScope` decorator to all of them, or only enforce scopes
   when the request is from a job token?
   Current resolution: endpoint authorization uses `@RequirePermission`, and
   job/service/service-principal tokens are blocked from undecorated endpoints.

4. **K8s runner: where does the worker mint?** In the current k8s-runner
   flow, the worker spawns the runner pod, then the runner pod runs the
   harness. The worker has `EVE_INTERNAL_API_KEY` but the runner pod
   also has it. The runner pod's invoke service is what actually calls
   `buildSanitizedHarnessEnv`. So the runner pod's invoke service should
   mint the token (it has access to the auth service or the internal API).
   Current resolution: worker and agent-runtime both use the shared
   `writeEveCredentials` / `resolveInvocationJobToken` path, which mints via
   the internal API when an invocation token was not already supplied.

5. **Credential format**: The CLI expects `credentials.json` with
   `tokens[apiUrl].access_token`. Should we also write the `api_url`
   to a `.eve/profile.yaml` in the tool home? Or is `EVE_API_URL` env
   var sufficient?
   Current resolution: `EVE_API_URL` plus `~/.eve/credentials.json` is the
   current runtime path; no tool-home profile file is required.
