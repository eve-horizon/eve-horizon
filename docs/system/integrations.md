# Integrations (Current)

> Status: Current
> Last Updated: 2026-06-02
> Purpose: Describe external integrations (Google Drive, Slack, GitHub) and identity mapping.

## Overview

Integrations connect external providers (Google Drive, Slack, GitHub) to Eve events, cloud storage mounts, and chat routing. Each integration is **org-scoped** and maps a provider account (e.g., a Google account or Slack workspace) to an Eve org. Provider identities are resolved into Eve users through a tiered identity resolution system that handles everything from automatic email matching to admin-approved membership requests.

Key tables:

| Table | Purpose |
|-------|---------|
| `integrations` | Maps provider accounts to orgs (one row per Slack workspace, GitHub app install, etc.) |
| `cloud_fs_mounts` | Maps Google Drive folders to org/project Cloud FS mounts |
| `external_identities` | Maps provider-specific user IDs to Eve users |
| `membership_requests` | Tracks pending/approved/denied access requests from unknown external users |

## Google Drive / Cloud FS

Google Drive integrations use per-org OAuth app credentials. Configure the app, connect an account, then mount a Drive folder:

```bash
eve integrations setup-info google-drive --org <org_id>
eve integrations configure google-drive --org <org_id> --client-id <id> --client-secret <secret>
eve integrations connect google-drive --org <org_id>
eve cloud-fs mount --provider google-drive --folder-id <drive-folder-id> --label "Shared Drive" --org <org_id>
```

Cloud FS browse and search expose provider-neutral pagination:

```bash
eve cloud-fs ls / --mount <mount_id> --page-size 100 --org <org_id>
eve cloud-fs ls / --mount <mount_id> --page-token <token> --org <org_id>
eve cloud-fs ls / --mount <mount_id> --all --json --org <org_id>
eve cloud-fs ls / --mount <mount_id> --recursive --json --org <org_id>
eve cloud-fs search "budget" --mount <mount_id> --mime-type application/pdf --all --json --org <org_id>
```

Default browse/search returns one provider page and may include `next_page_token`. CLI `--all` loops until the token is absent or `EVE_CLOUD_FS_MAX_AUTO_PAGES` (default 200) is reached; JSON output includes `complete`, `page_count`, and `next_page_token` when incomplete. `--order-by` accepts `name`, `name_desc`, `modified`, or `modified_desc`. Recursive browse is server-side and bounded; it rejects `page_token`/`--all` and reports `truncated: true` when safety limits stop traversal.

## Slack

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /gateway/providers/slack/webhook` | Receives all Slack Events API payloads (mentions, messages, URL verification) |
| `POST /gateway/providers/slack/interactive` | Receives Slack interactive payloads (button clicks, e.g., membership approval) |

The webhook endpoint handles URL verification challenges, validates request signatures against the signing secret, resolves `team_id` to an org via the `integrations` table, and dispatches the event through the gateway provider pipeline.

### Routing

- `@eve <agent-slug> <command>` resolves the slug to a project/agent (slugs are unique per org)
- If the first word after `@eve` is not a known slug, Eve routes to the org `default_agent_slug`
- `message` events (no mention) are dispatched to channel/thread listeners

### Auth

- **Signing secret**: Used to verify inbound webhook signatures. Stored as a system secret (`EVE_SLACK_SIGNING_SECRET`) or per-integration in `tokens_json`.
- **Bot token**: `xoxb-...` token used for outbound messages and Slack API calls. Stored in `tokens_json.access_token`.

### Channel Notifications for Non-Chat Workflows

Non-chat jobs can send one-way Slack channel notifications through Eve without
reading the Slack integration or exposing the bot token:

```bash
eve notifications send \
  --project <project_id_or_slug> \
  --channel eve-horizon-notifications \
  --message "Workflow complete: <summary>"
```

This calls `POST /projects/:project_id/notifications/send` and requires the
caller to hold `notifications:send`. Agent jobs receive only the normal default
job-token permissions unless the agent declares this extra permission:

```yaml
agents:
  publisher:
    access:
      permissions:
        - notifications:send
