# Platform Web Auth via Supabase Auth (GoTrue)

> Idea (Superseded — see `docs/plans/platform-web-auth-plan.md` for the unified design)
> Last Updated: 2026-02-12

Note: This doc describes a "pure JWT, per-app storage" approach. For the newer requirement
"login is automatically portable across ANY Eve-compatible web app on the same cluster domain",
see `docs/ideas/platform-web-auth-supabase-sso.md`.

## The Problem

Eve Horizon has powerful **machine-identity** auth (SSH challenge, Nostr, service principals) but no **browser-friendly** auth. The CLI paste-a-token flow in the dashboard plan is a stopgap — it can't support magic links, password resets, OAuth sign-in, or the kind of "just works" login experience that web apps need.

Every Eve-compatible web app (the dashboard, future customer-facing apps, admin tools) would need to reinvent browser auth independently. That's wasteful and dangerous — auth is the one thing you never want to get wrong twice.

## The Insight

We already have the building blocks:

1. **Eve API already verifies Supabase JWTs** — when `SUPABASE_JWT_SECRET` is set, the auth guard switches to HS256 mode and auto-provisions users from Supabase claims.
2. **The identity provider interface** is pluggable — SSH and Nostr are registered in `AuthModule.onModuleInit()`.
3. **GoTrue (Supabase Auth) runs standalone** — it's a single Go binary (~24 MB Alpine container) that needs only Postgres and SMTP. No Kong, no PostgREST, no Supabase Cloud.

The elegant move: deploy GoTrue as a **platform-level service** alongside the API, sharing the same Postgres instance. Any Eve-compatible web app on the cluster gets browser auth for free — same JWT, same user, same RBAC.

## Design

### Architecture: GoTrue as a Cluster Service

```
                                    ┌─────────────────────────┐
                                    │    eve-horizon-dashboard │
                                    │    (or any web app)      │
                                    └────────┬────────────────┘
                                             │ @supabase/auth-js
                                             │ (PKCE flow)
                                             ▼
┌──────────┐   JWT verify    ┌───────────────────────────────┐
│ Eve API  │◄────────────────│       GoTrue (supabase-auth)  │
│ (NestJS) │  shared secret  │       Port 9999               │
│          │                 │       auth.eve.lvh.me (local)  │
└──────┬───┘                 └──────────────┬────────────────┘
       │                          ▲         │
       │                          │         │
       │             REST API     │         │
       │          (pure JWT,      │         │
       │           no cookies)    │         │
       │                          │         │
       │              ┌───────────┘         │
       │              │       ┌─────────────┤
       ▼              │       ▼             ▼
  ┌─────────────────────────┐    ┌─────────────────────┐
  │   PostgreSQL             │    │  SMTP Provider       │
  │   public.*  (Eve tables)│    │  Local: Mailpit      │
  │   auth.*    (GoTrue)    │    │  Staging: AWS SES    │
  └─────────────────────────┘    └─────────────────────┘
```

### Key Decisions

**1. Shared Database, Separate Schema**

GoTrue creates and owns the `auth` schema. Eve's tables stay in `public`. GoTrue auto-migrates on startup — zero schema management burden. We give GoTrue a dedicated DB role (`eve_auth_admin`) with `CREATE` on the Eve database, scoped to the `auth` schema.

This means:
- One Postgres instance, one connection string (with different roles)
- Eve tables can FK to `auth.users.id` if needed (e.g., linking Eve `users.id` to Supabase user UUID)
- No new StatefulSet, no new PVC — just a new Deployment

**2. JWT Bridge: GoTrue → Eve API**

GoTrue signs HS256 JWTs with `GOTRUE_JWT_SECRET`. Eve API already reads this via `SUPABASE_JWT_SECRET`. When the guard sees a Supabase JWT:

1. Decode `sub` (UUID) from the token
2. Look up or auto-create an Eve user with that ID
3. Populate `AuthUser` with role/permissions from Eve's RBAC

