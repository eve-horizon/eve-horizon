# Auth & Governance

> Status: Current
> Last Updated: 2026-02-12

## Overview

Eve Horizon uses RS256 JWT tokens for authentication. When Supabase Auth is
enabled, Eve also accepts Supabase-issued HS256 access tokens for web login.
Verification is **dual-mode**: RS256 is tried first, then HS256 (when configured).
Job tokens and service principal tokens remain **RS256-only**.

| Token Source | Algorithm | Use Case |
|--------------|-----------|----------|
| **Eve internal** | RS256 | CLI, job tokens, service principals, SSH/Nostr identity flows |
| **Supabase Auth** | HS256 | Browser login and SSO-based user sessions |

See [Identity Providers](./identity-providers.md) for the pluggable provider architecture.

## Job Token Resource Scope

Job tokens carry explicit permission names and may also carry an optional
`scope` claim. Tokens without `scope` keep the legacy permission-name-only
behavior. Tokens with `scope` are resource-checked by `ScopedAccessService`
before org filesystem, org document, env DB, or Cloud FS operations proceed.

The `scope` claim uses the same shape as access binding `scope_json`:

```json
{
  "orgfs": { "allow_prefixes": ["/groups/projects/proj-a/**"] },
  "orgdocs": { "read_only_prefixes": ["/briefs/**"] },
  "envdb": { "schemas": ["public"], "tables": ["public.jobs"] },
  "cloud_fs": { "allow_mount_ids": ["mount_a"] }
}
```

Workflow step jobs persist the resolved value on `jobs.token_scope`. The
orchestrator uses that same value to build the workspace `.org` mount and to
mint the job token, so the on-disk view and API authority match.

## Configuration

### Required Variables

| Variable | Description |
|----------|-------------|
| `EVE_AUTH_ENABLED` | Enable authentication (`true`/`false`, default: `true`) |
| `EVE_AUTH_PRIVATE_KEY` | RSA private key (PEM string or file path) — required for internal mode |
| `EVE_BOOTSTRAP_TOKEN` | One-time token for initial admin creation |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `EVE_AUTH_PUBLIC_KEY` | RSA public key (derived from private if omitted) | — |
| `EVE_AUTH_PUBLIC_KEY_OLD` | Previous public key for rotation grace period | — |
| `EVE_AUTH_KEY_ID` | Key identifier in JWKS | `key-1` |
| `EVE_AUTH_KEY_ID_OLD` | Previous key identifier | `key-0` |
| `EVE_AUTH_CHALLENGE_TTL_SECONDS` | SSH challenge validity | `300` |
| `EVE_AUTH_TOKEN_TTL_DAYS` | User token TTL in days (max 90) | `1` |
| `SUPABASE_JWT_SECRET` | Enables Supabase token verification (HS256) | — |
| `EVE_SUPABASE_URL` | Legacy Supabase URL (deprecated; prefer `SUPABASE_AUTH_URL`) | — |
| `SUPABASE_URL` | Legacy Supabase URL (deprecated; prefer `SUPABASE_AUTH_URL`) | — |

### Supabase Web Auth Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SUPABASE_AUTH_URL` | GoTrue internal URL (service-to-service) | — |
| `SUPABASE_AUTH_EXTERNAL_URL` | GoTrue public URL for browser clients | — |
| `SUPABASE_AUTH_SERVICE_KEY` | HS256 JWT with `service_role` claim | — |
| `SUPABASE_ANON_KEY` | HS256 JWT with `anon` claim | — |
| `EVE_SSO_URL` | Public SSO broker URL (e.g., `https://sso.<domain>`) | — |
| `EVE_AUTH_ADMIN_PASSWORD` | GoTrue DB role password for bootstrap job | — |

## Web Auth Stack (Supabase + SSO)

When Supabase Auth is enabled, Eve runs three web-auth components:

- **GoTrue (Supabase Auth)**: Handles email/password, magic links, and invites.
- **SSO broker** (`apps/sso`): Central login/session service that exchanges Supabase
  tokens for Eve RS256 tokens and sets a shared, root-domain session cookie.
- **Mailpit (local only)**: Captures invite and magic-link emails at `mail.<domain>`.

### Auth Configuration Discovery

Clients should discover auth settings via the public endpoint:

```
GET /auth/config
```

Response:

```json
{
  "supabase_url": "https://auth.example.com",
  "anon_key": "<supabase_anon_jwt>",
  "sso_url": "https://sso.example.com"
}
```

### Token Exchange (Supabase → Eve)

Exchange a Supabase HS256 access token for an Eve RS256 token:

```
POST /auth/exchange
Authorization: Bearer <supabase_access_token>
```

This endpoint verifies the Supabase token, resolves or auto-links the Eve user,
and returns a standard Eve access token.

### Admin Web Invites

Admins can send Supabase Auth invite emails:

```
POST /auth/supabase/invite
```

CLI usage:

```bash
eve admin invite --email newuser@example.com --org org_xxx --web
eve admin invite --email newuser@example.com --web --redirect-to https://app.example.com
```

### App-Scoped Passwordless Login

An app can opt into branded passwordless login with manifest `x-eve.auth`:

```yaml
x-eve:
  auth:
    login_method: magic_link
    self_signup: false
    invite_requires_password: false
```

With this policy, app-initiated SSO redirects include `project_id`, SSO fetches `GET /auth/app-context?project_id=<project_id>`, and the login page renders a branded magic-link-only form. Magic-link email is sent by Eve API through `POST /auth/magic-link` after checking project policy and recipient eligibility, so unknown emails do not trigger GoTrue user creation when `self_signup` is false. Projects that explicitly use `login_method: password_or_magic_link` keep password login plus the secondary magic-link control, but that magic-link request is still app-scoped and branded. Projects without `x-eve.auth` keep the legacy SSO behavior.

