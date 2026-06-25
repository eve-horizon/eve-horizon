# Chat Client Integrations (Event Spine)

> Status: Idea
> Last Updated: 2026-01-27
> Inputs:
> - docs/system/events.md
> - docs/system/pipelines.md
> - docs/system/workflows.md
> - docs/system/workflow-invocation.md
> - docs/system/manifest.md
> - docs/plans/event-driven-pipelines-platform-plan.md
> - docs/plans/manifest-v2-compose-plan.md
> - docs/ideas/chat-gateway-clawdbot.md
> - docs/ideas/clawdbot-personal-assistant-proposal.md

## Summary
Add chat clients as first-class event sources without creating a parallel automation system.
Messages become normalized events, triggers route to workflows or pipelines, and jobs remain the
execution unit. Configuration stays simple by splitting behavior (manifest) from secrets and
channel credentials (gateway or hosted integration).

Two deployment modes are supported:
1) Single VPS: admin runs a local gateway with direct channel credentials, including WhatsApp.
2) Cloud: hosted gateway with self-serve integrations for Slack and Telegram, plus as many other
   providers as possible (WhatsApp preferred when feasible).

## Goals
- Make chat configuration easy: minimal files, clear ownership, good defaults.
- Reuse existing primitives: events, triggers, workflows, pipelines, jobs.
- Support Slack and Telegram everywhere; WhatsApp on VPS and preferred in cloud.
- Allow both DM and channel/group routing with explicit session policies.
- Keep the API as the system of record; gateway remains a thin client.

## Non-goals
- Building native mobile apps or full client UIs in v1.
- Replacing the event spine with a separate chat router.
- Long-term backward compatibility (pre-MVP freedom to refactor).

## Current primitives to reuse
- Event spine: normalized events, stored in DB, routed by the orchestrator.
- Triggers: manifest-defined filters that create pipeline runs or workflow jobs.
- Pipelines: deterministic job graphs for actions or scripts.
- Workflows: agent-driven jobs with optional request/response.
- Jobs: universal execution unit with logs, gates, and review.

## Design principles (configuration first)
1) Two-layer config: manifest defines behavior, gateway/integration defines secrets.
2) Defaults everywhere: connect a channel, auto-bind to a default assistant.
3) Same contract in both deployment modes: integrations, bindings, sessions.
4) Provider-specific config lives behind a schema with validation and clear errors.
5) Chat is just another event source; no special-case orchestration.

## Proposed primitives (minimal additions)

### ChatAssistant (manifest)
Defines behavior for a conversation. It references a workflow or pipeline, a target env,
tools policy, and a session policy.

### ChatIntegration (gateway or hosted)
Provider account + credentials + webhook settings. Stored in a local config file (VPS)
or in the Eve DB (cloud).

### ChatBinding
Maps a channel or peer to a ChatAssistant. A binding can be explicit or derived from a
default assistant.

### ChatSession
Conversation continuity record, keyed by channel + peer + assistant policy. Holds
summary and last message metadata.

Sessions may optionally pin a **session-scoped workspace** so each turn can reuse
the same working directory. This enables continuity (stateful tools, incremental
edits) without requiring commits or pushes on every turn.

### ChatMessage
Inbound/outbound message record linked to a session and job attempt, with delivery status.

### ChatCommand (manifest)
Deterministic mapping from a message match to a pipeline or workflow invocation.

## Gateway integration plugins (all channels)
Each chat provider is implemented as a gateway plugin with a small, stable interface.
Plugins ship a manifest (name, config schema, capabilities, OAuth metadata, webhook paths)
so setup can be validated and rendered consistently.

Plugin responsibilities:
- connect(): perform OAuth or token capture, store credentials.
- watch(): start webhook listener or polling/IDLE loop.
- normalize(): map provider payloads to chat.* or email.* events.
- send(): deliver outbound replies with threading metadata.
- health(): expose connectivity and auth status.

Default policy: only allow built-in plugins unless explicitly enabled.

### Plugin manifest schema (proposal)
The plugin manifest is used by the gateway and Integrations Console to render forms,
validate config, and drive OAuth + webhook setup.

```yaml
name: slack
version: 1
capabilities: [chat]
auth:
  mode: oauth
  oauth:
    authorize_url: https://slack.com/oauth/v2/authorize
    token_url: https://slack.com/api/oauth.v2.access
    scopes: ["chat:write", "channels:history", "app_mentions:read"]
webhooks:
  paths:
    events: /integrations/slack/events/{project_id}
config_schema:
  type: object
  required: ["bot_token", "app_token"]
  properties:
    bot_token: { type: string }
    app_token: { type: string }
defaults:
  bindings:
    mode: default_assistant
```

## Integrations Console (setup UX)
We should ship a small web app to make OAuth and webhook setup effortless.

