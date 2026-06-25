# Eve Auth SDK

> Status: Current
> Last Updated: 2026-03-12

Two shared packages that eliminate auth boilerplate in Eve-compatible apps.

| Package | Scope | Replaces |
|---------|-------|----------|
| `@eve-horizon/auth` | Backend (Express/NestJS) | JWKS setup, org check, role mapping, auth config |
| `@eve-horizon/auth-react` | Frontend (React) | SSO session probe, token cache, login form |

## Architecture

```
Browser                               Backend (Express)                      Eve Platform
───────                               ─────────────────                      ────────────
EveAuthProvider                        eveUserAuth()                          Eve API
  ├─ sessionStorage check              ├─ Extract Bearer token                ├─ /.well-known/jwks.json
  ├─ GET /auth/config ─────────────>   │  eveAuthConfig()                    ├─ /auth/token/verify
  ├─ GET {sso_url}/session ────────>   │  └─ { sso_url, eve_api_url, ... }   └─ /auth/config
  │  (root-domain cookie)              ├─ Verify RS256 (JWKS, 15-min cache)
  ├─ Store token in sessionStorage     ├─ Check orgs claim for org membership
  └─ GET /auth/me ─────────────────>   ├─ Attach req.eveUser
     (Authorization: Bearer)           │  eveAuthGuard()
                                       └─ 401 if no req.eveUser

SSO Broker (apps/sso)
  /login     ── HTML login form
  /callback  ── Supabase → Eve token exchange, sets cookies
  /session   ── Returns Eve token from refresh cookie (CORS)
  /logout    ── Clears cookies
```

## Package: `@eve-horizon/auth`

Source: `packages/auth/`

### Exports

| Export | Type | Purpose |
|--------|------|---------|
| `eveUserAuth(options?)` | Middleware | Verify user token, check org, attach `req.eveUser` |
| `eveAppUserAuth(options?)` | Middleware | Verify user token, resolve app-scoped org access through Eve API, attach `req.eveUser` |
| `eveAuthGuard()` | Middleware | 401 if `req.eveUser` not set |
| `eveAuthConfig()` | Handler | Serve `{ sso_url, eve_api_url, ... }` from env |
| `eveAuth(options?)` | Middleware | Unified non-blocking user/job middleware, attach `req.eveIdentity` |
| `eveAppAuth(options?)` | Middleware | Unified user/job middleware with app-scoped user org access |
| `eveIdentityGuard()` | Middleware | 401 if `req.eveIdentity` not set |
| `eveAuthMiddleware(options?)` | Middleware | Agent/job token verification, attach `req.agent` |
| `verifyEveToken(token, url?)` | Function | JWKS-based local verification (15-min cache) |
| `verifyEveTokenRemote(token, url?)` | Function | HTTP verification via `/auth/token/verify` |

### Types

```typescript
interface EveTokenClaims {
  valid: true;
  type: 'user' | 'job' | 'service_principal';
  user_id: string;
  email?: string;
  org_id?: string | null;     // Job tokens: single org
  orgs?: Array<{              // User tokens: all memberships
    id: string;
    role: string;
  }>;
  project_id?: string;
  job_id?: string;
  permissions?: string[];
  is_admin?: boolean;
  role?: string;
}

interface EveUser {
  id: string;
  email: string;
  orgId: string;
  role: 'owner' | 'admin' | 'member';
}

interface EveAppAccessOrg {
  id: string;
  slug: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  capabilities: {
    enter_app: boolean;
    invite_members: boolean;
  };
}

interface EveAppAccess {
  project_id: string;
  orgs: EveAppAccessOrg[];
  admin_orgs: Array<Omit<EveAppAccessOrg, 'capabilities'>>;
}
```

### Middleware Behavior

**`eveUserAuth()`** is non-blocking. It passes through without setting `req.eveUser` when:
- No token present
- Token is invalid or expired
- Token type is not `user`
- `orgs` claim missing or target org not found

This lets you mix public and protected routes:

```typescript
app.use(eveUserAuth());                    // Parse on every request
app.get('/public', publicHandler);         // req.eveUser may or may not be set
app.get('/private', eveAuthGuard(), privateHandler);  // 401 if not set
```

**`eveAuthMiddleware()`** is blocking. It returns 401 immediately on any verification failure. Use this for agent-facing APIs where every request must be authenticated.

**`eveAppUserAuth()`** is for apps that opt into `x-eve.auth.org_access`.
It verifies a user token, calls Eve API `GET /auth/app-access?project_id=...`,
and attaches `req.eveUser` for an allowed org. The selected org is read from
`X-Eve-Org-Id`, `?eve_org_id=...`, the token `org_id` claim, or the first
allowed org returned by Eve. Use `eveAuthGuard()` after it just like
`eveUserAuth()`.

