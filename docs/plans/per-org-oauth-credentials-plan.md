# Per-Org OAuth Credentials Plan

> **Status**: Complete
> **Author**: AI Architect
> **Date**: 2026-03-14
> **Scope**: Google Drive, Slack (extensible to all OAuth providers)

---

## 1. Problem Statement

Today, Eve Horizon uses **cluster-level OAuth app credentials** for both Google Drive and Slack:

```yaml
# k8s/base/app-secret.yaml — shared across ALL orgs
EVE_GOOGLE_CLIENT_ID: "xxx.apps.googleusercontent.com"
EVE_GOOGLE_CLIENT_SECRET: "GOCSPX-xxx"
EVE_SLACK_CLIENT_ID: "12345.67890"
EVE_SLACK_CLIENT_SECRET: "abc123"
EVE_SLACK_SIGNING_SECRET: "def456"
```

Every org on the platform shares a single OAuth application. This creates several problems:

| Risk | Impact |
|------|--------|
| **Shared secret leak** | One leaked `client_secret` compromises every org's token exchange |
| **Platform-wide revocation** | Google/Slack suspending the shared app kills all orgs simultaneously |
| **No branding control** | Org employees see "Eve Horizon" on the consent screen, not their own company |
| **Shared rate limits** | One noisy org exhausts API quotas for everyone |
| **Enterprise blockers** | Google Workspace admins can't "trust" a third-party app; Slack Enterprise Grid admins can't manage a shared app |
| **Ops burden** | Platform operator must maintain GCP projects, Slack apps, consent screen verification |

### The Goal

**Zero cluster-level OAuth secrets.** Each org brings its own OAuth app credentials. The platform stores, routes, and uses per-org credentials for all OAuth flows and token refresh.

---

## 2. Design Philosophy

### Bring Your Own App (BYOA)

This is a well-established pattern in production SaaS platforms:

| Platform | How they do it |
|----------|---------------|
| **Make.com** | "Connect to Google services using a custom OAuth client" — customers paste their own client_id + client_secret |
| **Windmill** | Workspace-level Slack app configuration — each workspace configures its own Slack app |
| **Supabase** | Per-project Google OAuth — project owner provides client_id + client_secret |
| **n8n** (self-hosted) | Users create their own GCP project and OAuth client for all Google integrations |

### Key Technical Insight

Multiple OAuth client IDs from different GCP projects (or Slack apps) can **all register the same redirect URI** as long as that URI is explicitly configured on each client. Google and Slack validate that `redirect_uri` matches the requesting client's registered URI(s); there is no per-host uniqueness constraint across different clients.

This means Eve keeps **one callback endpoint** per provider. Org routing happens via the `state` parameter (already implemented).

### Two-Tier Model (Optional)

For platforms that want quick onboarding:

| Tier | Who provides credentials | Use case |
|------|-------------------------|----------|
| **Platform default** | Platform operator (env vars) | Quick start, trials, small teams |
| **BYOA** | Each org | Enterprise, compliance, production |

Eve's initial implementation will be **BYOA-only** (no platform defaults). The fallback tier can be added later if needed.

---

## 3. Data Model

### 3.1 OAuth App Configurations Table

A new table stores per-org OAuth app credentials, separate from the per-connection integration tokens:

```sql
-- Migration: 00083_oauth_app_configs.sql

CREATE TABLE oauth_app_configs (
  id              TEXT PRIMARY KEY,           -- oac_xxx (TypeID)
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,              -- 'google_drive', 'slack', etc.

  -- OAuth application credentials (sensitive — encrypted at rest via DB-level encryption)
  client_id       TEXT NOT NULL,
  client_secret   TEXT NOT NULL,

  -- Provider-specific additional config
  config_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- For Slack: { "signing_secret": "xxx", "app_id": "A0123", "bot_name": "Eve" }
  -- For Google: { "project_id": "my-gcp-project", "consent_screen_name": "Acme Corp" }

  -- Metadata
  label           TEXT,                       -- "Acme Corp Google Drive App"
  status          TEXT NOT NULL DEFAULT 'active',
                  -- Keep alignment with integration lifecycle and routing semantics (active/inactive/revoked)
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(org_id, provider)                    -- One OAuth app config per provider per org
);

CREATE INDEX idx_oauth_app_configs_org ON oauth_app_configs(org_id);
CREATE INDEX idx_oauth_app_configs_provider ON oauth_app_configs(provider);
```

