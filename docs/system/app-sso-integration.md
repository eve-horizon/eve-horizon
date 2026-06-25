# App SSO Integration

> Add Eve SSO login to your app in ~25 lines of code.

## Prerequisites

- Your app is deployed to Eve (gets `EVE_SSO_URL`, `EVE_ORG_ID`, `EVE_API_URL` auto-injected)
- Or set these env vars manually for local development

## Backend Setup (Express)

Install:
```bash
npm install @eve-horizon/auth
```

Add middleware (~10 lines):
```typescript
import { eveUserAuth, eveAuthGuard, eveAuthConfig } from '@eve-horizon/auth';

// Parse tokens, check org membership (non-blocking)
app.use(eveUserAuth());

// Serve auth discovery config
app.get('/auth/config', eveAuthConfig());

// Protected route example
app.get('/auth/me', eveAuthGuard(), (req, res) => {
  res.json(req.eveUser);
});

// Protect all API routes
app.use('/api', eveAuthGuard());
```

For apps that are available to one or more customer orgs through
`x-eve.auth.org_access`, use the app-scoped middleware instead of binding
authorization to the project owner org:

```typescript
import { eveAppUserAuth, eveAuthGuard, eveAuthConfig } from '@eve-horizon/auth';

app.use(eveAppUserAuth());
app.get('/auth/config', eveAuthConfig());
app.use('/api', eveAuthGuard());
```

`eveAppUserAuth()` calls Eve API `GET /auth/app-access` with the user token,
selects an allowed org from `X-Eve-Org-Id`, `?eve_org_id=...`, or the first
allowed org, and attaches `req.eveUser` for that org.

## Frontend Setup (React)

Install:
```bash
npm install @eve-horizon/auth-react
```

Wrap your app (~15 lines):
```tsx
import { EveAuthProvider, EveLoginGate } from '@eve-horizon/auth-react';

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

## How It Works

### Token Flow

1. User visits app -- `EveAuthProvider` checks `sessionStorage` for cached token
2. If no cached token -- probes SSO broker `/session` endpoint (uses root-domain cookie)
3. If SSO session exists -- gets fresh Eve RS256 token, caches in `sessionStorage`
4. If no SSO session -- shows login form (SSO redirect or token paste)
5. All API requests include `Authorization: Bearer <token>` header

### Auto-Injected Environment Variables

| Variable | Source | Description |
|----------|--------|-------------|
| `EVE_API_URL` | Platform deployer | Internal API URL for server-to-server calls |
| `EVE_PUBLIC_API_URL` | Platform deployer | Public-facing API URL (optional) |
| `EVE_SSO_URL` | Platform deployer | SSO broker URL |
| `EVE_ORG_ID` | Platform deployer | Organization ID |
| `EVE_PROJECT_ID` | Platform deployer | Project ID |
| `EVE_ENV_NAME` | Platform deployer | Environment name |

### Manifest Interpolation

Use `${SSO_URL}` in manifest env blocks:
```yaml
services:
  web:
    environment:
      MY_SSO_URL: "${SSO_URL}"