```typescript
import { eveAppUserAuth, eveAuthGuard, eveAuthConfig } from '@eve-horizon/auth';

app.use(eveAppUserAuth());
app.get('/auth/config', eveAuthConfig());
app.use('/api', eveAuthGuard());
```

**`eveAppAuth()`** mirrors that behavior for apps that accept both user tokens
and job tokens. User tokens go through `GET /auth/app-access`; job tokens keep
their token org/project context.

### Verification Strategies

| Strategy | Default for | Latency | Freshness |
|----------|-------------|---------|-----------|
| `'local'` | `eveUserAuth` | Fast (JWKS cached 15 min) | Stale up to 15 min |
| `'remote'` | `eveAuthMiddleware` | ~50ms per request | Always current |

The `'local'` strategy fetches `/.well-known/jwks.json` once and caches keys for 15 minutes. The `'remote'` strategy calls `/auth/token/verify` on every request.

### Environment Variables

All read from `process.env` automatically:

| Variable | Used by | Injected by |
|----------|---------|-------------|
| `EVE_API_URL` | JWKS fetch, remote verify | Platform deployer |
| `EVE_ORG_ID` | Org membership check | Platform deployer |
| `EVE_SSO_URL` | `eveAuthConfig()` response | Platform deployer |
| `EVE_PUBLIC_API_URL` | `eveAuthConfig()` response | Platform deployer |
| `EVE_PROJECT_ID` | App access lookup, SSO project context, auth config response | Platform deployer |

## Package: `@eve-horizon/auth-react`

Source: `packages/auth-react/`

### Exports

| Export | Type | Purpose |
|--------|------|---------|
| `EveAuthProvider` | Component | Context provider, session bootstrap |
| `useEveAuth()` | Hook | User state, login/logout actions |
| `EveLoginGate` | Component | Render children when authed, login form when not |
| `EveLoginForm` | Component | SSO + token paste login UI |
| `useEveAppAccess(projectId?)` | Hook | Fetch app-scoped orgs and expose admin invite helper |
| `createEveClient(baseUrl?)` | Function | Fetch wrapper with Bearer injection |
| `getStoredToken()` | Function | Read cached token from sessionStorage |
| `storeToken(token)` | Function | Write token to sessionStorage |
| `clearToken()` | Function | Remove cached token |

### Session Bootstrap

`EveAuthProvider` runs this sequence on mount:

1. Check `sessionStorage` for cached token
   - Verify expiry locally (skip network if expired)
   - Validate via `GET {apiUrl}/auth/me`
   - If valid: set user, done
2. Fetch `GET {apiUrl}/auth/config` to get `sso_url`
3. Probe `GET {sso_url}/session` with `credentials: 'include'`
   - If SSO cookie exists: get fresh token, cache, validate
4. Unauthenticated: `user = null`, `loading = false`

### Token Lifecycle

| Token | Storage | TTL | Refresh Path |
|-------|---------|-----|--------------|
| Eve RS256 access token | `sessionStorage` | 1 day (default) | Re-probe SSO `/session` |
| SSO refresh cookie | httpOnly cookie (root domain) | 30 days | GoTrue refresh |
| GoTrue refresh token | httpOnly cookie (SSO broker) | 30 days | Re-login |

When the cached access token expires, the bootstrap re-probes the SSO session. If the SSO refresh token is also expired, the user sees the login form. No manual token refresh logic needed in apps.

## Org Awareness (Auth-React)

`@eve-horizon/auth-react` exposes the user's org memberships and provides
org switching. This enables multi-org apps without custom state management.

### Context Fields

```typescript
import { useEveAuth } from '@eve-horizon/auth-react';

const { orgs, activeOrg, switchOrg } = useEveAuth();
```

### Types

```typescript
interface EveAuthOrg {
  id: string;
  role: 'owner' | 'admin' | 'member';
}

interface EveAuthContextValue {
  // ... existing fields (user, loading, loginWithSso, etc.) ...
  orgs: EveAuthOrg[];               // All org memberships
  activeOrg: EveAuthOrg | null;     // Currently active org
  switchOrg: (orgId: string) => void; // Switch active org
}
```

### Behavior

| Field | Source | Persistence |
|-------|--------|-------------|
| `orgs` | `/auth/me` `memberships` field (already in backend) | Refreshed on session bootstrap |
| `activeOrg` | First org from `orgs`, or restored from `localStorage` | `localStorage` (survives page reload) |
| `switchOrg` | Validates `orgId` is in `orgs` before switching | Updates `localStorage` |
| `eve_org_id` query param | SSO invite callback for app-scoped invites | Used once at provider initialization, then persisted |

### Usage