### 3.2 Relationship to Existing Tables

```
oauth_app_configs              integrations                  cloud_fs_mounts
┌──────────────────┐          ┌──────────────────┐          ┌──────────────────┐
│ org_id           │──────┐   │ org_id           │──────┐   │ org_id           │
│ provider         │      │   │ provider         │      │   │ integration_id ──┼──→ integrations.id
│ client_id        │      │   │ account_id       │      │   │ provider         │
│ client_secret    │      │   │ tokens_json      │      │   │ root_folder_id   │
│ config_json      │      │   │ settings_json    │      │   └──────────────────┘
└──────────────────┘      │   │ status           │      │
   One per (org, provider)│   └──────────────────┘      │
                          │      Many per org           │
                          └─────────────────────────────┘
```

**Key**: `oauth_app_configs` holds the OAuth *application* credentials (what the org creates in GCP/Slack). `integrations` holds the OAuth *tokens* (what the user grants during consent). An org has one app config per provider, but can have multiple integrations (e.g., connecting multiple Google accounts or Slack workspaces).

### 3.3 Credential Lookup Chain

When performing any OAuth operation (authorize, callback, token refresh), the system resolves credentials in this order:

```
  1. oauth_app_configs WHERE org_id = ? AND provider = ?
     → Found? Use org's client_id + client_secret
     → Not found?
       - During migration (temporary): if legacy env vars are enabled, use them and emit a warning
       - Standard mode: reject with clear error
         "No OAuth app configured for this provider. Register your app credentials first."
```

No fallback to env vars. No cluster-level secrets.

---

## 4. Google Drive: Per-Org OAuth

### 4.1 Setup Flow

The org admin performs a one-time setup:

```
Admin (GCP Console):
  1. Create GCP project (or use existing)
  2. Enable Google Drive API
  3. Configure OAuth consent screen
     - Internal (Workspace) or External
     - Add company branding
  4. Create OAuth 2.0 Client ID (Web application)
     - Authorized redirect URI: <provided by `eve integrations setup-info google-drive`>
  5. Copy client_id and client_secret

Admin (Eve CLI):
  eve integrations configure google-drive \
    --client-id "xxx.apps.googleusercontent.com" \
    --client-secret "GOCSPX-xxx" \
    --label "Acme Corp Google Drive"

  # Now initiate the OAuth connection:
  eve integrations connect google-drive
```

### 4.2 Authorization Flow (Modified)

```
GET /orgs/:org_id/integrations/google-drive/authorize

  1. Look up oauth_app_configs for (org_id, 'google_drive')
     → Not found? Return 400: "Register Google Drive app credentials first"

  2. Generate state token (signed JWT):
     { org_id, provider: 'google_drive', nonce, exp: +10min }

  3. Redirect to Google:
     https://accounts.google.com/o/oauth2/v2/auth?
       client_id={org's client_id from DB}     ← NOT from env var
       &redirect_uri={callback_url}
       &state={signed_state}
       &scope=https://www.googleapis.com/auth/drive
       &access_type=offline
       &prompt=consent
```

### 4.3 Callback Flow (Modified)

```
GET /integrations/google-drive/oauth/callback?code=xxx&state=xxx

  1. Verify + decode state token → extract org_id

  2. Look up oauth_app_configs for (org_id, 'google_drive')
     → Gets org's client_id + client_secret

  3. Exchange code for tokens using ORG'S credentials:
     POST https://oauth2.googleapis.com/token
     {
       client_id: {org's client_id},           ← NOT from env var
       client_secret: {org's client_secret},   ← NOT from env var
       code: xxx,
       grant_type: 'authorization_code',
       redirect_uri: {callback_url}
     }

  4. Store tokens in integrations table (unchanged)
  5. Return success
```

