# Chat Simulate: Route Through the Gateway

> Status: **Implementation Plan (in-progress)**
> Last Updated: 2026-02-27
> Purpose: Refactor `eve chat simulate` to exercise the full gateway code path, fixing the verification gap that makes Slack integration features untestable without a live workspace.
> Current gap status: registry scaffolding exists, but startup bootstrap, active-integrations API, simulate endpoint, CLI redirection, ingress/deploy wiring, and scenario updates are still pending.

## Problem Statement

`eve chat simulate` bypasses the gateway entirely. The CLI hits the API's `/projects/:id/chat/simulate` endpoint, which calls `ChatService.routeMessage()` directly. This skips all gateway logic:

- **Identity resolution** (Tier 1 email auto-match, Tier 2 link command, Tier 3 membership gating)
- **Outbound formatting** (Block Kit, markdown→mrkdwn conversion)
- **Structured error logging** (all `slack.outbound.*` and `slack.inbound.*` events)
- **Deduplication** (event_id cache)
- **Interactive replies** (immediate reply → outbound `chat.postMessage`)

In manual testing (scenario 08), this means **10 of 20 steps fail** — not because the code is broken, but because simulate never exercises it.

### Current Architecture (Two Separate Paths)

```
Path A — CLI Simulate (what we test):
  CLI → POST /projects/:id/chat/simulate → ChatService.routeMessage() → jobs

Path B — Real Slack Webhook (what we ship):
  Slack → POST /gateway/providers/slack/webhook
       → SlackGatewayProvider.validate+parse
       → isDuplicate()
       → GatewayChatService.resolveAndRoute()
         → POST /internal/integrations/resolve
         → lookupSlackEmail() [Tier 1]
         → POST /internal/external-identities/resolve
         → isLinkCommand() [Tier 2]
         → identity interception [Tier 3]
         → POST /internal/orgs/:org_id/chat/route
       → provider.sendMessage() [outbound reply]
```

Path A tests job creation. Path B tests everything else. We only test Path A.

### Additional Issue: Gateway Provider Registry Not Initialized on Startup

The gateway registers provider **factories** at boot (`app.module.ts`) but does not call `initializeAll()` at startup. Direct webhook calls to `/gateway/providers/slack/webhook` return `404: Unknown webhook provider: slack` because the provider instance cache is empty. This blocks both real Slack webhooks and any simulate-through-gateway approach.

### Current Repo State

- `apps/gateway/src/providers/provider-registry.ts` already exposes `initializeAll()` and `initializeOne()`.
- `apps/gateway/src/main.ts` does **not** call bootstrap initialization on startup.
- `apps/api/src/integrations/integrations.internal.controller.ts` has no active-integration endpoint for gateway bootstrap.
- `apps/gateway/src/webhook/webhook.controller.ts` uses module-level dedupe state (`isDuplicate`) and currently 404s unknown providers.
- `packages/cli/src/commands/chat.ts` still calls `/projects/:id/chat/simulate`.

---

## Design Goals

1. **`eve chat simulate` exercises the gateway code path** — identity resolution, link commands, membership interception, formatting, deduplication, error logging
2. **No real Slack workspace needed** — simulate mode should avoid live Slack webhook verification and outbound Slack posting; `external_email` should support identity tests without `users.info`.
3. **Minimal new code** — reuse existing gateway infrastructure; don't build a parallel test framework
4. **Provider registry works at startup** — gateway loads active integrations from API on boot
5. **Outbound replies captured** — simulate returns what would have been sent to Slack, not just job IDs
6. **Backward compatible** — existing `eve chat simulate` behavior preserved for simple testing

---

## Design

### Architectural Principle

The gateway already has a clean internal API: `GatewayChatService.resolveAndRoute(inbound: NormalizedInbound) → RouteResult`. This is provider-agnostic — it doesn't know about Slack signatures, webhook format, or HTTP transport. The simulate path should call this method directly, constructing a `NormalizedInbound` from the simulate request body.