```

The API resolves the project org, finds the active Slack integration, resolves a
channel name to a Slack channel ID using the bot token, and posts via
`chat.postMessage`. If an org has multiple active Slack workspaces, pass
`--integration-id <integration_id>` to choose one explicitly.

Required Slack scopes for this path are `chat:write`, plus `channels:read` for
public-channel name lookup and `groups:read` for private-channel name lookup.
`chat:write.public` lets the app post to public channels where it has not been
invited.

### Connect (OAuth Install Link — Recommended)

Generate a shareable install link. The recipient needs only Slack workspace admin access — no Eve credentials required.

```bash
# Generate a shareable install link (24h TTL by default)
eve integrations slack install-url --org <org_id>

# Custom TTL (e.g., 7 days)
eve integrations slack install-url --org <org_id> --ttl 7d
```

The link redirects to Slack's OAuth consent screen. On approval, Eve exchanges the OAuth code for a bot token and creates the integration automatically. No manual token copying needed.

**Gateway hot-loading**: The gateway detects and initializes new integrations within ~30 seconds (no restart required). It polls the API for active integrations on a 30-second interval.

**Install token format**: `eve-slack-install-<base64url(payload)>.<base64url(hmac)>`. Tokens are HMAC-signed with `EVE_INTERNAL_API_KEY`, single-use (JTI tracked), and expire after the configured TTL.

**API endpoints**:
- `POST /orgs/:org_id/integrations/slack/install-token` — generate signed install token (requires `integrations:write`)
- `GET /integrations/slack/install?token=...` — public endpoint; validates token, redirects to Slack OAuth
- `GET /integrations/slack/oauth/callback` — handles OAuth code exchange and creates integration

### Connect (Manual — Fallback)

For air-gapped environments or when OAuth is unavailable:

```bash
# Connect a Slack workspace to an org
eve integrations slack connect \
  --org <org_id> \
  --team-id <T-ID from Slack> \
  --token xoxb-...

# Full bootstrap (restore or migrate)
eve integrations slack connect \
  --org <org_id> \
  --team-id <T-ID from Slack> \
  --tokens-json '{"access_token":"xoxb-...","bot_user_id":"U...","team_id":"T...","app_id":"A..."}'

# Verify
eve integrations list --org <org_id>
eve integrations test <integration_id> --org <org_id>
```

### Events

Subscribe to these bot events in the Slack App configuration:

| Event | Purpose |
|-------|---------|
| `app_mention` | `@eve` commands |
| `message.channels` | Listener dispatch in public channels |
| `message.groups` | Listener dispatch in private channels |
| `message.im` | Direct messages to the bot |

## Identity Resolution

When a Slack user messages `@eve`, the platform must determine who they are in Eve. Identity resolution proceeds through three tiers, evaluated in order. The first tier that produces a match short-circuits the rest.

### Tier 1: Email Auto-Match

The gateway fetches the Slack user's email via `users.info` and passes it to the API. The API checks whether an Eve user with that email exists and is a member of the org associated with the integration. If both conditions are met, the external identity is automatically bound to the Eve user.

```
Slack user (U123) --email--> user@company.com --lookup--> Eve user (usr_xxx) --check--> org member? --> BOUND
```

No user action required. This is the zero-friction happy path for teams where Slack and Eve share the same email domain.

### Tier 2: Self-Service CLI Link

An existing Eve user who was not auto-matched (e.g., different email on Slack vs. Eve) can link their identity via the CLI:

```bash
eve identity link slack --org <org_id>
```

This generates a one-time link token. The user sends the token to `@eve` in Slack (e.g., `@eve link <token>`). The gateway validates the token, binds the external identity, and confirms in-channel.

### Tier 3: Admin Approval

When neither Tier 1 nor Tier 2 resolves the user, the platform creates a **membership request**. This is the fallback for completely unknown users -- someone in a Slack workspace who has no Eve account at all.

The membership request is surfaced to org admins via:
- **CLI**: `eve org membership-requests list --org <org_id>`
- **Slack interactive buttons**: If `admin_channel_id` is configured, a Block Kit message is posted to the admin channel with Approve/Deny buttons

On approval, the platform:
1. Creates an Eve user (if none exists for this identity)
2. Adds org membership
3. Binds the external identity to the new Eve user
4. Notifies the Slack user that they are now connected

On denial, the request is marked `denied` and the user is informed.

### Resolution Decision Table

| Slack user has Eve email? | Eve user is org member? | Result |
|---------------------------|------------------------|--------|
| Yes | Yes | Tier 1: auto-bind |
| Yes | No | Tier 3: membership request (user exists but not a member) |
| No / unknown | -- | Tier 2 if they self-link, otherwise Tier 3 |

## Membership Request Lifecycle

```
[Unknown Slack user messages @eve]
        |
        v
  external_identity created (eve_user_id = null)
        |
        v
  membership_request created (status = 'pending')
        |
        v
  Admin notified (Slack buttons + CLI)
        |
   +---------+---------+
   |                   |
   v                   v
 APPROVED            DENIED
   |                   |
   v                   v
 Eve user created    Request closed
 Org membership added
 External identity bound
 Slack user notified
