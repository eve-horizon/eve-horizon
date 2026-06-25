# Plan: Trivial SSO for Eve-Compatible Apps

> Status: Draft
> Created: 2026-02-27
> Updated: 2026-02-28

## Problem

Every Eve-compatible app that needs user login reinvents the same authentication boilerplate. reference-app is the proof: hundreds of backend and frontend lines all doing the same thing: verify Eve tokens, check org membership, discover the SSO URL, manage browser sessions, render a login form.

When the next app ships (and the one after that), this pattern will be copy-pasted with subtle divergences. That's how auth bugs are born.

## Goal

Adding SSO login to an Eve-compatible app should require:

**Backend (Express/NestJS):** ~10 lines
```typescript
import { eveUserAuth, eveAuthConfig } from '@eve-horizon/auth';

// One middleware, one config endpoint
app.use(eveUserAuth({ orgId: process.env.EVE_ORG_ID }));
app.get('/auth/config', eveAuthConfig());
app.get('/auth/me', (req, res) => res.json(req.eveUser));
```

**Frontend (React):** ~15 lines
```tsx
import { EveAuthProvider, useEveAuth, EveLoginGate } from '@eve-horizon/auth-react';

function App() {
  return (
    <EveAuthProvider apiUrl="/api">
      <EveLoginGate>
        <ProtectedApp />
      </EveLoginGate>
    </EveAuthProvider>
  );
}
```

No SSO URL guessing. No JWKS setup. No cookie probing. No token refresh logic.

---

## Current State

### What Exists

| Component | Status | Notes |
|-----------|--------|-------|
| SSO broker (`apps/sso`) | Working | `/login`, `/callback`, `/session`, `/logout` |
| GoTrue (Supabase Auth) | Working | Email/password, magic links, invites |
| `@eve-horizon/auth` package | Working | Agent job token verification (JWKS + Express middleware) only; no user `orgs` claim extraction yet |
| `/auth/config` API endpoint | Working | Returns `{ sso_url, supabase_url, anon_key }` |
| `/auth/exchange` API endpoint | Working | Supabase HS256 → Eve RS256 |
| EVE_API_URL auto-injection | Working | Deployer injects into every app |
| `EVE_SSO_URL` auto-injection | **Draft** | Verify runtime wiring in deployer |
| SSO documentation | **Missing** | `/login` and `/session` endpoints undocumented |
| Shared Express auth middleware | **Missing** | Every app rebuilds JWKS + org check |
| Shared React auth SDK | **Missing** | Every app rebuilds useAuth + LoginForm |

### reference-app Auth Anatomy (Reference Implementation)

```
Backend (444 lines):
  auth.service.ts      263 lines  — JWKS setup, org check, role mapping, dual-mode
  auth.middleware.ts     41 lines  — Bearer extraction, req.user enrichment
  auth.guard.ts          43 lines  — Route protection, SSE token fallback
  auth.controller.ts     69 lines  — /login, /logout, /me endpoints
  auth-config.ctrl.ts    16 lines  — SSO URL discovery (api. → sso. hack)
  auth.module.ts         12 lines  — NestJS wiring

Frontend (333 lines):
  useAuth.ts            140 lines  — SSO session probe, token cache, 3 login modes
  api/auth.ts            63 lines  — loginWithToken, login, logout, getMe
  api/client.ts          65 lines  — Token storage, Bearer injection, base URL
  LoginForm.tsx         ~65 lines  — SSO/token/password tabs
```

### `@eve-horizon/auth` (Existing Package)

Already has the hard parts:
- JWKS fetching + 15-minute cache
- RS256 signature verification
- JWT claim parsing with expiry checks
- Express middleware pattern

But it's agent-scoped: attaches `req.agent`, returns "Invalid agent token", no org membership check.

**Critical gap:** `verifyEveToken()` doesn't extract the `orgs` claim from JWT payloads — `EveTokenClaims` only has `org_id` (singular, from job tokens). The `orgs` array claim (present in user tokens) is silently dropped during local verification. This must be fixed before user auth can work with the `'local'` (JWKS) strategy.

---

## Design

### Package Strategy

**Rename `@eve-horizon/auth` → `@eve-horizon/auth`** — don't create a third package. The JWKS verification, key caching, and token parsing are identical for agent and user tokens. The difference is what you do *after* verification: agents check job scoping, users check org membership.

We're in pre-deployment phase (no users, no external consumers). Skip the compatibility shim — rename the package directly and update all internal import sites in one pass.