This avoids the need to:
- Fake Slack webhook payloads with HMAC signatures
- Build a separate Slack provider test harness
- Route through HTTP to the gateway (cross-service call complexity)

### Where to Put the Simulate Endpoint

**Option A: On the gateway (chosen)**. Add `POST /gateway/simulate` to the webhook controller. The gateway already has `GatewayChatService` and all routing logic. The simulate endpoint constructs a `NormalizedInbound` directly and calls `resolveAndRoute()`.

**Option B: On the API, forwarding to gateway**. The API would proxy simulate requests to the gateway via HTTP. Rejected: adds cross-service complexity, requires the gateway to be reachable from the API, and complicates the response flow.

**Option C: On the API, importing gateway logic**. Extract `GatewayChatService` into a shared package. Rejected: violates the separation between API (provider-agnostic) and gateway (provider-specific).

### CRITICAL: Gateway Ingress Routing

The gateway is NOT on a separate host. Both the API and gateway are exposed through `api.eve.lvh.me` via path-based ingress routing:

```yaml
# k8s/base/gateway-ingress.yaml
rules:
  - host: api.eve.lvh.me
    http:
      paths:
        - path: /integrations/slack    → eve-gateway:4820
        - path: /gateway/providers     → eve-gateway:4820
        # MUST ADD:
        - path: /gateway/simulate      → eve-gateway:4820
```

The CLI calls `POST $EVE_API_URL/gateway/simulate` — same host as the API. **No `EVE_GATEWAY_URL` env var needed.**

### The Simulate Flow

```
CLI → POST $EVE_API_URL/gateway/simulate
    → WebhookController.handleSimulate()
      → Check EVE_SIMULATE_ENABLED gate
      → Check deduplication (if dedupe_key provided)
      → Construct NormalizedInbound from request body
      → chatService.resolveAndRoute(inbound)
      → Return { immediate_reply, duplicate, route }
```

The gateway returns both the route result (thread_id, job_ids, etc.) AND the immediate reply content (what would have been sent to Slack). This lets the test scenario verify identity interception messages, link command responses, Block Kit formatting, etc.

### Handling the Slack Email Lookup (Tier 1)

In the real flow, the gateway calls `lookupSlackEmail()` which hits the Slack API (`users.info`). In simulate mode, the caller passes the email directly via the `external_email` field in the request body.

The current code (`gateway-chat.service.ts:84`) does:

```typescript
if (inbound.provider === 'slack') {
  externalEmail = await this.lookupSlackEmail(inbound.externalUserId, integration.integration_id);
}
```

**Fix**: Check `inbound.externalEmail` first. If present, use it directly. Otherwise fall back to `lookupSlackEmail()`. Real webhook path never sets `externalEmail`. Simulate path sets it from the request body.

### Auth Model

The simulate endpoint does NOT forward user bearer tokens. The gateway's internal API calls already use `x-eve-internal-token` (`EVE_INTERNAL_API_KEY`) for service-to-service auth (see `api-client.ts`). Protection comes from:

1. **`EVE_SIMULATE_ENABLED=true`** env var gate — disabled in production
2. **Ingress routing** — the endpoint is only reachable in environments where the gateway is deployed
3. **Existing integration required** — simulate needs a real integration record (created via `eve integrations slack connect`), so it cannot target arbitrary orgs

---

## Implementation Plan

### Phase 1: Gateway Provider Bootstrap + Internal API

Fix the root cause: the gateway never loads provider instances from the database.

**File**: `apps/api/src/integrations/integrations.internal.controller.ts`

Add a new endpoint for the gateway to fetch active integrations:

```typescript
@Get('integrations/active')
async listActive(): Promise<Array<{
  id: string; org_id: string; provider: string;
  account_id: string; tokens_json: Record<string, unknown> | null;
  settings_json: Record<string, unknown>; status: string;
}>> {
  return this.integrationsService.listActiveIntegrations();
}
```