```

## API Reference

### Backend (`@eve-horizon/auth`)

#### `eveUserAuth(options?)`

Express middleware. Verifies Eve RS256 tokens and checks org membership.

- Non-blocking: unauthenticated requests pass through (use `eveAuthGuard()` to enforce)
- Attaches `req.eveUser: { id, email, orgId, role }` on success
- Extracts tokens from `Authorization: Bearer` header or `?token=` query param
- Options:
  - `orgId?: string` -- Override `EVE_ORG_ID` env var
  - `eveApiUrl?: string` -- Override `EVE_API_URL` env var
  - `strategy?: 'local' | 'remote'` -- JWKS verification (default) or HTTP verification

#### `eveAuthGuard()`

Express middleware. Returns 401 if `req.eveUser` is not set. Use after `eveUserAuth()`.

#### `eveAuthConfig()`

Express handler. Returns `{ sso_url, eve_api_url, eve_public_api_url, eve_org_id }` from env vars.

#### `eveAuthMiddleware(options?)`

Lower-level middleware for agent/job token verification. Attaches `req.agent` with full `EveTokenClaims`. Returns 401 on failure (blocking, unlike `eveUserAuth`).

- Options:
  - `eveApiUrl?: string` -- Override `EVE_API_URL` env var
  - `strategy?: 'remote' | 'local'` -- HTTP (default) or JWKS verification

#### `verifyEveToken(token, eveApiUrl?)`

Verify a token locally using JWKS (fetched and cached from Eve API). Faster for high-throughput scenarios. Returns `EveTokenClaims`.

#### `verifyEveTokenRemote(token, eveApiUrl?)`

Verify a token by calling the Eve API `/auth/token/verify` endpoint. Simplest approach -- no key management needed. Returns `EveTokenClaims`.

### Frontend (`@eve-horizon/auth-react`)

#### `<EveAuthProvider apiUrl="/api">`

Context provider. Handles session bootstrap, token caching, SSO probing. Fetches `/auth/config` from the backend to discover SSO URL.

#### `useEveAuth()`

Hook returning `{ user, loading, error, config, loginWithSso, loginWithToken, logout }`.

- `user: { id, email, orgId, role } | null`
- `loginWithSso()` -- redirect to SSO broker login page
- `loginWithToken(token: string)` -- validate and store a pasted token
- `logout()` -- clear stored token and reset state

#### `<EveLoginGate>`

Renders children when authenticated, login form otherwise. Props:
- `fallback?: ReactNode` -- custom login component (defaults to `EveLoginForm`)
- `loadingFallback?: ReactNode` -- custom loading component (defaults to null)

#### `<EveLoginForm>`

Built-in login UI with SSO and token paste modes. The SSO button is disabled when `sso_url` is not configured.

#### `createEveClient(baseUrl?)`

Fetch wrapper with automatic Bearer token injection. Returns `{ fetch, getToken }`.

```typescript
const client = createEveClient('/api');
const res = await client.fetch('/users');
```

#### `getStoredToken()` / `storeToken(token)` / `clearToken()`

Direct `sessionStorage` access for the cached Eve token.

## Advanced

### Token Paste Mode

For development or headless environments, use `eve auth token` to get a token and paste it:
```bash
eve auth token  # prints Bearer token
```

### SSE Authentication

The middleware supports `?token=` query parameter for Server-Sent Events:
```
GET /api/events?token=eyJ...
```

### Token Staleness

The `orgs` claim in JWT tokens reflects membership at token mint time. With default 1-day TTL, membership changes take up to 24h to reflect. For immediate membership checks, use `strategy: 'remote'`.

## Invite Email Branding

Projects can opt into app-branded invite emails with manifest metadata:

```yaml
x-eve:
  branding:
    app_name: "ACME Portal"
    app_logo_url: "https://sandbox.acme.example/assets/logo.svg"
    primary_color: "#1f6feb"
    email_from_name: "ACME Portal"
    reply_to_email: "support@acme.example"
    support_email: "support@acme.example"
    support_url: "https://acme.example/help"
```

Run `eve project sync` after editing the manifest. Invites sent with `eve org invite <email> --org <org_id> --project <project_id>` use the project branding for the email subject, body, and `From:` display name. The sender address remains the platform default in Phase 1.

## App-Scoped Magic-Link Login

Projects can opt into passwordless app login with the same manifest block that carries app branding:

```yaml
x-eve:
  branding:
    app_name: "ACME Portal"
    primary_color: "#1f6feb"
    email_from_name: "ACME Portal"
  auth:
    login_method: magic_link
    self_signup: false
    invite_requires_password: false
