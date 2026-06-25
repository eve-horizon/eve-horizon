# Slack Integration Gap Closure Plan

> Status: Draft
> Last Updated: 2026-02-26
> Purpose: Close all gaps between the current Slack implementation and a production-ready integration.
> Predecessor: `docs/plans/chat-gateway-slack-plan.md` (Phase 1-4 complete)

## Current State

The gateway, inbound routing, agent dispatch, listener subscriptions, and outbound replies are in place. What's missing falls into two categories:

1. **Slack-side setup** — no guide for creating and configuring the Slack App itself.
2. **Platform gaps** — interactive handler is a no-op, membership approval has no workflow, outbound errors are silently swallowed, no rich formatting.

There is a provider-based Slack runtime (`/gateway/providers/slack/webhook`) backed by `GatewayChatService`. Legacy Slack ingress points still exist in code (`apps/api/src/integrations/slack.controller.ts` and `apps/gateway/src/slack.controller.ts`) and should be removed as part of this plan.

The work is structured in priority order: Phase 1 unblocks real-world usage with zero code changes. Each subsequent phase adds production hardening.

### Architectural Principle: Provider-Agnostic API

The API service (`integrations.service.ts`) is provider-agnostic — it knows about external identities, membership requests, and org members, but never calls Slack (or any other provider) APIs directly. Provider-specific logic (Slack `users.info`, signature verification, Block Kit formatting) lives in the gateway provider layer. When the gateway needs the API to do provider-agnostic work (email lookup, identity binding), it passes extracted data (e.g., email) in the request body.

---

## Phase 1: Slack App Setup Guide (docs only, no code)

> Unblocks anyone from connecting Slack today.

Create `docs/guides/slack-app-setup.md` covering:

### 1.1 Create the Slack App

- Go to https://api.slack.com/apps → "Create New App" → "From scratch"
- App name: `Eve` (or org-specific name)
- Select the target workspace

### 1.2 Bot Token Scopes

Required scopes under **OAuth & Permissions → Bot Token Scopes**:

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Receive `@eve` mentions |
| `chat:write` | Send replies and threaded messages |
| `chat:write.public` | Send in public channels where the app has not been invited |
| `channels:history` | Read messages for listener dispatch |
| `channels:read` | Resolve channel info |
| `groups:history` | Read messages in private channels |
| `groups:read` | Resolve private channel info for listeners |
| `im:history` | Read direct messages |
| `users:read` | Look up Slack user profiles for identity auto-match (Phase 3) |
| `users:read.email` | Access Slack user email for auto-binding to Eve accounts (Phase 3) |
| `im:write` | Send DM notifications to users (approval notices, link confirmations) |
| `reactions:read` | Receive emoji reaction events for agent feedback (Phase 7) |
| `files:read` | Required for file attachment ingest (Phase 7) |

### 1.3 Event Subscriptions

- Enable Events → set Request URL to: `https://<gateway-host>/gateway/providers/slack/webhook`
- Subscribe to bot events: `app_mention`, `message.channels`, `message.groups`, `message.im`

### 1.4 Interactive Components

- Enable Interactivity → set Request URL to: `https://<gateway-host>/gateway/providers/slack/interactive`
- Required for Phase 3 (membership approval buttons)
  - This route should be implemented on the gateway provider side (no legacy shim).

### 1.5 Install and Connect

```bash
# After installing to workspace, grab bot token + signing secret from Slack console

# Set signing secret on gateway
# (system secret or K8s env var: EVE_SLACK_SIGNING_SECRET)

# Connect via CLI
eve integrations slack connect \
  --org <org_id> \
  --team-id <T-ID from Slack> \
  --token xoxb-...

# Optional for bootstrap restore (advanced)
eve integrations slack connect \
  --org <org_id> \
  --team-id <T-ID from Slack> \
  --tokens-json '{"access_token":"xoxb-...","bot_user_id":"U...","team_id":"T...","app_id":"A..."}'

# Verify
eve integrations list --org <org_id>
eve integrations test <integration_id> --org <org_id>
```

### 1.6 Agent Configuration

```bash
# Set the org default agent (fallback when no slug matches)
eve org update <org_id> --default-agent <agent-slug>

# Ensure agents are gateway-routable
# In agents.yaml:
#   gateway:
#     policy: routable
#     clients: [slack]
```

### 1.7 System Documentation

Update the existing system docs which are outdated (still reference legacy endpoint as primary, note interactive approvals as "stubbed"):

**Update `docs/system/integrations.md`**:
- Replace Slack webhook reference (`/integrations/slack/events`) with canonical provider endpoint (`/gateway/providers/slack/webhook`)
- Add identity resolution overview (3 tiers)
- Add membership request lifecycle
- Add `settings_json` vs `tokens_json` distinction
- Reference the setup guide

**Update `docs/system/chat-gateway.md`**:
- Remove "Interactive approvals are stubbed; full approval flow is deferred" note
- Add identity interception flow (before agent routing)
- Add `link` reserved command
- Add interactive endpoint (`/gateway/providers/slack/interactive`)
- Add deduplication and timeout handling notes

**Create `docs/guides/slack-app-setup.md`**:
- End-user setup guide (sections 1.1–1.6 above)
- Standalone, no platform internals — just what an admin needs to connect Slack

### Deliverables

- [ ] `docs/guides/slack-app-setup.md` — step-by-step guide with screenshot placeholders
- [ ] Update `docs/system/integrations.md` — replace legacy references, add identity resolution tiers
- [ ] Update `docs/system/chat-gateway.md` — remove "stubbed" notes, add interactive + identity interception
- [ ] Update `tests/manual/scenarios/08-chat-gateway-slack.md` — add "Live Slack" section with full setup steps
- [ ] Add links from `CLAUDE.md` documentation map

