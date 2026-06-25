# Platform Web Auth (Portable SSO) via Supabase Auth (GoTrue)

> Idea (Superseded — see `docs/plans/platform-web-auth-plan.md` for the unified design)
> Last Updated: 2026-02-12

Related (v1, pure-JWT): `docs/ideas/platform-web-auth-supabase.md`

## Requirements (New)

We need **browser-friendly user auth** (email/password, magic link, OAuth later) that:

- Works for any Eve-compatible web app (ex: `../eve-horizon-dashboard`).
- Is **automatically portable across all apps** on the same deployment/cluster.
  - Log in once, and you are logged in everywhere on that cluster domain.
- Uses **Supabase Auth (GoTrue)** as the identity system.
- Extends the **Eve CLI invite flow** to trigger Supabase-auth emails.
- Supports different email providers:
  - Staging: AWS SES (already wired in AWS).
  - Local dev stack: Mailhog/Mailpit (capture-only).

## Decisions (Chosen for Now)

- **Signup policy**
  - Staging/production: **invite-only** (no open signup).
  - Dev/test: **open signup allowed** (to make flows easy to test).
- **Eve user IDs**: keep Eve `user_...` TypeIDs.
  - Store Supabase UUID linkage via `identities(provider='supabase', fingerprint='<uuid>')`.
- **What apps receive**: SSO broker returns **Eve RS256 user tokens** (apps do not need Supabase tokens).
- **SSO broker placement**: standalone service (`apps/sso`).
- **SSO boundary**: per cluster domain (no cross-cluster SSO).

## What We Already Have (Current State)

### Eve Auth Today

- Eve API auth is JWT-based (`docs/system/auth.md`).
- Internal auth issues **RS256** JWTs (bootstrap, SSH challenge/verify, service principals, job tokens).
- The API can verify **Supabase HS256** tokens today:
  - `apps/api/src/auth/auth.service.ts` selects `mode = 'supabase'` when `SUPABASE_JWT_SECRET` is set.
  - In that mode, `verifyAuthorizationHeader()` verifies HS256 and auto-creates `users` rows.

Important constraint:

- The current implementation is effectively **single-mode** (`internal` OR `supabase`).
  - Switching to Supabase mode breaks RS256 token paths (job tokens, service principal tokens, SSH challenge minting) unless we extend verification to accept both.

### Invites Today

- There is an org invite primitive for invite-gated provisioning:
  - Table: `org_invites` (`packages/db/migrations/00042_nostr_identity.sql`)
  - API: `apps/api/src/auth/auth.invites.controller.ts`
- The CLI "invite" flow today (`eve admin invite`) does not send email:
  - It adds org membership via `POST /orgs/:org_id/members`.
  - Optionally registers SSH keys via `POST /auth/identities`.
  - Code: `packages/cli/src/commands/admin.ts`

### Supabase Auth Touchpoints Today

- The CLI already has legacy Supabase password login and refresh support:
  - `packages/cli/src/commands/auth.ts` (password login via `/auth/v1/token?grant_type=password`)
  - `packages/cli/src/lib/client.ts` (refresh via `/auth/v1/token?grant_type=refresh_token`)

## The Core Design: Cluster-Level SSO, Not Per-App Sessions

The portability requirement means we cannot rely on per-origin `localStorage` / `sessionStorage`.
Those are isolated by hostname and do not share state across:

- `web.foo-staging.eve.example.com`
- `web.bar-staging.eve.example.com`
- `dashboard.eve.example.com`

We need a **shared, root-domain session** using cookies scoped to the cluster domain.

### Proposed Components

1. **Supabase Auth (GoTrue)**: Identity system, email/password, magic link, OAuth.
2. **Eve SSO Broker** (new small service: `apps/sso`):
   - Owns the shared browser session cookie(s).
   - Exchanges refresh tokens for access tokens.
   - Exchanges Supabase sessions for Eve RS256 tokens (chosen).

### URL / Domain Convention

For a deployment domain like:

- Local: `*.lvh.me`
- Staging: `*.eve.example.com`

Add:

- GoTrue public URL: `https://auth.<cluster-domain>`
- SSO broker public URL: `https://sso.<cluster-domain>`

Cookie domain:

- `Domain=.<cluster-domain>` so every `*.{cluster-domain}` app shares the session.

## Auth Flow (Browser)

### 1) Unauthenticated User Visits Any App

Any Eve-compatible web app should implement one of:

- App-level middleware: redirect to `https://sso.<cluster-domain>/login?redirect_to=<current_url>`
- Ingress-level auth (preferred long-term): platform adds an auth middleware on the app ingress that performs the redirect automatically.

### 2) Login Happens Once, Centrally

`GET https://sso.<cluster-domain>/login?redirect_to=...`

User chooses:

- Email/password login
- Magic link login
- OAuth (later)

SSO broker calls GoTrue to start the flow and finalizes it on callback.

### 3) SSO Stores a Shared Session Cookie

On successful login, SSO broker stores the GoTrue refresh token in an httpOnly cookie:

- `eve_sso_rt=<refresh_token>`
- `HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.<cluster-domain>`

SSO broker can also store a small non-sensitive "session hint" cookie (non-httpOnly) for UX:

- `eve_sso=1` to skip redirect loops (optional)

### 4) Any App Can Fetch an Access Token

Apps call:

- `GET https://sso.<cluster-domain>/session`
  - `credentials: include`
  - returns JSON `{ access_token, expires_at, user: { id, email } }` (Eve RS256 user token)

SSO broker uses the refresh token cookie to:

1. Call GoTrue refresh (`POST /auth/v1/token?grant_type=refresh_token`).
2. Exchange Supabase access token → Eve RS256 user token.
3. Return the Eve token to the app (in response body).