```
@eve-horizon/auth (new primary package)
├── Agent auth (existing, unchanged)
│   ├── verifyEveToken()
│   ├── verifyEveTokenRemote()
│   └── eveAuthMiddleware()      → req.agent
│
└── User auth (new)
    ├── verifyEveUserToken()     → org check, role mapping
    ├── eveUserAuth()            → req.eveUser
    ├── eveAuthGuard()           → 401 if no req.eveUser
    └── eveAuthConfig()          → /auth/config handler

@eve-horizon/auth-react (new package)
├── EveAuthProvider              → context + session management
├── useEveAuth()                 → user, loading, login, logout
├── EveLoginGate                 → renders children only when authed
└── EveLoginForm                 → SSO button + token paste + password
```

### EVE_SSO_URL Auto-Injection

Add `EVE_SSO_URL` to the deployer's platform env vars, right next to `EVE_API_URL`:

```typescript
// deployer.service.ts — resolveServiceEnvEntries()
const platformEnvVars = [
  { name: 'EVE_API_URL', value: this.resolveServiceEveApiUrl(config.EVE_API_URL) },
  ...(config.EVE_PUBLIC_API_URL ? [{ name: 'EVE_PUBLIC_API_URL', value: config.EVE_PUBLIC_API_URL }] : []),
  ...(config.EVE_SSO_URL ? [{ name: 'EVE_SSO_URL', value: config.EVE_SSO_URL }] : []),  // NEW
  { name: 'EVE_PROJECT_ID', value: context.projectId },
  { name: 'EVE_ORG_ID', value: context.orgId },
  { name: 'EVE_ENV_NAME', value: context.envName },
];
```

Also add `${SSO_URL}` to manifest interpolation variables so apps can reference it in env blocks. Existing interpolation uses bare names without `EVE_` prefix (`${ENV_NAME}`, `${ORG_ID}`, `${ORG_SLUG}`, etc.), so follow that convention.
Use `${SSO_URL}`, not `${EVE_SSO_URL}`, for manifest interpolation.

This is the highest-leverage change — it removes the fragile `api. → sso.` convention entirely.

### Auth Config Discovery

Currently apps must implement their own `/auth/config` endpoint that either:
1. Reads `EVE_SSO_URL` from env, or
2. Hacks `api. → sso.` string replacement

With auto-injection, the shared middleware can provide this as a one-liner:

```typescript
// Returns { sso_url, eve_api_url, eve_public_api_url, eve_org_id }
app.get('/auth/config', eveAuthConfig());
```

This reads from env vars that the platform already injected. No guessing.

---

## Implementation Phases

### Phase 1: Auto-Inject EVE_SSO_URL

**Smallest change, biggest payoff.** Every deployed app gets the SSO URL for free.

**Changes:**
1. `apps/worker/src/deployer/deployer.service.ts` — Add `EVE_SSO_URL` to platform env vars (conditional, only when configured)
2. Add `${SSO_URL}` to manifest interpolation variables in `interpolateValue()` (follows existing `${ENV_NAME}`, `${ORG_ID}` naming convention)
3. `docs/system/deployment.md` — Document the new platform-injected variable
4. Update `../eve-skillpacks/eve-work/eve-read-eve-docs/references/deploy-debug.md` and `references/manifest.md` — Sync

Execution checklist:
- Owner: deployer + docs owners
- In scope:
  - Add `EVE_SSO_URL` only when non-empty in `resolveServiceEnvEntries()`.
  - Add `${SSO_URL}` interpolation in `interpolateValue()` (matching `${ENV_NAME}` etc. convention).
  - Document and sync changed behavior in platform docs and references.
- Acceptance:
  - A deployed service env list includes `EVE_SSO_URL` when configured.
  - `${SSO_URL}` expands in app manifest env blocks.
  - Existing apps without auth config continue to deploy with no behavior regression.

**Impact:** Apps can read `process.env.EVE_SSO_URL` directly. No discovery endpoint needed for server-side code.

### Phase 2: Rename `@eve-horizon/auth` → `@eve-horizon/auth`

Rename the package in-place and add user-auth exports. No compatibility shim needed (pre-deployment, no external consumers).

**2a. Rename + extend `EveTokenClaims`**

Rename `packages/app-auth/` → `packages/auth/`, update `package.json` name to `@eve-horizon/auth`, and update all internal import sites. Extend `EveTokenClaims` to include the `orgs` claim that user tokens carry:

```typescript
export interface EveTokenClaims {
  valid: true;
  type: 'user' | 'job' | 'service_principal';
  user_id: string;
  email?: string;
  org_id?: string | null;
  orgs?: Array<{ id: string; role: string }>;  // NEW: present in user tokens
  project_id?: string;
  job_id?: string;
  permissions?: string[];
  is_admin?: boolean;
  role?: string;
  iat?: number;
  exp?: number;
}
```

Update `verifyEveToken()` to extract the `orgs` claim from JWT payloads (currently silently dropped).

**2b. Add user auth middleware**

New exports in `packages/auth/src/user.ts`:

```typescript
export interface EveUser {
  id: string;
  email: string;
  orgId: string;
  role: 'owner' | 'admin' | 'member';
}

/**
 * Express middleware: verifies Eve RS256 token, checks org membership,
 * attaches req.eveUser. Non-blocking — unauthenticated requests pass through.
 */
export function eveUserAuth(options?: {
  orgId?: string;        // Override EVE_ORG_ID
  eveApiUrl?: string;    // Override EVE_API_URL
  strategy?: 'local' | 'remote';  // JWKS vs HTTP verify
}): RequestHandler;

/**
 * Express middleware: returns 401 if req.eveUser is not set.
 * Use after eveUserAuth() on protected routes.
 */
export function eveAuthGuard(): RequestHandler;

/**
 * Express handler for /auth/config endpoint.
 * Returns { sso_url, eve_api_url, eve_public_api_url, eve_org_id } from env.
 */
export function eveAuthConfig(): RequestHandler;
```