```tsx
function OrgSwitcher() {
  const { orgs, activeOrg, switchOrg } = useEveAuth();

  return (
    <select
      value={activeOrg?.id ?? ''}
      onChange={(e) => switchOrg(e.target.value)}
    >
      {orgs.map((org) => (
        <option key={org.id} value={org.id}>
          {org.id} ({org.role})
        </option>
      ))}
    </select>
  );
}
```

### Backward Compatibility

`user.orgId` continues to work for single-org apps. The `orgs` / `activeOrg`
fields are additive. Apps that don't reference them are unaffected.

## App-Scoped Org Access

Apps that declare `x-eve.auth.org_access` should treat Eve API as the source of
truth for which orgs a signed-in user can enter for that project:

```tsx
import { useEveAppAccess } from '@eve-horizon/auth-react';

function AppAdmin() {
  const { orgs, adminOrgs, loading, inviteMember } = useEveAppAccess();

  async function invite(email: string) {
    const org = adminOrgs[0];
    if (!org) return;
    await inviteMember({ orgId: org.id, email });
  }
}
```

`useEveAppAccess(projectId?)` resolves the project ID from its argument or
`config.eve_project_id`, calls `GET /auth/app-access`, and exposes:

```typescript
{
  access: EveAppAccess | null;
  orgs: EveAppAccessOrg[];
  adminOrgs: EveAppAccess['admin_orgs'];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  inviteMember: (input: {
    orgId: string;
    email: string;
    redirectTo?: string;
    resend?: boolean;
  }) => Promise<{
    status: 'invited' | 'pending' | 'already_member';
    org_id: string;
    email: string;
    role: 'member';
    invite_code?: string;
    expires_at?: string;
  }>;
}
```

The invite helper posts to `POST /auth/app-invites`. Eve enforces that the
caller is an app-authorized `admin` or `owner` in the target org, creates only
regular member invites, and sends the existing project-branded invite email.
When the invited user accepts, SSO appends `eve_org_id=<target-org-id>` to the
final redirect so the React provider can initialize the active org correctly.

## Platform Integration

### Auto-Injected Environment Variables

The deployer (`apps/worker/src/deployer/deployer.service.ts`) injects these into every deployed app:

```typescript
const platformEnvVars = [
  { name: 'EVE_API_URL',        value: /* internal API URL */ },
  { name: 'EVE_PUBLIC_API_URL', value: /* public API URL (optional) */ },
  { name: 'EVE_SSO_URL',        value: /* SSO broker URL (optional) */ },
  { name: 'EVE_PROJECT_ID',     value: context.projectId },
  { name: 'EVE_ORG_ID',         value: context.orgId },
  { name: 'EVE_ENV_NAME',       value: context.envName },
];
```

### Manifest Interpolation

Use `${SSO_URL}` in manifest env blocks (follows existing `${ENV_NAME}`, `${ORG_ID}` convention):

```yaml
services:
  web:
    environment:
      NEXT_PUBLIC_SSO_URL: "${SSO_URL}"
```

### JWT `orgs` Claim

User tokens include an `orgs` array populated at mint time:

```json
{
  "sub": "user_xxx",
  "email": "user@example.com",
  "type": "user",
  "orgs": [
    { "id": "org_ManualTestOrg", "role": "owner" },
    { "id": "org_example", "role": "admin" }
  ]
}
```

Limited to 50 most-recent memberships (`EVE_AUTH_ORGS_CLAIM_LIMIT`). The claim can become stale if membership changes after token mint. With default 1-day TTL this is acceptable. For immediate revocation, use `strategy: 'remote'`.

## Migration Guide

### From Custom Auth to `@eve-horizon/auth`

This section uses reference-app as a reference. The same pattern applies to any NestJS or Express app with hand-rolled Eve auth.

#### Before (reference-app: 777 lines)

```
Backend (444 lines):
  auth.service.ts      263 lines  — JWKS setup, org check, role mapping
  auth.middleware.ts     41 lines  — Bearer extraction, req.user
  auth.guard.ts          43 lines  — Route protection, SSE token fallback
  auth.controller.ts     69 lines  — /login, /logout, /me
  auth-config.ctrl.ts    16 lines  — SSO URL discovery (api. → sso. hack)
  auth.module.ts         12 lines  — NestJS wiring

Frontend (333 lines):
  useAuth.ts            140 lines  — SSO session probe, token cache, 3 login modes
  api/auth.ts            63 lines  — loginWithToken, login, logout, getMe
  api/client.ts          65 lines  — Token storage, Bearer injection
  LoginForm.tsx          65 lines  — SSO/token/password tabs
```

#### After (~50 lines)

**Backend (Express):**

```typescript
import { eveUserAuth, eveAuthGuard, eveAuthConfig } from '@eve-horizon/auth';

app.use(eveUserAuth());
app.get('/auth/config', eveAuthConfig());
app.get('/auth/me', eveAuthGuard(), (req, res) => res.json(req.eveUser));
```