This single endpoint is what makes login portable: the refresh token is shared by cookie domain.

## Token Strategy (Eve API Compatibility)

We have two viable designs. The portability requirement is solved by the SSO broker either way.

### Option A (Recommended): Exchange Supabase Token for an Eve RS256 Token

Rationale:

- Eve already has rich RS256 token types (user/job/service principal).
- The platform currently assumes RS256 for job tokens and internal tooling.
- We avoid forcing all Eve internals to become "Supabase mode".

Flow:

1. SSO broker refreshes a Supabase access token from GoTrue using its root-domain refresh cookie.
2. SSO broker calls `POST /auth/exchange` on Eve API with `Authorization: Bearer <supabase_access_token>`.
3. Eve API verifies HS256, resolves Eve `user_...` via `identities(provider='supabase')` (or links by email on first login),
   then returns an Eve RS256 access token.
4. SSO broker returns the Eve RS256 token to the web app.

This keeps:

- RS256 job tokens working
- RS256 service principal tokens working
- Existing internal auth flow intact

### Option B: Eve API Accepts Both Supabase HS256 and Eve RS256 Tokens

Rationale:

- Simplifies app-side logic (one bearer token everywhere).

But requires refactoring auth verification:

- `apps/api/src/auth/auth.service.ts` must accept both token families concurrently.
- Verification must detect token type:
  - If `type === 'job' | 'service_principal'` verify RS256 and apply existing logic.
  - Otherwise try HS256 (Supabase) and map to Eve users.

This is aligned with `docs/plans/identity-and-gateway-plugins.md` (which describes mixed verification),
but is not how the code behaves today.

## CLI Invite Flow (Email + Magic Link)

We want `eve admin invite` (or a new `eve org invite`) to optionally send a Supabase invite email.

### Proposed CLI UX

Add a web-invite mode:

```bash
eve admin invite --email user@example.com --org org_xxx --role member --web
```

Behavior:

1. Ensure org membership exists (current behavior).
2. Call a new Eve API admin endpoint:
   - `POST /auth/supabase/invite`
   - Body: `{ email, redirect_to?, invite_metadata? }`
3. Eve API calls GoTrue admin API (service role key) to send the email.

Implementation detail:

- Eve API must hold the GoTrue service role key (system secret) so the CLI never sees it.

### Aligning Supabase User IDs and Eve User IDs

We keep Eve `users.id` as `user_...` TypeIDs and store a mapping from Supabase UUID → Eve user via:

- `identities.provider = 'supabase'`
- `identities.fingerprint = <supabase_user_uuid>`
- `identities.public_key = <supabase_user_uuid>` (string; not a real keypair)

Linking strategy (invite-only clusters):

1. Admin invites user by email (creates Eve `users` row + org membership).
2. GoTrue invite email is sent.
3. On first Supabase login, Eve links the Supabase UUID to the existing Eve user by matching `users.email`.
4. Future logins resolve by the `identities(provider='supabase')` mapping (no email match required).

## Email Provider Wiring

GoTrue email is configured via SMTP env vars. We standardize on SMTP so "different providers"
means "different SMTP settings".

### Local Dev: Mailhog or Mailpit

- Run `mailhog` (or `mailpit`) in the local dev stack.
- Configure GoTrue SMTP host to that service.
- Expose the mail UI:
  - Compose: `http://localhost:8025`
  - k3d: `http://mail.eve.lvh.me` (ingress)

### Staging: AWS SES (SMTP)

Configure GoTrue with SES SMTP settings:

- Host: `email-smtp.<region>.amazonaws.com`
- Port: `587`
- User/pass: SES SMTP credentials (not AWS access keys)
- From address: verified SES identity

Store these as platform/system secrets (not org/project secrets).

## Making This "First Class" for Eve-Compatible Apps

### 1) Standard Env Vars Injected Into App Containers

Extend the platform-provided env var set (see `docs/system/manifest.md`) to include:

- `EVE_PUBLIC_SSO_URL` (ex: `https://sso.eve.example.com`)
- `EVE_PUBLIC_SUPABASE_AUTH_URL` (ex: `https://auth.eve.example.com`)
- `EVE_SUPABASE_ANON_KEY` (public)

### 2) Ingress-Level Auth (Long-Term Elegant)

Add a manifest extension:

```yaml
services:
  web:
    x-eve:
      ingress:
        public: true
        auth: platform   # NEW
```

When `auth: platform` is set, the deployer injects the ingress middleware that:

- Calls `https://sso.<cluster-domain>/verify` on every request.
- Redirects to `/login` when unauthenticated.
- Optionally forwards `X-Eve-User-Id` headers to the app.

This makes auth portable and "automatic" even for apps that do not want to embed auth code.

## Phased Rollout (Pragmatic)

1. Deploy GoTrue + local mail capture (Mailhog/Mailpit) + staging SES.
2. Add SSO broker with root-domain cookies + `/session` endpoint.
3. Update `../eve-horizon-dashboard` to use SSO (remove token paste UX).
4. Add Eve API endpoint for GoTrue invites + update CLI `eve admin invite --web`.
5. Add ingress-level auth injection (`x-eve.ingress.auth: platform`).

## Resolved Decisions (Summary)

- Staging/prod: invite-only signup (no open signup).
- Dev/test: open signup allowed.
- Eve keeps `user_...` TypeIDs; Supabase UUID is mapped via `identities(provider='supabase')`.
- Web apps fetch Eve RS256 tokens from `sso.<cluster-domain>`.
- SSO broker is a standalone service (`apps/sso`).
- SSO is scoped to a single cluster domain.
