# Agentic App Plan C: PaaS Infrastructure & Provisioning

> Status: In Progress (Phases 3-4 implemented)
> Last Updated: 2026-02-11
>
> Inputs:
> - `docs/ideas/agentic-app-platform-primitives-roadmap.md`
> - `docs/ideas/native-agentic-app-primitives-roadmap.md`
> - `docs/ideas/platform-primitives-for-agentic-apps.md` (Primitives 3, 8)
> - `docs/plans/eve-native-container-registry-plan.md` (existing)
> - `docs/plans/managed-postgres-dbaas-plan.md` (existing)
>
> Parallel Streams:
> - **Plan A**: `docs/plans/agentic-app-identity-auth-access-plan.md`
> - **Plan B**: `docs/plans/agentic-app-context-intelligence-plan.md`

## Brief

This plan covers the infrastructure primitives that make deploying agentic apps
frictionless: zero-config container registry, managed databases, agent-triggered
project creation, and web-native chat transport.

Everything here touches the worker/deployer, k8s manifests, infra repo, and
gateway — a completely different code surface from Plan A (auth layer) and
Plan B (API controllers/data tables). Runs fully in parallel.

## Why This Stream Exists

Today, deploying an Eve app requires manually provisioning a container registry,
setting up database credentials, running a multi-step project creation ceremony,
and building a custom backend for web chat. These primitives eliminate that
friction.

---

## Phase 1: Native Container Registry

### Status

**Already planned** — see `docs/plans/eve-native-container-registry-plan.md`.

### Summary

Eve runs an instance of Distribution (the reference OCI registry used by Docker
Hub, GHCR, GitLab) as a platform service. Image layers stored in S3. Eve handles
all auth via short-lived scoped JWTs.

**Manifest experience:**

```yaml
registry: eve
# That's it. No host, namespace, or auth needed.
```

### What Changes for Agentic Apps

Nothing specific to this combined roadmap — the registry plan is self-contained.
It eliminates the biggest onboarding friction for any new app, agentic or
otherwise.

### Cross-Reference

Full implementation details: `docs/plans/eve-native-container-registry-plan.md`.

---

## Phase 2: Managed Postgres DBaaS

### Status

**Already planned** — see `docs/plans/managed-postgres-dbaas-plan.md`.

### Summary

Eve provisions and manages Postgres per environment. Third mode alongside
"run your own" and "bring external URL."

**Manifest experience:**

```yaml
services:
  db:
    x-eve:
      role: managed_db
      managed:
        class: db.p1
        engine: postgres
        engine_version: "16"
  api:
    environment:
      DATABASE_URL: ${managed.db.url}
```

### What Changes for Agentic Apps

Agentic apps with backends (PM app, support portal, dashboard) get zero-friction
database provisioning. Combined with the native registry (Phase 1), a new app
goes from "manually provision registry + DB + credentials" to two manifest
declarations.

### Cross-Reference

Full implementation details: `docs/plans/managed-postgres-dbaas-plan.md`.

---

## Phase 3: Project Bootstrap API

### Problem

Creating an Eve project requires a multi-step ceremony: create GitHub repo,
`eve init`, `eve projects create`, `eve projects link`, configure secrets,
environments, agents. An agent should say "create a new project" and have it
exist.

### What We Build

Single API endpoint that wraps the existing multi-step ceremony.

**API:**

```
POST /orgs/:id/projects/bootstrap
{
  "name": "payment-service",
  "description": "Payment processing microservice",
  "template": "eve-starter",
  "git": {
    "provider": "github",
    "org": "myorg",
    "visibility": "private"
  },
  "packs": ["software-factory"],
  "environments": ["staging"],
  "created_by": "pm-user-id"
}
```

**Response:**

```json
{
  "project_id": "proj_xxx",
  "repo_url": "https://github.com/myorg/payment-service",
  "status": "created",
  "next_steps": [
    "Clone the repo and start developing",
    "Run 'eve deploy staging' when ready"
  ]
}
```

**CLI:**

```bash
eve projects bootstrap --name payment-service \
  --template eve-starter \
  --git-org myorg \
  --packs software-factory \
  --environments staging
```

### Steps Performed by the Endpoint

1. Create GitHub repo from template (using org-level GH credentials).
2. Initialize manifest in the repo (`eve init` equivalent).
3. Register Eve project (`projects create`).
4. Link repo to project (`projects link`).
5. Install specified AgentPacks into manifest.
6. Create specified environment records.
7. Push initial commit.
8. Return project ID + repo URL.

### Implementation Notes

- Synchronous for v1 — the full ceremony takes seconds, not minutes.
  If latency becomes a problem, switch to async with a bootstrap job ID.
- Uses org-level GitHub credentials (already needed for builds).
- Template system: start with a hardcoded set (`eve-starter`,
  `eve-api-starter`, `eve-worker-starter`). Template registry is a future
  concern.
- Permission gate: requires `project:manage` (already exists).
- Idempotent on name: if a project with the same name exists, return it
  rather than erroring.
- Risk mitigation: rate limit project creation (10 per org per hour) to
  prevent repo sprawl from runaway agents.

### Exit Criteria

- `eve projects bootstrap` creates a fully functional Eve project with one
  command.
