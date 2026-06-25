# Agent Identity & Unified Auth Plan

> **Status**: Draft
> **Tracking**: eve-horizon-dh5k, eve-horizon-21uh
> **Origin**: Eden testing agent found that apps can't distinguish which agent is calling, and the dual-middleware pattern (`eveUserAuth` + `eveAuthMiddleware`) forces apps into awkward two-route-tree architectures.

## Problem Statement

When an Eve agent calls an app API via `eve api call`, the app receives a job token with these claims:

```json
{
  "type": "job",
  "sub": "user_01abc...",
  "user_id": "user_01abc...",
  "org_id": "org_example",
  "project_id": "proj_01xyz...",
  "job_id": "eden-08c64625",
  "permissions": ["jobs:read", "jobs:write", "projects:read", ...]
}
```

**What's missing**: There's no `agent_slug` claim. The app knows *which job* is calling, but not *which agent*. This matters because:
- Apps may want different behavior per agent (e.g., "map-generator gets write access, reviewer gets read-only")
- Audit logs should identify agents, not just jobs
- Agent email synthesis (`{job_id}@eve.agent`) produces unstable identifiers — every job gets a new "identity"

**Second problem**: Apps that serve both browser users AND agent API calls must juggle two middleware stacks:
- `eveUserAuth()` → non-blocking, sets `req.eveUser`, rejects non-user tokens silently
- `eveAuthMiddleware()` → blocking, sets `req.agent`, 401s on missing tokens

This forces apps into separate route trees or manual req.eveUser/req.agent checks in every handler.

## Current State (What Exists)

| Component | Current Behavior |
|-----------|-----------------|
| **Job token claims** | `type`, `sub`, `user_id`, `org_id`, `project_id`, `job_id`, `permissions` — no agent identity |
| **`mintJobToken()`** | `auth.service.ts:600-630` — builds payload from params, no agent_slug param |
| **`mint-job-token` endpoint** | `auth.internal.controller.ts:42-83` — looks up job from DB (has `job.target.agent_slug`) but doesn't pass it to mintJobToken |
| **`EveTokenClaims`** | `packages/auth/src/index.ts:21-33` — no `agent_slug` field |
| **`eveUserAuth()`** | `packages/auth/src/user.ts:51-101` — non-blocking, only sets `req.eveUser` for `type === 'user'` |
| **`eveAuthMiddleware()`** | `packages/auth/src/index.ts:252-282` — blocking (401), sets `req.agent` for any token type |
| **Job DB record** | `packages/db/src/queries/jobs.ts:150` — `target: { agent_slug?: string }` is available |
| **`HarnessInvocation`** | `packages/shared/src/types/harness.ts:50` — has `agentId` field |

## Plan

### Phase 1: Agent Identity in Token Claims

**Goal**: Include `agent_slug` in job token JWT so apps know which agent is calling.

#### 1.1 Update `mintJobToken()` to accept `agentSlug`

**File**: `apps/api/src/auth/auth.service.ts`

```typescript
mintJobToken(params: {
  userId: string;
  orgId: string | null;
  projectId: string;
  jobId: string;
  permissions: string[];
  ttlSeconds?: number;
  agentSlug?: string;     // ← NEW
}): string {
  const payload: Record<string, unknown> = {
    sub: params.userId,
    user_id: params.userId,
    org_id: params.orgId,
    project_id: params.projectId,
    job_id: params.jobId,
    permissions: params.permissions,
    exp,
    iat: now,
    type: 'job',
  };

  // Include agent identity when available
  if (params.agentSlug) {
    payload.agent_slug = params.agentSlug;
    payload.email = `${params.agentSlug}@eve.agent`;  // Stable agent email
  }

  return createJwtRs256(payload, this.signerKey);
}
```

**Key change**: Agent email is now `{agent_slug}@eve.agent` (stable per agent) instead of `{job_id}@eve.agent` (unique per job). This gives agents stable identity across jobs.

#### 1.2 Pass `agent_slug` from job record in mint endpoint

**File**: `apps/api/src/auth/auth.internal.controller.ts`