### Hosting and URL model
- Cloud: hosted console at https://console.eve.example.com/integrations
- VPS: gateway serves the console locally (http://localhost:4777/integrations)
- CLI: eve chat connect <provider> prints or opens a one-time setup URL

### Console responsibilities
- Render provider tiles from plugin manifests.
- Run OAuth flows and store tokens in the Eve DB (cloud) or local gateway store (VPS).
- Generate provider-specific webhook URLs and surface copy buttons.
- Bind channels/peers to assistants with a quick default binding flow.

## Credential storage and default bindings
We need predictable storage and simple defaults so setup is low-friction.

### Credential storage
- Cloud: tokens stored in Eve DB (encrypted, scoped to project + integration account).
- VPS: tokens stored in gateway config store (file or sqlite), not in the repo.
- Never write secrets to .eve/manifest.yaml or project source.

### Default binding policy
- If chat.default_assistant exists, auto-bind new integrations to it.
- If no default assistant, require an explicit binding before processing messages.
- Allow per-channel overrides without removing the default.

## Event spine integration

### Event types
- chat.message.received
- chat.command.received
- chat.session.reset
- chat.message.delivered (optional observability)

### Email event types (aliased to chat)
- email.message.received -> chat.message.received
- email.message.delivered -> chat.message.delivered
- email.thread.reset -> chat.session.reset

### Flow (message -> response)
1) Gateway receives message and normalizes payload.
2) Gateway emits chat.message.received event via API.
3) Router matches triggers or assistant defaults, creates a workflow job.
4) Job runs, writes response to chat_messages and optional json-result.
5) Gateway delivers outbound message to the channel.

### Flow (command -> pipeline)
1) Gateway detects command match and emits chat.command.received event.
2) Trigger creates pipeline run or workflow job.
3) Pipeline outputs are summarized and sent back as a chat response.

## Manifest configuration (behavior)
Prefer a top-level chat block in manifest v2. For compatibility, allow x-eve.chat
as an alias until the v2 schema is final.

```yaml
chat:
  default_assistant: main

  assistants:
    main:
      workflow: assistant
      env: dev
      tools:
        allow: ["repo", "deploy", "logs"]
      workspace:
        mode: session
      git:
        branch: "session/${session_id}"
        create_branch: "if_missing"
        commit: manual
        push: never
      session:
        scope: per_peer
        reset:
          mode: idle
          idle_minutes: 120
      context:
        mode: summary_plus_last_n
        last_n: 12

  commands:
    deploy_staging:
      match: "^/deploy staging$"
      pipeline: deploy-staging
```

Notes:
- assistants map to workflows by default; allow pipeline for deterministic flows.
- commands map to pipelines or workflows with explicit match rules.
- default_assistant makes it easy to connect a new channel with no extra config.
- session workspaces should default to `push: never` and `commit: manual` unless an explicit
  command requests commit/push.

## Gateway or hosted integration config (secrets)
The integration layer stores provider credentials and bindings. It never carries
workflow logic.

### VPS gateway config example
```yaml
gateway:
  api_url: ${EVE_API_URL}
  auth:
    token: ${secret.EVE_TOKEN}

projects:
  - id: proj_123
    default_assistant: main

integrations:
  slack:
    accounts:
      main:
        bot_token: ${secret.SLACK_BOT_TOKEN}
        app_token: ${secret.SLACK_APP_TOKEN}

  telegram:
    accounts:
      main:
        token: ${secret.TELEGRAM_BOT_TOKEN}

  whatsapp_web:
    accounts:
      phone_1:
        session_dir: /var/lib/eve/whatsapp/phone_1
        qr_mode: terminal

  email:
    accounts:
      ops:
        mode: imap
        imap:
          host: imap.example.com
          port: 993
          tls: true
          username: ops@example.com
          password: ${secret.IMAP_PASSWORD}
        smtp:
          host: smtp.example.com
          port: 587
          tls: true
          username: ops@example.com
          password: ${secret.SMTP_PASSWORD}

bindings:
  - integration: slack/main
    channel: C1234567890
    assistant: main
  - integration: telegram/main
    peer: dm:123456789
    assistant: main
  - integration: email/ops
    thread: any
    assistant: main
```

### Cloud integration flow (self-serve)
- Integrations Console (web app) handles OAuth, webhook URLs, and bindings.
- eve chat connect slack --project proj_123 -> opens the console or prints a URL.
- eve chat connect telegram --project proj_123 -> bot token stored in DB.
- eve chat bind --project proj_123 --integration slack/main --channel C123 --assistant main.
- If no binding is created, default_assistant handles all messages.