Returns all integrations with `status = 'active'`. The gateway calls this once at startup.
Keep internal-token protection (`x-eve-internal-token`) on this route, consistent with other internal integration endpoints.
If this endpoint is added, include `Get` in the controller imports.

**File**: `apps/api/src/integrations/integrations.service.ts`

Add `listActiveIntegrations()` — a simple query returning all active integration rows with their tokens and settings. Note: this method does NOT exist yet; `listByOrg()` is org-scoped.

**File**: `apps/gateway/src/main.ts`

After `app.init()`, fetch active integrations from the API and initialize the provider registry:

```typescript
// After app.init()
const registry = app.get(GatewayProviderRegistry);
try {
  const integrations = await getJson<Array<{
    id: string; org_id: string; provider: string;
    account_id: string; tokens_json: Record<string, unknown> | null;
    settings_json: Record<string, unknown>; status: string;
  }>>('/internal/integrations/active');
  await registry.initializeAll(integrations);
  logger.log(`Initialized ${integrations.length} provider instance(s)`);
} catch (err) {
  logger.warn(`Failed to load integrations at startup: ${err}`);
  // Non-fatal: gateway starts but webhooks will 404 until integrations are loaded
}
```

**File**: `apps/gateway/src/providers/provider-registry.ts`

Verify `initializeOne()` passes `settings_json` to the provider config and merges `EVE_SLACK_SIGNING_SECRET` from env for Slack instances:

```typescript
const config: ProviderConfig = {
  integration,
  settings: (() => {
    const settings = { ...(integration.settings_json ?? {}) };
    if (integration.provider === 'slack' && process.env.EVE_SLACK_SIGNING_SECRET) {
      settings.signing_secret = process.env.EVE_SLACK_SIGNING_SECRET;
    }
    return settings;
  })(),
};
```

**Result**: Real Slack webhooks work. Provider instances are loaded. Scenario 08 Phase 5 (dedup) and Phase 6 (route existence) tests pass against real webhook endpoints.

### Phase 2: Gateway Simulate Endpoint + Response Enrichment

Add the simulate endpoint and enrich `RouteResult` in a single pass — both are gateway-side changes to the same files.

**File**: `apps/gateway/src/providers/gateway-provider.interface.ts`

Add `externalEmail` to `NormalizedInbound` and add simulate types:

```typescript
// Add to NormalizedInbound interface
externalEmail?: string;  // Tier 1: email hint (skips Slack users.info API call)

// New types
export interface SimulateRequest {
  provider?: string;        // default: 'slack'
  account_id: string;       // team_id equivalent
  channel_id?: string;
  user_id?: string;
  text: string;
  external_email?: string;  // Tier 1: email hint (skips Slack API)
  event_type?: string;      // default: 'app_mention'
  thread_id?: string;
  dedupe_key?: string;
}

export interface SimulateResponse {
  immediate_reply: MessageContent | null;
  duplicate: boolean;
  route: {
    thread_id: string;
    route_id: string | null;
    target: string | null;
    job_ids: string[];
    event_id: string | null;
    denied?: boolean;
    denial_reason?: string;
  } | null;
}
```

**File**: `apps/gateway/src/chat/gateway-chat.service.ts`

Two changes:

1. **Use `inbound.externalEmail` when present** (skip `lookupSlackEmail`):

```typescript
// Tier 1: Look up Slack user's email for auto-match
let externalEmail: string | undefined;
if (inbound.externalEmail) {
  externalEmail = inbound.externalEmail;  // Simulate mode: provided directly
} else if (inbound.provider === 'slack') {
  externalEmail = await this.lookupSlackEmail(
    inbound.externalUserId, integration.integration_id,
  );
}
```

2. **Enrich `RouteResult`** — extend the interface and return route metadata from `routeToAgent()`:

```typescript
export interface RouteResult {
  immediateReply?: MessageContent;
  duplicate?: boolean;
  routeResponse?: {
    thread_id: string;
    route_id: string | null;
    target: string | null;
    job_ids: string[];
    event_id: string | null;
    denied?: boolean;
    denial_reason?: string;
  };
}
```