```

When `login_method: magic_link` is set, the app SSO page is branded for the project and shows email magic-link login instead of username/password. When `login_method: password_or_magic_link` is set explicitly under `x-eve.auth`, the page keeps password login and the secondary magic-link option, but the magic-link request still goes through Eve API so branding and app self-signup policy are enforced. If `x-eve.auth` is absent, existing app SSO behavior is preserved.

`self_signup: false` means unknown emails receive a generic success response but Eve does not call GoTrue and does not send an email. New users should be created through `eve org invite <email> --org <org_id> --project <project_id>`, and `invite_requires_password: false` lets invite acceptance establish the session and redirect to the app without `/set-password`.

Apps using `@eve-horizon/auth` and `@eve-horizon/auth-react` get project-aware SSO automatically because deployed services receive `EVE_PROJECT_ID`, `/auth/config` exposes it as `eve_project_id`, and the React provider includes `project_id` when redirecting to SSO.

## App Org Access And In-App Invites

Apps can declare the orgs they are available to. By default an app is limited
to its project owner org. Use `org_access.mode: allowlist` when the app should
serve specific customer orgs:

```yaml
x-eve:
  branding:
    app_name: "ACME Portal"
    primary_color: "#1f6feb"
    email_from_name: "ACME Portal"
  auth:
    login_method: magic_link
    self_signup: false
    invite_requires_password: false
    org_access:
      mode: allowlist
      allowed_orgs:
        - org_customer123
        - another-customer-slug
      invite:
        enabled: true
        admin_roles: [admin, owner]
        invited_role: member
```

Manifest sync resolves org slugs to canonical org IDs and stores the normalized
policy on the project. `invited_role` is fixed to `member`; app-facing invite
flows cannot create admins or owners.

Public app context exposes only a summary:

```http
GET /auth/app-context?project_id=proj_xxx
```

```json
{
  "project_id": "proj_xxx",
  "auth": {
    "login_method": "magic_link",
    "self_signup": false,
    "invite_requires_password": false,
    "org_access": {
      "mode": "allowlist",
      "multi_org": true,
      "invite_enabled": true,
      "domain_signup_enabled": false
    }
  }
}
```

The `domain_signup_enabled` boolean lets the SSO UI render a generic hint
("Use your work email to sign in") without revealing which domains are
allowed. The raw rule list is **never** returned by this public endpoint —
fetch `GET /auth/app-context/admin?project_id=...` with a project-admin
token to see each rule's `domain`, `target_org`, and `role`. See
"Domain-Based Signup" in [auth.md](./auth.md) for the full v2 rule-list
shape and the matching/audit flow.

Authenticated apps can fetch the current user's app-scoped orgs:

```http
GET /auth/app-access?project_id=proj_xxx
Authorization: Bearer <eve-user-token>
```

The response includes all allowed orgs the user belongs to and which of those
orgs can invite members:

```json
{
  "project_id": "proj_xxx",
  "orgs": [
    {
      "id": "org_customer123",
      "slug": "customer-123",
      "name": "Customer 123",
      "role": "admin",
      "capabilities": {
        "enter_app": true,
        "invite_members": true
      }
    }
  ],
  "admin_orgs": [
    {
      "id": "org_customer123",
      "slug": "customer-123",
      "name": "Customer 123",
      "role": "admin"
    }
  ]
}
```

In-app admin pages should call the app-scoped invite endpoint:

```http
POST /auth/app-invites
Authorization: Bearer <eve-user-token>
Content-Type: application/json

{
  "project_id": "proj_xxx",
  "org_id": "org_customer123",
  "email": "new.user@example.com",
  "redirect_to": "https://app.example.com/",
  "resend": false
}
```

The caller must be an `admin` or `owner` in the target org, the target org must
be allowed by the app policy, and app invites must be enabled. Eve creates a
regular member invite, sends the project-branded invite email, and carries the
target org through SSO as `eve_org_id` after the user accepts. Apps can use the
same project branding for invite and magic-link emails; only the email copy
differs.

React apps can build a small admin invite page with:

```tsx
import { useEveAppAccess } from '@eve-horizon/auth-react';

function InviteMembers() {
  const { adminOrgs, inviteMember } = useEveAppAccess();

  async function submit(email: string) {
    const org = adminOrgs[0];
    if (!org) return;
    await inviteMember({ orgId: org.id, email });
  }
}
```
