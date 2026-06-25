# Slack Install Smoothing Plan

> Status: Implemented (2026-03-09, commits 280980a, c2b638d, 014456e)
> Last Updated: 2026-03-09
> Purpose: Make connecting a Slack workspace to an Eve org a one-click flow — no Eve auth session required by the person clicking the link.

## Dependencies

- `apps/api/src/integrations/slack-oauth.controller.ts`
- `apps/api/src/integrations/integrations.service.ts`
- `packages/cli/src/commands/integrations.ts`

## Problem

The current "Add to Slack" flow is broken for its primary use case: an org admin generates an install URL via the CLI, then shares it with a Slack workspace admin who clicks it.

**Current flow:**
1. Eve admin runs `eve integrations slack install-url --org org_xxx`
2. CLI prints `https://api.eve.example.com/orgs/org_xxx/integrations/slack/authorize`
3. Admin shares that URL with a Slack workspace owner
4. Workspace owner clicks it → **401 Unauthorized** (endpoint requires `@RequirePermission('integrations:write')`)

The authorize endpoint requires an active Eve auth session because it generates an OAuth state token and redirects to Slack. But the person clicking the link is typically a Slack workspace admin who may not have an Eve account at all.

## Goals

- **Shareable install link**: Eve admin generates a URL that anyone can click to start the Slack OAuth flow — no Eve login required.
- **Time-bounded**: Install links expire (24h default) to limit exposure.
- **Single-use**: Each link can only be used once to prevent replay.
- **Org-scoped**: The link is cryptographically bound to a specific org so the resulting integration lands in the right place.
- **No new dependencies**: Reuse the existing HMAC signing pattern from `generateLinkToken()`.

## Non-Goals

- Changing the existing authenticated authorize endpoint (keep it for API/programmatic use).
- Building a web UI for install management.
- Supporting multi-workspace install from a single link.
- Self-service org discovery (the admin must know which org to connect).

---

## Design

### Signed Install Token

Reuse the same HMAC pattern already used for identity link tokens in `IntegrationsService.generateLinkToken()`:

```
eve-slack-install-<base64url(payload)>.<base64url(hmac)>
```

**Payload:**
```json
{
  "org_id": "org_xxx",
  "jti": "<uuid>",
  "exp": 1741564800,
  "iat": 1741478400
}
```

- Signed with `EVE_INTERNAL_API_KEY` (same secret as link tokens)
- 24-hour TTL (configurable via flag)
- Single-use: JTI tracked in-memory (same pattern as link token redemption)

### New Public Endpoint

```
GET /integrations/slack/install?token=<signed-token>
```

- Decorated `@Public()` — no auth required
- Validates token signature, expiry, and single-use JTI
- Extracts `org_id` from payload
- Generates OAuth state (same as current authorize endpoint)
- Redirects to Slack OAuth consent screen
- On error: returns a clear HTML error page (not JSON — this is a browser flow)

### Updated CLI Command

```bash
eve integrations slack install-url --org org_xxx [--ttl 24h]
```

**Changed behavior:**
- Calls a new API endpoint: `POST /orgs/:org_id/integrations/slack/install-token`
- API generates the signed token and returns the full URL
- CLI prints the shareable URL: `https://api.eve.example.com/integrations/slack/install?token=eve-slack-install-...`
- The `--ttl` flag controls expiry (default 24h, max 7d)

The token-generation endpoint stays behind `@RequirePermission('integrations:write')` — only the install link itself is public.

### Callback — No Changes

The existing callback (`GET /integrations/slack/oauth/callback`) already works:
- It's `@Public()`
- It validates the OAuth state token (which encodes `org_id`)
- It exchanges the code and creates the integration

No changes needed.

---

## Implementation

### Step 1: Add signed install token methods to IntegrationsService

**File:** `apps/api/src/integrations/integrations.service.ts`

Add two methods following the existing `generateLinkToken` / `redeemLinkToken` pattern:

```typescript
generateSlackInstallToken(orgId: string, ttlSeconds?: number): { token: string; expiresAt: string }
validateSlackInstallToken(token: string): { orgId: string } | null
```

- Uses `EVE_INTERNAL_API_KEY` as HMAC secret
- Token prefix: `eve-slack-install-`
- Default TTL: 86400 (24h)
- Single-use via `redeemedJtis` set (already exists)

### Step 2: Add token-generation endpoint

**File:** `apps/api/src/integrations/org-integrations.controller.ts`

```
POST /orgs/:org_id/integrations/slack/install-token
```

- `@RequirePermission('integrations:write')` — only Eve admins can generate
- Accepts optional `{ ttl_seconds?: number }` body
- Returns `{ url: string, expires_at: string }`
- URL format: `${EVE_API_URL}/integrations/slack/install?token=<token>`

### Step 3: Add public install endpoint

**File:** `apps/api/src/integrations/slack-oauth.controller.ts`

```
GET /integrations/slack/install?token=<token>
```

- `@Public()` + `@Redirect()`
- Validates install token (signature, expiry, JTI)
- On success: generates OAuth state, redirects to Slack (same logic as current `authorize()`)
- On error: returns simple HTML error page with the reason

### Step 4: Update CLI command

**File:** `packages/cli/src/commands/integrations.ts`

Change `install-url` subcommand:
- Instead of constructing the URL locally, call `POST /orgs/:org_id/integrations/slack/install-token`
- Print the returned URL
- Add `--ttl` flag (e.g., `1h`, `24h`, `7d`) parsed to seconds

### Step 5: Keep existing authorize endpoint

The authenticated `GET /orgs/:org_id/integrations/slack/authorize` stays as-is for programmatic/API use. No changes.

---

## Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Token leakage (shared in Slack/email) | 24h TTL + single-use JTI. After install completes, token is burned. |
| Token replay | JTI tracked in-memory, rejected on second use. |
| Token forgery | HMAC-SHA256 with `EVE_INTERNAL_API_KEY`. |
| Org mismatch | Org ID is inside the signed payload, not a URL parameter. |
| Brute force | Tokens are 32-byte random JTIs — infeasible to guess. |
| In-memory JTI store | Sufficient for pre-MVP. If API restarts, unexpired tokens become re-usable (acceptable risk at current scale). Future: move to DB or Redis. |

---

## UX After Implementation

```bash
# Eve admin generates a shareable link
$ eve integrations slack install-url --org org_example
Slack install link (expires in 24h):
  https://api.eve.example.com/integrations/slack/install?token=eve-slack-install-eyJvcm...

Share this link with your Slack workspace admin. They'll be redirected
to Slack's OAuth consent screen to authorize the Eve bot.

# Workspace admin clicks the link in their browser
# → Slack OAuth consent screen
# → Approves
# → Redirected back to Eve callback
# → Integration created automatically
# → "Success! Slack workspace connected to org_example"
```

---

## Estimated Scope

| Step | Files Changed | Effort |
|------|--------------|--------|
| 1. Install token methods | `integrations.service.ts` | ~40 lines |
| 2. Token-generation endpoint | `org-integrations.controller.ts` | ~20 lines |
| 3. Public install endpoint | `slack-oauth.controller.ts` | ~40 lines |
| 4. CLI update | `integrations.ts` | ~15 lines |
| **Total** | **4 files** | **~115 lines** |

## Future Enhancements (Not in Scope)

- **Success page**: After callback, redirect to a branded "Connected!" HTML page instead of returning JSON.
- **Revocable tokens**: Store tokens in DB so admins can revoke before expiry.
- **Multi-use tokens**: Allow a token to be used N times (for installing across multiple workspaces).
- **Webhook auto-config**: After install, automatically configure Slack app event subscriptions via Slack API.