### 4.4 Token Refresh (Modified)

```typescript
// cloud-fs.service.ts — getProviderAndToken()

// BEFORE (cluster-level):
// const clientId = config.EVE_GOOGLE_CLIENT_ID;
// const clientSecret = config.EVE_GOOGLE_CLIENT_SECRET;

// AFTER (per-org):
const appConfig = await this.oauthAppConfigs.findByOrgAndProvider(orgId, 'google_drive');
if (!appConfig) throw new BadRequestException('Google Drive app not configured for this org');
const { client_id: clientId, client_secret: clientSecret } = appConfig;

const refreshed = await provider.refreshAccessToken(clientId, clientSecret, refreshToken);
```

---

## 5. Slack: Per-Org OAuth

### 5.1 Why BYOA for Slack Too

The same benefits apply, plus Slack-specific advantages:

| Benefit | Detail |
|---------|--------|
| **Bot identity control** | Org chooses their bot's name and avatar (configured in the Slack app) |
| **Scope minimalism** | Org only grants the bot scopes they need |
| **Event subscription control** | Org manages which events their Slack app subscribes to |
| **Enterprise Grid** | Org manages app approval at the Grid org level |
| **Signing secret isolation** | Each org's webhook verification is independent |

### 5.2 Setup Flow

```
Admin (Slack App Dashboard — api.slack.com/apps):
  1. Create new Slack app (from scratch or manifest)
  2. Configure:
     - Bot scopes: chat:write, channels:history, files:read, etc.
     - Event subscriptions/interaction URL: <provider-specific org URL from `eve integrations setup-info slack`>
     - Redirect URL: <provided by `eve integrations setup-info slack`>
     - Interactivity URL (if needed)
  3. Copy App ID, Client ID, Client Secret, Signing Secret

Admin (Eve CLI):
  eve integrations configure slack \
    --client-id "12345.67890" \
    --client-secret "abc123" \
    --signing-secret "def456" \
    --app-id "A0123ABC" \
    --label "Acme Corp Slack Bot"

  # Now initiate the OAuth connection:
  eve integrations connect slack
```

### 5.3 Authorization Flow (Modified)

Same pattern as Google Drive — read client_id from `oauth_app_configs` instead of env vars.

### 5.4 Gateway Webhook Verification (Modified)

The current gateway implementation exposes a single Slack webhook surface (`/gateway/providers/slack/webhook`, plus `interactive` and `slash`) and reads `EVE_SLACK_SIGNING_SECRET` from env for all orgs.
With BYOA, each org has its own signing secret, so this must change.

```
Slack Webhook Arrives:
  1. Read raw request body (buffer for signature verification)
  2. Resolve the target org before verification:
     - Primary: org-scoped webhook endpoint returned by setup-info (for example
       `?cfg=<config_id>` on `/gateway/providers/slack/webhook` or a new
       `/gateway/providers/slack/org/:org_id/webhook` route)
     - Fallback: parse `body.team_id`, `body.event.team`, `payload.team.id` when present
  3. Look up oauth_app_configs for (org_id, 'slack') using the resolved org_id
  4. Verify HMAC signature using org's signing_secret
     - Body parsing must happen on a raw buffer before JSON decode
     - If signature fails, return 401
  5. Parse JSON/form payload and process the event
```

**URL verification edge case**: Slack sends a `url_verification` challenge during setup and the body may not include `team_id`.
If using the org-scoped webhook URL from setup-info, org resolution occurs outside the body, so the signing secret can be selected without trusting unverified payload body fields.
If still falling back to payload body fields, return 401 when verification fails.

### 5.5 Provider Registry Changes

```typescript
// apps/gateway/src/providers/provider-registry.ts

// BEFORE:
if (integration.provider === 'slack' && process.env.EVE_SLACK_SIGNING_SECRET) {
  settings.signing_secret = process.env.EVE_SLACK_SIGNING_SECRET;
}

// AFTER:
if (integration.provider === 'slack') {
  const appConfig = await this.oauthAppConfigs.findByOrgAndProvider(
    integration.org_id, 'slack'
  );
  if (appConfig?.config_json?.signing_secret) {
    settings.signing_secret = appConfig.config_json.signing_secret;
  }
}
```