In `routeToAgent()`, the `routeResponse` variable already exists (line 182). Return it:

```typescript
return {
  immediateReply: { text: fmt.text, blocks: fmt.blocks },
  routeResponse: routeResponse,
};
```

**File**: `apps/gateway/src/webhook/webhook.controller.ts`

Add the simulate endpoint. Key detail: the dedup check must happen here (the webhook controller owns dedup, not `resolveAndRoute`):

```typescript
@Post('simulate')
@HttpCode(HttpStatus.OK)
async handleSimulate(
  @Req() req: { body: unknown },
): Promise<SimulateResponse> {
  if ((process.env.EVE_SIMULATE_ENABLED ?? '').toLowerCase() !== 'true') {
    throw new NotFoundException('Simulate endpoint disabled');
  }

  const body = req.body as SimulateRequest;
  const dedupeKey = body.dedupe_key;
  const now = Date.now();

  // Dedup check (same cache as real webhooks)
  if (dedupeKey && isDuplicate(dedupeKey)) {
    return { immediate_reply: null, duplicate: true, route: null };
  }

  const inbound: NormalizedInbound = {
    rawType: body.event_type ?? 'app_mention',
    provider: body.provider ?? 'slack',
    accountId: body.account_id,
    externalUserId: body.user_id ?? '',
    channel: body.channel_id ?? `sim-${now}`,
    threadId: body.thread_id ?? `sim-${now}.000001`,
    text: body.text,
    externalEmail: body.external_email,
    dedupeKey,
    raw: body,
  };

  const result = await this.chatService.resolveAndRoute(inbound);

  return {
    immediate_reply: result.immediateReply ?? null,
    duplicate: result.duplicate ?? false,
    route: result.routeResponse ?? null,
  };
}
```

Note: `isDuplicate()` is currently a module-level helper in `webhook.controller.ts` (lines 23-49). Simulate should reuse the same function as real webhook handling for consistent dedupe behavior.

**File**: `k8s/base/gateway-ingress.yaml`

Add the simulate path to the ingress rules:

```yaml
- path: /gateway/simulate
  pathType: Prefix
  backend:
    service:
      name: eve-gateway
      port:
        number: 4820
```

**File**: `k8s/base/gateway-deployment.yaml`

Add `EVE_SIMULATE_ENABLED` env var (default `"true"` for local dev):

```yaml
env:
  - name: EVE_SIMULATE_ENABLED
    value: "true"
```

**Result**: `POST $EVE_API_URL/gateway/simulate` exercises the full identity resolution, link command handling, membership interception, agent routing, and deduplication flow. Response includes both the immediate reply AND the route metadata.

### Phase 3: CLI Changes

Redirect `eve chat simulate` to call the gateway simulate endpoint.

**File**: `packages/cli/src/commands/chat.ts`

The key change: instead of `POST $EVE_API_URL/projects/:id/chat/simulate`, call `POST $EVE_API_URL/gateway/simulate`. Same host, different path — no URL derivation needed.

**New request mapping**:

```typescript
// Old: POST $API_URL/projects/$PROJECT_ID/chat/simulate
// New: POST $API_URL/gateway/simulate
const body = {
  provider: flags.provider ?? 'slack',
  account_id: flags.teamId,
  channel_id: flags.channelId,
  user_id: flags.userId,
  text: flags.text,
  external_email: metadata?.external_email ?? flags.externalEmail,
  event_type: 'app_mention',
  thread_id: flags.threadKey,
  dedupe_key: flags.dedupeKey,
};
```

**Response mapping** — normalize gateway response to existing `ChatRouteResponse` shape:

```typescript
return {
  thread_id: response.route?.thread_id ?? null,
  route_id: response.route?.route_id ?? null,
  target: response.route?.target ?? null,
  job_ids: response.route?.job_ids ?? [],
  event_id: response.route?.event_id ?? null,
  immediate_reply: response.immediate_reply,
  duplicate: response.duplicate,
};
```