---

## Phase 2: Outbound Observability and Error Handling

> Silent failures are dangerous. Fix before anything else touches production traffic.

### 2.1 Log Outbound Failures

**Files**: `apps/gateway/src/providers/slack/slack-sender.ts` + callers in
`apps/gateway/src/chat/gateway-chat.service.ts`.

Return a structured result instead of best-effort silence:

```typescript
export async function sendSlackMessage(options: SlackReplyOptions): Promise<{ ok: boolean; error?: string; httpStatus?: number }> {
  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', { ... });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok === false) {
      return {
        ok: false,
        httpStatus: response.status,
        error: payload?.error ?? 'unknown',
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

Call sites should log:
- `slack.outbound.failed` when `ok` is false
- `slack.outbound.error` when an exception occurred
- `httpStatus`, `teamId`, `integrationId`, `channelId` context fields

### 2.2 Log Token Fetch Failures

**File**: `apps/gateway/src/providers/slack/slack-sender.ts` → `getIntegrationTokens()`

The `catch {}` at line 61 silently swallows token fetch failures. The caller can't distinguish "integration doesn't exist" from "API is down":

```typescript
} catch (err) {
  logger.warn('slack.tokens.fetch_failed', {
    integrationId,
    error: err instanceof Error ? err.message : String(err),
  });
  return null;
}
```

### 2.3 Log Inbound Integration Resolution Failures

**File**: `apps/gateway/src/chat/gateway-chat.service.ts`

Resolve failures are currently silent (`catch {}` / empty return) in both paths. Log and continue with `{}`:

```typescript
} catch (err) {
  logger.warn('slack.inbound.integration_not_found', {
    provider: inbound.provider,
    accountId: inbound.accountId,
    error: err instanceof Error ? err.message : String(err),
  });
  return;
}
```

### 2.4 Log Listener Dispatch Failures

**File**: `apps/gateway/src/chat/gateway-chat.service.ts`

The `catch {}` in listener dispatch (line ~216) is a silent failure path and should log at warning/error level with request correlation fields.

### Summary of Silent Catch Blocks

| File | Location | Current | Fix |
|------|----------|---------|-----|
| `slack-sender.ts` | `sendSlackMessage` catch | Swallows all errors | Return structured `{ ok, error, httpStatus }` |
| `slack-sender.ts` | `getIntegrationTokens` catch | Returns null | Log `slack.tokens.fetch_failed` |
| `gateway-chat.service.ts` | Integration resolve catch (~line 52) | Returns `{}` | Log `slack.inbound.integration_not_found` |
| `gateway-chat.service.ts` | Identity resolve catch (~line 73) | Continues silently | Log `slack.inbound.identity_resolve_failed` |
| `gateway-chat.service.ts` | Listener dispatch catch (~line 216) | Silent | Log `slack.listener.dispatch_failed` |

### Deliverables

- [ ] Add structured logging to all 5 silent `catch` blocks listed above
- [ ] Return structured `ok/error` from `sendSlackMessage` and propagate to call sites
- [ ] Add `slack.outbound.failed` and `slack.inbound.*` log events

---

## Phase 3: Identity Resolution and Membership Approval

> Currently: unknown Slack users create a `membership_request` row in the DB and nothing happens. They get "Unable to route command" with no explanation.
>
> **Problem**: The most common case is existing Eve org members whose Slack email differs from their Eve email. They shouldn't need admin approval — they should be recognized automatically or able to self-link.

This phase uses a **hybrid identity resolution strategy** with three tiers:

```
Slack user arrives
  → Tier 1: Email auto-match (instant, silent)
  → Tier 2: Self-service CLI claim (user-initiated, no admin needed)
  → Tier 3: Admin approval (fallback for genuinely new users)