---

## 6. API Endpoints

### 6.1 OAuth App Configuration CRUD

```
POST   /orgs/:org_id/integrations/providers/:provider/config
  Body: { client_id, client_secret, config: { signing_secret?, app_id?, ... }, label? }
  Permission: integrations:write
  → Creates or updates the OAuth app config for this org + provider

GET    /orgs/:org_id/integrations/providers/:provider/config
  Permission: integrations:read
  → Returns the config (client_secret REDACTED in response)

DELETE /orgs/:org_id/integrations/providers/:provider/config
  Permission: integrations:write
  → Removes the config (prevents new OAuth flows; existing tokens still work until they expire)
```

### 6.2 Modified OAuth Endpoints

Existing endpoints remain the same but read credentials from `oauth_app_configs` instead of env vars:

```
GET /orgs/:org_id/integrations/google-drive/authorize   (unchanged URL, changed credential source)
GET /integrations/google-drive/oauth/callback            (unchanged URL, changed credential source)
GET /orgs/:org_id/integrations/slack/authorize           (unchanged URL, changed credential source)
GET /integrations/slack/oauth/callback                   (unchanged URL, changed credential source)
```

### 6.3 Provider Setup Info Endpoint

Help orgs configure their OAuth apps by providing the exact URLs they need:

```
GET /orgs/:org_id/integrations/providers/:provider/setup-info
  Permission: integrations:read
  Response:
  {
    "provider": "google_drive",
    "callback_url": "https://api.eve.example.com/integrations/google-drive/oauth/callback",
    "webhook_url": null,                                  // not used for Google Drive
    "required_scopes": ["https://www.googleapis.com/auth/drive"],
    "setup_instructions": "1. Go to console.cloud.google.com ..."
  }

  {
    "provider": "slack",
    "callback_url": "https://api.eve.example.com/integrations/slack/oauth/callback",
    "webhook_url": "https://api.eve.example.com/gateway/providers/slack/webhook?cfg=<config_id>",
    "required_scopes": ["channels:history", "chat:write", "commands", "app_mentions:read", ...],
    "setup_instructions": "1. Go to api.slack.com/apps ..."
  }
```

---

## 7. CLI Commands

```bash
# View setup instructions for a provider
eve integrations setup-info google-drive
eve integrations setup-info slack

# Register OAuth app credentials
eve integrations configure google-drive \
  --client-id "xxx.apps.googleusercontent.com" \
  --client-secret "GOCSPX-xxx" \
  [--label "Acme Corp Google Drive"]

eve integrations configure slack \
  --client-id "12345.67890" \
  --client-secret "abc123" \
  --signing-secret "def456" \
  [--app-id "A0123ABC"] \
  [--label "Acme Corp Slack Bot"]

# View current config (secrets redacted)
eve integrations config google-drive
eve integrations config slack

# Remove config
eve integrations unconfigure google-drive
eve integrations unconfigure slack

# Then connect as before (uses per-org credentials now)
eve integrations connect google-drive
eve integrations connect slack
```

---

## 8. What Gets Removed

### 8.1 Environment Variables (Deprecated)

These cluster-level env vars are no longer needed:

```diff
# k8s/base/app-secret.yaml
- EVE_GOOGLE_CLIENT_ID: ""
- EVE_GOOGLE_CLIENT_SECRET: ""
- EVE_SLACK_CLIENT_ID: ""
- EVE_SLACK_CLIENT_SECRET: ""
- EVE_SLACK_SIGNING_SECRET: ""
```

### 8.2 Config Schema (Deprecated)

```diff
# packages/shared/src/config/schema.ts
- EVE_GOOGLE_CLIENT_ID: z.string().optional(),
- EVE_GOOGLE_CLIENT_SECRET: z.string().optional(),
- EVE_SLACK_CLIENT_ID: z.string().optional(),
- EVE_SLACK_CLIENT_SECRET: z.string().optional(),
- EVE_SLACK_SIGNING_SECRET: z.string().optional(),
```