**Flag changes**:
- Keep `--project` (deprecated, fallback-only — triggers old API path with deprecation warning)
- Keep `--team-id` (maps to `account_id`)
- Keep `--channel-id`, `--user-id`, `--text`
- Add `--external-email` (replaces `--metadata` usage for `external_email`)
- Add `--dedupe-key` (for dedup testing)
- Keep `--metadata` for general-purpose passthrough

**Backward compatibility**: If `--project` is provided, use the old API simulate path with a deprecation warning. This preserves project-scoped testing for simple cases.

### Phase 4: Update Manual Test Scenario

Update `tests/manual/scenarios/08-chat-gateway-slack.md` to use the new simulate flow.

**Key changes**:

1. **Setup**: Remove `GATEWAY_URL` derivation (simulate goes through `EVE_API_URL` now)
2. **Phase 0**: `eve chat simulate` drops `--project`, uses `--team-id` to route through gateway
3. **Phase 2**: Steps 5-7 exercise real gateway logging (no longer bypassed)
4. **Phase 3a**: Steps 8-11 use `--external-email` flag instead of `--metadata`
5. **Phase 3b**: Steps 12-15 exercise real link command interception via gateway
6. **Phase 3c**: Steps 16-19 exercise real membership request creation and interception
7. **Phase 4**: Steps 21-22 assert on `immediate_reply` structure in response
8. **Phase 5**: Dedup tested via `--dedupe-key` flag on simulate (no raw webhook needed)
9. **Phase 6**: Direct HTTP checks unchanged (still use `$GATEWAY_URL` for raw webhook endpoints)

**New assertion patterns**:

```bash
# Assert on immediate reply text
RESULT=$(eve chat simulate --team-id T08TEST --text "hello" --json)
REPLY=$(echo "$RESULT" | jq -r '.immediate_reply.text // empty')
echo "$REPLY" | grep -q "expected text" && echo "PASS" || echo "FAIL"

# Assert on route metadata
JOB_ID=$(echo "$RESULT" | jq -r '.route.job_ids[0] // empty')
test -n "$JOB_ID" && echo "PASS: job created" || echo "FAIL: no job"

# Assert on deduplication
RESULT2=$(eve chat simulate --team-id T08TEST --text "hello" --dedupe-key same-key --json)
DUPE=$(echo "$RESULT2" | jq -r '.duplicate')
test "$DUPE" = "true" && echo "PASS: dedup works" || echo "FAIL: not deduped"
```

---

## Dependency Graph

```
Phase 1: Gateway provider bootstrap + GET /internal/integrations/active
  ↓
Phase 2: Gateway simulate endpoint + NormalizedInbound.externalEmail + RouteResult enrichment + K8s config
  ↓
Phase 3: CLI changes (redirect to gateway)
  ↓
Phase 4: Update scenario 08
  ↓
Phase 5: Verification loop (build → deploy → test → fix → repeat)
```

Phases 1-2 are gateway + API. Phase 3 is CLI. Phase 4 is docs/tests. Phase 5 is integration validation.

---

## Phase 5: Verification Loop

After all code changes land, iterate against the local k3d stack until scenario 08 passes end-to-end.

### Process

```
┌─────────────────────────────────────┐
│  1. Build all packages              │
│     pnpm build                      │
├─────────────────────────────────────┤
│  2. Deploy to k3d                   │
│     ./bin/eh k8s deploy             │
├─────────────────────────────────────┤
│  3. Verify stack health             │
│     eve system health --json        │
├─────────────────────────────────────┤
│  4. Run scenario 08 phases          │
│     Phase 0 (baseline) first        │
│     Then phases 2-6 incrementally   │
├─────────────────────────────────────┤
│  5. Any failures?                   │
│     YES → fix code → goto step 1   │
│     NO  → done                      │
└─────────────────────────────────────┘
```

### Verification Checkpoints

