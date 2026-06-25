# Channel Integrations Gap Analysis and Permissioned Routing

> Status: Idea
> Last Updated: 2026-02-01
> Purpose: Identify gaps for channel integrations and propose a permission model that prevents arbitrary or injected behavior.
>
> Inputs:
> - docs/system/events.md
> - docs/system/pipelines.md
> - docs/system/workflows.md
> - docs/system/workflow-invocation.md
> - docs/system/auth.md
> - docs/system/manifest.md
> - docs/ideas/chat-client-integrations.md
> - docs/ideas/chat-gateway-clawdbot.md
> - docs/ideas/clawdbot-personal-assistant-proposal.md
> - reference-app/.eve/manifest.yaml (reference pipeline pattern)

## Summary
We can accept messages from any channel (Slack, WhatsApp, Telegram, Nostr, WebChat),
and even arbitrary prompts, but execution must be routed
through explicit, permissioned workflows or pipelines. Today Eve only accepts Slack
Events API webhooks and normalizes them into events. There is no channel OAuth, bot
token storage, outbound messaging, or identity mapping from channel users to Eve users.
There is also no workflow- or pipeline-level permission model. The gap is not just
channel plumbing; the missing layer is permissioned routing and actor-aware execution.

This doc proposes a minimal permissioned routing layer that:
- Links channel users to Eve users and org/project roles.
- Defines required permissions on workflows/pipelines (manifest-level).
- Routes channel requests only to permitted workflows/pipelines.
- Allows an "arbitrary prompt" mode, but only within a safe, read-only assistant.
- Supports a channel-native auth flow with admin approvals (no SSH keys).

## Goals
- Hook a bot into company chat (Slack first, but portable).
- Allow people to ask for info and request actions within an app/env scope.
- Prevent arbitrary job creation and prompt injection by restricting to defined behavior.
- Apply RBAC and per-workflow permission requirements before execution.
- Keep configuration in the manifest and secrets outside the repo.
- Let admins approve new users + roles via chat without SSH keys.

## Non-goals
- Implicit deploys or unbounded agent permissions.
- Storing provider secrets in repo manifests.
- Building a full consumer-grade chat client UI.

## Current Eve Capabilities (Relevant)
- Slack Events API webhook endpoint: `POST /integrations/slack/events/{projectId}`.
- Signature verification with `SLACK_SIGNING_SECRET`.
- Event spine with `slack.*` event types and trigger matching.
- Pipelines (deterministic job graphs) and workflows (agent jobs) can be triggered by events.
- Org/project RBAC with roles: owner/admin/member.
- Secrets store with project/org/system scopes.

## Gaps (What We Need to Add)

### 1) Channel app setup + outbound messaging
Current:
- Only inbound Slack Events API webhooks.
- No OAuth flow, no bot token storage, no outbound messaging.

Needed:
- Provider OAuth (bot + user scopes) or app token support.
- Secure storage for provider tokens (project or org scope).
- A sender path to post responses back to channels/DMs.
- Workspace/account allowlist validation and provider-specific team/account checks.

### 2) Identity mapping (Channel user -> Eve user)
Current:
- Slack events store actor_id as Slack user or bot id.
- No mapping to Eve user or membership roles.

Needed:
- `external_identities` mapping (provider, account_id, external_user_id -> eve_user_id).
- A "link account" flow (Slack DM + one-time token) or OAuth sign-in.
- Store and surface the resolved Eve user in events.

### 3) Permissioned routing (required permissions per workflow/pipeline)
Current:
- RBAC is enforced on API endpoints, not on event-triggered runs.
- Workflows/pipelines have no permission requirements.

Needed:
- Manifest schema for permission requirements on workflows/pipelines.
- Router that checks Slack actor permissions before invoking a workflow/pipeline.
- Clear default: if no permissions defined, deny for Slack-triggered execution.

### 4) Command routing and safe "arbitrary prompt" mode
Current:
- Trigger matching is event-type + channel only (slack.message, etc).
- No command parsing, no chat session context.