```

### Membership Request States

| Status | Meaning |
|--------|---------|
| `pending` | Awaiting admin decision |
| `approved` | Admin approved; user created and bound |
| `denied` | Admin denied; no access granted |

### CLI Commands

```bash
# List pending requests
eve org membership-requests list --org <org_id>

# Approve (creates user + membership + identity binding)
eve org membership-requests approve <request_id> --org <org_id>

# Deny
eve org membership-requests deny <request_id> --org <org_id>
```

## Integration Settings

Each integration row stores two JSONB columns that serve distinct purposes:

### `tokens_json` (Auth Credentials)

Sensitive authentication material. Never exposed in list responses.

| Key | Example | Purpose |
|-----|---------|---------|
| `access_token` | `xoxb-...` | Slack bot token for API calls |
| `bot_user_id` | `U0123ABC` | Bot's own Slack user ID (used to filter self-messages) |
| `team_id` | `T0123ABC` | Slack workspace ID |
| `app_id` | `A0123ABC` | Slack app ID |

### `settings_json` (Configuration)

Non-sensitive integration configuration. Managed separately from auth tokens.

| Key | Example | Purpose |
|-----|---------|---------|
| `admin_channel_id` | `C-ADMIN` | Slack channel for admin notifications (membership requests, errors). When unset, notifications are suppressed (CLI-only approval). |

```bash
# Set the admin notification channel
eve integrations update <integration_id> --org <org_id> \
  --setting admin_channel_id=C-ADMIN-CHANNEL
```

## GitHub

- **Webhook**: `/integrations/github/events/:projectId`
- **Auth**: `EVE_GITHUB_WEBHOOK_SECRET` + project-scoped secret override
- **Events**: Push, pull request, and other configured GitHub webhook events trigger Eve pipelines and workflows

## External Identities

External identities map provider-specific user IDs to Eve users. The `external_identities` table is the single source of truth for "Slack user U123 in workspace T456 is Eve user usr_789."

### Schema

```
external_identities
  id                  TEXT PRIMARY KEY
  provider            TEXT NOT NULL          -- 'slack', 'github', 'nostr'
  account_id          TEXT NOT NULL          -- workspace/org ID (e.g., Slack team_id)
  external_user_id    TEXT NOT NULL          -- user ID in the provider (e.g., Slack user_id)
  eve_user_id         TEXT NULLABLE          -- bound Eve user (null = unresolved)
  created_at          TIMESTAMPTZ
  updated_at          TIMESTAMPTZ
  UNIQUE (provider, account_id, external_user_id)
```

### Lifecycle

1. **Created** when a provider user is first seen (e.g., first Slack message to `@eve`). `eve_user_id` is null.
2. **Bound** when identity resolution succeeds (Tier 1 auto-match, Tier 2 CLI link, or Tier 3 admin approval). `eve_user_id` is set.
3. **Unbound** if the Eve user is deleted (`ON DELETE SET NULL`), returning the identity to unresolved state.

Once bound, subsequent messages from the same external user skip identity resolution entirely -- the existing binding is used for authorization and routing.

## Related Docs

- [Chat Gateway](./chat-gateway.md) -- provider architecture, webhook/subscription transports
- [Chat Routing](./chat-routing.md) -- agent slug resolution, listener dispatch
- [Workflows](./workflows.md) -- workflow steps and non-chat notification usage
- [Identity Providers](./identity-providers.md) -- SSO and web auth identity federation
- [Auth & RBAC](./auth.md) -- org membership, roles, access control
- [Slack Integration Gap Closure Plan](../plans/slack-integration-gap-closure-plan.md) -- implementation roadmap