### 8.3 Gateway Env Merge (Removed)

```diff
# apps/gateway/src/providers/provider-registry.ts
- if (integration.provider === 'slack' && process.env.EVE_SLACK_SIGNING_SECRET) {
-   settings.signing_secret = process.env.EVE_SLACK_SIGNING_SECRET;
- }
+ // Signing secret now comes from oauth_app_configs via the integration load
```

---

## 9. Security Considerations

| Concern | Mitigation |
|---------|-----------|
| **Storing client_secret in DB** | Encrypted at rest (PostgreSQL column-level or application-level encryption). Never returned in API responses. |
| **State parameter tampering** | Signed JWT with HMAC (existing implementation). Short TTL (10 min). |
| **Signing secret lookup timing** | Gateway reads body to extract team_id, then verifies signature. Body parsing before verification is safe — the signature check still rejects forged payloads. |
| **Credential rotation** | Admin updates via `eve integrations configure`. Existing tokens continue to work. New OAuth flows use new credentials. |
| **Orphaned tokens** | If app config is deleted, existing integration tokens still work until they expire or refresh fails. Refresh failure can mark integration `inactive` or trigger a re-auth prompt in client UI. |
| **Multi-account orgs** | One OAuth app config per org per provider. Multiple connections (integrations) share the same app config. |

### 9.1 Client Secret Storage

The `client_secret` field in `oauth_app_configs` must be treated with the same sensitivity as the refresh tokens in `integrations.tokens_json`. Options:

1. **Application-level encryption**: Encrypt before INSERT, decrypt on SELECT. Key from env var `EVE_SECRETS_MASTER_KEY` (already used elsewhere).
2. **PostgreSQL pgcrypto**: `pgp_sym_encrypt` / `pgp_sym_decrypt` with a server-side key.
3. **Vault integration** (future): Store secrets in HashiCorp Vault, reference by path.

Recommendation: Use the same approach currently used for `integrations.tokens_json`. If tokens_json is stored as plaintext JSONB (current state), then client_secret can be too — both should be upgraded to encrypted storage together in a future hardening pass.

---

## 10. Implementation Phases

### Phase 1: Data Model + Google Drive BYOA

**Goal**: Google Drive OAuth uses per-org credentials. No cluster-level Google secrets.

- [ ] Migration `00083_oauth_app_configs.sql`
- [ ] DB queries: `oauthAppConfigQueries` (findByOrgAndProvider, upsert, remove)
- [ ] TypeID: `generateOauthAppConfigId()` → `typeid('oac')`
- [ ] Zod schemas: `OAuthAppConfigResponse`, `CreateOAuthAppConfigRequest`
- [ ] API: `POST/GET/DELETE /orgs/:org_id/integrations/providers/:provider/config`
- [ ] API: `GET /orgs/:org_id/integrations/providers/:provider/setup-info`
- [ ] Modify `google-drive-oauth.controller.ts`: read credentials from DB
- [ ] Modify `cloud-fs.service.ts`: token refresh uses per-org credentials
- [ ] CLI: `eve integrations configure`, `eve integrations config`, `eve integrations setup-info`
- [ ] Remove `EVE_GOOGLE_CLIENT_ID` and `EVE_GOOGLE_CLIENT_SECRET` from config schema
- [ ] Remove from `k8s/base/app-secret.yaml`
  - [ ] Permission: `integrations:write` for config create/update/delete

### Phase 2: Slack BYOA

**Goal**: Slack OAuth uses per-org credentials. No cluster-level Slack secrets.

- [ ] Modify `slack-oauth.controller.ts`: read credentials from DB
- [ ] Modify gateway `provider-registry.ts`: read signing_secret from `oauth_app_configs`
- [ ] Modify gateway webhook verification: per-org signing secret lookup by team_id
- [ ] CLI: `eve integrations configure slack` (with `--signing-secret`)
- [ ] Remove `EVE_SLACK_CLIENT_ID`, `EVE_SLACK_CLIENT_SECRET`, `EVE_SLACK_SIGNING_SECRET` from config schema
- [ ] Remove from `k8s/base/app-secret.yaml`
- [ ] Update gateway Slack provider to handle URL verification edge case
- [ ] Integration test: multi-org Slack webhook verification