The bridge is **already implemented** (`auth.service.ts:179-199`). We just need to ensure the user-provisioning path handles the GoTrue claims gracefully (email from `email` claim, display name from `user_metadata.name`).

**3. Portable Auth Across Apps**

Any web app on the cluster that knows two things can authenticate:
- `SUPABASE_URL` — the GoTrue service URL (e.g., `http://auth.eve.lvh.me` local, `https://auth.eve.example.com` staging)
- `SUPABASE_ANON_KEY` — a JWT with `role: anon` signed by the same secret (for public GoTrue API calls)

**Auth is pure JWT — no cookies, no server-side sessions, no SSR middleware.** The app talks to GoTrue's REST API directly (via `@supabase/auth-js` or raw `fetch`), gets back a JWT, and sends it to Eve API as `Authorization: Bearer <token>`. GoTrue is just a JWT-minting service with email/OAuth/magic-link flows bolted on.

The key GoTrue endpoints:
- `POST /auth/v1/signup` — email/password registration → JWT
- `POST /auth/v1/token?grant_type=password` — email/password login → JWT
- `POST /auth/v1/magiclink` — send magic link email → user clicks → JWT
- `POST /auth/v1/token?grant_type=refresh_token` — refresh → new JWT
- `GET /auth/v1/authorize?provider=github` — OAuth redirect → callback → JWT

Web apps store the JWT in memory (or `sessionStorage` for tab persistence). No httpOnly cookies, no BFF session proxy. This keeps the auth model identical to what the CLI already does — just a different way to obtain the Bearer token.

**4. SMTP Provider Abstraction**

GoTrue's SMTP config is pure env vars. We wire different providers per environment:

| Environment | SMTP Host | SMTP Port | Auth | Web UI |
|---|---|---|---|---|
| **Local (k3d)** | `mailpit.eve.svc` | 1025 | None | `http://mail.eve.lvh.me` |
| **Local (docker-compose)** | `mailpit` | 1025 | None | `http://localhost:8025` |
| **Staging** | `email-smtp.{region}.amazonaws.com` | 587 | SES SMTP creds | — |
| **Production** | `email-smtp.{region}.amazonaws.com` | 587 | SES SMTP creds | — |

For local dev, Mailpit is ideal — it captures all outgoing email with a clean web UI. No emails ever leave the machine.

**5. Invite Flow Integration**

Eve's existing invite system (`auth.invites.controller.ts`) creates invite codes. The new flow:

1. Admin creates invite: `eve org invite --email user@example.com --role member`
2. Eve API creates an `org_invite` record (existing) AND calls GoTrue's admin API to send an invite email:
   ```
   POST {GOTRUE_URL}/invite
   Authorization: Bearer <service_role_jwt>
   { "email": "user@example.com" }
   ```
3. GoTrue sends the invite email with a magic link pointing to `GOTRUE_SITE_URL/auth/invite?token_hash=xxx`
4. User clicks link → lands on the web app → completes signup (sets password or just confirms)
5. User gets a GoTrue JWT → web app forwards to Eve API → Eve auto-provisions user and applies invite

The CLI `eve auth login` command gains a new `--web` flag that opens the browser to the GoTrue login page for interactive auth, then captures the token via a local callback server (similar to `gh auth login`).

**6. Auth Methods Supported**

With GoTrue, we immediately get:

| Method | Config | Notes |
|---|---|---|
| **Email + Password** | Built-in | Signup, login, password reset |
| **Magic Link** | Built-in + SMTP | Passwordless email login |
| **GitHub OAuth** | `GOTRUE_EXTERNAL_GITHUB_*` | Reuse existing GitHub integration |
| **Google OAuth** | `GOTRUE_EXTERNAL_GOOGLE_*` | Standard OIDC |
| **Any OIDC provider** | `GOTRUE_EXTERNAL_{PROVIDER}_*` | Keycloak, Azure AD, etc. |

The existing SSH and Nostr flows continue to work in parallel — they're orthogonal identity providers in Eve's auth system, not replaced by GoTrue.

### Infrastructure Changes

#### K8s Base Manifests (new files)