**How `eveUserAuth` works:**
1. Extract Bearer token from Authorization header (or `?token=` query for SSE)
2. Call existing `verifyEveToken()` (reuse JWKS cache)
3. Check `token.type === 'user'`
4. Check org membership: `token.orgs` array includes target org
5. Preserve role from token (don't collapse `owner` → `admin` — keep the full role)
6. Attach `req.eveUser = { id, email, orgId, role }`
7. Ignore non-user tokens (no `req.eveUser` mutation)

The org membership check uses the `orgs` claim already present in Eve user tokens:
```json
{
  "sub": "user_xxx",
  "email": "user@example.com",
  "type": "user",
  "orgs": [{ "id": "org_xxx", "role": "admin" }]
}
```

**Caveat: JWT `orgs` claim staleness.** The `orgs` array is populated at token mint time (from live DB) and can become stale if org membership changes after issuance. The Eve API itself uses live DB queries for auth decisions — but external apps using `@eve-horizon/auth` can only check the JWT claim. With default 1-day TTL this is an acceptable trade-off, but apps should be aware. For immediate membership revocation, apps can use the `'remote'` strategy which delegates to the API.

**2c. Add NestJS helpers (optional, stretch)**

For NestJS apps like reference-app, provide decorators:

```typescript
// Decorator versions (optional convenience)
export const EveUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest().eveUser,
);
```

Execution checklist:
- Owner: core backend/platform SDK owners
- In scope:
  - Rename `packages/app-auth` → `packages/auth`, update package name to `@eve-horizon/auth`.
  - Extend `EveTokenClaims` to include `orgs` claim; update `verifyEveToken()` to extract it.
  - Add `user.ts` with `EveUser` type, `eveUserAuth`, `eveAuthGuard`, and `eveAuthConfig`.
  - Update all internal import sites (`@eve-horizon/auth` → `@eve-horizon/auth`).
  - Add optional NestJS decorator helper only if needed by reference-app migration.
- Acceptance:
  - All internal imports compile against `@eve-horizon/auth`.
  - New `@eve-horizon/auth` user middleware populates `req.eveUser` on matched routes.
  - `eveUserAuth` only populates `req.eveUser` for verified user tokens in the target org.
  - `eveAuthConfig` serves `{ sso_url, eve_api_url, eve_public_api_url, eve_org_id }` from platform env vars.

### Phase 3: `@eve-horizon/auth-react`

New package: `packages/auth-react/`

**3a. EveAuthProvider + useEveAuth**

```typescript
// packages/auth-react/src/index.ts
export function EveAuthProvider({
  apiUrl,        // Backend API base URL (default: '/api')
  children
}: Props);

export function useEveAuth(): {
  user: EveUser | null;
  loading: boolean;
  error: string | null;
  loginWithSso: () => void;
  loginWithToken: (token: string) => Promise<void>;
  logout: () => void;
};
```

**Session bootstrap logic (the 140 lines from reference-app, distilled):**

```
1. Check sessionStorage for cached token
   → check exp claim locally (skip network if expired)
   → validate via GET {apiUrl}/auth/me
   → if valid: set user, done
   → if expired/invalid: clear sessionStorage, fall through

2. Check document.cookie for eve_sso hint
   → fetch GET {apiUrl}/auth/config (get sso_url)
   → fetch GET {sso_url}/session (credentials: include)
   → if success: store access_token in sessionStorage
   → validate via GET {apiUrl}/auth/me
   → if valid: set user, done

3. Unauthenticated → user = null, loading = false
```

**Token expiry handling:** User tokens default to 1-day TTL. The SDK handles this transparently: when a cached token expires, the bootstrap re-probes the SSO session cookie (30-day TTL). If the SSO refresh token is also expired, the user sees the login form. No manual token refresh logic needed in apps.

**3b. EveLoginGate**

Renders children when authenticated, login form when not:

```tsx
export function EveLoginGate({
  children,
  fallback,  // Optional custom login component
}: Props);
```

Default fallback is `<EveLoginForm />`.

**3c. EveLoginForm**

Clean, minimal login component with two modes:
- **SSO** (default): "Sign in with Eve" button → redirects to SSO
- **Token**: Paste an `eve auth token` output

No password mode by default (that's local-auth-only, apps can add it if needed).

**3d. HTTP client helper**

```typescript
/**
 * Creates a fetch wrapper that injects the Eve token.
 * Use for API calls to your backend.
 */
export function createEveClient(baseUrl?: string): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  getToken: () => string | null;
};
```

Execution checklist:
- Owner: frontend SDK owner
- In scope:
  - Add `@eve-horizon/auth-react` package with provider, hook, gate, login form, and `createEveClient`.
  - Keep SDK default to sessionStorage and preserve explicit SSO fallback flow.
  - Document local-token flow as an explicit opt-in path.
- Acceptance:
  - New app can render protected route behind `EveLoginGate`.
  - `useEveAuth()` reports loading and authenticated state without custom token plumbing.
  - Login via SSO and token fallback both converge on the same user context state.

### Phase 4: Documentation

**4a. New doc: `docs/system/app-sso-integration.md`**

Complete guide for adding SSO to an Eve-compatible app:

1. **Prerequisites** — EVE_SSO_URL, EVE_ORG_ID (auto-injected)
2. **Backend setup** — Install `@eve-horizon/auth`, add middleware, add /auth/config endpoint
3. **Frontend setup** — Install `@eve-horizon/auth-react`, wrap with provider, add gate
4. **How it works** — Token flow diagram, session management, CORS
5. **Advanced** — Custom roles, token paste mode, SSE auth, NestJS integration
6. **Reference** — SSO endpoints (`/login`, `/session`, `/callback`, `/logout`)

**4b. Update existing docs**

- `docs/system/auth.md` — Add "App Integration" section pointing to new guide
- `docs/system/deployment.md` — Document EVE_SSO_URL auto-injection
- `docs/system/agent-app-api-access.md` — Cross-reference the new package

**4c. Update eve-skillpacks**

- `references/secrets-auth.md` — EVE_SSO_URL auto-injection
- `references/deploy-debug.md` — New platform env vars
- `references/overview.md` — Mention shared auth packages

Execution checklist:
- Owner: docs owners
- In scope:
  - Publish `docs/system/app-sso-integration.md`.
  - Update auth/deployment docs with canonical `/auth/config` flow.
  - Sync references for env vars, interpolation, and platform debug behavior.
- Acceptance:
  - New app onboarding path is documented end-to-end.
  - No stale references to `/auth/config` remain in the linked docs set.
  - Reference docs describe the injected env vars and interpolation key.

### Phase 5: Migrate reference-app

Prove the packages work by migrating reference-app from 780 lines → ~50 lines:

1. Replace `auth.service.ts` (263 lines) → `eveUserAuth()` middleware
2. Replace `auth.middleware.ts` + `auth.guard.ts` (84 lines) → `eveAuthGuard()`
3. Replace `auth-config.controller.ts` (16 lines) → `eveAuthConfig()`
4. Replace `useAuth.ts` (140 lines) → `useEveAuth()`
5. Replace `LoginForm.tsx` → `EveLoginForm`
6. Remove `api/auth.ts` + `api/client.ts` → `createEveClient()`

Keep local auth mode as an app-specific opt-in (not in shared packages).

Execution checklist:
- Owner: reference-app app owner
- In scope:
  - Replace auth service/middleware/guard/config/token plumbing with shared package equivalents.
  - Remove duplicated token/session/client helpers.
  - Keep local-password path only as explicit opt-in.
- Acceptance:
  - Backend auth path reduced to thin wrappers around `@eve-horizon/auth`.
  - Frontend auth path reduced to thin wrappers around `@eve-horizon/auth-react`.
  - Feature parity remains for SSO login and token bootstrap.

---

## What We're NOT Doing

- **Not replacing GoTrue** — It handles email/password, magic links, invites. That stays.
- **Not changing the SSO broker** — `/login`, `/callback`, `/session` work fine. No changes needed.
- **Not adding OAuth providers** — Google, GitHub, etc. are a GoTrue config change, not a platform change.
- **Not building a Supabase client** — The SSO broker already abstracts GoTrue. Apps talk to the SSO broker, not GoTrue directly.
- **Not supporting non-Express backends** — Express/NestJS covers our apps. Other frameworks can use the verification functions directly.
- **Not adding server-side sessions** — Stateless JWTs. The SSO cookie is the only server-side state, and that lives in the SSO broker.

---

## File Map

```
packages/
  auth/                          ← @eve-horizon/auth (renamed from app-auth)
    package.json                 ← @eve-horizon/auth
    src/
      index.ts                   ← re-exports everything
      agent.ts                   ← existing agent auth (moved from single-file entry)
      user.ts                    ← NEW: eveUserAuth, eveAuthGuard, eveAuthConfig
      types.ts                   ← shared types (EveUser, EveTokenClaims with orgs)

  auth-react/                    ← NEW package
    package.json                 ← @eve-horizon/auth-react
    src/
      index.ts                   ← public exports
      provider.tsx               ← EveAuthProvider context
      hooks.ts                   ← useEveAuth
      gate.tsx                   ← EveLoginGate
      login-form.tsx             ← EveLoginForm component
      client.ts                  ← createEveClient

apps/worker/src/deployer/
  deployer.service.ts            ← add EVE_SSO_URL to platform env vars

docs/system/
  app-sso-integration.md         ← NEW: complete SSO integration guide
  auth.md                        ← update: cross-reference
  deployment.md                  ← update: document EVE_SSO_URL injection
```

---

## Sequencing

| Phase | Effort | Depends On | Value |
|-------|--------|------------|-------|
| 1. Auto-inject EVE_SSO_URL | Small | Nothing | High — eliminates URL guessing |
| 2. @eve-horizon/auth package | Medium | Phase 1 | High — eliminates backend boilerplate |
| 3. @eve-horizon/auth-react | Medium | Phase 2 | High — eliminates frontend boilerplate |
| 4. Documentation | Small | Phases 1-3 | High — makes it discoverable |
| 5. reference-app migration | Small | Phases 2-3 | Proof — validates the design |

Phases 1 and 2 can start in parallel. Phase 3 needs the backend package for type sharing. Phase 5 is the validation that the abstractions are right.

### Risks and Mitigations

- Package rename risk: breaking internal import paths during `@eve-horizon/auth` → `@eve-horizon/auth` rename.
  - Mitigation: pre-deployment phase means no external consumers. Single-pass rename of all internal import sites.
- JWT staleness risk: `orgs` claim in tokens can become stale if membership changes after token mint.
  - Mitigation: default 1-day TTL limits staleness window. Apps needing immediate revocation can use `'remote'` strategy.
- Endpoint/contract risk: `eveAuthConfig` response shape changes could break existing consumers.
  - Mitigation: keep `/auth/config` shape additive and treat all fields as optional in SDK parsing.
- Security risk: token extraction from query params can leak tokens in logs.
  - Mitigation: keep `?token=` support opt-in and document SSE/local-debug use only.
  - Mitigation: avoid logging Authorization headers and query tokens in middleware helpers.

---

## Success Criteria

1. A new Express app can add Eve SSO login with `npm install @eve-horizon/auth` and ~10 lines of code
2. A new React app can add SSO UI with `npm install @eve-horizon/auth-react` and ~15 lines of code
3. EVE_SSO_URL is automatically available in all deployed apps (no manual config)
4. The SSO `/login` and `/session` endpoints are documented with examples and fallback behavior
5. reference-app auth code drops significantly (target: ~50 lines of app-level auth glue)