### Setup UX (web app)
OAuth and webhook setup are much easier with a small web app:
- Cloud: hosted Integrations Console with provider tiles and guided setup.
- VPS: gateway serves the same UI locally (e.g., http://localhost:4777).
- CLI: "eve chat connect" opens a browser or prints a one-time setup URL.

## WhatsApp support
Two viable paths, both should be supported, with clear tradeoffs:

1) WhatsApp Web (VPS only)
- Uses a local session that requires QR scan.
- Best for single-host deployments.
- Session data stored on disk; no multi-tenant scaling.

2) WhatsApp Cloud API (preferred for cloud)
- Uses Meta Business verified phone number and webhook.
- Fits hosted gateway; scalable, but more setup friction.
- Provide a wizard and a strict config schema to reduce errors.

## Email support (Gmail + IMAP)
Email behaves like a chat channel with thread-based sessions.
Use email.message.* events, then alias to chat.* for routing.

### Session key
- Gmail: email:gmail:{account}:{thread_id}
- IMAP: email:imap:{account}:{message_id_root}

### Gmail setup (cloud)
- OAuth-based connector with Gmail API.
- Prefer Pub/Sub watch; fallback to polling for missed events.

Gmail account config (hosted):
```yaml
integrations:
  email:
    accounts:
      gmail_main:
        mode: gmail
        oauth:
          client_id: ${secret.GMAIL_CLIENT_ID}
          client_secret: ${secret.GMAIL_CLIENT_SECRET}
          refresh_token: ${secret.GMAIL_REFRESH_TOKEN}
        watch:
          mode: pubsub
          topic: projects/myproj/topics/eve-gmail
```

### IMAP/SMTP setup (VPS or cloud)
- IMAP IDLE for inbound, SMTP for outbound.
- Fallback to polling if IDLE drops.

IMAP account config (VPS):
```yaml
integrations:
  email:
    accounts:
      support:
        mode: imap
        imap:
          host: imap.example.com
          port: 993
          tls: true
          username: support@example.com
          password: ${secret.IMAP_PASSWORD}
        smtp:
          host: smtp.example.com
          port: 587
          tls: true
          username: support@example.com
          password: ${secret.SMTP_PASSWORD}
```

### Email safety defaults
- Ignore auto-generated mail (Auto-Submitted, List-Id, Precedence: bulk).
- Enforce reply threading with In-Reply-To and References.
- Strip or summarize large attachments before injection to jobs.

### Email adapter implementation notes
Email uses the same gateway plugin interface as other channels.
Suggested libraries:
- imapflow + mailparser for IMAP inbound.
- nodemailer for SMTP outbound.
- Gmail API client for OAuth and watch setup.

## Provider coverage (target matrix)

| Provider | Setup Type | VPS | Cloud | Notes |
| --- | --- | --- | --- | --- |
| Slack | OAuth bot + events | Yes | Yes | Mandatory |
| Telegram | Bot token + webhook | Yes | Yes | Mandatory |
| WhatsApp Web | QR session | Yes | No | VPS only |
| WhatsApp Cloud API | OAuth token + webhook | Optional | Preferred | Business verification required |
| Email (Gmail) | OAuth + API | Optional | Yes | Preferred for cloud |
| Email (IMAP/SMTP) | Credentials | Yes | Yes | Best for VPS |
| Discord | Bot token + gateway/webhook | Yes | Yes | Low friction |
| Matrix | Access token | Yes | Yes | Good for self-hosted |
| MS Teams | Bot + webhook | Optional | Optional | Higher setup friction |
| Google Chat | Webhook or bot | Optional | Optional | Enterprise setup |
| WebChat | Hosted widget | Yes | Yes | Good default channel |
| SMS (Twilio) | Account + webhook | Optional | Optional | Cost based |

## API and CLI surface (proposal)
- API:
  - POST /projects/:id/chat/integrations
  - GET /projects/:id/chat/integrations
  - POST /projects/:id/chat/bindings
  - GET /projects/:id/chat/sessions
  - GET /projects/:id/chat/messages
- CLI:
  - eve chat connect <provider>
  - eve chat bind <provider> --channel/--peer --assistant
  - eve chat sessions --project <id>
  - eve chat messages --session <id>
  - eve event list --source chat

## Observability
- All inbound and outbound messages map to events and chat_messages rows.
- Job logs remain the canonical execution trace.
- Pipeline runs are visible with standard eve pipeline commands.

## Phased rollout
1) Schema + events: chat events, chat session/message tables, basic gateway.
2) Providers: Slack + Telegram + WebChat, default assistant routing.
3) Commands + pipelines: deterministic command handling, richer outputs.
4) WhatsApp: Web for VPS, Cloud API for hosted.
5) Extensions: more providers and per-channel policies.

## Open questions
- Should chat sessions be stored only in the Eve DB or optionally in the gateway?
- How much message history is injected vs summarized for each job?
- Do we need a formal response schema for chat workflows?
- What is the minimum UX for cloud onboarding to avoid manual YAML edits?
- Do we want an Eve-managed session remote to support push-on-demand for chat workflows?