### Phase 3: Cleanup + Docs

- [ ] Remove all cluster-level OAuth env vars from deployment manifests
- [ ] Update system docs: `docs/system/integrations.md`
- [ ] Update eve-skillpacks: `references/secrets-auth.md`, `references/gateways.md`
- [ ] Add setup guides for Google Drive and Slack app creation
- [ ] Update `docs/plans/cloud-fs-integration-plan.md` to reflect per-org model

---

## 11. Migration Path for Existing Deployments

For deployments that already have cluster-level credentials and active integrations:

1. **Deploy Phase 1 code** — includes fallback: if no `oauth_app_configs` row exists, check env vars as legacy fallback
2. **Admin registers per-org credentials** via CLI
3. **Verify**: new OAuth flows use per-org credentials
4. **Remove env vars** from K8s secrets
5. **Deploy Phase 3** — removes fallback code, clean break

The legacy fallback is a temporary bridge, not a permanent feature. It should be removed within one release cycle.

---

## 12. Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Separate table vs settings_json | Separate `oauth_app_configs` table | Clean separation: app credentials (org-level) vs connection tokens (per-account). One-to-many: one app config, many connections. |
| Single callback URL vs per-org paths | Single callback URL + state routing | Simpler for orgs to configure. Already implemented (state tokens). No URI proliferation. |
| BYOA-only vs two-tier | BYOA-only (no platform defaults) | Eliminates cluster-level secrets entirely. Simpler mental model. Quick-start tier can be added later if needed. |
| Signing secret lookup timing | Primary via org-scoped URL (from setup-info), fallback parse `team_id` fields → lookup → verify | Better because setup verification avoids relying on body fields that can be missing during challenge requests. |
| Client secret storage | Same as tokens_json (plaintext JSONB for now) | Consistent with existing security posture. Both should be encrypted together in a future hardening pass. |

---

## Appendix A: Google Drive Setup Guide (for Org Admins)

```
1. Go to https://console.cloud.google.com
2. Create a new project (or select existing)
3. Enable the Google Drive API:
   - Navigation > APIs & Services > Library
   - Search "Google Drive API" > Enable
4. Configure OAuth consent screen:
   - Navigation > APIs & Services > OAuth consent screen
   - Choose "Internal" (Google Workspace) or "External"
   - Fill in app name, support email, authorized domains
5. Create OAuth credentials:
   - Navigation > APIs & Services > Credentials
   - Create Credentials > OAuth client ID
   - Application type: Web application
   - Authorized redirect URI: <provided by `eve integrations setup-info google-drive`>
6. Copy the Client ID and Client Secret
7. Run: eve integrations configure google-drive --client-id "..." --client-secret "..."
8. Run: eve integrations connect google-drive
```

## Appendix B: Slack App Setup Guide (for Org Admins)

```
1. Go to https://api.slack.com/apps
2. Click "Create New App" > "From scratch"
3. App Name: choose a name (e.g., "Eve Bot" or your company's name)
4. Workspace: select your workspace
5. Under "OAuth & Permissions":
   - Add Bot Token Scopes: chat:write, channels:history, channels:read,
     files:read, files:write, groups:history, groups:read, im:history,
     im:read, users:read
   - Add Redirect URL: <provided by `eve integrations setup-info slack`>
6. Under "Event Subscriptions":
   - Enable Events
   - Request URL: <provided by `eve integrations setup-info slack`>
   - Subscribe to bot events: message.channels, message.groups,
     message.im, app_mention, file_shared
7. Under "Basic Information":
   - Copy App ID, Client ID, Client Secret, Signing Secret
8. Run: eve integrations configure slack --client-id "..." --client-secret "..."
         --signing-secret "..." --app-id "..."
9. Run: eve integrations connect slack
10. Install the app to your workspace when prompted
```
