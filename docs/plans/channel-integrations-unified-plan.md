# Channel Integrations Unified Plan (Chat + Messaging + Email)

> Status: Plan
> Last Updated: 2026-02-01
> Purpose: Ship a unified, permissioned channel integration layer for Eve Horizon, covering chat, messaging, and email, with a first-class admin UI (OAuth + QR flows).

## Core Principle
Treat chat, messaging, and email as the same event flow:

```
message -> event -> routed job -> response
```

Differences are limited to **credentials**, **delivery semantics**, and **session keying**.
This keeps Eve's existing event spine and job model as the only execution path.

## Architecture Summary

- **One gateway service** (`eve-gateway`) with provider plugins.
- **Eve API remains the system of record**.
- **No parallel router**: inbound messages normalize into `chat.*` events and use existing routing.

```
Provider -> Eve Gateway -> POST /events -> Eve API -> Orchestrator -> Worker -> Response -> Gateway -> Provider
```

## Goals

- Ship Slack-first, then expand to Telegram, WebChat, and email.
- Enforce permissioned routing for all channel-triggered workflows/pipelines.
- Provide a clean admin UI for OAuth, QR flows, bindings, and approvals.
- Keep secrets out of manifests and repos.

## Non-goals

- A parallel automation system outside the event spine.
- Unbounded agent execution from arbitrary prompts.
- Storing provider tokens in repo manifests.

## Data Model (Minimal, Composable)

Required tables:

- `chat_integrations` (provider config, encrypted tokens)
- `chat_assistants` (manifest-synced behavior)
- `chat_bindings` (channel/peer -> assistant, priority)
- `chat_sessions` (conversation continuity)
- `chat_messages` (inbound/outbound log linked to jobs)
- `chat_commands` (deterministic routing)
- `external_identities` (provider user -> Eve user)
- `membership_requests` (channel-native approvals)

## Manifest Additions (Behavior Only)

```yaml
chat:
  default_assistant: assistant-readonly
  assistants:
    assistant-readonly:
      workflow: app-status
      env: staging
      permissions:
        project_roles: [member, admin, owner]
      hints:
        permission_policy: never
        git:
          commit: never
          push: never
  commands:
    deploy_staging:
      match: "^/deploy staging$"
      pipeline: deploy-staging
```

Behavior lives in the manifest. Secrets and provider credentials live in integration storage.

## Permissioned Routing (Mandatory)

- Default deny if no permissions are defined.
- Resolve external identity -> Eve user -> org/project roles.
- Enforce env constraints and approvals for risky actions.
- Allow arbitrary prompts only through read-only assistants.

## Admin UI Requirements

Integrations console inside the system dashboard SPA:

- Provider tiles (Slack/Telegram/Email/WhatsApp/WebChat) with status/health.
- OAuth connect flow with callback success screen.
- QR connect flow with live refresh for QR codes.
- Binding editor: channel/peer -> assistant or pipeline.
- Audit log panel for integrations + routing decisions.
- Optional approval queue for gated responses.

## API Surface (Proposed)

Integrations:
- `POST /projects/{id}/chat/integrations`
- `GET /projects/{id}/chat/integrations`
- `PATCH /projects/{id}/chat/integrations/{cint_id}`
- `POST /projects/{id}/chat/integrations/{cint_id}/test`

Bindings:
- `POST /projects/{id}/chat/bindings`
- `GET /projects/{id}/chat/bindings`
- `DELETE /projects/{id}/chat/bindings/{cbnd_id}`

Sessions/messages:
- `GET /projects/{id}/chat/sessions`
- `GET /projects/{id}/chat/messages`
- `DELETE /projects/{id}/chat/sessions/{csess_id}`

OAuth/QR:
- `GET /integrations/{provider}/oauth/start`
- `GET /integrations/{provider}/oauth/callback`
- `GET /integrations/{cint_id}/qr/stream`

## Safety Guardrails

- Default deny for unconfigured workflows/pipelines.
- Explicit commands required for destructive actions.
- Read-only assistant for arbitrary prompts.
- Rate limits per integration and per channel.
- Email loop prevention via `Message-ID` and `In-Reply-To` dedupe.
- Audit trail for every routing decision.

## Phased Rollout

### Phase 0: Foundation (API + DB)
- Add tables and manifest sync for `chat` block.
- Add `chat.*` event types.
- Enforce permission checks on event-triggered runs.

### Phase 1: Gateway MVP + WebChat
- Implement `eve-gateway` with plugin host.
- WebChat plugin for fast end-to-end validation.

### Phase 2: Slack OAuth + Outbound
- Slack OAuth, inbound verification, outbound replies.
- External identity mapping for Slack users.

### Phase 3: Admin Console + OAuth/QR UX
- Integration setup UI (OAuth + QR).
- Binding editor + audit log.
- Approval queue for gated responses.

### Phase 4: Email (IMAP + Gmail OAuth)
- IMAP and Gmail plugins.
- Threaded replies and auto-generated email filtering.

### Phase 5: Sessions + Context
- Session policies (per peer, per channel, global).
- Summaries + bounded context windows.
- Session reset policies (idle/daily/manual).

## Open Questions

- Which provider is the MVP anchor (Slack vs WebChat)?
- Should identity linking be mandatory for all commands or only privileged ones?
- Where should approvals live in the UI (chat console vs job review queue)?