Needed:
- Deterministic command routing (regex or slash commands) to pipelines/workflows.
- Optional "arbitrary prompt" assistant, but limited to safe capabilities.

### 5) Channel-native auth + admin approvals (no SSH keys)
Current:
- Auth requires SSH-based login or admin-minted tokens.
- No concept of chat-first identity proof or admin approvals via chat.

Needed:
- A channel auth mode where external identities can request access.
- Admin notifications in channel + approve/deny flow with role selection.
- Token issuance bound to external identity (no SSH keys).

### 6) Observability + audit
Current:
- Events stored; job logs available.
- No Slack message storage or session timeline.

Needed:
- Optional chat session/message tables for traceability.
- Audit trail that records: Slack user, resolved Eve user, chosen workflow, decision reason.

## Proposed Model: Permissioned Channel Routing

### A) Integration Layer
Two deployment modes (aligned with existing ideas):
- **Hosted Gateway**: A new `eve-gateway` service manages Slack OAuth, tokens, and
  outbound messages. It talks only to the Eve API.
- **VPS Local Gateway**: Gateway runs beside Eve and stores tokens locally.

Inbound events remain provider-specific (Slack Events API today), but outbound replies
go through the gateway which holds provider tokens.

### B) Identity Linking
Add a minimal identity map:

```
external_identities:
  id
  provider: "slack" | "telegram" | "whatsapp" | "nostr" | ...
  account_id
  external_user_id
  eve_user_id
  created_at
```

Linking flows:
1) Channel DM: "link" -> gateway issues one-time code -> user runs `eve auth link` or
   clicks a link to bind Slack user to Eve user.
2) Slack OAuth Sign-in: map Slack user to Eve user directly if allowed.

Events should include:
- `actor_type: user`
- `actor_id: user_...` (Eve user id, not Slack id)
- `payload_json` keeps raw Slack data

### C) Channel-Native Auth + Admin Approvals (No SSH Keys)
Goal: allow a Slack/Telegram/WhatsApp/Nostr identity to become the primary auth layer.
No SSH keys. Access is granted by org admins in-chat.

Proposed flow:
1) A new channel user sends "join" or triggers any command.
2) Gateway creates a `membership_request` tied to the external identity.
3) Admins in the org receive a notification message with approve/deny actions.
4) Admin approves with a role (member/admin/owner) and optional project scope.
5) Eve creates the user + membership, binds the external identity, and issues a token.
6) Gateway stores the token for future requests.

Key rules:
- Default deny until approved.
- Approval message must include the external identity + channel metadata.
- Tokens are scoped to the org/project role, rotated periodically.

Minimal data model:
```
membership_requests:
  id
  org_id
  external_identity_id
  requested_role
  status: pending|approved|denied
  approved_by
  approved_at
```

Optional: allow org admins to set an auto-approve policy for specific channels or domains.

### D) Permission Requirements in Manifest
Add explicit permissions to workflows and pipelines:

```yaml
workflows:
  app-status:
    permissions:
      org_roles: [member, admin, owner]
      project_roles: [member, admin, owner]
      envs: [staging, production]
    hints:
      permission_policy: never   # read-only agent

pipelines:
  deploy-staging:
    permissions:
      project_roles: [admin, owner]
      envs: [staging]
```

Permission checks:
- Resolve Slack user -> Eve user.
- Resolve user role in org/project.
- Validate any env constraints.
- Deny if missing or insufficient.

### E) Routing Strategy (No Arbitrary Jobs)
Routing should be deterministic and explicit:

1) **Commands first**:
   - `/deploy staging` -> pipeline `deploy-staging`
   - `/status` -> workflow `app-status`
2) **Arbitrary prompt** (optional):
   - Route only to a safe workflow with read-only policy.
   - Example: `assistant-readonly` workflow that can read logs, status, docs.
   - No git commit/push, no deploy, no secret writes.

This keeps "any prompt" available while preventing unbounded action.

### F) Safeguards Against Prompt Injection
- Default deny for any workflow/pipeline without explicit permissions.
- Require explicit commands for high-risk actions (deploy, secrets, DB).
- Use pipeline approvals for production actions.
- Enforce safe job hints:
  - `permission_policy: never`
  - `git.commit: never`, `git.push: never`
  - `workspace.mode: isolated`