**`k8s/base/supabase-auth-deployment.yaml`**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: supabase-auth
  namespace: eve
spec:
  replicas: 1
  selector:
    matchLabels:
      app: supabase-auth
  template:
    metadata:
      labels:
        app: supabase-auth
    spec:
      containers:
        - name: auth
          image: supabase/gotrue:v2.185.0
          ports:
            - containerPort: 9999
          envFrom:
            - secretRef:
                name: supabase-auth-secret
          env:
            - name: GOTRUE_API_HOST
              value: "0.0.0.0"
            - name: GOTRUE_API_PORT
              value: "9999"
            - name: GOTRUE_DB_DRIVER
              value: postgres
            - name: GOTRUE_JWT_AUD
              value: authenticated
            - name: GOTRUE_JWT_DEFAULT_GROUP_NAME
              value: authenticated
            - name: GOTRUE_JWT_EXP
              value: "3600"
            - name: GOTRUE_EXTERNAL_EMAIL_ENABLED
              value: "true"
            - name: GOTRUE_DISABLE_SIGNUP
              value: "true"  # Invite-only by default
          readinessProbe:
            httpGet:
              path: /health
              port: 9999
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 9999
            periodSeconds: 30
```

**`k8s/base/supabase-auth-secret.yaml`**
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: supabase-auth-secret
  namespace: eve
stringData:
  GOTRUE_DB_DATABASE_URL: ""      # postgres://eve_auth_admin:xxx@postgres.eve.svc:5432/eve
  GOTRUE_JWT_SECRET: ""            # Shared with Eve API's SUPABASE_JWT_SECRET
  API_EXTERNAL_URL: ""             # https://auth.{domain}
  GOTRUE_SITE_URL: ""              # https://dashboard.{domain}
  GOTRUE_SMTP_HOST: ""
  GOTRUE_SMTP_PORT: ""
  GOTRUE_SMTP_USER: ""
  GOTRUE_SMTP_PASS: ""
  GOTRUE_SMTP_ADMIN_EMAIL: ""
```

**`k8s/base/supabase-auth-service.yaml`** + **`supabase-auth-ingress.yaml`**

Service on port 9999, ingress at `auth.{domain}` (e.g., `auth.eve.lvh.me` for local).

**`k8s/base/mailpit-deployment.yaml`** (local overlay only)

Mailpit for local SMTP capture:
```yaml
# Deployment: mailpit, port 1025 (SMTP), 8025 (Web UI)
# Ingress: mail.eve.lvh.me → port 8025
```

#### Local Overlay Patches

`k8s/overlays/local/` gains:
- `supabase-auth.patch.yaml` — sets `GOTRUE_MAILER_AUTOCONFIRM=false` (keep email flow testable), local URLs, local SMTP pointing to mailpit
- Adds `mailpit-deployment.yaml` to local resources
- Sets `GOTRUE_DISABLE_SIGNUP=false` for easier local testing

#### Docker Compose

Add `supabase-auth` and `mailpit` services to `docker/compose/docker-compose.yml`:
```yaml
supabase-auth:
  image: supabase/gotrue:v2.185.0
  depends_on:
    db: { condition: service_healthy }
  environment:
    GOTRUE_DB_DATABASE_URL: postgres://eve:eve@db:5432/eve
    GOTRUE_JWT_SECRET: ${SUPABASE_JWT_SECRET:-super-secret-jwt-token-with-at-least-32-characters}
    GOTRUE_SITE_URL: http://localhost:3000
    API_EXTERNAL_URL: http://localhost:9999
    GOTRUE_SMTP_HOST: mailpit
    GOTRUE_SMTP_PORT: 1025
    GOTRUE_SMTP_ADMIN_EMAIL: noreply@eve.local
    GOTRUE_EXTERNAL_EMAIL_ENABLED: "true"
    GOTRUE_MAILER_AUTOCONFIRM: "false"
  ports:
    - "9999:9999"

mailpit:
  image: axllent/mailpit:latest
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI
```

### Config Schema Changes

Add to `packages/shared/src/config/schema.ts`:

```typescript
// Supabase Auth (GoTrue) integration
SUPABASE_AUTH_URL: z.string().url().optional(),      // GoTrue service URL
SUPABASE_AUTH_SERVICE_KEY: z.string().optional(),     // service_role JWT for admin API calls
SUPABASE_ANON_KEY: z.string().optional(),             // anon JWT for public API calls
```

The existing `SUPABASE_JWT_SECRET` and `EVE_SUPABASE_URL` fields already cover JWT verification and URL config.

### Database Migration

One new migration to create the `eve_auth_admin` role and grant it access:

```sql
-- 00050_supabase_auth_role.sql
-- Create a dedicated role for GoTrue to manage the auth schema
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'eve_auth_admin') THEN
    CREATE ROLE eve_auth_admin LOGIN PASSWORD 'eve_auth';
  END IF;
END $$;

GRANT ALL ON SCHEMA public TO eve_auth_admin;  -- GoTrue needs to create the auth schema
GRANT ALL ON DATABASE eve TO eve_auth_admin;

-- GoTrue will create and manage the 'auth' schema itself on startup.
-- We just need to ensure the role has sufficient privileges.
```

### User Identity Bridging

When a GoTrue JWT arrives at Eve API, the auto-provision flow (`auth.service.ts:188-199`) already creates an Eve user. We enhance it slightly:

1. Extract `email` from JWT `email` claim (already done)
2. Extract `display_name` from `user_metadata.name` if present (new)
3. Store the GoTrue user UUID as the Eve user ID (already done — `sub` becomes `user_id`)
4. If an `org_invite` exists matching the email, auto-apply it (new — check `identity_hint` or email match)

This means: admin invites a user → user clicks magic link → signs up via GoTrue → first API call auto-provisions Eve user AND applies the pending invite. Zero manual steps.

### CLI Changes

**`eve auth login --web`** (new flag):
1. Start a local HTTP server on a random port (e.g., `http://localhost:54321/callback`)
2. Open browser to `{SUPABASE_AUTH_URL}?redirect_to=http://localhost:54321/callback`
3. User authenticates in browser (password, magic link, OAuth — whatever is configured)
4. GoTrue redirects back with tokens in URL fragment
5. Local server captures the access token, stores it in CLI credentials
6. Close browser tab, done

This mirrors the `gh auth login` experience.

**`eve org invite --email user@example.com`** (enhanced):
- If `SUPABASE_AUTH_URL` is configured, also trigger GoTrue invite email via admin API
- Falls back to creating a code-only invite if GoTrue is not available

### What This Unlocks

**For eve-horizon-dashboard:**
- Replace the "paste a token" flow with real login (email/password, magic link, Google, GitHub)
- Session management with refresh tokens (GoTrue handles this)
- "Forgot password" flow out of the box
- SSO via any OIDC provider

**For any Eve-compatible web app:**
- Drop in `@supabase/auth-js` + two env vars → get login for free
- Same user identity across all apps on the cluster
- No per-app auth backend needed

**For the CLI:**
- `eve auth login --web` for users who prefer browser auth
- Existing SSH/Nostr flows unchanged (power users, CI)

**For platform operators:**
- One place to configure auth methods (GoTrue env vars)
- One place to manage SMTP (GoTrue + provider secrets)
- Audit trail in `auth.audit_log_entries`

## Implementation Phases

### Phase 1: GoTrue on Local Stack (1-2 days)

- Add `supabase-auth` + `mailpit` to k8s base manifests
- Add local overlay patches (URLs, SMTP config, auto-confirm off)
- Add Mailpit ingress at `mail.eve.lvh.me`
- Add GoTrue ingress at `auth.eve.lvh.me`
- Database migration for `eve_auth_admin` role
- Update `./bin/eh k8s deploy` to include new services
- Wire `SUPABASE_JWT_SECRET` in `app-secret.yaml` (shared between GoTrue and Eve API)
- Smoke test: create user via GoTrue API, verify JWT accepted by Eve API
- Verify magic link flow: signup → Mailpit captures email → click link → token works

