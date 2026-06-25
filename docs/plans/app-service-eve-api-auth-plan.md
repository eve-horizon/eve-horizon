# App Service Eve API Auth Plan

> **Status**: Shipped (2639970)  
> **Last Updated**: 2026-01-30  
> **Intent**: Enable Eve-compatible app services (deployed components) to call the Eve REST API securely from inside the service runtime.

## Why This Exists

Teams want buttons and automations inside their deployed app (API/backend) to:
- Create Eve jobs
- Follow job logs / results
- Trigger environment deploys

Today, services receive `EVE_API_URL` but **no auth token**. The only auth is a user JWT obtained via CLI login, which is not suitable for long‑running services.

## Goals

- **Opt‑in per service**: apps explicitly enable Eve API access in the manifest.
- **Short‑lived access tokens**: app services get expiring tokens (minutes/hours).
- **Role‑based access**: use existing org/project roles (member/admin/owner).
- **Env‑scoped**: tokens limited to one environment (e.g., `staging`).
- **CLI‑first**: service accounts and tokens managed via Eve CLI.
- **Auditability**: track issuance and usage.

## Non‑Goals (for now)

- UI for service account management.
- Fine‑grained scopes (role‑only in v1).
- OIDC/workload identity integration.

---

## Current State (Implemented)

- Auth uses RS256 JWT with SSH login for humans (`eve auth login`).
- Tokens are stored in CLI profiles and sent via `Authorization: Bearer`.
- Deployed services get `EVE_API_URL`, `EVE_PROJECT_ID`, `EVE_ORG_ID`, `EVE_ENV_NAME`.
- No Eve token is injected into services.

---

## Proposed Design

### 1) Service Accounts (Project‑Scoped, Env‑Scoped)

Introduce **service accounts** that represent an application component (e.g., `api-staging`).

**Key properties:**
- `project_id` (required)
- `org_id` (derived)
- `env_name` (required for v1)
- `role` (`member` or `admin`)
- `name` (display label)

Service accounts are used to obtain short‑lived access tokens.

### 2) Long‑Lived Service Key + Short‑Lived Access Token

**Service Key (long‑lived):**
- Random secret generated once on create.
- Stored hashed in DB (argon2/bcrypt).
- Returned only once on creation.
- Used to exchange for short‑lived access tokens.

**Access Token (short‑lived JWT):**
- Signed by existing auth key (RS256).
- Claims include:
  - `type: service`
  - `sub: service_account_id`
  - `project_id`, `org_id`
  - `env_name`
  - `role`
  - `exp` (short‑lived)
- Accepted by `Authorization: Bearer`.

### 3) Token Exchange Endpoint

Add a new auth endpoint:

```
POST /auth/service/token
Headers:
  x-eve-service-key: <long-lived service key>
Body:
  project_id: string
  env_name: string
```

Response:
```
{ access_token, token_type: "bearer", expires_at }
```

**Security rules:**
- Key must match a service account with the same `project_id` + `env_name`.
- Role is derived from the service account.
- Rate limit per key.
- Record `last_used_at`.

### 4) Auth Guard Extensions

Extend auth to accept **service tokens**:
- `AuthService.verifyAuthorizationHeader` recognizes `type=service`.
- Returns a principal with:
  - `principal_type: service`
  - `service_account_id`
  - `project_id`, `org_id`, `env_name`, `role`

### 5) Env Scope Enforcement

Add an `EnvScopeGuard` that:
- Checks if token has `env_name`.
- Ensures request env matches.

Apply to endpoints:
- `POST /projects/:id/envs/:name/deploy`
- `GET /projects/:id/envs/:name/*`
- Job endpoints when `env_name` is present:
  - create jobs: if token has env, require `env_name` in body and match
  - list/get jobs: require `env_name` filter or validate job.env_name
  - logs/stream: validate job.env_name matches token

### 6) Manifest Opt‑In + Injection

Manifest extension:

```yaml
services:
  api:
    x-eve:
      eve_api:
        enabled: true
        env_scope: staging
        role: member
        key_secret: EVE_APP_KEY
```

**Behavior:**
- Deployer injects `EVE_APP_KEY` from secrets into the service env.
- Service uses `EVE_APP_KEY` to exchange for short‑lived access tokens.
- Optional: inject `EVE_API_TOKEN_TTL_SECONDS` for client refresh timing.

### 7) CLI Workflow

Add `eve service-accounts` commands:

```
eve service-accounts create \
  --project proj_xxx \
  --env staging \
  --role member \
  --name api-staging

eve service-accounts list --project proj_xxx
eve service-accounts rotate --project proj_xxx --name api-staging
eve service-accounts delete --project proj_xxx --name api-staging
```

**Create** outputs the secret once:
```
Service key: eve_sa_...
```

User stores it in secrets:
```
eve secrets set EVE_APP_KEY eve_sa_... --project proj_xxx
```

### 8) App Runtime Usage (SDK‑less)

Example flow inside the service:

```
POST /auth/service/token
  x-eve-service-key: $EVE_APP_KEY
  { project_id, env_name }

Authorization: Bearer <access_token>
```

Token refresh is performed by re‑calling `/auth/service/token` before expiry.

---

## Data Model Changes

### New Table: `service_accounts`

Fields:
- `id` (text PK)
- `project_id` (FK)
- `org_id` (FK)
- `env_name` (text, required)
- `role` (enum: member/admin)
- `name` (text)
- `key_hash` (text)
- `created_by` (user_id)
- `last_used_at` (timestamp)
- `created_at`, `updated_at`

Indexes:
- `(project_id, env_name, name)` unique

---

## API Surface (New / Updated)

**New endpoints**
- `POST /projects/:id/service-accounts` (admin only)
- `GET /projects/:id/service-accounts`
- `DELETE /projects/:id/service-accounts/:sa_id`
- `POST /projects/:id/service-accounts/:sa_id/rotate`
- `POST /auth/service/token` (service key exchange)

**Updated endpoints**
- Job + env endpoints to enforce `env_name` for service tokens.

---

## Config & Defaults

Add config:
- `EVE_AUTH_SERVICE_TOKEN_TTL_SECONDS` (default: 3600, max: 86400)
- `EVE_AUTH_SERVICE_KEY_TTL_DAYS` (optional; if rotation enforced later)

---

## Phased Implementation Plan

### Phase 1 — Data Model + Auth Core
- Add `service_accounts` table + queries.
- Add service account CRUD in API (project‑scoped).
- Add `/auth/service/token` endpoint.
- Extend AuthService to verify service tokens.

### Phase 2 — Env Scoping Enforcement
- Add `EnvScopeGuard` (global or endpoint‑specific).
- Enforce env match for:
  - env deploy / env diagnostics / env logs / env db
  - job create / job get / job list / job stream

### Phase 3 — CLI + Secrets Workflow
- Add CLI commands for service accounts.
- Document secret injection (`EVE_APP_KEY`).
- Add `eve secrets` helper docs for app auth.

### Phase 4 — Manifest Opt‑In + Deployer Injection
- Add `x-eve.eve_api` manifest schema.
- Validate required secret exists when enabled.
- Inject service key into service env.

### Phase 5 — Testing + Docs
- Integration tests:
  - exchange token success/failure
  - env mismatch → 403
  - job creation with env scope
  - deploy with env scope
- Update system docs:
  - `docs/system/auth.md`
  - `docs/system/secrets.md`
  - `docs/system/manifest.md`
  - CLI docs

---

## Risks & Mitigations

- **Token leakage**: do not log service keys; redact in logs.
- **Over‑broad access**: enforce env scoping everywhere.
- **Rotation pain**: add rotate endpoint + CLI.

---

## Open Questions

1. Should service tokens also include `project_slug` for easier debugging?
2. Should we block `admin` role for service accounts in v1?
3. Should env‑scoped tokens be mandatory for all service accounts (v1 default)?