```

### 3.1 Tier 1: Email Auto-Match

When an unknown Slack user first contacts `@eve`, attempt automatic identity binding before creating a membership request.

**Requires**: `users:read` + `users:read.email` Slack bot scopes.

**Architecture**: The Slack `users.info` API call happens in the **gateway** (which holds the bot token and knows it's Slack). The gateway extracts the email and passes it to the **API** in the identity resolution request. The API does the provider-agnostic email→user lookup and auto-bind. This preserves the API's provider-agnostic design.

**Gateway side** (`apps/gateway/src/chat/gateway-chat.service.ts` or `slack.provider.ts`):

Before calling `/internal/integrations/external-identities/resolve`, look up the Slack user's email:

```typescript
// Gateway: fetch email from Slack (provider-specific)
let slackEmail: string | null = null;
try {
  const tokens = await getIntegrationTokens(integrationId);
  const botToken = extractSlackToken(tokens);
  if (botToken && externalUserId) {
    const resp = await fetch(`https://slack.com/api/users.info?user=${externalUserId}`, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const data = await resp.json();
    slackEmail = data.ok ? data.user?.profile?.email ?? null : null;
  }
} catch (err) {
  logger.warn('slack.identity.email_lookup_failed', { externalUserId, error: String(err) });
}

// Pass email to API in the resolution request
const identity = await postJson('/internal/integrations/external-identities/resolve', {
  provider: 'slack',
  account_id: teamId,
  external_user_id: externalUserId,
  org_id: orgId,
  external_email: slackEmail,  // NEW: optional email hint
});
```

**API side** (`apps/api/src/integrations/integrations.service.ts` → `resolveExternalIdentity()`):

Add `external_email?: string` parameter. Insert between "identity has no `eve_user_id`" and "create membership request":

```typescript
// If caller provided an email hint, try auto-match (provider-agnostic)
if (externalEmail) {
  const eveUser = await this.users.findByEmail(externalEmail);
  if (eveUser) {
    const membership = await this.orgMembers.findByOrgAndUser(orgId, eveUser.id);
    if (membership) {
      await this.externalIdentities.updateEveUser(identity.id, eveUser.id);
      logger.info('identity.auto_matched', {
        externalIdentityId: identity.id,
        eveUserId: eveUser.id,
        matchedBy: 'email',
      });
      return { external_identity_id: identity.id, eve_user_id: eveUser.id, membership_request_id: null };
    }
  }
}
// No match → continue to membership request
```

**Edge cases**:
- Slack user has no email visible (workspace restriction) → `external_email` is null, skip auto-match
- Email matches an Eve user who is NOT a member of this org → do NOT auto-bind; they may have been deliberately excluded
- Slack API call fails → log warning in gateway, pass null email, continue to Tier 2/3 (never block on a failed lookup)
- Email uniqueness: `users.email` has a UNIQUE constraint, so `findByEmail` always returns 0 or 1 result

**Logging**: Gateway logs the Slack API call outcome. API logs the auto-match attempt and result (`identity.auto_match_attempted`, `identity.auto_matched`, `identity.auto_match_skipped`).

### 3.2 Tier 2: Self-Service CLI Claim

When auto-match fails (different email, restricted profile, etc.), give the user a way to link their own identity without waiting for admin approval.

**User-facing message** (sent as Slack reply when identity is unresolved):

> "I don't recognize your Slack account. If you already have an Eve account, link it by running:\n\n`eve identity link slack --org <org_slug>`\n\nOtherwise, a membership request has been sent to your org admins."

**CLI command**: `eve identity link <provider>`

```bash
# User runs this from their terminal (already authenticated via SSH key)
eve identity link slack --org my-org
```

**Flow**:

1. CLI calls API: `POST /users/me/identity-link-tokens`
   ```json
   { "provider": "slack", "org_id": "org_xxx" }
   ```

2. API generates a signed JWT (no new DB table needed):
   ```typescript
   const token = jwt.sign(
     { eve_user_id: currentUser.id, provider: 'slack', org_id: orgId },
     EVE_INTERNAL_API_KEY,  // Reuse existing shared secret
     { expiresIn: '15m', jwtid: randomUUID() },  // jti for single-use tracking
   );
   ```
   Single-use enforcement: store redeemed `jti` values in a short-lived cache (or a `redeemed_link_tokens` table with TTL cleanup). Given pre-MVP, a simple in-memory Set with 1-hour expiry is sufficient.

3. CLI displays instructions:
   ```
   To link your Slack identity, send this message to @eve in Slack:

     @eve link eve-link-abc123def

   Token expires in 15 minutes.
   ```

4. User pastes the message in Slack. Gateway receives it, recognizes the `link <token>` command:
   - Validates token (not expired, not used)
   - Calls `POST /internal/identity-link-tokens/redeem` with the token and the Slack external identity
   - API verifies JWT, checks jti hasn't been redeemed, binds `external_identity.eve_user_id`
   - Replies: "Your Slack account is now linked to your Eve account. You're all set."

5. If the token is invalid/expired, reply: "That link token is invalid or expired. Run `eve identity link slack --org <org_slug>` to get a new one."

**Gateway routing for `link` command**:

The current `parseAgentCommand` in `slack-parser.ts` treats the first word after `@eve` as an agent slug. "link" would collide with agent resolution. Fix: add `link` as a **reserved command** checked before agent routing in `gateway-chat.service.ts`:

```typescript
// In resolveAndRoute, before routeToAgent:
if (inbound.command?.first === 'link') {
  return this.handleLinkCommand(inbound);
}
```

**API endpoints**:

```
POST /users/me/identity-link-tokens          # Generate link token (authenticated user)
POST /internal/identity-link-tokens/redeem    # Redeem token (called by gateway)
```

**Security considerations**:
- Token is single-use (jti tracking) and time-limited (15 min JWT expiry)
- Only works for the specific provider and org in the token claims
- The user must be authenticated in the CLI (proves they own the Eve account) AND in Slack (proves they own the Slack account)
- Existing `eve_user_id` binding is NOT overwritten — if the external identity is already bound, reject the link attempt
- JWT signed with the existing internal API key — no new secrets needed

### 3.3 Tier 3: Admin Approval (Fallback)

For genuinely new users who don't have an Eve account, fall back to admin-managed approval.

**3.3.1 Clear Error Message**

When a Slack user's identity cannot be resolved by Tier 1 or Tier 2, and they haven't sent a link token, the gateway replies:

> "You don't have an Eve account yet. A membership request has been sent to your org admins. You'll be notified when it's approved."

**File**: `apps/gateway/src/chat/gateway-chat.service.ts`

**Critical interception point**: Currently, `resolveAndRoute` sets `inbound.eveUserId = null` when identity resolution fails, then continues to `routeToAgent`, which fails with "Unable to route command" — a confusing error. The clear error message must intercept **before** agent routing:

```typescript
// In resolveAndRoute, after identity resolution:
if (identityResult.external_identity_id && !identityResult.eve_user_id) {
  // Unknown user — don't route to agent, give a helpful message instead
  if (identityResult.membership_request_id) {
    return { immediateReply: { text: 'Your membership request is still pending. An admin will review it soon.' } };
  }
  return {
    immediateReply: {
      text: "I don't recognize your Slack account. If you already have an Eve account, link it by running:\n\n`eve identity link slack --org <org_slug>`\n\nOtherwise, a membership request has been sent to your org admins.",
    },
  };
}
```

Behavior:
- If `external_identity_id` is present and `eve_user_id` is null, and no link token was provided, reply with the above message.
- If a membership request already exists for this identity, do NOT create a duplicate (the API's `resolveExternalIdentity` already handles this). Reply: "Your membership request is still pending. An admin will review it soon."

**3.3.2 Admin Notification**

When a new membership request is created (not a duplicate), notify the admin channel with interactive buttons:

```json
{
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "New access request from <@U123> for *my-org*" }
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "Slack email: `alice.jones@example.com` (no matching Eve account found)" }
      ]
    },
    {
      "type": "actions",
      "elements": [
        { "type": "button", "text": { "type": "plain_text", "text": "Approve" }, "action_id": "membership_approve", "value": "<request_id>", "style": "primary" },
        { "type": "button", "text": { "type": "plain_text", "text": "Deny" }, "action_id": "membership_deny", "value": "<request_id>", "style": "danger" }
      ]
    }
  ]
}
```

Include the Slack email in the notification so admins can make an informed decision. If the email is close to a known Eve user (e.g., same name, different domain), mention it as a hint.

**3.3.3 Interactive Handler**

**Files**: `apps/gateway/src/webhook/webhook.controller.ts` and `apps/gateway/src/providers/slack/slack.provider.ts`

Canonical endpoint: `POST /gateway/providers/slack/interactive`.

The legacy `slack.controller.ts` has a no-op `handleInteractive()` (verifies signature, returns `{ ok: true }`). The new provider system has **no interactive route at all** — it needs to be added to `webhook.controller.ts` as a new endpoint.

Implement:

1. Add `POST /gateway/providers/slack/interactive` route to `webhook.controller.ts`.
2. Parse the `payload` parameter from the URL-encoded form body (Slack sends `application/x-www-form-urlencoded` with a `payload` JSON field).
3. Verify signature (reuse `slack-signature.ts` shared utility).
4. Route by `action_id`:
   - `membership_approve` → call API `POST /orgs/:org_id/membership-requests/:id/approve`. The API approve handler should leverage the existing `orgs.service.ts:addMember()` method, which already creates users on-demand from email and upserts org membership. After approval, bind the external identity's `eve_user_id`. Reply with confirmation. Notify the user in Slack: "You've been approved! Try `@eve` again." (requires `im:write` scope for DM).
   - `membership_deny` → call API to deny membership request. Reply with denial notice. Optionally notify the user.

### 3.4 API Endpoints

**Files**: `apps/api/src/integrations/integrations.service.ts` + controller extensions

**Membership requests** (admin-facing):

```
GET  /orgs/:org_id/membership-requests              # List pending requests (default: pending)
POST /orgs/:org_id/membership-requests/:id/approve   # Approve → create user + org membership + bind identity
POST /orgs/:org_id/membership-requests/:id/deny      # Deny
```

**Identity link tokens** (user-facing):

```
POST /users/me/identity-link-tokens                  # Generate link token
POST /internal/identity-link-tokens/redeem            # Redeem token (gateway-internal)
```

**CLI commands**:

```bash
# Admin: manage membership requests
eve org membership-requests list --org <org_id>
eve org membership-requests approve <request_id> --org <org_id> --role member
eve org membership-requests deny <request_id> --org <org_id>