- Record the routing decision in the event/audit log for review.

### G) Data Model Additions (Minimal)
Optional chat data:
- `chat_sessions` (conversation continuity)
- `chat_messages` (inbound/outbound logs)

Required for permissions:
- `external_identities` mapping (channel -> Eve user)
- `integrations` table for provider tokens (account + bot/app tokens)
- `membership_requests` for channel-native approvals

### H) API Surface (Sketch)
- `POST /integrations/{provider}/connect` (OAuth start)
- `POST /integrations/{provider}/callback` (OAuth finish)
- `POST /integrations/{provider}/commands/{projectId}` (slash commands, optional)
- `POST /integrations/slack/events/{projectId}` (already exists; expand per provider)
- `POST /projects/{id}/chat/route` (internal: route message -> workflow/pipeline)
- `POST /orgs/{id}/membership-requests` (create request)
- `POST /orgs/{id}/membership-requests/{requestId}/approve` (approve + role)
- `POST /orgs/{id}/membership-requests/{requestId}/deny`

### I) Manifest Extensions (Chat + Permissions)
Prefer a top-level `chat` block (as in chat-client-integrations):

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

If we do not want a full `chat` block yet, add `permissions` directly under
`workflows.*` and `pipelines.*` and keep routing in the gateway config.

## MVP Full Conversational Platform (Primitives Built-In)
If we decide to ship a conversational MVP (not just command routing), the minimal
primitives should be first-class and explicit:

1) **ChatAssistant** (manifest-defined) -> workflow/pipeline + env + tools policy
2) **ChatSession** -> session key policy + summary + last message metadata
3) **ChatMessage** -> inbound/outbound message log with delivery status
4) **ChatCommand** -> deterministic match to pipeline/workflow
5) **ChatBinding** -> channel/peer -> assistant mapping

Constraints for MVP safety:
- Default assistant is read-only unless explicitly allowed.
- Commands required for any mutation (deploy, secrets, DB).
- Session memory is summaries only; no unbounded full history.

## Gap Analysis Matrix (Short)

| Capability | Current | Gap |
| --- | --- | --- |
| Slack inbound verification | Implemented | None |
| Non-Slack inbound verification | Missing | Add provider webhooks/connectors |
| Provider OAuth + bot tokens | Missing | Add integration + secrets storage |
| Outbound replies | Missing | Add sender/gateway |
| Channel user -> Eve user | Missing | Add external identity mapping |
| Permissioned routing | Missing | Add per-workflow/pipeline permissions |
| Command parsing | Missing | Add deterministic command router |
| Arbitrary prompt support | Missing | Add safe assistant workflow |
| Channel-native auth + approvals | Missing | Add membership requests + admin approvals |
| Audit trail | Partial | Add routing/audit metadata |

## Phased Rollout

### Phase 0 - Deterministic Commands (Minimum Viable)
- Add Slack OAuth + bot token storage (first provider).
- Add slash command endpoint or app_mention parser.
- Add per-workflow/pipeline permissions.
- Route commands to pipelines/workflows with RBAC checks.
- Add outbound response posting.

### Phase 1 - Safe Assistant (Arbitrary Prompt, Read-only)
- Add a read-only workflow with strict hints.
- Route unmatched prompts to the safe assistant.
- Log all routing decisions.

### Phase 2 - Conversational MVP
- Add ChatAssistant/Session/Message/Command primitives.
- Add bindings (channel/peer -> assistant) with defaults.
- Add message delivery + read receipts (optional).

### Phase 3 - Sessions + Context
- Add chat sessions/messages.
- Add summarization and limited memory.
- Add richer binding (channel -> assistant/env).

## Open Questions
- Should permissions be role-based only, or include granular capabilities?
- Where does routing live: gateway or Eve API?
- Do we allow any event-triggered workflow without explicit permissions?
- Should identity mapping be required for all events, or only for commands?
- Do we treat Nostr as a first-class provider or a gateway plugin that emits `chat.*` events?