The same `x-eve.branding` values used by app-branded invites are used for magic-link emails. Invite copy and magic-login copy differ, but logo, app name, color, sender display name, reply-to, and support footer are shared.

For passwordless apps, create new users through the org invite flow. If `invite_requires_password: false`, the invite callback establishes the SSO session and redirects to the app without `/set-password`. Projects without `x-eve.auth` keep the existing password, sign-up, and GoTrue magic-link SSO behavior.

#### Magic-Link Confirmation Interstitial

Eve-rendered magic-link and invite emails do not embed the raw GoTrue verify URL. Email-security scanners (Microsoft Defender SafeLinks, Mimecast, Proofpoint, Barracuda, Cisco IronPort) follow every URL in incoming mail, which consumes single-use GoTrue OTPs before the human ever clicks. To protect against this, the API wraps each `action_link` behind an SSO confirmation interstitial:

1. `AuthService.wrapActionLink` stores the GoTrue URL in the `magic_link_wraps` table (1h TTL, retention 24h) and returns `https://sso/m/mlw_<id>`.
2. The email contains only the wrap URL.
3. `HEAD/GET /m/:wrap` on the SSO renders a branded confirmation page (or just headers) and is fully idempotent. Each call bumps `get_count` and `last_get_at` so scanner prefetches are visible in telemetry.
4. `POST /m/:wrap` (from the form's "Sign in" / "Accept invite" button) calls `/internal/auth/magic-link-wrap/consume`, which atomically marks the wrap consumed and reveals the GoTrue URL. The SSO 302-redirects the browser; GoTrue verifies the OTP and returns to `/callback` as before.

Operations note: rows with `get_count > 1` are expected for users on protected mailboxes. The pruner deletes expired or long-consumed rows after 24h. Wrap tokens have the typeid('mlw') shape (`mlw_<26 base32>`) and are validated against that regex before any DB lookup. The wrap token is the bearer credential — knowing it lets the holder redeem. Trust boundary matches `org_invites.invite_code`.

CSRF defense is a stateless HMAC nonce (signed with `EVE_INTERNAL_API_KEY`); it defends against accidental cross-origin form submissions but does not add against a token-holder attacker. All `/m/*` responses set `Cache-Control: no-store` and `Referrer-Policy: no-referrer` to prevent token leakage via Referer or shared caches. The interstitial only displays the destination host once `redirect_to` passes the same project-aware allowlist used by `/callback`.

A successful consume emits `auth.action_link.wrap_redeemed` to the event spine when `project_id` is present, carrying `{ org_id, email_hash, kind, get_count, latency_ms }`. The event source `auth` is also used for the existing `auth.domain_signup.*` events.

### App Org Access And Admin Invites

Apps can restrict SSO access to the project owner org or a specific allowlist of
orgs:

```yaml
x-eve:
  auth:
    login_method: magic_link
    self_signup: false
    invite_requires_password: false
    org_access:
      mode: allowlist
      allowed_orgs:
        - org_customer123
        - customer-slug
      invite:
        enabled: true
        admin_roles: [admin, owner]
        invited_role: member
```

Manifest sync resolves `allowed_orgs` to canonical org IDs. Auth and SDK flows
then use that same policy for:

- app-scoped magic-link eligibility;
- `GET /auth/app-access`, which returns the allowed orgs for the current user;
- `POST /auth/app-invites`, which lets an allowed org admin/owner invite a new
  regular member into that org with the app-branded invite email.

App-facing invites always create `member` invites. The generic org invite APIs
remain available for platform/CLI workflows, but an app admin page should use
`POST /auth/app-invites` so Eve can enforce both org role and app allowlist
policy before sending cross-org project-branded mail.

### Domain-Based Signup

Apps can pre-approve email domains so anyone with a matching address can sign
in via magic link without a per-user invite. On first successful login the
platform auto-attaches them as a `member` of the **rule-specific** `target_org`,
so one project can serve multiple customer orgs from a single manifest.

```yaml
x-eve:
  auth:
    login_method: magic_link
    invite_requires_password: false
    org_access:
      mode: allowlist
      allowed_orgs: [org_Acme, org_ExampleCo, org_SampleCo, org_ALLTAG]
      domain_signup:
        enabled: true
        domains:
          - domain: example.com
            target_org: org_Acme
            role: member            # optional; defaults to 'member'
          - domain: partner.example
            target_org: org_ExampleCo
          - domain: sampleco.example
            target_org: org_SampleCo
          - domain: tag.example
            target_org: org_ALLTAG
```

**v2 schema (2026-05-12, breaking change).** Each entry under `domains` is now
an object with a required `target_org`. The v1 list-of-strings shape and the
block-level `target_org` / `role` fields are no longer accepted; manifest
sync rejects them. See [ADR/finding 0016 in acme-portal] for the rationale.

**Trust model.** The operator declares the domains and the platform trusts
them — no DNS proof is required in v2. Declaring `gmail.com` (or any free-
email provider) is allowed but produces a manifest coherence warning per
rule, because the effect is "anyone on Earth can join that rule's `target_org`
from this app". Domain ownership verification is a planned future enhancement.

**Mechanics.**

1. `POST /auth/magic-link` walks `domains[]` in **declaration order** and
   takes the first rule whose domain pattern matches the sender's email.
   No implicit longest-match: if both `acme.com` and `*.acme.com` could
   match (different rules, potentially different target orgs), the one
   that appears first in the list wins. Declare more-specific rules
   first if precedence matters.
2. On a match, the API writes a one-shot `org_invites` row tagged
   `app_context.source = "domain_signup"` with `org_id = matched
   rule.target_org` plus `matched_rule` (the rule's `domain` pattern)
   and `matched_domain` (the email's actual domain) for auditing, then
   sends the standard branded magic-link email.
3. After GoTrue redeems the magic link, `/auth/exchange` resolves the
   user (existing or newly auto-provisioned) and the shared invite-claim
   helper upserts membership into the matched `target_org` and marks
   the invite used.
4. Two audit events flow through the event spine for every domain signup:
   `auth.domain_signup.invite_created` (creation) and
   `auth.domain_signup.member_attached` (consumption). Both can be wired
   to webhooks subscribed to `auth.*` and carry `org_id` from the
   matched rule plus `matched_rule` on the creation event.

**Eligibility precedence.**

- An existing user with membership in an allowed org gets the existing
  branded send path (Path A).
- An *explicit* pending invite for the email (an invite written by an
  admin via `POST /auth/app-invites` or `eve org invite`) takes priority
  over the domain signup path — no second invite row is written and no
  magic-link email is sent, so the explicit invite remains the entry
  point (Path B).
- A pending `source: domain_signup` invite for the same email + target
  org is reused for idempotency: a repeat magic-link request within 72
  hours does not create a second row, but it still sends a fresh email
  so the user can retry.
- Non-matching domains fall through to the legacy `self_signup` check,
  then to generic success with no email (Paths D / E).

**Validation rules (sync-time).**

- `domain_signup.enabled = true` requires at least one rule in `domains[]`.
- Each rule's `target_org` is required; missing it → sync rejects with
  the offending rule index + domain.
- Each rule's `target_org` (resolved from slug or canonical id) must
  appear in the project's effective `allowed_orgs`. Otherwise reject.
- No duplicate `domain:` patterns within one block. Reject on conflict.
- `domain_signup.enabled = true` is invalid with `login_method: password`
  (there's no way to deliver the link). `magic_link` and
  `password_or_magic_link` both work.
- Domain patterns are lowercased and IDN-normalized (punycode) at parse
  time. Wildcard `*.example.com` matches subdomains; declare apex
  `example.com` as a separate rule if it should also match.
- Per-rule `role` is forward-compat reserved at `member`; admin promotion
  is never automatic.

**Surfacing.**

- `GET /auth/app-context?project_id=...` returns only the boolean
  `auth.org_access.domain_signup_enabled` to the unauthenticated SSO UI
  — the raw rule list would be an enumeration oracle exposing which
  customer orgs the app serves.
- `GET /auth/app-context/admin?project_id=...` returns the full resolved
  rule list (each entry's `domain`, `target_org`, `role`) for project
  admins and system admins.
- `eve project auth-context <project_id>` tries the admin endpoint
  first and renders the rule list (one line per rule:
  `<domain> -> <target_org> (<role>)`); non-admins see `Domain signup:
  enabled (details hidden)`.

**Revocation.** Removing a rule from the manifest stops new signups
under that rule but does not retroactively remove members that already
joined. Drop their org memberships explicitly:

```bash
eve org members remove --org org_ExampleCo --user user_xxx
```

### Redirect Allowlist (Custom Domains)

By default, the SSO broker only accepts redirect targets that live under the
cluster domain (`EVE_DEFAULT_DOMAIN`, e.g. `eve.example.com`). Apps deployed on
their own domain need to opt their origin into the redirect and CORS allowlist.

There are three sources that contribute to the final allowlist returned by
`GET /auth/app-context?project_id=...` as `auth.allowed_redirect_origins`:

1. **Explicit manifest declaration** —
   ```yaml
   x-eve:
     auth:
       allowed_redirect_origins:
         - https://app.example.com
         - https://www.example.com
   ```
   Entries are origins only (`scheme://host[:port]`). Paths, query, fragments,
   and userinfo are rejected at manifest-validate time. `http://` is permitted
   only for `localhost`, loopback IPs, and `*.lvh.me` so local k3d works
   without TLS.

2. **Project's own eligible custom domains** — every `custom_domains` row owned
   by the project with `environment_id IS NOT NULL` and status in
   (`dns_verified`, `cert_provisioning`, `active`) is auto-included as
   `https://<hostname>`. A project with a registered custom domain does not
   need to repeat it in the manifest.

3. **Cross-org allowed_orgs expansion** — when `auth.org_access.mode` is
   `allowlist`, eligible custom domains owned by any project in `allowed_orgs`
   are also auto-included. This handles the case where a branding-only project
   in one org redirects to a deployed app whose custom domain lives in a
   sibling org.

The SSO broker uses this list for two checks:

- **`redirect_to` validation** in `/callback` and the `/` / `/login` landing
  pages. Cluster-domain hostnames are always accepted; anything else must
  match an entry in the project's allowlist (by exact scheme+host+port).
- **CORS** for `/session` and `/logout`. Same-origin and cluster-domain
  origins are accepted unconditionally. Non-cluster origins require
  `project_id` in the request query so the broker can look up the project's
  allowlist. The browser `Origin` header is then matched against that list.

When a custom-domain app uses the `@eve-horizon/auth-react` SDK, the provider
calls `GET /session?project_id=<eve_project_id>` and
`POST /logout?project_id=<eve_project_id>` so CORS validation has the project
context it needs.

The resolved list (manifest origins ∪ own eligible custom domains ∪ cross-org
custom domains) is visible to operators via the CLI:

```
eve project auth-context <project_id>
```

#### Session Cookie SameSite

The SSO broker sets two cookies on `.<EVE_DEFAULT_DOMAIN>` after a successful
sign-in:

| Cookie | Purpose | Attributes (https) | Attributes (http local) |
| --- | --- | --- | --- |
| `eve_sso_rt` | Refresh token (httpOnly) | `Secure; HttpOnly; SameSite=None` | `SameSite=Lax` |
| `eve_sso` | UX hint (cookie presence) | `Secure; SameSite=None` | `SameSite=Lax` |

`SameSite=None` is required for the `@eve-horizon/auth-react` provider's
`fetch(SSO_URL/session, { credentials: 'include' })` probe to carry the
cookies when the app is hosted on a custom domain (e.g.
`sandbox.acme.example` → `sso.eve.example.com` is cross-site to the
browser, so `SameSite=Lax` cookies are stripped per spec). Browsers reject
`SameSite=None` on insecure origins, so the cookie attribute is gated on
`EVE_SSO_SECURE_COOKIES=true`. Local k3d (`http://*.lvh.me`) keeps
`SameSite=Lax` because the app and SSO share the `.lvh.me` parent (same
site, no cross-site issue).

Operators can confirm the SSO broker's running mode from container logs:

```
[eve-sso] Secure cookies: true (SameSite=none)
```

### Token Verification (Apps)

Apps can verify Eve tokens via:

```
GET /auth/token/verify
```

See [Agent App API Access](./agent-app-api-access.md) for SDK usage.

### Generating Keys

```bash
# Generate a new RSA key pair
openssl genrsa -out eve-auth.key 2048
openssl rsa -in eve-auth.key -pubout -out eve-auth.pub

# Set in environment (or use file paths)
export EVE_AUTH_PRIVATE_KEY="$(cat eve-auth.key)"
export EVE_AUTH_PUBLIC_KEY="$(cat eve-auth.pub)"

# Or reference files directly
export EVE_AUTH_PRIVATE_KEY="/path/to/eve-auth.key"
```

## Bootstrap Flow

The first admin user is created via the bootstrap endpoint. Eve supports three security modes:

### Security Modes

| Mode | Trigger | Token Required | Use Case |
|------|---------|----------------|----------|
| **auto-open** | Fresh deploy, no users exist | No | Easy initial setup |
| **recovery** | Trigger file on host | No | Lost admin access |
| **secure** | `EVE_BOOTSTRAP_TOKEN` set | Yes | Production lockdown |

**Production note:** When `NODE_ENV=production`, bootstrap requires `EVE_BOOTSTRAP_TOKEN`. If it is missing, the bootstrap window is closed.

### Auto-Open Mode (Default)

On a fresh deployment with no users, the bootstrap endpoint is open for 10 minutes:

```bash
# Check bootstrap status
eve auth bootstrap --status

# Bootstrap with YOUR email (not a placeholder!)
eve auth bootstrap --email your-real-email@example.com
```

> **Warning:** Use your actual email address during bootstrap. The bootstrap email becomes the admin account you'll login with. Using a placeholder like `admin@example.com` will lock you out since you won't have the SSH key to authenticate.

The window closes after:
- 10 minutes elapse, OR
- First admin is successfully created

### Recovery Mode

If you lose admin access, create a trigger file on the host to re-open the window:

```bash
# On the server/pod
touch /tmp/eve-bootstrap-enable

# Then from your machine (within 10 minutes)
eve auth bootstrap --email admin@example.com
```

The trigger file is automatically deleted after successful bootstrap.

### Secure Mode (Recommended for Production)

Set `EVE_BOOTSTRAP_TOKEN` to require a token for all bootstrap attempts:

```bash
# Server environment
EVE_BOOTSTRAP_TOKEN=your-secure-random-token

# Bootstrap requires the token
eve auth bootstrap --email admin@example.com --token your-secure-random-token
```

This mode overrides auto-open and recovery modes.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `EVE_BOOTSTRAP_TOKEN` | (none) | Enables secure mode if set |
| `EVE_BOOTSTRAP_TRIGGER_FILE` | `/tmp/eve-bootstrap-enable` | Recovery trigger file path |
| `EVE_BOOTSTRAP_WINDOW_MINUTES` | `10` | Window duration |

### Checking Status

```bash
eve auth bootstrap --status
# Output:
# Bootstrap Status:
#   Mode: auto-open
#   Window: open (closes in 8 minutes)
#   Token required: no
```

Or via API:
```bash
curl $EVE_API_URL/auth/bootstrap/status
```

## CLI Authentication Commands

The Eve CLI provides streamlined authentication commands that handle the complexity of SSH challenge-response automatically.

### eve auth bootstrap

Creates the first admin user. Requires `EVE_BOOTSTRAP_TOKEN` to be set on the server.

```bash
eve auth bootstrap --email admin@example.com --token $EVE_BOOTSTRAP_TOKEN

# Options:
#   --email         Your email address (required)
#   --token         Bootstrap token from server config (required)
#   --ssh-key       Path to SSH public key (default: ~/.ssh/id_ed25519.pub)
#   --display-name  Display name for the user
```

### eve admin invite

Admins can invite new users. The CLI can automatically fetch SSH keys from GitHub,
and can optionally send a Supabase web-auth invite email.

```bash
# Invite with GitHub key auto-fetch
eve admin invite --email newuser@example.com --github newuser

# Invite with role
eve admin invite --email newuser@example.com --github newuser --role admin

# Send a Supabase web-auth invite email
eve admin invite --email newuser@example.com --web
eve admin invite --email newuser@example.com --web --redirect-to https://app.example.com
```

### eve auth request-access

Users can submit self-service access requests when they don’t yet have an invite:

```bash
eve auth request-access --org "My Company" --email you@example.com
eve auth request-access --org "My Company" --ssh-key ~/.ssh/id_ed25519.pub
eve auth request-access --org "My Company" --nostr-pubkey <hex>

# Poll request status
eve auth request-access --status <request_id>
```

### eve admin access-requests

Admins can review, approve, or reject access requests:

```bash
eve admin access-requests list
eve admin access-requests approve <request_id>
eve admin access-requests reject <request_id> --reason "..."
```

List responses use the canonical collection envelope:

```json
{
  "data": [
    { "id": "areq_xxx", "status": "pending" }
  ]
}
```

Approval behavior:
- Approval is atomic (single DB transaction). Failed attempts do not leave partial org/user state.
- If the access-request fingerprint is already registered, Eve reuses that identity owner instead of failing.
- Re-approving an already-approved request is idempotent and returns the existing approved record.
- If a legacy partial org already exists with the same slug and name, Eve reuses it during approval.

### Org Invites (Identity-Targeted)

Admins can create invites targeting specific identity providers:

```bash
curl -X POST "$EVE_API_URL/auth/invites" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"org_id": "org_xxx", "role": "member", "provider_hint": "nostr", "identity_hint": "<pubkey>"}'
```

When an unregistered Nostr pubkey authenticates and matches an invite's identity_hint, Eve auto-provisions a user account and org membership.

### eve auth login

Authenticates using SSH challenge-response. The CLI handles the entire flow automatically.

```bash
eve auth login --email user@example.com

# Options:
#   --email     Your registered email
#   --ssh-key   Path to SSH private key for signing (default: ~/.ssh/id_ed25519)
#   --ttl       Token TTL in days (1-90, default: server configured)

# Login with a 7-day token
eve auth login --email user@example.com --ttl 7
```

### eve auth creds

Check local Claude/Codex credential availability:

```bash
eve auth creds
eve auth creds --claude
eve auth creds --codex
```

### eve auth verify

Run a managed Claude-family probe job against a project and verify the selected
credential works through the same runtime path as normal jobs:

```bash
eve auth verify --harness claude --project proj_xxx --json
```

The command creates a short job that asks Claude to return `EVE_AUTH_OK`, waits
for completion, and inspects runtime logs for `claude_auth_selected` plus Claude
Code's `system/init.apiKeySource`. JSON output includes `ok`, `secret_key`,
`scope_type`, `scope_id`, `token_class`, `apiKeySource`, and `model_replied`.

### eve auth sync

Sync local OAuth tokens into Eve secrets (scope: project > org > user):

```bash
eve auth sync
eve auth sync --org org_xxx
eve auth sync --project proj_xxx
eve auth sync --dry-run
```

### Profile Defaults

Configure default values to simplify repeated commands:

```bash
# Set default email
eve config set --default-email user@example.com

# Set default SSH key
eve config set --default-ssh-key ~/.ssh/id_ed25519

# With defaults set, login becomes:
eve auth login
```

### GitHub Key Auto-Discovery

When login fails because no SSH key is registered, the CLI offers to fetch keys from GitHub:

```bash
$ eve auth login --email user@example.com
Error: No SSH key registered for this email

Would you like to fetch your SSH keys from GitHub? [y/N]: y
GitHub username: myuser

Found 2 SSH keys for myuser:
  1. ssh-ed25519 AAAA... (added 2024-01-15)
  2. ssh-rsa AAAA...     (added 2023-06-20)

Select a key to register [1]: 1
Key registered successfully. Retrying login...
```

### eve auth token

Prints your current access token to stdout for use in scripts, HTTP requests, or sharing with reviewers for PR preview environments.

**Security note:** Treat tokens as secrets. Avoid printing them in shared logs or issue trackers and rotate tokens if exposed.

```bash
eve auth token

# Options:
#   --print    Explicitly request token print (default behavior)
```

**Use Cases:**

1. **Share with reviewers** for PR preview environment access:
   ```bash
   TOKEN=$(eve auth token)
   # Share the token with reviewers to access preview deployments
   ```

2. **Use in scripts**:
   ```bash
   TOKEN=$(eve auth token)
   curl -H "Authorization: Bearer $TOKEN" https://api.example.com/endpoint
   ```

3. **Copy to clipboard** (macOS):
   ```bash
   eve auth token | pbcopy
   ```

See [PR Preview Environments](./pr-preview-environments.md) for comprehensive guidance on sharing tokens with reviewers accessing preview deployments.

### eve auth mint (admin-only)

Admins can mint a user token **without SSH login**. This is useful for bot/service users
that don't have SSH keys.

```bash
# Mint token for a bot user, creating the user + org membership if needed
eve auth mint --email app-bot@example.com --org org_xxx

# Or scope by project (also creates project membership)
eve auth mint --email app-bot@example.com --project proj_xxx

# Assign admin role to the bot (optional)
eve auth mint --email app-bot@example.com --project proj_xxx --role admin

# Mint a long-lived token (1-90 days, default: server configured via EVE_AUTH_TOKEN_TTL_DAYS)
eve auth mint --email app-bot@example.com --org org_xxx --ttl 90
```

Notes:
- Requires admin privileges (system admin or org/project admin).
- The user is created if it doesn't already exist.
- A membership is added to the org/project you specify.
- `--ttl <days>` sets the token TTL (1-90 days). Capped at the server's `EVE_AUTH_TOKEN_TTL_DAYS`.

## Challenge-Response Login

Users authenticate by signing a challenge with a registered identity. This flow works for both SSH key providers and Nostr providers — the server selects the appropriate verifier based on the identity type.

### Using CLI (Recommended)

The CLI handles the entire challenge/sign/verify flow automatically:

```bash
# With email specified
eve auth login --email user@example.com

# With profile defaults configured
eve auth login

# With custom token TTL (1-90 days)
eve auth login --email user@example.com --ttl 30
```

The CLI will:
1. Request a challenge from the server
2. Sign the nonce with your SSH key
3. Submit the signature for verification
4. Store the access token in `~/.eve/credentials.json` (scoped by API URL)

If login fails due to an unregistered key, the CLI offers GitHub key auto-discovery (see [CLI Authentication Commands](#cli-authentication-commands)).

### Manual Flow (curl)

For automation or debugging, you can perform the steps manually:

#### Step 1: Request Challenge

```bash
curl -X POST "$EVE_API_URL/auth/challenge" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com"}'

# Response: { "challenge_id": "...", "nonce": "...", "expires_at": "..." }
```

#### Step 2: Sign the Nonce

```bash
# Sign with ssh-keygen (namespace must be "eve-auth")
echo -n "$NONCE" | ssh-keygen -Y sign -f ~/.ssh/id_ed25519 -n eve-auth
```

#### Step 3: Verify Signature

```bash
curl -X POST "$EVE_API_URL/auth/verify" \
  -H "Content-Type: application/json" \
  -d '{
    "challenge_id": "...",
    "signature": "-----BEGIN SSH SIGNATURE-----\n..."
  }'

# Response: { "access_token": "...", "user_id": "...", "expires_at": ... }
```

### Nostr Login (Manual Flow)

```bash
# Step 1: Request Nostr challenge
curl -X POST "$EVE_API_URL/auth/challenge" \
  -H "Content-Type: application/json" \
  -d '{"provider": "nostr", "pubkey": "<64-char-hex-pubkey>"}'
# Response: { "challenge_id": "...", "nonce": "<64-char-hex>", "expires_at": "..." }

# Step 2: Sign a kind-22242 event with ["challenge", nonce] tag
# (done client-side with Nostr signing tools)

# Step 3: Submit signed event
curl -X POST "$EVE_API_URL/auth/verify" \
  -H "Content-Type: application/json" \
  -d '{"challenge_id": "...", "signature": "<kind-22242-event-json>"}'
```

## Token Types

### User Tokens

Issued on successful login. Used for API access. The `orgs` claim lists the
user's org memberships at mint time (limited to 50 most-recent,
`EVE_AUTH_ORGS_CLAIM_LIMIT`).

```json
{
  "sub": "user_abc123",
  "email": "user@example.com",
  "type": "user",
  "orgs": [
    { "id": "org_xxx", "role": "owner" },
    { "id": "org_yyy", "role": "admin" }
  ],
  "iat": 1706000000,
  "exp": 1706086400
}
```

### Job Tokens

Scoped tokens issued to running jobs. Limited permissions.

```json
{
  "user_id": "user_abc123",
  "org_id": "org_xyz789",
  "permissions": ["job:read", "job:write"],
  "type": "job",
  "iat": 1706000000,
  "exp": 1706086400
}
```

## Permissions

Eve uses a unified permission model for API access.

- `GET /auth/permissions` returns the full permission catalog.
- `GET /auth/me` includes the current user's effective permissions.
- Job tokens carry a limited `permissions` list scoped to the project/job.

CLI helpers:

```bash
eve auth permissions
eve auth whoami
```

## Identity Management

Identities can be SSH public keys, Nostr pubkeys, or other provider-specific credentials. Each identity is linked to a user account and can be used for challenge-response authentication.

### Register Additional Identities

Authenticated users can register additional identities (e.g., SSH keys):

```bash
curl -X POST "$EVE_API_URL/auth/identities" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "public_key": "ssh-ed25519 AAAA... user@laptop",
    "label": "laptop"
  }'
```

Admins can register keys for other users:

```bash
curl -X POST "$EVE_API_URL/auth/identities" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "newuser@example.com",
    "public_key": "ssh-ed25519 AAAA...",
    "label": "initial"
  }'
```

## JWKS Endpoint

Public keys are available for token verification:

```bash
curl "$EVE_API_URL/.well-known/jwks.json"

# Response:
{
  "keys": [
    {
      "kty": "RSA",
      "kid": "key-1",
      "use": "sig",
      "alg": "RS256",
      "n": "...",
      "e": "AQAB"
    }
  ]
}
```

## Key Rotation

When you need to rotate signing keys (security incident, scheduled rotation, etc.):

### Rotation Procedure

```bash
# 1. Generate new key pair
openssl genrsa -out eve-auth-new.key 2048
openssl rsa -in eve-auth-new.key -pubout -out eve-auth-new.pub

# 2. Configure grace period (old key still verifies, new key signs)
export EVE_AUTH_PRIVATE_KEY="$(cat eve-auth-new.key)"
export EVE_AUTH_PUBLIC_KEY="$(cat eve-auth-new.pub)"
export EVE_AUTH_PUBLIC_KEY_OLD="$(cat eve-auth-old.pub)"  # Keep old public key
export EVE_AUTH_KEY_ID="key-2"                            # Increment key ID
export EVE_AUTH_KEY_ID_OLD="key-1"                        # Previous key ID

# 3. Restart API servers

# 4. Wait for old tokens to expire (24 hours default)

# 5. Remove old key configuration
unset EVE_AUTH_PUBLIC_KEY_OLD
unset EVE_AUTH_KEY_ID_OLD
```

### How It Works

During the grace period:
- New tokens are signed with the new private key (`key-2`)
- Both old and new public keys are in JWKS
- Token verification tries all keys matching the `kid` header
- Old tokens (signed with `key-1`) still verify against `EVE_AUTH_PUBLIC_KEY_OLD`

After grace period:
- Remove `EVE_AUTH_PUBLIC_KEY_OLD` and `EVE_AUTH_KEY_ID_OLD`
- Only new tokens are valid

### Emergency Rotation

If a key is compromised:

```bash
# 1. Generate and deploy new key immediately (no grace period)
export EVE_AUTH_PRIVATE_KEY="$(cat eve-auth-new.key)"
export EVE_AUTH_KEY_ID="key-emergency-$(date +%s)"
unset EVE_AUTH_PUBLIC_KEY_OLD  # Don't honor old tokens

# 2. Restart all API servers

# 3. All existing tokens are immediately invalidated
# Users must re-authenticate
```

## RBAC

### Org Roles

| Role | Capabilities |
|------|-------------|
| `owner` | Full control, can delete org |
| `admin` | Manage members, projects, settings |
| `member` | Access projects, create jobs |

### Adding Members

```bash
curl -X POST "$EVE_API_URL/orgs/$ORG_ID/members" \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "user_abc123",
    "role": "member"
  }'
```

### Org and Project Membership (API + CLI)

Org membership:

- `GET /orgs/:org_id/members`
- `POST /orgs/:org_id/members` (by email or user_id)
- `DELETE /orgs/:org_id/members/:user_id` (last-owner protection)

Project membership:

- `GET /projects/:project_id/members`
- `POST /projects/:project_id/members`
- `DELETE /projects/:project_id/members/:user_id`

CLI examples:

```bash
eve org members --org org_xxx
eve org members add user@example.com --role admin --org org_xxx
eve org members remove user_abc --org org_xxx

eve project members --project proj_xxx
eve project members add user@example.com --role admin --project proj_xxx
eve project members remove user_abc --project proj_xxx
```

## Supabase Tokens (HS256)

When `SUPABASE_JWT_SECRET` is set, Eve accepts Supabase-issued JWTs **in addition
to** RS256 tokens:

```bash
export SUPABASE_JWT_SECRET="your-supabase-jwt-secret"
```

In this configuration:
- Supabase users are auto-created on first login (identity-linked by Supabase UUID
  and/or email match)
- RS256 flows (SSH/Nostr, job tokens, service principals) continue to work
- Bootstrap is still required for the **first** internal admin user

## App Integration

For adding SSO login to Eve-compatible apps, see [App SSO Integration](./app-sso-integration.md).

Shared packages:
- `@eve-horizon/auth` -- Backend middleware (Express): token verification, org membership check, auth config endpoint
- `@eve-horizon/auth-react` -- Frontend SDK (React): provider, hooks, login gate, login form

## Troubleshooting

### "EVE_AUTH_PRIVATE_KEY is required when auth is enabled"

Set `EVE_AUTH_PRIVATE_KEY` or disable auth:
```bash
export EVE_AUTH_ENABLED=false  # For local dev only
```

### "Bootstrap already completed"

In normal operation, use `eve auth login` (existing user) or `eve admin invite` (new users).

For local/non-production stacks, `eve auth bootstrap` now attempts the server recovery path automatically.
If the API is configured to allow non-prod recovery, it can return an existing admin token.

**If you bootstrapped with the wrong email** and need an explicit recovery flow:

```bash
eve auth bootstrap --email your-real-email@example.com
```

If needed, call the API directly:

```bash
# Get the bootstrap token
kubectl -n eve get secret eve-app -o jsonpath='{.data.EVE_BOOTSTRAP_TOKEN}' | base64 -d

# Call the API directly with your real email and SSH key
curl -X POST https://your-api-url/auth/bootstrap \
  -H "Content-Type: application/json" \
  -d "{
    \"token\": \"your-bootstrap-token\",
    \"email\": \"your-real-email@example.com\",
    \"public_key\": \"$(cat ~/.ssh/id_ed25519.pub)\"
  }"
```

### "No matching key for token"

Token was signed with a key that's no longer configured. User must re-authenticate.

### Challenge Expired

Challenges are valid for 5 minutes by default. Request a new challenge and sign immediately.

---

## Mail Delivery and SES Suppression

Eve's branded auth emails (org/app invites, app-scoped magic-link login, system-admin Supabase invites) all flow through a single `MailerService` in `apps/api/src/mailer/mailer.service.ts`. When SMTP is pointed at Amazon SES, the mailer adds a pre-send suppression check and emits structured log events so account-level SES suppressions can never look like a successful send.

See the shipped fix plan: [magic-link-email-silent-drop-plan.md](../plans/magic-link-email-silent-drop-plan.md). Env-var wiring lives in [deployment.md](./deployment.md). For inspecting and clearing SES account-level suppression entries, see [docs/runbooks/ses-suppression.md](../runbooks/ses-suppression.md).

### Pre-Send Suppression Check

When `GOTRUE_SMTP_HOST` matches `*.amazonaws.com` (or `EVE_MAILER_CHECK_SUPPRESSION=true`), the mailer calls `GetSuppressedDestinationCommand` from `@aws-sdk/client-sesv2` before opening the SMTP session.

| Outcome | Behavior |
| --- | --- |
| Address on SES suppression list | Throws `EmailSuppressedError`. No SMTP send. Logs `mailer.suppressed`. |
| `NotFoundException` from SES | Address is not suppressed. Send proceeds. |
| Other AWS errors (IRSA, throttling, network) | **Fails open** — logs `mailer.suppression_check_failed` and proceeds with SMTP. A broken IRSA never blocks delivery for unsuppressed addresses. |
| SDK fails to load or no region resolvable | Logs `mailer.suppression_check_disabled` once and skips the check for the lifetime of the pod. |

All recipients are normalised to lower-case before lookup and send, because the SES suppression API is case-sensitive while SMTP delivery is not.

When `EVE_SES_CONFIGURATION_SET` is set, the mailer passes `X-SES-CONFIGURATION-SET: <name>` on each send so SES routes Bounce/Complaint/Delivery/Reject events to the SNS topic configured in `deployment-instance-repo` (`terraform/aws/modules/ses-feedback`).

### Caller Behavior on `EmailSuppressedError`

| Caller | Behavior |
| --- | --- |
| `AuthService.sendEligibleMagicLink` (app magic-link login) | Catches and swallows. Returns `{ sent: true }` to the SSO UI to preserve account-enumeration defense. Logs `mail.suppressed_drop kind=magic_link to=... reason=... since=...`. |
| `AuthService.createAppInvite` → `sendProjectInviteEmail` | Re-throws. Admins inviting a permanently-bounced address see the error, not silent success. |
| `OrgsService` org invites | Re-throws. Same rationale. |
| `AuthController.sendSupabaseInvite` (`eve admin invite --web`) | Re-throws. System admins always see the failure. |

This is the only place in the auth path where "generic success" is preserved post-eligibility; the trade-off matches the magic-link-login design.

### Bounce / Complaint Feedback Loop

SES publishes feedback events to an SNS topic, which POSTs to `/webhooks/ses-feedback` (public, signature-verified). The webhook:

- Verifies the SNS signature against the cert fetched from `SigningCertURL` (SHA1 for `SignatureVersion=1`, SHA256 for `SignatureVersion=2`). Rejects non-HTTPS cert URLs and cert hosts that do not match `sns.<region>.amazonaws.com[.cn]`.
- Validates `TopicArn` against `EVE_SES_FEEDBACK_TOPIC_ARN` when set, so spoofed payloads on a different topic are rejected.
- Handles `SubscriptionConfirmation` (GET `SubscribeURL`), `Notification` (parse SES feedback, persist one row per affected recipient), and `UnsubscribeConfirmation` (log).
- Idempotency: row id is `ede_<sha256-24>(snsMessageId|eventType|recipient)` with `INSERT … ON CONFLICT (id) DO NOTHING`, so SNS retries never duplicate rows.

Events are persisted to the `email_delivery_events` table (migration `00095_email_delivery_events.sql`):

| Column | Notes |
| --- | --- |
| `id` | `ede_<sha256-24>` of `(snsMessageId, eventType, recipient)` — idempotent. |
| `recipient` | Lower-cased. |
| `ses_message_id` | Matches the `ses_message_id` parsed from the SES SMTP `250 Ok …` response and logged on `mailer.sent`. |
| `rfc_message_id` | Original `Message-ID` header when present. |
| `event_type` | `Bounce` \| `Complaint` \| `Delivery` \| `Reject` \| `DeliveryDelay` \| `Send` … |
| `bounce_type` | `Permanent` \| `Transient` (Bounce only). |
| `bounce_subtype` | `General` \| `NoEmail` \| `MailboxFull` \| `Suppressed` \| etc. |
| `diagnostic` | Raw SMTP/feedback diagnostic from SES. |
| `raw_payload` | Full SES event JSON for forensics. |
| `received_at` | Webhook persist time. |

Indexed on `(recipient, received_at DESC)` and `(ses_message_id)`.

### Structured Log Events

All emitted by the `MailerService` / SES feedback path. Grep these in API pod logs.

| Event | Emitted When |
| --- | --- |
| `mailer.sent` | SMTP `sendMail()` succeeded. Includes `to`, `subject`, `rfc_message_id`, `ses_message_id`, `smtp_response`. |
| `mailer.smtp_failed` | SMTP `sendMail()` threw. Includes `to`, `subject`, `error`. The exception still re-throws to the caller. |
| `mailer.suppressed` | Pre-send check found the address on the SES suppression list. Followed by `EmailSuppressedError`. |
| `mailer.suppression_check_failed` | AWS call failed for any reason other than `NotFoundException`. Fails open. |
| `mailer.suppression_check_disabled` | SDK load failed or no region could be resolved. Logged once per pod. |
| `mail.suppressed_drop` | `sendEligibleMagicLink` swallowed an `EmailSuppressedError`. Includes `kind`, `to`, `reason`, `since`. |
| `sns.subscription_confirmed` / `sns.unsubscribe_confirmation` | SNS lifecycle. |
| `sns.rejected` | Webhook rejected an SNS payload (bad signature, wrong topic, bad cert URL). |
| `ses.feedback_persisted` / `ses.feedback_duplicate` / `ses.feedback_no_recipients` | Per-recipient feedback persistence outcomes. |

### Inspecting Delivery Events

```bash
# System-admin only. Lists recent events from email_delivery_events.
eve admin email bounces list
eve admin email bounces list --recipient admin@example.com
eve admin email bounces list --event-type Bounce --limit 100 --json
```

Backed by `GET /admin/email-bounces`. Reads-only from the local table; does **not** mutate SES.

```bash
# Env diagnose also includes up to 20 recent events for org members.
eve env diagnose <project> <env>
# Rendered under "Recent Email Delivery Events (org members)".
```

### Clearing an Account-Level Suppression Entry

Mailer code never calls `DeleteSuppressedDestination`. Clearing a suppression is an explicit ops action — keep true permanent bounces on the list.

```bash
aws sesv2 list-suppressed-destinations --region us-west-2 \
  --query "SuppressedDestinationSummaries[?contains(EmailAddress, 'example.com')]"

aws sesv2 delete-suppressed-destination \
  --email-address <addr> --region us-west-2
```

See [docs/runbooks/ses-suppression.md](../runbooks/ses-suppression.md) for the full procedure and decision criteria.

### Required Env Vars

See [deployment.md → Runtime Environment Variables](./deployment.md#runtime-environment-variables-key) for full descriptions. Summary:

| Variable | Default | Purpose |
| --- | --- | --- |
| `EVE_MAILER_CHECK_SUPPRESSION` | `auto` | `auto` enables the check when `GOTRUE_SMTP_HOST` is `*.amazonaws.com`; `true` / `false` override. |
| `EVE_MAILER_SES_REGION` | parsed from `GOTRUE_SMTP_HOST` | Region for `GetSuppressedDestination`. |
| `EVE_SES_CONFIGURATION_SET` | — | Sent as `X-SES-CONFIGURATION-SET` so events route to SNS. |
| `EVE_SES_FEEDBACK_TOPIC_ARN` | — | Allow-list for `/webhooks/ses-feedback`; mismatches are rejected. |

> **NOTE**: The shipped code differs from the plan in two minor ways. (1) The `mailer.suppression_check_disabled` event was added during implementation (when no SES region can be resolved or the SDK fails to load) — it is not in the plan. (2) `assertNotSuppressed` is called only after the recipient is normalised to lower-case, which the plan describes as a footnote rather than the primary flow. Behavior matches the plan's intent; logging surface is a superset.