# User: self-service identity linking
eve identity link slack --org <org_slug>
```

### 3.5 Integration Settings: Admin Channel

Add a `settings_json JSONB` column to the `integrations` table (separate from `tokens_json` which holds auth credentials). This cleanly separates configuration from secrets:

```sql
-- Migration
ALTER TABLE integrations ADD COLUMN settings_json JSONB DEFAULT '{}'::jsonb;
```

```bash
# Set admin channel on an existing integration
eve integrations update <integration_id> --setting admin_channel_id=C-ADMIN-CHANNEL

# Or during initial connect
eve integrations slack connect --org <org_id> --team-id T123 \
  --token xoxb-... \
  --setting admin_channel_id=C-ADMIN-CHANNEL
```

**API**: `PATCH /orgs/:org_id/integrations/:id/settings` to merge keys into `settings_json` without touching auth tokens.

When `settings_json.admin_channel_id` is set, admin notifications go to this channel. When unset, notifications are suppressed (CLI-only approval).

### 3.6 Resolution Priority and Decision Table

| Scenario | Tier | Outcome | Admin Action Needed? |
|----------|------|---------|---------------------|
| Slack email matches Eve user who is org member | 1 | Auto-bind, immediate access | No |
| Slack email matches Eve user NOT in this org | 3 | Membership request | Yes |
| Slack email matches no Eve user | 3 | Membership request (new user) | Yes |
| Slack email not available (workspace restriction) | 2/3 | Offer CLI link, or membership request | Depends |
| User sends `@eve link <token>` | 2 | Validate + bind, immediate access | No |
| User has pending membership request, messages again | — | "Still pending" reply, no duplicate | No |
| Approved membership request | 3 | Create user + membership + bind | One-time |

### Deliverables

- [ ] Gateway: Slack `users.info` email lookup before identity resolution call (Tier 1)
- [ ] API: `external_email` parameter in `resolveExternalIdentity` for provider-agnostic auto-match (Tier 1)
- [ ] Gateway: Intercept unresolved identity BEFORE agent routing with clear error message
- [ ] `eve identity link slack` CLI command + JWT link token generation API (Tier 2)
- [ ] Gateway: `link` as reserved command (before agent slug resolution) + token redemption (Tier 2)
- [ ] Gateway: `POST /gateway/providers/slack/interactive` endpoint with action routing (Tier 3)
- [ ] API: Membership approve/deny endpoints leveraging existing `addMember()` for user creation (Tier 3)
- [ ] Admin notification with Block Kit buttons including Slack email context
- [ ] CLI commands for listing/approving/denying membership requests (`eve org ...`)
- [ ] DB migration: `settings_json` column on `integrations` table + `admin_channel_id` setting
- [ ] Logging for all three tiers (`identity.auto_matched`, `identity.link_redeemed`, `identity.membership_requested`)

---

## Phase 4: Rich Formatting (Block Kit)

> Agent replies are plain text. Slack supports rich formatting via Block Kit.

### 4.1 Outbound Block Kit Support

The gateway's `MessageContent` interface already has an optional `blocks: unknown` field, but it's unused. Wire it through:

1. **Type the blocks field** in `SlackReplyOptions` (currently only has `token`, `channelId`, `text`, `threadTs`):
   ```typescript
   export interface SlackReplyOptions {
     token: string;
     channelId: string;
     text: string;           // Fallback for notifications and plain clients
     threadTs?: string;
     blocks?: SlackBlock[];  // Rich Block Kit content (wire from MessageContent.blocks)
   }
   ```

2. **Pass blocks through** in `sendSlackMessage` — include `blocks` in the `chat.postMessage` payload when present.

3. **Populate from `MessageContent`** in `slack.provider.ts:sendMessage()` — map `content.blocks` to `SlackReplyOptions.blocks`.

Apply this through `apps/gateway/src/providers/slack/slack-sender.ts` and keep
`apps/gateway/src/chat/gateway-chat.service.ts` as the content producer.

### 4.2 Agent Reply Formatting

When agents produce chat responses, apply basic Markdown-to-Slack mrkdwn conversion:

| Markdown | Slack mrkdwn |
|----------|-------------|
| `**bold**` | `*bold*` |
| `_italic_` | `_italic_` |
| `` `code` `` | `` `code` `` |
| ```` ```block``` ```` | ```` ```block``` ```` |
| `[text](url)` | `<url|text>` |

### 4.3 Job Status Formatting

Replace the current plain-text "Queued 1 job(s)" reply with a structured Block Kit message:

```json
{
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "Queued *1* job for `mission-control`" }
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "Job: `myproj-a3f2dd12` | Route: `deploy-route`" }
      ]
    }
  ]
}
```

### Deliverables

- [ ] `SlackReplyOptions.blocks` support in sender
- [ ] Markdown → mrkdwn converter utility
- [ ] Formatted job status messages
- [ ] Agent reply content rendered as Block Kit sections with code block support

---

## Phase 5: Rate Limiting and Resilience

> Slack enforces rate limits. High-traffic orgs will hit them.

### 5.1 Outbound Rate Limit Handling

When `chat.postMessage` returns HTTP 429:
- Read the `Retry-After` header.
- Queue the message for retry after the specified delay.
- Log `slack.outbound.rate_limited` with the delay.

Use a simple in-memory queue per integration with exponential backoff. No need for a durable queue — best-effort delivery is acceptable for chat replies.

### 5.2 Inbound Deduplication and Timeout Hardening

Slack retries webhook delivery if Eve doesn't respond within 3 seconds. The gateway currently has **no deduplication mechanism** — duplicate events will be processed twice.

**Deduplication**: Track `event_id` from the Slack payload in a short-lived in-memory cache (e.g., `Set<string>` with 5-minute TTL). If a duplicate `event_id` arrives, return `200` immediately without processing.

**Timeout**: The webhook controller must return `200` to Slack before the 3-second deadline. If `resolveAndRoute` risks exceeding this:
- Return `200` immediately after validation and parsing.
- Process the message asynchronously (fire-and-forget with structured logging).
- Add `slack.webhook_latency_ms` timing around `GatewayChatService.resolveAndRoute()` to monitor.

### 5.3 Token Refresh

Slack bot tokens (`xoxb-`) don't expire, but if Eve adds support for user tokens (`xoxp-`) in the future, token refresh will be needed. For now, document this as a non-issue and add a health check that validates the token is still active:

```bash
eve integrations test <id> --org <org_id>
```

Enhance this to actually call `auth.test` on the Slack API and report the result.

### Deliverables

- [ ] Outbound rate limit handling with `Retry-After` and in-memory queue
- [ ] Token health check via `auth.test` in `eve integrations test`
- [ ] Inbound event deduplication via `event_id` cache
- [ ] Async message processing if webhook latency approaches 3s threshold
- [ ] `slack.webhook_latency_ms` timing metric

---

## Phase 6: Legacy Cleanup

> Remove legacy Slack webhook code paths and keep a single canonical provider flow.

### 6.1 Remove API-Side Slack Controller

**File**: `apps/api/src/integrations/slack.controller.ts`

This controller handles `POST /integrations/slack/events/:projectId` — a project-scoped Slack webhook that creates Eve events. It predates the gateway and is no longer the primary routing path.

**Action**: Remove it. All Slack events should flow through the gateway provider runtime:
`POST /gateway/providers/slack/webhook` via `SlackGatewayProvider` + `GatewayChatService`.

### 6.2 Remove Legacy Gateway Controller

The legacy `apps/gateway/src/slack.controller.ts` duplicates logic that exists in provider files (`slack-parser.ts`, `slack-sender.ts`, `slack-signature.ts`) and `GatewayChatService`.

**Action**: Delete `apps/gateway/src/slack.controller.ts`. By this point (after Phase 3):
- Interactive route handling already exists at `POST /gateway/providers/slack/interactive` (Phase 3.3.3)
- All webhook handling flows through `SlackGatewayProvider` + `GatewayChatService`
- Shared utilities live in `slack-parser.ts`, `slack-sender.ts`, `slack-signature.ts`

No code migration needed — just delete the file and remove its module wiring.

### 6.3 Remove Duplicate Signature Verification

Three implementations remain during cleanup:
1. `apps/gateway/src/slack.controller.ts` (legacy inline function)
2. `apps/gateway/src/providers/slack/slack-signature.ts` (shared utility)
3. `apps/api/src/integrations/slack.controller.ts` (legacy inline function)

After removing `apps/api/src/integrations/slack.controller.ts` and `apps/gateway/src/slack.controller.ts`, keep only
`apps/gateway/src/providers/slack/slack-signature.ts` as the shared implementation.

### Deliverables

- [ ] Remove `apps/api/src/integrations/slack.controller.ts`
- [ ] Remove `apps/gateway/src/slack.controller.ts`
- [ ] Single `isValidSlackSignature` implementation in `slack-signature.ts`

---

## Phase 7: Extended Event Support

> Currently only `app_mention` and `message` are handled. Expand coverage.

### 7.1 Emoji Reactions

When a user reacts to an Eve reply with an emoji, surface it as feedback:

- Subscribe to `reaction_added` bot event in Slack App config.
- In the gateway, parse the reaction and post a `chat.reaction` event to the thread.
- Agents can use reactions as approval/rejection signals (e.g., thumbsup = approve).

### 7.2 File Uploads

When a user uploads a file in a message to `@eve`:

- Extract file metadata from the Slack event payload (`files` array).
- Download the file via Slack's `files.info` API using the bot token.
- Store in org filesystem or pass as a job attachment.
- Requires `files:read` bot scope.

### 7.3 Slash Commands

Register `/eve` as a Slack slash command:

- Endpoint: `POST /gateway/providers/slack/slash`
- Parses `/eve <agent-slug> <command>` syntax.
- Returns an ephemeral response (visible only to the invoker) with job status.
- Useful for quick commands that shouldn't clutter the channel.

### Deliverables

- [ ] `reaction_added` event handling → thread feedback
- [ ] File upload download and attachment to jobs
- [ ] `/eve` slash command endpoint and ephemeral responses

---

## Phase 8: OAuth Install Flow (Self-Service)

> Currently admins must manually create a Slack App and copy tokens. This phase adds "Add to Slack" button support.

### 8.1 OAuth Endpoints

**New endpoints on the API** (not gateway — OAuth is an admin flow):

```
GET  /orgs/:org_id/integrations/slack/authorize    # Redirect to Slack OAuth
GET  /integrations/slack/oauth/callback             # Handle OAuth callback
```

**Authorize flow**:
1. Generate a `state` token (store in DB with org_id, expiry).
2. Redirect to `https://slack.com/oauth/v2/authorize?client_id=...&scope=...&state=...&redirect_uri=...`.

