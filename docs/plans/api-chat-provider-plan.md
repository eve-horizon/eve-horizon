# API Chat Provider — Fix Missing Provider for Polling-Based Web Clients

> **Status**: Implemented
> **Created**: 2026-04-10
> **Relates to**: [agent-runtime-and-chat-program-plan.md](./agent-runtime-and-chat-program-plan.md)

## Problem

When a web app sends chat messages via the REST API with `provider: "api"`, agent replies fail with:

```
No active provider instance for api:eden-web
```

**Root cause**: The gateway registers three provider factories — `slack`, `nostr`, `webchat` — but not `api`. When the delivery controller looks up the provider instance for `api:eden-web`, there's no factory to create it, so the instance doesn't exist.

**Impact**: All chat replies from agents to API/polling clients silently fail. The message *is* persisted to `thread_messages` (that happens before the gateway call), but the delivery status is marked `failed`, and any real-time push is lost.

**Who's affected**: Any Eve-compatible app using `provider: "api"` in chat route requests (e.g., Eden's web UI with `team_id: "eden-web"`). These apps poll `thread_messages` for responses, so users *may* still see replies — but the delivery pipeline treats every reply as a failure.

## The Delivery Flow Today

```
Agent produces result
  → API chat.service.ts:deliverChatResult()
    → Stores message in thread_messages (works fine)
    → POST /internal/deliver to gateway with {provider: "api", account_id: "eden-web"}
      → DeliveryController.handleDelivery()
        → registry.getInstance("api", "eden-web") → undefined
        → NotFoundException ← BUG HERE
    → Marks delivery_status = "failed"
```

The message is already stored. The only purpose of the gateway call is to push it to a connected client. For polling-based API clients, there is no connected client to push to.

## Design

### Phase 1: No-Op API Provider (Fixes the Bug)

Create an `ApiGatewayProvider` that implements `GatewayProvider` with a no-op `sendMessage()`. Register it in the gateway factory.

**Why a no-op provider rather than skipping the gateway call?**
- Keeps the delivery pipeline uniform — all providers go through the gateway
- The gateway remains the single authority for delivery decisions
- No special-casing in the API's `deliverChatResult`
- Easy to evolve: if we later add SSE/WebSocket push for API clients, we just fill in the provider

**Implementation:**

```
apps/gateway/src/providers/api/
  api.provider.ts          — GatewayProvider implementation
  index.ts                 — barrel export
```

The provider:
- `name`: `'api'`
- `transport`: `'subscription'` (logically, the client subscribes by polling)
- `capabilities`: `['inbound', 'outbound']`
- `initialize()`: No-op (no connections to establish)
- `shutdown()`: No-op
- `sendMessage()`: No-op — logs the delivery at debug level, returns immediately. The message is already persisted in `thread_messages`. The client polls for it.

Register in `app.module.ts`:
```typescript
registry.registerFactory('api', {
  create: () => new ApiGatewayProvider(),
});
```

**Files changed:**
| File | Change |
|------|--------|
| `apps/gateway/src/providers/api/api.provider.ts` | New — provider implementation |
| `apps/gateway/src/providers/api/index.ts` | New — barrel export |
| `apps/gateway/src/app.module.ts` | Register `api` factory |

### Phase 2: Graceful Degradation for Unknown Providers

Harden `DeliveryController.handleDelivery()` so a missing provider instance is a warning, not a 404.

**Current behavior** (line 43-44 of `delivery.controller.ts`):
```typescript
if (!provider) {
  throw new NotFoundException(`No active provider instance for ${body.provider}:${body.account_id}`);
}
```

**New behavior:**
```typescript
if (!provider) {
  logger.warn({ event: 'delivery.provider_missing', provider: body.provider, accountId: body.account_id });
  return { delivered: false, reason: 'no_provider_instance' };
}
```

This way, future unknown provider types degrade gracefully instead of throwing errors. The API already handles non-2xx responses by marking `delivery_status = 'failed'`, so no change needed there — but we should also handle the `{ delivered: false }` response shape.

**Files changed:**
| File | Change |
|------|--------|
| `apps/gateway/src/delivery/delivery.controller.ts` | Warn instead of throw for missing providers |
| `apps/api/src/chat/chat.service.ts` | Handle `{ delivered: false }` response from gateway (currently only checks `response.ok`) |

### Phase 3: Documentation

Update gateway references to document the four provider types:

| Provider | Transport | Push Model | When to Use |
|----------|-----------|------------|-------------|
| `slack` | webhook | Slack API push | Slack workspace integration |
| `nostr` | subscription | Nostr relay publish | Decentralized/Nostr clients |
| `webchat` | subscription | WebSocket push | Browser apps with real-time WebSocket |
| `api` | subscription (poll) | No push — client polls | REST API clients, mobile apps |

**Files changed:**
| File | Change |
|------|--------|
| `docs/system/chat-gateway.md` | Add `api` provider documentation |
| `../eve-skillpacks/.../gateways.md` | Update agent-facing docs |

## Acceptance Criteria

1. Chat route requests with `provider: "api"` result in `delivery_status = 'delivered'` (not `'failed'`)
2. No WebSocket server or HTTP listener is started for the `api` provider
3. Gateway starts cleanly with `api` integrations present
4. Unknown provider types produce a warning log, not a 404
5. Existing `slack`, `nostr`, and `webchat` providers are unaffected

## Non-Goals

- Real-time push for API clients (SSE/WebSocket). That's the `webchat` provider's job. If an app wants push, it should use `webchat`.
- Migrating Eden from `provider: "api"` to `provider: "webchat"`. That's an app-level decision, not a platform fix.
- Validating `provider` values against registered types at chat-route time. The platform is deliberately open — apps can use any provider string. The gateway just needs to handle all of them gracefully.

## Implementation Order

Phase 1 is the critical bug fix. Phases 2 and 3 are hardening and docs — they should ship in the same PR but aren't blocking.

Estimated scope: ~80 lines of new code, ~10 lines of changes to existing code.
