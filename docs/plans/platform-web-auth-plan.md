# Platform Web Auth — Unified Design & Implementation Plan

> Status: Plan (Draft)
> Last Updated: 2026-02-12
> Supersedes: `docs/ideas/platform-web-auth-supabase.md`, `docs/ideas/platform-web-auth-supabase-sso.md`

## Problem

Eve Horizon has powerful machine-identity auth (SSH challenge, Nostr, service principals) but no browser-friendly auth. The dashboard plan relies on a paste-a-token stopgap. Every Eve-compatible web app would need to reinvent browser login independently.

We need a single login that works across every app on a cluster domain — log in once, authenticated everywhere.

## Requirements

1. **Browser-friendly login**: email/password, magic link, OAuth (later).
2. **Portable SSO**: log in once on `*.eve.example.com` and be authenticated on every app on that cluster domain.
3. **Eve RS256 tokens**: web apps receive Eve RS256 JWTs — they never need to understand Supabase tokens.
4. **Eve user IDs preserved**: keep `user_...` TypeIDs; Supabase UUID mapped via `identities(provider='supabase')`.
5. **Invite-only by default**: staging/production use invite-gated signup; dev/test allow open signup.
6. **CLI invite integration**: `eve admin invite --web` triggers Supabase Auth invite emails.
7. **Pluggable email**: local dev uses Mailpit (capture-only); staging uses AWS SES.
8. **Existing auth unchanged**: SSH, Nostr, service principal, and job token flows continue working.
9. **Dual-mode verification**: Eve API accepts both RS256 (internal) and HS256 (Supabase) tokens concurrently — not exclusively one or the other.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Session portability | Root-domain httpOnly cookie via SSO broker | `localStorage` is per-origin; cookies scoped to `.<cluster-domain>` share across all apps |
| **Cookie domain** | `Domain=.${EVE_DEFAULT_DOMAIN}` | Matches how the platform already defines "the app domain"; correct per-cluster isolation boundary; deterministic across all subdomains. Requires `EVE_DEFAULT_DOMAIN` set correctly (already required by worker/deployer). |
| Token strategy | Exchange Supabase → Eve RS256 (Option A) | Avoids forcing all Eve internals to Supabase mode; job tokens, service principals, SSH all stay RS256 |
| SSO broker placement | Standalone service `apps/sso` | Clean separation; no coupling to API process |
| **GoTrue redirect target** | Always SSO broker (`sso.<domain>/callback`) | `GOTRUE_SITE_URL` points at SSO broker. All magic links, invites, password resets, and OAuth callbacks land on SSO first. SSO finalizes auth, sets root-domain cookie, then redirects to the originating app. Apps never implement Supabase callback handling. |
| User ID strategy | Eve `user_...` TypeIDs, Supabase UUID linked via `identities` | Existing RBAC, memberships, and tooling all reference TypeIDs |
| Signup policy | Invite-only default, configurable per environment | Production security with dev ergonomics |
| **GoTrue database** | Shared Postgres instance, dedicated `eve_auth_admin` role scoped to `auth` schema | No new StatefulSet/PVC; unified backup/restore; dedicated role limits blast radius (GoTrue can't alter `public.*`). |
| API auth mode | Concurrent dual-mode (RS256 + HS256) | Replaces current single-mode switch; both token families verified simultaneously |
| **DB role provisioning** | Deploy-time bootstrap job | Deterministic + idempotent; runs before GoTrue starts. Keeps app runtime simpler (API/SSO don't need `CREATE ROLE` logic). Wired into `./bin/eh k8s deploy` and staging deploy workflow. |
| **SSO token minting** | SSO calls Eve API (`POST /auth/exchange`); never holds signing key | Cleaner security boundary: only Eve API holds `EVE_AUTH_PRIVATE_KEY`. Centralizes auth policy (linking, membership, RBAC claims). Easier key rotation. One extra hop is acceptable since API must be up anyway. |
| **Exchange endpoint input** | Bearer Supabase access token only (`Authorization: Bearer <supabase_access_token>`) | Clean API: "prove you're a Supabase user by presenting a valid token". No extra body needed. Eve API verifies HS256 via `SUPABASE_JWT_SECRET`. Additional IdPs would add new exchange endpoints or a `provider` param. |
| **Local mail capture** | Mailpit | Modern UI, active maintenance, good search/filtering. Single container for SMTP sink + web UI. |
| **Staging email** | AWS SES via SMTP credentials directly to GoTrue | GoTrue natively supports SMTP; no relay service needed. Least moving parts: just secrets + env vars. |

## What We Already Have

### Eve Auth Today

- JWT-based auth (`docs/system/auth.md`) with RS256 internal mode.
- `AuthService` at `apps/api/src/auth/auth.service.ts` has:
  - Full RS256 token minting/verification (user, job, service principal tokens).
  - HS256 Supabase verification (line 1019-1026) — but in single-mode: `internal` OR `supabase`, not both.
  - `AuthMode = 'internal' | 'supabase' | 'disabled'` (line 99).
- Pluggable identity providers: SSH + Nostr already registered (`auth.module.ts`).
- Invite system: `org_invites` table, `auth.invites.controller.ts`, CLI `eve admin invite`.
- Key rotation support with grace period.
- JWKS endpoint at `/.well-known/jwks.json`.

### Supabase Auth Touchpoints Today

- CLI has legacy Supabase password login (`packages/cli/src/commands/auth.ts:53-78`).
- Config schema has `SUPABASE_JWT_SECRET`, `SUPABASE_URL`, `EVE_SUPABASE_URL` (all optional).
- When `SUPABASE_JWT_SECRET` is set, auth guard switches to HS256 mode and auto-provisions users.

### Critical Constraint

The current implementation is **single-mode** (`internal` OR `supabase`). Switching to Supabase mode breaks RS256 token paths (job tokens, service principal tokens, SSH challenge minting). **Phase 2 of this plan fixes this by making verification dual-mode.**

## Architecture

```
                                   ┌─────────────────────────────┐
                                   │   Eve-compatible web app     │
                                   │   (dashboard, admin, etc.)   │
                                   └───────────┬─────────────────┘
                                               │ fetch('https://sso.<domain>/session')
                                               │ credentials: include
                                               ▼
┌──────────────┐  Eve RS256 JWT   ┌────────────────────────────────┐
│   Eve API    │◄─────────────────│  SSO Broker (apps/sso)         │
│   (NestJS)   │                  │  sso.<cluster-domain>          │
│              │─────────────────►│  • /login  → GoTrue login page │
│  RS256 + HS256                  │  • /session → Eve RS256 token  │
│  dual verify │  POST /auth/     │  • /logout → clear cookies     │
│              │  exchange         │  • httpOnly refresh cookie     │
└──────┬───────┘                  └──────────┬─────────────────────┘
       │                                     │ refresh token
       │                                     ▼
       │                          ┌──────────────────────────────┐
       │                          │  Supabase Auth (GoTrue)       │
       │                          │  auth.<cluster-domain>        │
       │                          │  Port 9999                    │
       │                          │  auth.* schema (auto-managed) │
       │                          └──────────┬───────────────────┘
       │                                     │
       ▼                                     ▼
  ┌────────────────────────┐     ┌─────────────────────┐
  │  PostgreSQL             │     │  SMTP Provider       │
  │  public.*  (Eve tables)│     │  Local: Mailpit      │
  │  auth.*    (GoTrue)    │     │  Staging: AWS SES    │
  └────────────────────────┘     └─────────────────────┘
```

### URL / Domain Convention

| Environment | Cluster Domain | Auth URL | SSO URL | Mail UI |
|-------------|---------------|----------|---------|---------|
| Local (k3d) | `*.lvh.me` | `http://auth.eve.lvh.me` | `http://sso.eve.lvh.me` | `http://mail.eve.lvh.me` |
| Staging | `*.eve.example.com` | `https://auth.eve.example.com` | `https://sso.eve.example.com` | — |

Cookie domain: `Domain=.${EVE_DEFAULT_DOMAIN}` (e.g., `.lvh.me` local, `.eve.example.com` staging) so every app on the cluster shares the session. This uses the same `EVE_DEFAULT_DOMAIN` config that the worker/deployer already require for ingress routing.

## Auth Flow (Browser)

### 1. Unauthenticated User Visits Any App

App-level: redirect to `https://sso.<cluster-domain>/login?redirect_to=<current_url>`.

Long-term: ingress-level auth middleware (`x-eve.ingress.auth: platform`) performs the redirect automatically.

### 2. Login Happens Once, Centrally

`GET https://sso.<cluster-domain>/login?redirect_to=...`

User chooses email/password, magic link, or OAuth (later). SSO broker renders a minimal login UI that calls GoTrue endpoints.

### 3. SSO Stores a Shared Session Cookie

On successful login, SSO broker stores the GoTrue refresh token:

- `eve_sso_rt=<refresh_token>` — `HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.${EVE_DEFAULT_DOMAIN}`
- `eve_sso=1` — non-httpOnly session hint for UX (skip redirect loops)

The SSO broker reads `EVE_DEFAULT_DOMAIN` from its env to set the cookie domain. This is the same var the worker uses for ingress routing, so it's always available in the cluster config.

### 4. Any App Can Fetch an Access Token

```
GET https://sso.<cluster-domain>/session
  credentials: include
  → { access_token, expires_at, user: { id, email } }
```

SSO broker:
1. Reads refresh token cookie.
2. Calls GoTrue refresh (`POST /auth/v1/token?grant_type=refresh_token`).
3. Calls Eve API exchange (`POST /auth/exchange`) with Supabase access token.
4. Returns Eve RS256 token to the app.

This is what makes login portable — the refresh token cookie is shared across the cluster domain.

## Token Exchange (Eve API)

New endpoint: `POST /auth/exchange`

```
Authorization: Bearer <supabase_access_token>
→ { access_token: <eve_rs256_token>, token_type: "bearer", expires_at, user_id }
```

The exchange endpoint accepts a Supabase access token as a standard `Authorization: Bearer` header — no request body needed. "Prove you're a Supabase user by presenting a valid token."

**Security boundary**: Only the Eve API holds `EVE_AUTH_PRIVATE_KEY` and can mint RS256 tokens. The SSO broker calls this endpoint — it never holds signing keys itself. This centralizes all auth policy (identity linking, membership checks, RBAC claims) in one place and simplifies key rotation.

Flow:
1. Verify HS256 Supabase token (extract `sub` UUID and `email`).
2. Look up `identities(provider='supabase', fingerprint=<uuid>)`.
3. If found: resolve Eve user, mint RS256 token.
4. If not found: match by `users.email`, create identity link, mint RS256 token.
5. If no user exists: auto-provision user (if config allows) or reject.

This keeps RS256 as the single token format for all Eve API consumers.

## Eve User ↔ Supabase User Linking

Eve keeps `users.id` as `user_...` TypeIDs. The Supabase UUID is stored as an identity:

- `identities.provider = 'supabase'`
- `identities.fingerprint = <supabase_user_uuid>`
- `identities.public_key = <supabase_user_uuid>`

Linking strategy (invite-only clusters):
1. Admin invites user by email → creates Eve `users` row + org membership.
2. GoTrue invite email is sent (via SSO broker admin endpoint).
3. On first Supabase login, Eve API links UUID to existing user by `users.email` match.
4. Future logins resolve by the `identities(provider='supabase')` mapping directly.

## CLI Invite Flow (Email + Magic Link)

### Enhanced `eve admin invite`

```bash
eve admin invite --email user@example.com --org org_xxx --role member --web
```

With `--web`:
1. Ensure org membership exists (current behavior).
2. Call Eve API: `POST /auth/supabase/invite` with `{ email, redirect_to? }`.
3. Eve API calls GoTrue admin API (service role key) to send invite email.
4. User clicks link → lands on SSO login → completes signup → authenticated.

The Eve API holds the GoTrue service role key (system secret) — the CLI never sees it.

## Email Provider Wiring

GoTrue email is configured via SMTP env vars. Different SMTP settings per environment:

| Environment | SMTP Host | SMTP Port | Auth | Web UI |
|---|---|---|---|---|
| **Local (k3d)** | `mailpit.eve.svc` | 1025 | None | `http://mail.eve.lvh.me` |
| **Staging** | `email-smtp.{region}.amazonaws.com` | 587 | SES SMTP creds | — |

For local dev, Mailpit captures all outgoing email with a clean web UI. No emails leave the machine.

## Platform Env Vars for Apps

Extend platform-provided env vars (see `docs/system/manifest.md`):

- `EVE_PUBLIC_SSO_URL` — e.g., `https://sso.eve.example.com`
- `EVE_PUBLIC_SUPABASE_AUTH_URL` — e.g., `https://auth.eve.example.com`
- `EVE_SUPABASE_ANON_KEY` — public anon JWT for GoTrue API calls

## Ingress-Level Auth (Long-Term)

Manifest extension:

```yaml
services:
  web:
    x-eve:
      ingress:
        public: true
        auth: platform   # NEW
```

When `auth: platform` is set, the deployer injects ingress middleware that:
- Calls `https://sso.<cluster-domain>/verify` on every request.
- Redirects to `/login` when unauthenticated.
- Forwards `X-Eve-User-Id` header to the app.

This makes auth automatic for apps that don't want to embed auth code.

---

## Implementation Phases

### Phase 1: GoTrue + Mailpit on Local Stack

**Goal**: Deploy Supabase Auth (GoTrue) and Mailpit as platform services on the k3d local stack.

**K8s manifests** (new files in `k8s/base/`):

1. `supabase-auth-deployment.yaml` — GoTrue container (`supabase/gotrue:v2.185.0`), port 9999, readiness/liveness probes on `/health`.
2. `supabase-auth-service.yaml` — ClusterIP on port 9999.
3. `supabase-auth-ingress.yaml` — `auth.eve.lvh.me` (local), `auth.<staging-domain>` (staging).
4. `supabase-auth-secret.yaml` — GoTrue env: `GOTRUE_DB_DATABASE_URL` (using `eve_auth_admin` role), `GOTRUE_JWT_SECRET`, `API_EXTERNAL_URL` (GoTrue public URL), `GOTRUE_SITE_URL` (**always SSO broker URL**: `http://sso.eve.lvh.me` local, `https://sso.<staging-domain>` staging), SMTP settings, `GOTRUE_SMTP_ADMIN_EMAIL`.
5. `mailpit-deployment.yaml` — Mailpit container (SMTP 1025, Web UI 8025).
6. `mailpit-service.yaml` — ClusterIP on ports 1025 + 8025.
7. `mailpit-ingress.yaml` — `mail.eve.lvh.me`.

**Kustomization updates**:
- Add all new resources to `k8s/base/kustomization.yaml`.
- Local overlay: patch GoTrue with `GOTRUE_DISABLE_SIGNUP=false`, `GOTRUE_MAILER_AUTOCONFIRM=false`, local URLs, local SMTP to Mailpit.
- Staging overlay: patch with `GOTRUE_DISABLE_SIGNUP=true`, SES SMTP settings, staging URLs.

**Database migration** (`packages/db/migrations/`):
```sql
-- Create a dedicated role for GoTrue, scoped to the auth schema.
-- GoTrue auto-creates and manages the 'auth' schema on startup.
-- This role has CREATE on the database (needed for schema creation)
-- but is NOT granted access to public.* — clean blast radius.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'eve_auth_admin') THEN
    CREATE ROLE eve_auth_admin LOGIN PASSWORD 'eve_auth';
  END IF;
END $$;

-- GoTrue needs CREATE privilege to create the auth schema
GRANT CREATE ON DATABASE eve TO eve_auth_admin;

-- Grant usage on public schema (GoTrue references auth.users → may need cross-schema FKs)
-- but NOT write access to public tables
GRANT USAGE ON SCHEMA public TO eve_auth_admin;
```

The `eve_auth_admin` role can create/manage `auth.*` but cannot alter `public.*` tables. GoTrue's auto-migration handles all schema management within `auth`.

**DB role bootstrap job** (new `k8s/base/auth-bootstrap-job.yaml`):

A one-shot K8s Job that runs before GoTrue starts:
1. Connects to PostgreSQL with the main Eve DB credentials.
2. Creates/updates the `eve_auth_admin` role with the password from secrets.
3. Grants `CREATE ON DATABASE` and `USAGE ON SCHEMA public`.
4. Idempotent — safe to re-run on every deploy.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: auth-db-bootstrap
  annotations:
    argocd.argoproj.io/hook: PreSync   # runs before GoTrue deployment
spec:
  template:
    spec:
      containers:
        - name: bootstrap
          image: postgres:16-alpine
          command: ["psql", "-f", "/scripts/bootstrap-auth-role.sql"]
          env:
            - name: PGHOST
              valueFrom: { secretKeyRef: { name: app-secret, key: EVE_DB_HOST } }
            - name: PGDATABASE
              value: eve
            - name: PGUSER
              valueFrom: { secretKeyRef: { name: app-secret, key: EVE_DB_USER } }
            - name: PGPASSWORD
              valueFrom: { secretKeyRef: { name: app-secret, key: EVE_DB_PASSWORD } }
            - name: AUTH_ROLE_PASSWORD
              valueFrom: { secretKeyRef: { name: app-secret, key: EVE_AUTH_ADMIN_PASSWORD } }
          volumeMounts:
            - name: scripts
              mountPath: /scripts
      volumes:
        - name: scripts
          configMap:
            name: auth-bootstrap-scripts
      restartPolicy: OnFailure
```

Wire into `./bin/eh k8s deploy` so it runs after migrations and before GoTrue rolls out. For staging, the CI deploy workflow applies the Job before the GoTrue Deployment.

**Secrets wiring** (`k8s/base/app-secret.yaml`):
- Add `SUPABASE_JWT_SECRET` (shared between GoTrue and Eve API).
- Add `SUPABASE_AUTH_SERVICE_KEY` (service role JWT for admin API calls).
- Add `EVE_AUTH_ADMIN_PASSWORD` (password for the `eve_auth_admin` DB role; used by bootstrap job and GoTrue connection string).
- Update `./bin/eh k8s secrets` to generate and populate these.

**Config schema** (`packages/shared/src/config/schema.ts`):
- Add `SUPABASE_AUTH_URL: z.string().url().optional()` — GoTrue service URL.
- Add `SUPABASE_AUTH_SERVICE_KEY: z.string().optional()` — service role JWT.
- Add `SUPABASE_ANON_KEY: z.string().optional()` — anon JWT.

**Anon key + service role key generation**:
- Add to `./bin/eh k8s secrets` (or bootstrap): generate HS256 JWTs with `role: anon` and `role: service_role` signed with `SUPABASE_JWT_SECRET`.

**Smoke test**:
- Create user via GoTrue REST API → verify token issued.
- Send magic link → verify Mailpit captures email.
- Verify GoTrue `/health` endpoint via `auth.eve.lvh.me`.

**Deliverables**: GoTrue + Mailpit running on local stack, `auth.eve.lvh.me` serving GoTrue API, `mail.eve.lvh.me` showing captured emails.

---

### Phase 2: Eve API Dual-Mode Auth + Token Exchange

**Goal**: Make Eve API accept both RS256 (internal) and HS256 (Supabase) tokens concurrently, and add a token exchange endpoint.

**Auth service changes** (`apps/api/src/auth/auth.service.ts`):

Replace the single-mode switch (line 127-129):

```typescript
// BEFORE: this.mode = config.SUPABASE_JWT_SECRET ? 'supabase' : 'internal';
// AFTER: both modes active when both keys are configured
this.supabaseSecret = config.SUPABASE_JWT_SECRET;
this.hasInternalKeys = Boolean(this.signerKey);
```

Update `verifyAuthorizationHeader()` to try RS256 first, then HS256:

```typescript
async verifyAuthorizationHeader(header: string): Promise<AuthUser> {
  const token = this.extractBearerToken(header);
  const rawPayload = decodeJwtPayload(token);

  // Job and service principal tokens are always RS256
  if (rawPayload?.type === 'job') return this.resolveJobTokenAuth(token);
  if (rawPayload?.type === 'service_principal') return this.resolveServicePrincipalTokenAuth(token);

  // Try RS256 (internal user token) first
  if (this.hasInternalKeys) {
    try { return this.resolveInternalToken(token); } catch { /* fall through */ }
  }

  // Try HS256 (Supabase token)
  if (this.supabaseSecret) {
    return this.resolveSupabaseToken(token);
  }

  throw new UnauthorizedException('No valid token verification method available');
}
```

**New Supabase user resolution** (enhanced from current auto-provision):

```typescript
private async resolveSupabaseToken(token: string): Promise<AuthUser> {
  const claims = this.verifySupabaseToken(token);
  const supabaseUuid = claims.sub;

  // 1. Look up by Supabase identity link
  const identity = await this.identities.findByFingerprint('supabase', supabaseUuid);
  if (identity) {
    const user = await this.users.findById(identity.user_id);
    if (user) return this.authUserFromUser(user);
  }

  // 2. Match by email (first login after invite)
  if (claims.email) {
    const user = await this.users.findByEmail(claims.email);
    if (user) {
      // Create identity link for future logins
      await this.identities.create({
        id: generateIdentityId(),
        user_id: user.id,
        provider: 'supabase',
        public_key: supabaseUuid,
        fingerprint: supabaseUuid,
        label: 'supabase-auto-linked',
      });
      return this.authUserFromUser(user);
    }
  }

  // 3. Auto-provision (dev/test only, or if invite exists)
  // ... create user with Eve TypeID, link Supabase UUID
}
```

**Token exchange endpoint** (`apps/api/src/auth/auth.controller.ts`):

```typescript
@Post('auth/exchange')
async exchangeToken(@Headers('authorization') authHeader: string) {
  // Verify the Supabase HS256 token
  // Resolve to Eve user (link by identity or email)
  // Mint and return Eve RS256 token
}
```

**Display name extraction**: Pull `user_metadata.name` from Supabase JWT claims into `users.display_name` on first login.

**Org invite auto-apply**: On first GoTrue login, if an `org_invite` exists matching the email, auto-apply it (create membership).

**Tests**:
- RS256 user token still works (regression).
- HS256 Supabase token verifies and resolves to Eve user.
- Job tokens and service principal tokens still work (RS256 only).
- Token exchange endpoint returns Eve RS256 token from Supabase input.
- Email-matched linking creates identity row.
- Second login resolves via identity link (not email match).

**Deliverables**: Eve API verifies both token families concurrently; exchange endpoint mints Eve RS256 tokens from Supabase tokens.

---

### Phase 3: SSO Broker Service

**Goal**: Build the SSO broker (`apps/sso`) that owns the shared browser session and makes login portable across apps.

**New service** (`apps/sso/`):

A lightweight Node.js/Express (or Fastify) service with:

- `GET /login?redirect_to=...` — Renders minimal login UI (email/password form + magic link option). Calls GoTrue REST endpoints.
- `GET /callback` — GoTrue redirects here after OAuth/magic link. Extracts tokens.
- `GET /session` — Returns Eve RS256 access token from refresh cookie. This is the key portability endpoint.
- `POST /logout` — Clears session cookies.
- `GET /verify` — Quick token validity check for ingress middleware (later).

**GoTrue redirect configuration**:

`GOTRUE_SITE_URL` always points at the SSO broker: `https://sso.${EVE_DEFAULT_DOMAIN}`. All GoTrue email links (magic links, invites, password resets) and OAuth callbacks land on `sso.<domain>/callback`. The SSO broker finalizes auth, sets the root-domain cookie, then redirects to the originating app. This centralizes all the tricky parts (PKCE, token parsing, cookie write, redirect validation) and guarantees the portable login cookie gets set regardless of which app initiated the login.

**Session management**:

On successful login:
1. GoTrue returns access token + refresh token (via callback to SSO broker).
2. SSO broker calls `POST /auth/exchange` on Eve API with the Supabase access token → gets Eve RS256 token.
3. Stores GoTrue refresh token in httpOnly cookie: `eve_sso_rt=<refresh_token>; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.${EVE_DEFAULT_DOMAIN}`.
4. Sets UX hint cookie: `eve_sso=1; Path=/; Domain=.${EVE_DEFAULT_DOMAIN}`.
5. Redirects to the originating app's `redirect_to` URL (validated against allowed domains).

**`/session` endpoint** (called by every app):
1. Read `eve_sso_rt` cookie.
2. Call GoTrue refresh → get new Supabase access token.
3. Call Eve API exchange → get Eve RS256 token.
4. Return `{ access_token, expires_at, user: { id, email } }`.
5. CORS: allow `*.${EVE_DEFAULT_DOMAIN}` origins with `credentials: include`.

**K8s manifests**:
- `sso-deployment.yaml`, `sso-service.yaml`, `sso-ingress.yaml` (`sso.eve.lvh.me` / `sso.<staging-domain>`).

**Docker image**: Add `apps/sso` to the build pipeline (Dockerfile, k3d image push).

**Login UI**: Minimal HTML/CSS form. No framework needed — server-rendered pages. Styled to match Eve branding.

**Deliverables**: SSO broker running at `sso.eve.lvh.me`; any app can fetch Eve RS256 tokens via `/session` using shared cookies.

---

### Phase 4: CLI Invite + Admin Endpoints

**Goal**: Wire CLI `eve admin invite --web` to send GoTrue invite emails, and add the Supabase admin endpoints to Eve API.

**Eve API admin endpoint** (`apps/api/src/auth/auth.controller.ts`):

```typescript
@Post('auth/supabase/invite')
@RequirePermission('admin:invite')
async sendSupabaseInvite(@Body() body: { email: string; redirect_to?: string }) {
  // Call GoTrue admin API: POST {GOTRUE_URL}/invite
  // Authorization: Bearer <service_role_key>
  // Body: { email, data: { invite_metadata } }
}
```

**Auth config endpoint**:

```typescript
@Get('auth/config')
@Public()
async getAuthConfig() {
  return {
    supabase_url: config.SUPABASE_AUTH_URL,
    anon_key: config.SUPABASE_ANON_KEY,
    sso_url: config.EVE_SSO_URL,
  };
}
```

**CLI changes** (`packages/cli/src/commands/admin.ts`):

Extend `eve admin invite`:
- Add `--web` flag.
- When `--web` is set: after creating org membership (existing behavior), call `POST /auth/supabase/invite`.
- Log: "Invite email sent to user@example.com via Supabase Auth".

**CLI web auth** (`packages/cli/src/commands/auth.ts`):

Add `eve auth login --web`:
1. Start local HTTP server on random port.
2. Open browser to `{SSO_URL}/login?redirect_to=http://localhost:{port}/callback`.
3. User authenticates in browser.
4. SSO broker redirects back with token in query param.
5. Local server captures token, stores in CLI credentials.
6. Close browser tab.

This mirrors the `gh auth login` experience.

**Deliverables**: `eve admin invite --web` sends real emails; `eve auth login --web` opens browser-based login flow.

---

### Phase 5: Dashboard Integration

**Goal**: Replace token-paste auth in the dashboard with SSO-backed login.

**Dashboard changes** (in `../eve-horizon-dashboard`):

1. On page load, check for `eve_sso` hint cookie.
2. If present, call `GET https://sso.<cluster-domain>/session` with `credentials: include`.
3. If token returned, store in memory and use for API calls.
4. If no session, redirect to `https://sso.<cluster-domain>/login?redirect_to=<current_url>`.
5. Token refresh: before expiry, call `/session` again (refresh cookie handles rotation).

**Remove**: Token paste input, manual token entry flow.

**Add**: Logout button → calls `POST https://sso.<cluster-domain>/logout`, clears local state.

**Deliverables**: Dashboard uses SSO for auth; no manual token management.

---

### Phase 6: Docker Compose + Staging Deploy

**Goal**: Add GoTrue + Mailpit to Docker Compose dev stack, and deploy to staging with SES.

**Docker Compose** (`docker/compose/docker-compose.yml`):

```yaml
supabase-auth:
  image: supabase/gotrue:v2.185.0
  depends_on:
    db: { condition: service_healthy }
  environment:
    GOTRUE_DB_DATABASE_URL: postgres://eve_auth_admin:eve_auth@db:5432/eve
    GOTRUE_JWT_SECRET: ${SUPABASE_JWT_SECRET:-super-secret-jwt-token-with-at-least-32-characters}
    GOTRUE_SITE_URL: http://localhost:3100       # SSO broker (always the callback target)
    API_EXTERNAL_URL: http://localhost:9999       # GoTrue public API
    GOTRUE_SMTP_HOST: mailpit
    GOTRUE_SMTP_PORT: 1025
    GOTRUE_SMTP_ADMIN_EMAIL: noreply@eve.local
    GOTRUE_EXTERNAL_EMAIL_ENABLED: "true"
    GOTRUE_MAILER_AUTOCONFIRM: "false"
    GOTRUE_DISABLE_SIGNUP: "false"               # Open signup for local dev
  ports:
    - "9999:9999"

mailpit:
  image: axllent/mailpit:latest
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI
```

**Staging overlay**:
- `k8s/overlays/staging/supabase-auth.patch.yaml`:
  - `GOTRUE_SITE_URL=https://sso.eve.example.com` (SSO broker — all callbacks land here).
  - `API_EXTERNAL_URL=https://auth.eve.example.com` (GoTrue public API).
  - `GOTRUE_DISABLE_SIGNUP=true` (invite-only).
  - SES SMTP via direct credentials (no relay service):
    - `GOTRUE_SMTP_HOST=email-smtp.{region}.amazonaws.com`
    - `GOTRUE_SMTP_PORT=587`
    - `GOTRUE_SMTP_USER` / `GOTRUE_SMTP_PASS` from K8s secret (SES SMTP credentials, not AWS access keys).
    - `GOTRUE_SMTP_ADMIN_EMAIL` from verified SES identity.

**CI updates**: Add `sso` image build to `deploy-staging.yml` workflow.

**Test**: Invite → SES email delivery → signup → login on staging.

**Deliverables**: Full auth stack running on staging with real email delivery.

---

### Phase 7: Ingress-Level Auth Injection (Long-Term)

**Goal**: Make auth automatic for apps that declare `auth: platform` in their manifest.

**Manifest extension**:
```yaml
services:
  web:
    x-eve:
      ingress:
        public: true
        auth: platform
```

**Deployer changes** (`apps/worker/src/deploy/`):
- When `auth: platform` is set, inject ingress annotation/middleware that:
  - Calls `https://sso.<cluster-domain>/verify` on every request.
  - Redirects unauthenticated users to SSO login.
  - Forwards `X-Eve-User-Id` and `X-Eve-User-Email` headers to the app.

**Implementation**: Traefik ForwardAuth middleware pointing at SSO broker `/verify`.

**Deliverables**: Apps get auth for free by adding one manifest line.

---

## Phase Dependencies

```
Phase 1 (GoTrue + Mailpit)
    │
    ▼
Phase 2 (Dual-Mode Auth + Exchange)
    │
    ├───────────────────┐
    ▼                   ▼
Phase 3 (SSO Broker)   Phase 4 (CLI + Admin)
    │                       │
    ├───────────────────────┘
    ▼
Phase 5 (Dashboard)
    │
    ▼
Phase 6 (Docker Compose + Staging)
    │
    ▼
Phase 7 (Ingress Auth — deferred)
```

Phases 3 and 4 can proceed in parallel after Phase 2. Phase 5 needs Phase 3. Phase 6 is independent infrastructure work that can overlap with Phase 5.

## Auth Methods Supported (via GoTrue)

| Method | Config | Notes |
|---|---|---|
| **Email + Password** | Built-in | Signup, login, password reset |
| **Magic Link** | Built-in + SMTP | Passwordless email login |
| **GitHub OAuth** | `GOTRUE_EXTERNAL_GITHUB_*` | Reuse existing GitHub integration |
| **Google OAuth** | `GOTRUE_EXTERNAL_GOOGLE_*` | Standard OIDC |
| **Any OIDC provider** | `GOTRUE_EXTERNAL_{PROVIDER}_*` | Keycloak, Azure AD, etc. |

Existing SSH and Nostr flows continue to work in parallel — they're orthogonal identity providers, not replaced by GoTrue.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| GoTrue schema conflicts with Eve | GoTrue uses `auth` schema exclusively; Eve uses `public`. No overlap. |
| JWT secret rotation | Both GoTrue and Eve API read from same K8s secret. Rotate by updating secret and rolling both. |
| GoTrue image updates break things | Pin to specific tag (`v2.185.0`). Test upgrades in local stack first. GoTrue auto-migrates. |
| SES sandbox limits | Request SES production access before staging launch. Use verified sending domain. |
| Cookie security (XSS) | `HttpOnly; Secure; SameSite=Lax` — refresh token never accessible to JavaScript. |
| CORS complexity | SSO broker allows `*.${EVE_DEFAULT_DOMAIN}` with credentials. Strict origin validation. |
| Single point of failure (SSO) | SSO broker is stateless (cookies + GoTrue + Eve API). Scale horizontally. |

## Non-Goals (v1)

- Phone/SMS auth (requires SMS provider).
- MFA/TOTP (GoTrue supports it, but not a priority).
- Custom email templates (use GoTrue defaults initially).
- Multiple GoTrue instances per cluster.
- Replacing SSH/Nostr auth for CLI users.
- Cross-cluster SSO (each cluster is its own SSO boundary).

## References

- [Supabase Auth Self-Hosting Config](https://supabase.com/docs/guides/self-hosting/auth/config)
- [GoTrue Docker Image](https://hub.docker.com/r/supabase/gotrue)
- [Eve Auth Service](../../apps/api/src/auth/auth.service.ts)
- [Eve Config Schema](../../packages/shared/src/config/schema.ts)
- [Eve Auth System Doc](../system/auth.md)
- [Identity Provider Framework](../plans/identity-and-gateway-plugins.md)
- [Dashboard Plan](../plans/system-dashboard-app-plan.md)
- [Agent Secret Hardening](../ideas/agent-harness-secret-hardening.md)