**Callback flow**:
1. Validate `state` token.
2. Exchange `code` for access token via `https://slack.com/api/oauth.v2.access`.
3. Store tokens in integration record (same as manual `connectSlack`).
4. Redirect to success page or return JSON.

### 8.2 Slack App Configuration

Requires a single Slack App registered at the platform level:
- Client ID and Client Secret stored as system secrets.
- Redirect URI: `https://<api-host>/integrations/slack/oauth/callback`.
- Scopes defined in the authorize URL, matching Phase 1.2.

### 8.3 Multi-Tenant Considerations

Each org gets its own integration record, but they all use the same Slack App (Client ID). The `team_id` in the OAuth response determines which workspace was authorized. If the same workspace connects to multiple orgs, reject with an error (one workspace → one org).

### 8.4 "Add to Slack" Button

Expose a URL that can be embedded in docs, onboarding flows, or a future UI:

```bash
eve integrations slack install-url --org <org_id>
```

Returns a URL like:
```
https://api.eve.lvh.me/orgs/org_xxx/integrations/slack/authorize
```

### Deliverables

- [ ] OAuth authorize endpoint with state token
- [ ] OAuth callback endpoint with token exchange
- [ ] System secrets: `EVE_SLACK_CLIENT_ID`, `EVE_SLACK_CLIENT_SECRET`
- [ ] CLI: `eve integrations slack install-url`
- [ ] Multi-tenant guard: one workspace per org

