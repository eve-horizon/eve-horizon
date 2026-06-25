# VPS-Only Chat Assistants and Chat Primitives

> Status: Idea
> Last Updated: 2026-01-26
> Superseded by: `docs/plans/chat-gateway-slack-plan.md` and `docs/system/chat-gateway.md`.
> The primitives described here evolved into agents + threads + chat.yaml routes.

## Summary
We are targeting VPS-only deployments. The key to Clawdbot-style assistants on Eve is
not a local gateway, but a hosted gateway plus new chat primitives. Each inbound
message becomes a job, while chat sessions provide multi-turn continuity and a
clean UX. Jobs stay the execution unit; chat sessions are the continuity layer.

## Goals
- Support chat assistants on VPS/cloud only.
- Keep configuration obvious and minimal.
- Reuse Eve primitives (projects, envs, pipelines, workflows, jobs, triggers).
- Add chat primitives that are small, composable, and explicit.

## Non-goals
- Local device integrations (iMessage, device sensors) in v1.
- Replacing the Eve API as the system of record.
- Backwards compatibility with the current platform state.

## VPS-only architecture (core dynamics)
- A hosted gateway service (part of the Eve stack) owns channel connections.
- Gateway talks only to Eve API (same constraint as CLI).
- Each inbound message creates or updates a chat session, then triggers a job.
- Job output is written to the chat session and delivered back to the channel.

## New chat primitives (minimal set)

### ChatAssistant
Manifest-defined assistant that maps to a workflow, env, and tool policy.

### ChatSession
Conversation record with a session key policy (dm scope, per-channel, etc),
last message metadata, and optional summary.

### ChatMessage
Inbound/outbound message record linked to a session and a job attempt.

### ChatCommand
Deterministic command routing (match -> pipeline or workflow).

### ChannelExtension
Plugin system for channels and tools with schema-validated config.

## How it fits with existing primitives

| Concept | Eve mapping |
| --- | --- |
| Gateway | New hosted `eve-gateway` service (thin API client) |
| Assistant | Manifest-defined chat assistant (workflow + env) |
| Session | `chat_sessions` rows linked to jobs |
| Message | `chat_messages` rows linked to job attempts |
| Command | Manifest `chat.commands` to pipelines/workflows |
| Trigger | New `chat.*` events in the existing event spine |
| Tool | Skills/agent tools with allow/deny policies |

## Session policy and state (elegant and explicit)
- Session keys are derived from channel + peer using a declared policy.
- Reset rules are declarative (daily or idle).
- Context policy is explicit (last_n + summary).
- Optional state directory is separate from the repo clone:
  - `state.mode: none | assistant | conversation`

This keeps multi-turn continuity without turning the workspace into the session store.

## Data model sketch

```
chat_assistants: id, project_id, name, workflow, env, tools_policy, session_policy
chat_sessions: id, project_id, assistant_id, session_key, channel, peer_id,
               last_message_at, summary, state_ref
chat_messages: id, session_id, direction, body, attachments_json,
               job_id, job_attempt_id, created_at
```

Sessions and messages live in the Eve DB; jobs remain the execution history.

## Execution flow

Message -> Gateway -> Session -> Job (chat_turn) -> Worker -> Agent -> Response
        -> Session update -> Gateway -> Channel

Command -> Gateway -> Pipeline/Workflow run -> Job output -> Gateway -> Channel

## Trigger integration
Add chat events to the existing trigger spine:
- `chat.message.received`
- `chat.command`
- `chat.session.reset`

Triggers can match on assistant_id, channel, command, or project. This avoids a
separate chat automation system and keeps all automation in one model.

## Configuration proposal

Two layers keep config obvious and ownership clear.

### A) Repo manifest (`.eve/manifest.yaml`)
Defines assistants and commands (no secrets).

```yaml
chat:
  assistants:
    main:
      workflow: assistant
      env: dev
      tools:
        allow: ["repo", "deploy", "logs"]
      session:
        dm_scope: per_peer
        reset:
          mode: idle
          idle_minutes: 120
      state:
        mode: conversation

  commands:
    deploy_staging:
      match: "/deploy staging"
      pipeline: deploy-staging
```

### B) Gateway config (`/etc/eve/gateway.yaml`)
Defines channel credentials, bindings, and extensions.

```yaml
gateway:
  api_url: ${EVE_API_URL}
  auth:
    token: ${secret.EVE_TOKEN}

projects:
  - proj_123   # gateway fetches manifest.chat from API

channels:
  telegram:
    accounts:
      default:
        token: ${secret.TELEGRAM_BOT_TOKEN}
        enabled: true

bindings:
  - channel: telegram
    peer: dm:123456789
    assistant: main

extensions:
  allow: ["telegram", "webchat"]
  entries:
    telegram:
      enabled: true
```

Optional: support `$include` for splitting configs by project or channel.

## Workspace reuse (no special casing)
- Each chat job uses the normal JobWorkspace clone.
- Session state lives outside the repo clone (state mode) to avoid coupling.
- Summary and memory live in chat session rows, not in job logs.

## Phased rollout
1. Hosted gateway MVP: one channel + WebChat, workflow-per-message.
2. Chat sessions + summaries + command routing.
3. Extensions with schema validation + tool allowlists.
4. Trigger-driven automation on chat events.

## Open questions
- Should sessions always live in Eve DB, or allow gateway-local storage?
- How much of chat history should be copied into job context vs summarized?
- Do we need a separate "assistant state" blob, or is summary enough?