- Repo is created on GitHub with manifest, linked to Eve, and ready to deploy.
- AgentPacks installed if specified.
- Works with both user tokens and service principal tokens (from Plan A).

---

## Phase 4: WebChat Gateway Provider

### Problem

The gateway supports Slack and Nostr but no browser-native transport. Simple
admin consoles, embeddable widgets, and internal tools need web chat without
building a full backend.

### What We Build

A new `webchat` provider registered in the gateway alongside Slack and Nostr.

**Architecture:**

```
┌─────────────────────┐         ┌──────────────────────────────────────┐
│   Any Web App        │         │   Eve Gateway                        │
│                      │         │                                      │
│   React UI ──────WebSocket────►│  WebChatProvider                     │
│                      │         │    ├─ authenticate (JWT in handshake)│
│                      │         │    ├─ parse → NormalizedInbound      │
│                      │         │    └─ sendMessage → WebSocket push   │
│                      │         │         │                            │
│                      │         │    GatewayChatService (shared)       │
│                      │         │    ├─ resolve org + identity         │
│                      │         │    ├─ route to agent                 │
│                      │         │    └─ create job → response          │
│                      │         │                                      │
└─────────────────────┘         └──────────────────────────────────────┘
```

**Provider implementation:**

```typescript
class WebChatGatewayProvider implements GatewayProvider {
  name = 'webchat';
  transport = 'subscription';       // WebSocket, like Nostr
  capabilities = ['inbound', 'outbound', 'identity'];
}
```

**Thread key format:** `webchat:<org_id>:<user_id>:<thread_id>`

**WebSocket endpoint:** `wss://gateway.eve/providers/webchat/ws`

**Inbound message:**

```json
{
  "type": "message",
  "agent_slug": "pm-concierge",
  "text": "What's the status of the auth migration?",
  "thread_id": "thr_xxx"
}
```

**Registration:**

```typescript
// app.module.ts
registry.registerFactory('webchat', {
  create: () => new WebChatGatewayProvider(),
});
```

### Implementation Notes

- Auth: JWT token in WebSocket handshake query param or first message.
  Maps to Eve user identity.
- Follows the Nostr provider pattern (subscription transport, bidirectional).
- ~300 lines of provider code — all routing, threading, and agent dispatch
  is shared `GatewayChatService` infrastructure.
- Connection management: heartbeat ping/pong, auto-reconnect guidance in
  client SDK.
- Rate limiting: per-user message rate (60/min default).

### When to Use WebChat vs Backend-Proxied Chat

| Scenario | Approach |
|---|---|
| Simple chat widget, admin console | WebChat provider (this) |
| App with its own data model, context enrichment | Backend-proxied (Mechanism B — already works with service accounts) |

Backend-proxied chat (app backend calls Eve internal chat API) works today
with service accounts from Plan A. The WebChat provider is for zero-backend
simple chat UIs.

### Exit Criteria

- WebSocket endpoint accepts connections with JWT auth.
- Messages route through GatewayChatService to agents.
- Agent responses push back to the WebSocket.
- Thread continuity works across reconnections.

---

## Cross-Stream Dependencies

| This Plan Consumes | From Plan A |
|---|---|
| Service principal tokens | Project bootstrap auth for machine-initiated creation |
| Short-lived JWTs | WebChat gateway auth (can use user JWTs independently) |

| This Plan Consumes | From Plan B |
|---|---|
| Job attachments | Bootstrap can attach initial project docs (soft dep) |

These are all soft dependencies — the registry and DBaaS phases have zero
dependencies on Plans A or B. Project bootstrap works with user auth until
service principals ship. WebChat uses user JWTs directly.

---

## Code Surface

| Area | Key Files |
|---|---|
| Worker/builder | `apps/worker/src/` |
| Deployer | `apps/deployer/src/` |
| K8s manifests | `k8s/` |
| Gateway providers | `apps/api/src/gateway/providers/` |
| Gateway chat service | `apps/api/src/gateway/chat/` |
| CLI project commands | `packages/cli/src/commands/projects/` |
| Infra repo modules | (external: eve-infra repo) |

---

## Delivery Summary

| Phase | Primitive | Cost | Unlocks |
|---|---|---|---|
| 1 | Native container registry | High | Zero-config image push/pull |
| 2 | Managed Postgres DBaaS | High | Zero-config database provisioning |
| 3 | Project bootstrap API | Medium | One-command project creation |
| 4 | WebChat gateway provider | Medium | Browser-native agent chat |

**Phases 1-2 are already in progress** via their existing plan documents.
Phases 3-4 are new work defined here.

---

## Combined Roadmap Integration

This is one of three parallel implementation plans for the unified agentic app
platform primitives roadmap:

```
Plan A ─── Identity, Auth & Access Control ─── auth middleware, RBAC
Plan B ─── Context Plane & Org Intelligence ─── API controllers, data tables
Plan C ─── PaaS Infrastructure & Provisioning ─── worker/deployer, k8s, gateway
                                                   (this plan)
```

All three plans can execute concurrently. The only cross-plan dependencies are
soft: Plans B and C benefit from Plan A's service principals but can build and
test with user auth until those ship.