---

## Dependency Graph

```
Phase 1 (docs)          ← no code, unblocks immediate usage
  ↓
Phase 2 (observability) ← no new features, just safety
  ↓
Phase 3 (identity)      ← requires Phase 2 logging; three tiers:
  ├─ 3.1 email auto-match (Tier 1, smallest scope)
  ├─ 3.2 CLI self-link   (Tier 2, requires link token API)
  └─ 3.3 admin approval  (Tier 3, interactive handler + Block Kit)
  ↓
Phase 6 (cleanup)       ← do immediately after Phase 3; reduces surface area for later phases
  ↓
Phase 4 (rich format)   ← cleaner after legacy removal
  ↓
Phase 5 (resilience)    ← independent, production hardening
  ↓
Phase 7 (events)        ← requires solid foundation from Phases 2-6
  ↓
Phase 8 (OAuth)         ← last, only needed for self-service onboarding
```

Phases 1-2 are the critical path. Phase 1 is purely documentation and can be done immediately. Phase 2 is a small code change that makes everything else safer.

Phase 3 is internally incremental: Tier 1 (email auto-match) can ship first and will handle the majority of existing org members silently. Tier 2 (CLI self-link) handles the email mismatch case. Tier 3 (admin approval) is the fallback for genuinely new users. Each tier is independently useful.