**Backend (NestJS):**

```typescript
import { eveUserAuth, eveAuthGuard, eveAuthConfig } from '@eve-horizon/auth';

// In main.ts or AppModule bootstrap
app.use(eveUserAuth());

// Auth controller
@Controller('auth')
export class AuthController {
  @Get('config')
  config(@Req() req, @Res() res) {
    return eveAuthConfig()(req, res);
  }

  @Get('me')
  @UseGuards(EveGuard) // thin wrapper around eveAuthGuard()
  me(@Req() req) {
    return req.eveUser;
  }
}
```

**Frontend (React):**

```tsx
import { EveAuthProvider, EveLoginGate, useEveAuth, createEveClient } from '@eve-horizon/auth-react';

function App() {
  return (
    <EveAuthProvider apiUrl="/api">
      <EveLoginGate>
        <Dashboard />
      </EveLoginGate>
    </EveAuthProvider>
  );
}

// In components that need the API
const client = createEveClient('/api');
const res = await client.fetch('/data');
```

#### Step-by-Step Migration

**1. Install packages**

```bash
npm install @eve-horizon/auth        # backend
npm install @eve-horizon/auth-react  # frontend
```

**2. Replace backend auth (delete ~430 lines, add ~10)**

| Delete | Replacement |
|--------|-------------|
| `auth.service.ts` (JWKS, org check, role mapping) | `eveUserAuth()` handles all of this |
| `auth.middleware.ts` (Bearer extraction) | Built into `eveUserAuth()` token extraction |
| `auth.guard.ts` (route protection) | `eveAuthGuard()` |
| `auth-config.controller.ts` (SSO URL discovery) | `eveAuthConfig()` reads auto-injected `EVE_SSO_URL` |
| `auth.controller.ts` `/me` endpoint | One-liner: `res.json(req.eveUser)` |

Keep `auth.controller.ts` `/login` and `/logout` if you need local password auth (not covered by the shared packages).

**3. Replace frontend auth (delete ~330 lines, add ~15)**

| Delete | Replacement |
|--------|-------------|
| `useAuth.ts` (SSO probe, token cache) | `useEveAuth()` hook |
| `api/auth.ts` (login/logout API calls) | `useEveAuth().loginWithSso/loginWithToken/logout` |
| `api/client.ts` (token storage, Bearer) | `createEveClient()` |
| `LoginForm.tsx` | `EveLoginForm` (or `EveLoginGate` default fallback) |

**4. Remove the `api. → sso.` URL hack**

The old pattern guessed the SSO URL by replacing `api.` with `sso.` in the API hostname. With `EVE_SSO_URL` auto-injected, this is no longer needed. `eveAuthConfig()` reads from the env var directly.

**5. Verify**

```bash
# Backend serves auth config
curl http://localhost:3000/auth/config
# → { "sso_url": "http://sso.eve.lvh.me", "eve_api_url": "...", ... }

# Token verification works
TOKEN=$(eve auth token)
curl http://localhost:3000/auth/me -H "Authorization: Bearer $TOKEN"
# → { "id": "user_xxx", "email": "...", "orgId": "org_xxx", "role": "owner" }
```

#### What to Keep

- **Local password auth**: If your app supports direct email/password login (not SSO), keep that as app-specific code. The shared packages only handle SSO and token-based auth.
- **Custom role logic**: If you map Eve roles to app-specific permissions beyond `owner/admin/member`, keep that mapping in your app.
- **NestJS decorators**: The shared packages export plain Express middleware. For NestJS, write a thin guard wrapper:

```typescript
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class EveGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    return !!req.eveUser;
  }
}
```

## Relationship to Other Auth Docs

| Doc | Scope |
|-----|-------|
| [auth.md](./auth.md) | Platform auth internals (token minting, JWKS, dual-mode, identity) |
| [app-sso-integration.md](./app-sso-integration.md) | Quick-start guide for app developers |
| **This doc** | System-level SDK reference, architecture, migration guide |
| [agent-app-api-access.md](./agent-app-api-access.md) | Agent job token verification (`eveAuthMiddleware`) |

## File Map

```
packages/
  auth/                           ← @eve-horizon/auth
    src/
      index.ts                    ← Agent auth + re-exports user auth
      user.ts                     ← eveUserAuth, eveAuthGuard, eveAuthConfig
  auth-react/                     ← @eve-horizon/auth-react
    src/
      index.ts                    ← Public exports
      provider.tsx                ← EveAuthProvider context + bootstrap
      hooks.ts                    ← useEveAuth
      gate.tsx                    ← EveLoginGate
      login-form.tsx              ← EveLoginForm
      client.ts                   ← createEveClient, token storage
      types.ts                    ← EveUser, AuthConfig, EveAuthState
```