**After Phase 1 (bootstrap) lands:**
```bash
./bin/eh k8s deploy
eve system health --json

# Verify provider registry loads at startup
kubectl -n eve logs deployment/eve-gateway --tail=30 | grep -i "initialized.*provider"

# Verify webhook no longer returns 404 for registered providers
curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$EVE_API_URL/gateway/providers/slack/webhook" \
  -H "Content-Type: application/json" \
  -d '{"type": "url_verification", "challenge": "test"}'
# Expected: 200 (url_verification) or 401 (signature validation), NOT 404
```

**After Phase 2 (simulate endpoint) lands:**
```bash
./bin/eh k8s deploy

# Verify simulate endpoint is reachable
curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$EVE_API_URL/gateway/simulate" \
  -H "Content-Type: application/json" \
  -d '{"account_id": "T08TEST", "text": "hello"}'
# Expected: 200 (with error about integration not found) or 200 with route result
# NOT 404 (means ingress not routing)

# Run scenario 08 Phase 0 (baseline)
# Should now route through gateway and return immediate_reply + route metadata
```

**After Phase 3 (CLI) lands:**
```bash
pnpm build   # rebuild CLI

# Verify CLI routes through gateway
eve chat simulate --team-id T08TEST --text "hello" --json
# Expected: response includes immediate_reply and route fields

# Verify deprecated --project flag still works
eve chat simulate --project $PROJECT_ID --team-id T08TEST --text "hello" --json
# Expected: works with deprecation warning
```

**After Phase 4 (scenario update) lands:**
```bash
# Run full scenario 08 end-to-end
# Phase 0: baseline routing
# Phase 2: observability (gateway logs)
# Phase 3a: identity auto-match via --external-email
# Phase 3b: link token via simulate
# Phase 3c: membership approval flow
# Phase 3d: admin channel notification (log verification)
# Phase 4: rich formatting (immediate_reply structure)
# Phase 5: dedup via --dedupe-key
# Phase 6: legacy cleanup (HTTP status checks)
```

### Failure Diagnosis

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `404` on `/gateway/simulate` | Ingress missing path rule | Add `/gateway/simulate` to `gateway-ingress.yaml` |
| `404` on simulate ("Simulate endpoint disabled") | `EVE_SIMULATE_ENABLED` not set | Add env var to `gateway-deployment.yaml` |
| `500` on simulate ("EVE_API_URL required") | Gateway can't reach API | Check `EVE_API_URL` in gateway deployment |
| Integration not found | No active integration for `account_id` | Run `eve integrations slack connect` first |
| `immediate_reply` is null when expected | `resolveAndRoute` early-returned | Check gateway logs for the specific error path |
| `route` is null but reply exists | Identity intercepted (Tier 3) | Expected for unresolved identities |
| Dedup not working | dedupe helper not called or key missing | Ensure simulate uses the shared `isDuplicate()` check before routing |

---

## Edge Cases and Design Decisions

### Q: What about the existing API simulate endpoint?

Keep it. It's still useful for project-scoped testing that doesn't need identity resolution (e.g., testing chat route matching, thread creation). The gateway simulate endpoint is the new default for integration testing. The CLI's `--project` flag triggers the old path.

### Q: How does simulate handle the "org" context?

The gateway resolves org from `account_id` via `POST /internal/integrations/resolve`. This means simulate requires a real integration record in the DB (created via `eve integrations slack connect`). This is intentional — it tests the same path as production.

### Q: Should simulate capture outbound messages?

Yes. The simulate endpoint captures `immediateReply` from `resolveAndRoute()` and returns it in the response body. In the real webhook flow, this reply would be sent to Slack via `provider.sendMessage()`. In simulate mode, it's returned to the caller instead.

### Q: What about deduplication testing?

The simulate endpoint reuses the webhook controller's `isDuplicate()` cache. Two calls with the same `dedupe_key` will return `{ "duplicate": true }` on the second call. This lets scenario 08 Phase 5 test dedup without needing raw webhook calls or HMAC signatures.

### Q: What about outbound rate limiting?