```typescript
const accessToken = this.authService.mintJobToken({
  userId: job.actor_user_id ?? 'system',
  orgId: project.org_id,
  projectId: job.project_id,
  jobId: job.id,
  permissions,
  ttlSeconds: body.ttl_seconds,
  agentSlug: job.target?.agent_slug ?? undefined,  // ← NEW: from job record
});
```

No new DB queries needed — the job record is already fetched on line 51.

#### 1.3 Update `EveTokenClaims` in the SDK

**File**: `packages/auth/src/index.ts`

```typescript
export interface EveTokenClaims {
  valid: true;
  type: 'user' | 'job' | 'service_principal';
  user_id: string;
  email?: string;
  org_id?: string | null;
  orgs?: Array<{ id: string; role: string }>;
  project_id?: string;
  job_id?: string;
  agent_slug?: string;     // ← NEW
  permissions?: string[];
  is_admin?: boolean;
  role?: string;
}
```

Also update the local verification payload parsing to include `agent_slug`:

```typescript
// In verifyEveToken(), add to payload parsing and return
...(payload.agent_slug ? { agent_slug: payload.agent_slug } : {}),
```

#### 1.4 Update `JobTokenPayload` interface

**File**: `apps/api/src/auth/auth.service.ts`

```typescript
export interface JobTokenPayload {
  sub: string;
  user_id: string;
  org_id: string | null;
  project_id: string;
  job_id: string;
  permissions: string[];
  agent_slug?: string;     // ← NEW
  email?: string;          // ← NEW (stable agent email)
  exp: number;
  iat: number;
  type: 'job';
}
```

Update `verifyJobToken()` to extract the new fields.

### Phase 2: Unified Auth Middleware

**Goal**: Single middleware for apps that serve both users and agents.

#### 2.1 New `EveIdentity` interface

**File**: `packages/auth/src/index.ts` (new export)

```typescript
export interface EveIdentity {
  /** User or agent ID */
  id: string;
  /** Email (real for users, {agent_slug}@eve.agent for agents) */
  email: string;
  /** Organization this request is scoped to */
  orgId: string;
  /** Role within the organization */
  role: 'owner' | 'admin' | 'member';
  /** True if this request comes from an agent job token */
  isAgent: boolean;
  /** Agent slug (only set for agent requests) */
  agentSlug?: string;
  /** Job ID (only set for agent requests) */
  jobId?: string;
  /** Project ID (only set for agent requests) */
  projectId?: string;
  /** Permissions (only set for agent requests) */
  permissions?: string[];
}

export interface EveIdentityRequest {
  eveIdentity?: EveIdentity;
}
```

#### 2.2 New `eveAuth()` middleware

**File**: `packages/auth/src/unified.ts` (new file)

