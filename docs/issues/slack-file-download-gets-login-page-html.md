# Slack File Download Returns Login Page HTML Instead of File Content

> **Status**: Root cause confirmed — ready to implement
> **Date**: 2026-03-11
> **Severity**: High — file attachments silently corrupted, agents receive garbage
> **Observed in**: Staging, job `proj_example-5309497f`

## Symptom

A user shared `nostrworld-initial-design.md` via Slack. The agent received the file but its
content was Slack's login page HTML, not the actual markdown document.

## Root Cause: `getByProvider()` Returns Wrong Provider Instance

The webhook controller gets a provider instance using `getByProvider('slack')`, which returns
the **first** Slack instance in the registry Map (insertion order). Two Slack integrations
exist on staging:

| Order | Integration | Account | Token | Created |
|-------|-------------|---------|-------|---------|
| 1st | `intg_REDACTED_test` | `T08TEST` | `xoxb-REDACTED-test...` (28 chars, **fake**) | 2026-02-27 |
| 2nd | `intg_REDACTED` | `T_REDACTED` | `xoxb-REDACTED...` (redacted production token) | 2026-03-09 |

`getByProvider('slack')` returns the test instance. This provider's `this.integrationId`
points to the test integration. When `resolveFiles()` calls `getIntegrationTokens()`, it
fetches the **fake** test token. Slack CDN rejects it, redirects to login page, `fetch()`
follows the redirect (default behavior), and the gateway uploads the HTML to Eve storage
as if it were the real file.

**Verified**: The production token passes `auth.test`, has `files:read` scope, and downloads the
file correctly when used directly.

### The exact code path

```
webhook.controller.ts:76    getByProvider('slack')     → TEST instance (T08TEST, first in Map)
webhook.controller.ts:125   resolveAndRoute(inbound, provider)  → passes TEST provider
gateway-chat.service.ts:71  resolve integration        → CORRECTLY resolves T_REDACTED → org_example
gateway-chat.service.ts:133 provider.resolveFiles()    → calls resolveFiles on TEST provider
slack.provider.ts:231       this.integrationId         → TEST integration ID
slack.provider.ts:235       getIntegrationTokens(...)  → fetches FAKE token
slack.provider.ts:271       fetch(url_private, Bearer fake-token) → Slack 302 → login page HTML
slack.provider.ts:280       response.ok === true       → uploads HTML to Eve storage
```

### Why the March 10 outbound reply fix didn't catch this