### Phase 2: Eve API Integration Polish (1 day)

- Enhance user auto-provision to extract `user_metadata.name` as `display_name`
- Auto-apply matching `org_invite` on first GoTrue login (email match)
- Generate `SUPABASE_ANON_KEY` (anon-role JWT) during bootstrap
- Add `SUPABASE_AUTH_URL` and `SUPABASE_ANON_KEY` to config schema
- Expose auth config endpoint: `GET /auth/config` → returns `{ supabase_url, anon_key }` for web apps
- Add admin invite trigger: POST to GoTrue `/invite` when `eve org invite` is called

### Phase 3: CLI Web Auth (1 day)

- Implement `eve auth login --web` with local callback server
- Browser-based PKCE flow using `@supabase/auth-js`
- Store GoTrue tokens in CLI credentials (existing token storage)
- Refresh token support in CLI HTTP client

### Phase 4: Docker Compose + Staging (1 day)

- Add `supabase-auth` + `mailpit` to `docker-compose.yml`
- Create staging overlay with SES SMTP config
- Wire SES credentials as K8s secret in staging overlay
- Configure `GOTRUE_SITE_URL` and `API_EXTERNAL_URL` for staging domain
- Test invite → email delivery → signup → login on staging

### Phase 5: Dashboard Integration (depends on dashboard)

- Replace token-paste auth with direct GoTrue REST calls (via `@supabase/auth-js` or raw `fetch`)
- Add login page (email/password + magic link + configured OAuth)
- JWT stored in memory, refresh via `POST /auth/v1/token?grant_type=refresh_token`
- No cookies, no SSR middleware, no BFF session proxy — pure JWT throughout

## Non-Goals (v1)

- Phone/SMS auth (requires SMS provider integration)
- MFA/TOTP (GoTrue supports it, but not a priority)
- Custom email templates (use GoTrue defaults initially)
- Multiple GoTrue instances per cluster (single instance is fine for now)
- Replacing SSH/Nostr auth for CLI users (these remain first-class)

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| GoTrue schema conflicts with Eve tables | GoTrue uses `auth` schema exclusively; Eve uses `public`. No overlap. |
| JWT secret rotation | Both GoTrue and Eve API read from the same K8s secret. Rotate by updating the secret and rolling both deployments. |
| GoTrue image updates break things | Pin to specific tag (`v2.185.0`). Test upgrades in local stack first. GoTrue auto-migrates its schema. |
| Email deliverability (SES sandbox) | Request SES production access before staging launch. Use verified sending domain. |
| Local dev email testing friction | Mailpit captures everything with a web UI. Zero config for developers. |

## Open Questions

1. **Anon key generation**: Should bootstrap auto-generate the anon key, or should it be a manual step in `./bin/eh k8s secrets`?
2. **User merge**: If someone first uses SSH auth (Eve user), then later uses GoTrue (new UUID), should we merge identities? For v1, treat them as separate users and add merge later.
3. **Signup policy**: Default to invite-only (`GOTRUE_DISABLE_SIGNUP=true`) or open signup with email verification? Recommend invite-only for initial deployments.

## References

- [Supabase Auth Self-Hosting Config](https://supabase.com/docs/guides/self-hosting/auth/config)
- [GoTrue Docker Image](https://hub.docker.com/r/supabase/gotrue)
- [Supabase Auth Architecture](https://supabase.com/docs/guides/auth/architecture)
- [PKCE Flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow)
- [Magic Link Auth](https://supabase.com/docs/guides/auth/passwordless-login/auth-magic-link)
- [Eve Auth Service](../apps/api/src/auth/auth.service.ts) — existing Supabase JWT verification at line 179
- [Eve Config Schema](../packages/shared/src/config/schema.ts) — existing `SUPABASE_JWT_SECRET` field
- [Dashboard Plan](../docs/plans/system-dashboard-app-plan.md) — token-paste auth being replaced
- [Agent Secret Hardening](./agent-harness-secret-hardening.md) — security context