Phase 6 (legacy cleanup) is pulled forward to right after Phase 3. The legacy controllers are dead code that add confusion — removing them early reduces the surface area for Phases 4-7.

Phases 4-8 can be prioritized based on whether the first real Slack users are internal (skip OAuth) or external (need OAuth sooner).

## Strict Execution Order (No Backward Compatibility)

Execute in this exact sequence:

1. **Phase 1**
  - `docs/guides/slack-app-setup.md` (new)
  - `docs/system/integrations.md` (update: replace legacy references, add identity tiers)
  - `docs/system/chat-gateway.md` (update: remove "stubbed" notes, add interactive + identity)
  - `tests/manual/scenarios/08-chat-gateway-slack.md` (restructure into phased verification)
  - docs map update in `CLAUDE.md`

2. **Phase 2**
  - `apps/gateway/src/providers/slack/slack-sender.ts` (structured return + token fetch logging)
  - `apps/gateway/src/chat/gateway-chat.service.ts` (3 silent catch blocks)

3. **Phase 3**
  - **3.1**: Gateway Slack `users.info` call + `external_email` param in API's `resolveExternalIdentity`
  - **3.1**: Gateway interception of unresolved identity (before agent routing)
  - **3.2**: JWT link token generation (API) + `link` reserved command (gateway) + redemption flow
  - **3.3**:
    - `POST /gateway/providers/slack/interactive` route in `webhook.controller.ts`
    - API membership approve/deny endpoints (leveraging existing `addMember()`)
    - Admin notification Block Kit message
    - CLI commands in `packages/cli/src/commands/`
  - **3.5**: DB migration for `integrations.settings_json` + `admin_channel_id`
  - This phase requires Phase 2 logging primitives to exist first, but Phase 3.1 can ship before 3.2/3.3.

4. **Phase 6**
  - `apps/gateway/src/slack.controller.ts` (delete)
  - `apps/api/src/integrations/slack.controller.ts` (delete)
  - `apps/api/src/integrations/integrations.module.ts` controller wiring cleanup

5. **Phase 4**
  - `apps/gateway/src/providers/slack/slack-sender.ts`
  - `apps/gateway/src/chat/gateway-chat.service.ts`
  - `apps/gateway/src/providers/slack/slack-parser.ts`

6. **Phase 5**
  - `apps/gateway/src/providers/slack/slack-sender.ts`
  - `apps/gateway/src/chat/gateway-chat.service.ts`
  - `apps/gateway/src/webhook/webhook.controller.ts` (if async handoff is needed)

7. **Phase 7**
  - `apps/gateway/src/providers/slack/slack-parser.ts` (if adding reactions/files support)
  - `apps/gateway/src/providers/slack/slack.provider.ts`
  - `apps/gateway/src/webhook/webhook.controller.ts` for slash command route

8. **Phase 8**
  - `apps/api/src/integrations` controllers for OAuth endpoints and tests
  - `packages/cli/src/commands/integrations.ts` for `install-url`
  - shared config/secrets docs updates

**Phase gate**: After each stage, run the corresponding section of scenario 08 against the k3d stack. Do not proceed to the next stage until the phase gate passes. Update `docs/system/integrations.md` and `docs/system/chat-gateway.md` after each phase to reflect the new behavior.

---

## Testing Strategy

| Phase | Test Type | Coverage |
|-------|-----------|----------|
| 1 | Manual | Follow the guide end-to-end with a real Slack workspace |
| 2 | Unit | Mock Slack API responses (`chat.postMessage`, `auth.test`), verify structured logs and queue retry metadata |
| 2 | Integration | `WebhookController` + `GatewayChatService` route error + success paths |
| 3 (Tier 1) | Unit | Gateway: Mock Slack `users.info` → pass email to API. API: email lookup → auto-bind when org member; skip when email missing or non-member |
| 3 (Tier 1) | Unit | Gateway: Intercept unresolved identity before agent routing → correct error message |
| 3 (Tier 2) | Unit | JWT token generation, expiry, single-use (jti) enforcement, provider/org mismatch rejection |
| 3 (Tier 2) | Integration | Generate link token via CLI API, send `@eve link <token>` via gateway, verify identity binding |
| 3 (Tier 2) | Unit | Gateway: `link` recognized as reserved command, not routed to agent |
| 3 (Tier 3) | Integration | Simulate membership request → admin notification → approval flow via API (using existing `addMember()`) |
| 3 (Tier 3) | Manual | Real Slack interactive buttons in test workspace |
| 4 | Unit | Markdown → mrkdwn converter |
| 5 | Unit | Rate limit queue behavior, retry timing |
| 6 | Integration | Verify API-side and legacy gateway controllers are removed and canonical provider routes are covered |
| 7 | Integration | File upload mock, reaction event mock |
| 8 | Integration | OAuth state/callback flow with mocked Slack API |

Update `tests/manual/scenarios/08-chat-gateway-slack.md` after each phase to cover the new functionality.

---

## Verification: Expanded Manual Scenario 08

> Each phase MUST be verified against the local k3d stack using the expanded manual test scenario before moving to the next phase.

The current scenario 08 (`tests/manual/scenarios/08-chat-gateway-slack.md`) only covers basic `eve chat simulate`. Expand it into a phased verification suite that exercises each gap closure phase using the simulated Slack flow (no real Slack workspace needed for most tests).

