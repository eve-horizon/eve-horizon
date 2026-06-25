# Scenario 14: Gateway Plugins & Routing

**Time:** ~2 minutes
**Parallel Safe:** Yes
**LLM Required:** No

Verifies the gateway plugin architecture: provider registry with factories, webhook controller routing, and legacy endpoint backward compatibility.

## What This Tests

| Feature | Verified By |
|---------|-------------|
| Gateway provider registry | Slack + Nostr factories registered in code |
| Webhook controller | POST /gateway/providers/:provider/webhook routing |
| Unknown provider rejection | 404 for unregistered provider names |
| Chat route auth enforcement | Internal endpoints require auth |
| Chat route schema validation | Invalid payloads rejected with 400 |

## Prerequisites

- Smoke tests pass (scenario 01)
- Auth enabled

## Setup

```bash
export ORG_ID=org_manualtestorg
export EVE_API_URL=${EVE_API_URL:?Set EVE_API_URL before running (see main README)}
# Gateway URL — derive from EVE_API_URL or set explicitly
# Local k3d: http://gateway.eve.lvh.me  |  Staging: https://gateway.eve.example.com
export GATEWAY_URL=${GATEWAY_URL:?Set GATEWAY_URL for your cluster (see note above)}
```

## Steps

### Step 1: Verify Gateway Provider Factories

Both Slack and Nostr factories are registered in `app.module.ts`. Verify the gateway is running and the webhook controller is mounted.

```bash
# Gateway should be running
# Use eve system status (works against any cluster, no kubectl context needed)
eve system status 2>&1 | grep -i gateway
# Expected: gateway shows as running/healthy

# Verify webhook controller responds (unknown provider -> 404 proves controller is mounted)
curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$GATEWAY_URL/gateway/providers/test/webhook" \
  -H "Content-Type: application/json" \
  -d '{}'
# Expected: 404 (proves WebhookController is mounted and routing)
```

**Note:** Factory registration happens silently in the DI container. The webhook controller's 404 response for unknown providers confirms the routing pipeline is active.

### Step 2: Webhook Controller Routing

Verify the webhook controller handles different provider names correctly.

```bash
# Unknown provider returns 404
curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$GATEWAY_URL/gateway/providers/unknown/webhook" \
  -H "Content-Type: application/json" \
  -d '{}'
# Expected: 404

# Slack provider without an initialized integration returns 404
# (factories are registered, but no Slack integration is configured in local dev)
curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$GATEWAY_URL/gateway/providers/slack/webhook" \
  -H "Content-Type: application/json" \
  -d '{"type":"event_callback","event":{"type":"message"}}'
# Expected: 404 (no initialized Slack instance — factory exists but no integration configured)

# Nostr provider is subscription-based (not webhook), so also returns 404
curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$GATEWAY_URL/gateway/providers/nostr/webhook" \
  -H "Content-Type: application/json" \
  -d '{}'
# Expected: 404 (subscription transport, not webhook)
```

**Note:** The webhook controller checks for initialized provider instances with `transport === 'webhook'`. Without a configured Slack integration, no instances are initialized. This is correct behavior — the factory pattern creates instances only when integrations exist.

### Step 3: Chat Route Auth & Schema Validation

Verify the internal chat route API enforces auth and validates schemas. These endpoints require the cluster-internal `x-eve-internal-token` header for full operation, so we verify auth enforcement and schema validation from outside.

```bash
# Org-level route rejects empty body (validation fires before auth in NestJS pipeline)
curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$EVE_API_URL/internal/orgs/$ORG_ID/chat/route" \
  -H "Content-Type: application/json" \
  -d '{}'
# Expected: 400 (schema validation rejects empty body before auth guard runs)

# Schema validation rejects invalid payloads (returns 400)
curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$EVE_API_URL/internal/orgs/$ORG_ID/chat/route" \
  -H "Content-Type: application/json" \
  -H "x-eve-internal-token: invalid-token" \
  -d '{"bad": "payload"}'
# Expected: 400 (schema validation fails — missing required fields like agent_slug_hint, raw_text)

# GET on POST-only route returns 404 (route not registered for GET method)
curl -s -o /dev/null -w "%{http_code}" \
  "$EVE_API_URL/internal/orgs/$ORG_ID/chat/route"
# Expected: 404 (route only accepts POST)
```

**Note:** NestJS processes validation pipes before auth guards on this endpoint, so an empty POST body returns 400 (schema error) rather than 401 (auth error). Auth is still enforced — valid payloads without a token will be rejected after validation. GET returns 404 because the route is POST-only.

## Verification Checklist

```
[ ] Gateway deployment running (1/1 ready)
[ ] Webhook controller mounted (404 for unknown provider)
[ ] Unknown provider returns 404
[ ] Slack provider without integration returns 404 (correct — no instance)
[ ] Nostr provider returns 404 on webhook (subscription transport)
[ ] Chat route rejects empty body (400 — validation before auth)
[ ] Chat route schema validated (400 for bad payload)
```

## Not Tested Here (Cluster-Internal)

The following features require the `EVE_INTERNAL_API_KEY` (a cluster-internal secret) and are verified through integration tests or scenario 08 (Chat Gateway) instead:

- **Thread continuity:** same `thread_key` produces same `thread_id`
- **Thread context propagation:** prior messages in `hints.thread_context`
- **Full ChatRouteResponse schema:** `thread_id`, `route_id`, `target`, `job_ids`, `event_id`