Rate limiting applies to `sendSlackMessage()` which is never called in simulate mode. Rate limiting is tested via unit tests, not manual scenarios.

### Q: What about the `routeMessageToAgent` vs `routeMessage` difference?

The gateway path calls `routeMessageToAgent()` (org-scoped, agent slug-based) via `POST /internal/orgs/:org_id/chat/route`. The old simulate path calls `routeMessage()` (project-scoped, text pattern-based) via `POST /projects/:id/chat/simulate`. These are different routing strategies:

- **Gateway path**: User says `@eve mission-control deploy prod` → gateway resolves `mission-control` agent in the org → routes to that agent's project
- **Old simulate path**: Caller specifies the project explicitly → routes via text pattern matching within that project

The new simulate-through-gateway uses the gateway path (org-scoped), which is the production routing behavior.

### Q: What about simulate auth?

The gateway uses `x-eve-internal-token` (`EVE_INTERNAL_API_KEY`) for all internal API calls (see `apps/gateway/src/api-client.ts`). The simulate endpoint does not need to proxy user bearer tokens. Protection is layered:

1. `EVE_SIMULATE_ENABLED` env var gate — must be explicitly enabled
2. Only reachable where the gateway is deployed (not exposed publicly)
3. Requires a real integration record in the DB to resolve org context

### Q: Why not a separate gateway host?

The gateway ingress already routes through `api.eve.lvh.me` via path-based rules (`/gateway/providers`, `/integrations/slack`). Adding `/gateway/simulate` as another path rule is simpler than creating a separate ingress host. The CLI already knows `EVE_API_URL` — no new URL needed.

---

## Testing Strategy

| Phase | Test Type | Coverage |
|-------|-----------|----------|
| 1 | Integration | Gateway startup loads integrations; webhook returns non-404 |
| 2 | Integration | `POST /gateway/simulate` exercises `resolveAndRoute()`; response includes route metadata and immediate reply |
| 3 | Manual | `eve chat simulate` routes through gateway, returns enriched response |
| 4 | Manual | Full scenario 08 passes (27/27 steps) |
| 5 | Manual | Verification loop against k3d until all green |

Acceptance criteria:

- Scenario 08 passes all phases end-to-end against k3d
- `immediate_reply` contains the gateway-generated reply text (identity messages, routing confirmations, etc.)
- `route.job_ids` is populated after successful agent routing
- `duplicate=true` returned on repeated `dedupe_key` requests
- Gateway logs show structured events for all code paths

---

## Files Changed

| File | Change |
|------|--------|
| `apps/api/src/integrations/integrations.internal.controller.ts` | Add `GET /internal/integrations/active` |
| `apps/api/src/integrations/integrations.service.ts` | Add `listActiveIntegrations()` method |
| `apps/gateway/src/main.ts` | Bootstrap provider registry from API |
| `apps/gateway/src/providers/provider-registry.ts` | Verify `initializeOne()` passes `settings_json` correctly |
| `apps/gateway/src/providers/gateway-provider.interface.ts` | Add `externalEmail` to `NormalizedInbound`, add `SimulateRequest`/`SimulateResponse` types |
| `apps/gateway/src/chat/gateway-chat.service.ts` | Use `inbound.externalEmail`, enrich `RouteResult` with `routeResponse` |
| `apps/gateway/src/webhook/webhook.controller.ts` | Add `POST /gateway/simulate` endpoint with dedup check |
| `packages/cli/src/commands/chat.ts` | Redirect simulate to gateway, add `--external-email` and `--dedupe-key` flags, deprecate `--project` |
| `k8s/base/gateway-ingress.yaml` | Add `/gateway/simulate` path rule |
| `k8s/base/gateway-deployment.yaml` | Add `EVE_SIMULATE_ENABLED: "true"` env var |
| `tests/manual/scenarios/08-chat-gateway-slack.md` | Rewrite to use gateway simulate, add reply/route/dedup assertions |
| `docs/system/chat-gateway.md` | Document simulate endpoint |