### Scenario Structure

Restructure scenario 08 into phases matching this plan:

```markdown
# Scenario 08: Chat Gateway (Slack Integration)

## Phase 0: Baseline (existing)
- eve chat simulate → job created, thread recorded
- Integration connect + list + test

## Phase 2: Observability Verification
- Simulate message to nonexistent integration → verify logs (not silent)
- Simulate message → verify structured send result returned
- Trigger outbound failure (invalid token) → verify slack.outbound.failed log

## Phase 3a: Identity Auto-Match (Tier 1)
- Create user with email alice@example.com, add to org
- Simulate inbound from Slack user whose email matches → verify auto-bind
- Simulate inbound from Slack user with non-matching email → verify membership request created
- Simulate inbound from already-bound user → verify immediate routing (no re-lookup)

## Phase 3b: Identity Link (Tier 2)
- Generate link token via API (POST /users/me/identity-link-tokens)
- Simulate @eve link <token> → verify identity binding
- Attempt expired/invalid token → verify error message
- Attempt link when already bound → verify rejection

## Phase 3c: Membership Approval (Tier 3)
- Simulate inbound from unknown user → verify "membership request sent" message (not "Unable to route command")
- Simulate repeat message → verify "still pending" message (no duplicate request)
- Approve via API (POST /orgs/:org_id/membership-requests/:id/approve) → verify user created + org membership + identity bound
- Simulate inbound again → verify immediate routing

## Phase 3d: Admin Channel Notification
- Set admin_channel_id via settings API
- Create new membership request → verify Block Kit notification sent to admin channel
- Verify notification includes Slack email context

## Phase 4: Rich Formatting
- Agent reply with markdown → verify mrkdwn conversion
- Job status reply → verify Block Kit structure

## Phase 5: Resilience
- Verify event deduplication (send same event_id twice → processed once)
- Verify webhook responds within 3s (timing assertion)

## Phase 6: Cleanup Verification
- Verify /integrations/slack/events/:projectId returns 404 (removed)
- Verify /gateway/providers/slack/webhook still works
- Verify /gateway/providers/slack/interactive still works
```

### k3d Verification Workflow

Each phase follows this loop:

```bash
# 1. Rebuild and deploy to k3d (if code changed)
./bin/eh k8s deploy

# 2. Set up test fixtures
export EVE_API_URL=http://api.eve.lvh.me
eve org ensure "manual-test-org" --slug mto --json
eve secrets import --org org_manualtestorg --file ./manual-tests.secrets

# 3. Run the scenario phase
# Ask Claude: "Run manual test scenario 08, Phase 3a"

# 4. Verify logs (structured logging from Phase 2)
eve system logs gateway --tail 50 | grep slack.identity
eve system logs api --tail 50 | grep identity.auto_matched

# 5. Clean up test state for next phase
# (delete test integrations, external identities, membership requests)
```

### Simulated vs. Live Slack

Most phases are testable with `eve chat simulate` which creates the same internal events as a real Slack webhook:

| Phase | Simulate | Live Slack | Notes |
|-------|----------|------------|-------|
| 0 (baseline) | Full | Optional | Simulate covers all routing |
| 2 (observability) | Full | Optional | Log assertions via `eve system logs` |
| 3a (auto-match) | Partial | Needed for `users.info` | Simulate can't call Slack API; mock or test API layer directly |
| 3b (link) | Full | Optional | Token flow is CLI→API→gateway, no Slack API needed |
| 3c (approval) | Full | Live for buttons | API endpoints testable directly; buttons need real Slack |
| 3d (admin notify) | Partial | Needed | Sending to admin channel requires real bot token |
| 4 (formatting) | Full | Visual check | Simulate verifies structure; live Slack for visual |
| 5 (resilience) | Full | Optional | Timing and dedup are internal |
| 6 (cleanup) | Full | N/A | Route existence checks |

For Phase 3a (auto-match), the gateway's Slack `users.info` call needs either:
- A **real Slack bot token** with `users:read` + `users:read.email` scopes, or
- An **integration test** that mocks the Slack API response and tests the API's `resolveExternalIdentity` with `external_email` directly

The API-side auto-match (email→user lookup + org membership check) is fully testable without Slack.

### Deliverables

- [ ] Expand `tests/manual/scenarios/08-chat-gateway-slack.md` into phased verification suite
- [ ] Add scenario 08 to the phase gate checklist in the strict execution order
- [ ] Document which phases require live Slack vs. simulate-only

---

## Estimated Effort

| Phase | Effort | Notes |
|-------|--------|-------|
| 1 | Half day | Setup guide, system doc updates, scenario 08 restructure |
| 2 | Half day | Logging changes + scenario 08 Phase 2 verification |
| 3 | 2-3 days | Tier 1: email auto-match (~half day), Tier 2: CLI self-link + token API (~1 day), Tier 3: interactive handler + approval API + Block Kit (~1 day). Each tier verified via scenario 08. |
| 6 | Quarter day | Delete legacy controllers, verify routes still work |
| 4 | 1 day | Block Kit sender, mrkdwn converter, formatted messages |
| 5 | Half day | Rate limit queue, deduplication, token health check |
| 7 | 1-2 days | Reactions, file uploads, slash commands |
| 8 | 1-2 days | OAuth flow, state management, multi-tenant guard |

**Total: ~6-9 days** for the full program. Phases 1-2 can ship in a single session. Phase 3 Tier 1 (email auto-match) can ship independently in half a day and handles the most common case.

Effort includes per-phase verification against k3d and system doc updates.