The March 10 fix (#30958) addressed the identical `getByProvider()` issue for **outbound
replies** — `webhook.controller.ts:129` now resolves the account-specific provider:

```typescript
const replyProvider = this.registry.getInstance(providerName, inbound.accountId) ?? provider;
```

But `resolveAndRoute()` on line 125 still receives the generic `provider`. The reply fix
and the file resolution code are in different branches of the same `setImmediate` callback.

---

## Fix Plan

Five changes, ordered by dependency. Fixes 1–3 are the core. Fixes 4–5 are hardening.

### Fix 1: Use account-specific provider after webhook parsing

**File**: `apps/gateway/src/webhook/webhook.controller.ts`

**Problem**: `getByProvider()` is used for initial validation (where `account_id` is unknown
from the URL), but the same arbitrary instance is passed downstream for routing, file
resolution, and replies. After `parseWebhook()`, `inbound.accountId` is known — all
subsequent operations should use the account-specific instance.

**Change**: After parsing extracts `accountId`, look up the correct provider and use it
for everything downstream. `getByProvider()` stays for validation/parsing only.

```typescript
// Current (broken):
const provider = this.registry.getByProvider(providerName);  // line 76
// ... validation, parsing ...
const inbound = parsed.inbound;
setImmediate(async () => {
  const result = await this.chatService.resolveAndRoute(inbound, provider);  // WRONG provider
  if (result.immediateReply) {
    const replyProvider = this.registry.getInstance(providerName, inbound.accountId) ?? provider;
    await replyProvider.sendMessage(...);
  }
});

// Fixed:
const validationProvider = this.registry.getByProvider(providerName);  // line 76 — for validation/parsing only
// ... validation, parsing ...
const inbound = parsed.inbound;
setImmediate(async () => {
  // Resolve account-specific provider now that we know accountId.
  // Falls back to validationProvider for single-integration setups.
  const provider = this.registry.getInstance(providerName, inbound.accountId) ?? validationProvider;

  const result = await this.chatService.resolveAndRoute(inbound, provider);
  if (result.immediateReply) {
    await provider.sendMessage(...);  // Same correct instance — no separate replyProvider needed
  }
});
```

This also simplifies the reply path — the separate `replyProvider` lookup on line 129
becomes unnecessary since `provider` is already account-specific.

### Fix 2: Make registry sync bidirectional (add + remove + update)

**File**: `apps/gateway/src/providers/provider-registry.ts`

**Problem**: The `sync()` method (line 110-124) only adds new integrations. It never:
- Removes instances for deactivated/deleted integrations
- Updates instances when tokens are refreshed (e.g., re-auth via OAuth)

A deactivated integration stays in the registry forever. A re-authorized integration keeps
its stale provider instance (though tokens are fetched fresh per-call, the `integrationId`
mapping could become wrong if the integration is replaced).

**Change**: Make sync a full reconciliation loop:

```typescript
private async sync(): Promise<void> {
  if (!this.syncFn) return;
  try {
    const integrations = await this.syncFn();
    const activeKeys = new Set<string>();

    for (const integration of integrations) {
      const key = `${integration.provider}:${integration.account_id}`;
      activeKeys.add(key);

      if (!this.instances.has(key)) {
        // New integration — initialize
        logger.log({ event: 'gateway.integration.hot_loaded', provider: integration.provider, accountId: integration.account_id });
        await this.initializeOne(integration);
      }
      // Note: existing instances are NOT re-initialized here. Token freshness is
      // handled by per-call getIntegrationTokens(). Only the integrationId matters,
      // and that's stable for the lifetime of an integration record.
    }

    // Remove instances for integrations no longer in the active list
    for (const key of this.instances.keys()) {
      if (!activeKeys.has(key)) {
        logger.log({ event: 'gateway.integration.removed', key });
        const instance = this.instances.get(key);
        if (instance) await instance.shutdown();
        this.instances.delete(key);
      }
    }
  } catch {
    // Silent — transient API failures shouldn't crash the gateway
  }
}
```

### Fix 3: Defend against Slack CDN misbehavior in file downloads

**File**: `apps/gateway/src/providers/slack/slack.provider.ts`

**Problem**: The download check is `response.ok` only. Slack's CDN returns 302 → login page
when auth fails, and `fetch()` follows the redirect silently, resulting in `200 OK` with HTML.
No validation catches this.

**Changes** (three layers of defense):

**3a. Disable redirect following:**

```typescript
// In resolveFiles(), replace the existing fetch:
response = await fetch(file.url, {
  headers: { Authorization: `Bearer ${token}` },
  redirect: 'manual',  // Don't follow Slack CDN redirects
});

// Treat any redirect as an auth failure
if (response.status >= 300 && response.status < 400) {
  const location = response.headers.get('location') || '';
  logger.warn({
    event: 'file.auth_redirect',
    fileId: file.id,
    fileName: file.name,
    status: response.status,
    location: location.slice(0, 200),
  });
  resolved.push({
    ...file,
    source_url: file.url,
    source_provider: 'slack',
    error: 'auth_failed',
  });
  continue;
}
```

**3b. Validate response content-type:**

After confirming `response.ok`, check the content-type makes sense:

```typescript
// After the existing response.ok check, before upload:
const responseContentType = response.headers.get('content-type') || '';
if (
  file.mimetype &&
  !file.mimetype.includes('html') &&
  responseContentType.includes('text/html')
) {
  logger.warn({
    event: 'file.content_type_mismatch',
    fileId: file.id,
    fileName: file.name,
    expected: file.mimetype,
    received: responseContentType,
  });
  resolved.push({
    ...file,
    source_url: file.url,
    source_provider: 'slack',
    error: 'content_mismatch',
  });
  continue;
}
```

**3c. Log successful downloads** (currently completely silent):

```typescript
// After successful upload to Eve storage:
logger.log({
  event: 'file.resolved',
  fileId: file.id,
  fileName: file.name,
  size: body.byteLength,
  contentType,
});
```

### Fix 4: Add `error` field to ChatFile — surface failures to agents

**Files**: `packages/shared/src/schemas/chat-file.ts`, `apps/agent-runtime/src/invoke/invoke.service.ts`

**Problem**: When file resolution fails, the file is silently dropped (no `eve-storage://`
URL → `stageAttachments` skips it). The agent never knows a file was attached, and the user
gets no feedback about why.

**4a. Add error field to ChatFileSchema:**

```typescript
// In chat-file.ts, add to ChatFileSchema:
/** Set when file resolution failed — reason code */
error: z.string().optional(),
```

**4b. Stage failed files in index.json with error status:**

In `stageAttachments()`, also include files that have an `error` field (but don't download
them). This lets the agent see "there was a file but it couldn't be downloaded":

```typescript
// In agent-runtime invoke.service.ts stageAttachments():
// After processing eve-storage:// files, also record failures:
const failedFiles = files.filter(f => f.error);
for (const file of failedFiles) {
  index.files.push({
    id: file.id,
    name: file.name || file.id || 'attachment',
    path: null,  // No local file — download failed
    mimetype: file.mimetype,
    size: file.size,
    source_url: file.source_url,
    source_provider: file.source_provider,
    error: file.error,
  });
}
```

**4c. Update AttachmentIndexEntrySchema** to include `error` and make `path` optional:

```typescript
// path becomes optional (null for failed files)
path: z.string().nullable(),
/** Error code if file could not be downloaded */
error: z.string().optional(),
```

Agents can then check `index.json` and report: "The file X couldn't be downloaded — please
re-upload it or paste the content directly."

### Fix 5: Delete test integration from staging

**Operational action** — not a code change.

The `T08TEST` integration on `org_manualtestorg` has a fake token and is actively
interfering with real Slack integrations. Delete it:

```bash
eve profile use staging
# Delete via API (or direct DB if no CLI command exists):
# DELETE FROM integrations WHERE id = 'intg_REDACTED_test';
```

If simulated chat testing needs a test integration, it should use a distinct `provider`
value (e.g., `slack-test`) or a `status` that keeps it out of the active integrations list.

---

## Files to Change

| Fix | File | Change |
|-----|------|--------|
| 1 | `apps/gateway/src/webhook/webhook.controller.ts` | Resolve account-specific provider after parsing |
| 2 | `apps/gateway/src/providers/provider-registry.ts` | Bidirectional sync (add/remove) |
| 3 | `apps/gateway/src/providers/slack/slack.provider.ts` | `redirect: 'manual'`, content-type check, success logging |
| 4a | `packages/shared/src/schemas/chat-file.ts` | Add `error` field to `ChatFileSchema` + `AttachmentIndexEntrySchema` |
| 4b | `apps/agent-runtime/src/invoke/invoke.service.ts` | Stage failed files in index.json |
| 5 | *(operational)* | Delete `T08TEST` integration from staging DB |

## Implementation Order

```
Fix 5 (delete test integration)  — immediate unblock, zero risk
  ↓
Fix 1 (account-specific provider) — fixes the actual bug
  ↓
Fix 4a (ChatFile error field)     — schema change, needed by Fix 3 and Fix 4b
  ↓
Fix 3 (redirect + content-type)   — defense in depth, uses error field
  ↓
Fix 4b (stage failed files)       — agents can report failures
  ↓
Fix 2 (bidirectional sync)        — prevents future stale-instance issues
```

Fixes 1 and 5 are independently deployable and together fully resolve the immediate issue.
Fixes 3, 4a, 4b can ship together as the hardening pass. Fix 2 is standalone.

## Testing

1. **After Fix 1**: Share a file in Slack → verify agent receives actual content, not HTML
2. **After Fix 3**: Test with a deliberately invalid token → verify `file.auth_redirect` is
   logged and file gets `error: 'auth_failed'` instead of being silently corrupted
3. **After Fix 4**: Verify `index.json` includes failed files with `error` field, and
   successful files with `path` pointing to the actual file
4. **After Fix 2**: Delete an integration via API → verify sync removes it from registry
   within 30 seconds (check gateway logs for `gateway.integration.removed`)