```typescript
import { verifyEveToken, verifyEveTokenRemote, type EveTokenClaims, type EveIdentity, type EveIdentityRequest } from './index.js';

/**
 * Unified auth middleware for Eve-compatible apps serving both users and agents.
 *
 * Verifies any Eve token (user, job, service_principal) and attaches a
 * normalized `req.eveIdentity` object. Non-blocking — unauthenticated
 * requests pass through with req.eveIdentity undefined.
 *
 * Use with eveIdentityGuard() to enforce authentication on protected routes.
 */
export function eveAuth(options?: {
  orgId?: string;
  eveApiUrl?: string;
  strategy?: 'local' | 'remote';
}) {
  const strategy = options?.strategy ?? 'local';
  const verify = strategy === 'local' ? verifyEveToken : verifyEveTokenRemote;

  return async (req: RequestLike & EveIdentityRequest, _res: ResponseLike, next: NextFn) => {
    const token = extractToken(req);
    if (!token) { next(); return; }

    let claims: EveTokenClaims;
    try {
      claims = await verify(token, options?.eveApiUrl);
    } catch {
      next(); return;
    }

    const targetOrgId = options?.orgId ?? process.env.EVE_ORG_ID;

    if (claims.type === 'user') {
      // User path — check org membership
      if (!targetOrgId || !claims.orgs) { next(); return; }
      const membership = claims.orgs.find((o) => o.id === targetOrgId);
      if (!membership) { next(); return; }

      req.eveIdentity = {
        id: claims.user_id,
        email: claims.email ?? '',
        orgId: targetOrgId,
        role: membership.role as EveIdentity['role'],
        isAgent: false,
      };
    } else if (claims.type === 'job') {
      // Agent path — use job claims directly
      const orgId = claims.org_id ?? targetOrgId;
      if (!orgId) { next(); return; }

      req.eveIdentity = {
        id: claims.user_id,
        email: claims.email ?? claims.agent_slug ? `${claims.agent_slug}@eve.agent` : `${claims.job_id}@eve.agent`,
        orgId,
        role: 'member',  // Agents are always members
        isAgent: true,
        agentSlug: claims.agent_slug,
        jobId: claims.job_id,
        projectId: claims.project_id,
        permissions: claims.permissions,
      };
    }
    // service_principal tokens: future extension

    next();
  };
}

/**
 * Guard middleware: returns 401 if req.eveIdentity is not set.
 * Use after eveAuth() on protected routes.
 */
export function eveIdentityGuard() {
  return (req: EveIdentityRequest, res: ResponseLike, next: NextFn) => {
    if (!req.eveIdentity) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    next();
  };
}
```

#### 2.3 Update SDK exports

**File**: `packages/auth/src/index.ts`

```typescript
// Add to existing exports
export { eveAuth, eveIdentityGuard } from './unified.js';
export type { EveIdentity, EveIdentityRequest } from './unified.js';
```

### Phase 3: Documentation & Skills

#### 3.1 Update `eve-auth-sdk.md`

Add the unified middleware pattern to the system docs.

#### 3.2 Update `eve-skillpacks` reference

Update `references/secrets-auth.md` in the eve-skillpacks repo to document:
- Agent identity claims (`agent_slug`, stable `email`)
- The new `eveAuth()` unified middleware
- Migration guide from dual-middleware to unified

#### 3.3 Update `eve-auth-and-secrets` skill

Add the unified middleware as the recommended pattern for new apps.

## Migration Path for Existing Apps

**No breaking changes.** All existing middleware continues to work:
- `eveUserAuth()` → unchanged (still only sets `req.eveUser` for user tokens)
- `eveAuthMiddleware()` → unchanged (still blocking, sets `req.agent`)
- New `eveAuth()` → additive (sets `req.eveIdentity` for both token types)

Apps can adopt the unified pattern at their own pace:

```typescript
// Before (two middleware stacks):
app.use(eveUserAuth());
app.use('/api', eveAuthMiddleware());

// After (single unified middleware):
app.use(eveAuth());
app.get('/protected', eveIdentityGuard(), (req, res) => {
  if (req.eveIdentity.isAgent) {
    // Agent-specific logic
  }
});
```

## Implementation Order

1. **Phase 1.1-1.4**: Agent identity in tokens (platform API + SDK types) — all in this repo
2. **Phase 2.1-2.3**: Unified middleware (SDK) — all in packages/auth
3. **Publish SDK**: `sdk-v*` tag to npm
4. **Phase 3**: Docs + skills update
5. **Eden**: Update to use unified middleware (separate PR in Eden repo)

## Files Changed

| File | Change |
|------|--------|
| `apps/api/src/auth/auth.service.ts` | Add `agentSlug` param to `mintJobToken()`, add to `JobTokenPayload` |
| `apps/api/src/auth/auth.internal.controller.ts` | Pass `job.target?.agent_slug` to mintJobToken |
| `packages/auth/src/index.ts` | Add `agent_slug` to `EveTokenClaims`, export unified types |
| `packages/auth/src/unified.ts` | **NEW** — `eveAuth()`, `eveIdentityGuard()`, `EveIdentity` |
| `packages/auth/src/user.ts` | No changes (backwards compatible) |
| `docs/system/eve-auth-sdk.md` | Document unified middleware pattern |
