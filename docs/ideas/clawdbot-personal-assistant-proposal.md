# Clawdbot-Inspired Personal Assistant Mode for Eve

> Status: Idea
> Last Updated: 2026-01-26

## Summary
Clawdbot demonstrates a clean pattern for personal AI assistants: a local gateway owns chat
channels, routes messages to isolated agents, and loads plugins with strict config
validation. Eve can adopt the same shape while keeping the API as the single system of
record (jobs, pipelines, workflows). This proposal defines a minimal, elegant configuration
model and a new “assistant mode” that plugs into existing Eve primitives.

## Goals
- Support personal deployments with real chat interfaces (Telegram, Slack, WebChat, etc).
- Keep configuration obvious and readable for humans.
- Reuse Eve primitives (projects, repos, envs, pipelines, workflows, jobs, triggers).
- Make extensions optional and safe (allowlist + schema validation).
- Keep the API as the single gateway and source of truth.

## Non-goals
- Replace Eve API with a separate gateway service of record.
- Build full mobile apps in the first iteration.
- Preserve backward compatibility with current platform shape.

## Clawdbot concepts worth importing
- Gateway as a local control plane with deterministic routing.
- Skills with precedence tiers and gating (os, bins, env, config).
- Plugins/extensions with manifests and schema-driven config validation.
- Session model for DM continuity and group isolation.
- Onboarding wizard as the primary UX.
- WebChat UI tied to sessions with deterministic reply routing.
- Channel abstraction with allowlists, DM policies, and per-channel settings.

## Mapping to Eve primitives

| Clawdbot concept | Eve mapping | Notes |
| --- | --- | --- |
| Gateway (control plane) | API + new WS/SSE “control plane” endpoints | API remains single gateway; WS/SSE for UI and chat streaming |
| Agent | Assistant profile bound to workflow + env | Assistant = project-scoped chat persona |
| Session | Job/attempt conversation context | Session key: `job:<id>:attempt:<n>` |
| Channel | Trigger source + channel connector | Channel events become triggers |
| Skills | Skillpacks with precedence + gating | Add gating metadata and install hints |
| Plugins | Extensions for channels, tools, providers | Manifest + schema validation, allowlist |
| Commands | Workflow or pipeline triggers | Slash commands map to pipeline runs |

## Proposed configuration model

Two layers keep ownership clear: project config (repo) and gateway config (user).

### A) Project config (`.eve/manifest.yaml`)
Defines assistants, commands, and session policy for a project.

```yaml
chat:
  assistants:
    main:
      workflow: assistant
      env: dev
      tools:
        allow: ["repo", "deploy", "logs"]
      session:
        dm_scope: main
        reset:
          mode: daily
          at_hour: 4

  commands:
    deploy_staging:
      match: "/deploy staging"
      pipeline: deploy-staging
```

### B) User gateway config (`~/.eve/gateway.yaml`)
Defines channel credentials, bindings, and extension installs.

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

Optional: support `$include` for clean file splitting and environment overrides.

## Session and routing model
- Each assistant owns a session policy (main, per-peer, per-channel-peer).
- Sessions are keyed to job attempts to preserve continuity across messages.
- DM policies and allowlists are enforced at the gateway edge.
- Replies route deterministically back to the originating channel.

## Plugins/extensions
- Extension packages ship a manifest with JSON Schema for config.
- Extensions may register:
  - Channels (Slack, Telegram, WebChat)
  - Tools (agent tools with allow/deny)
  - Provider auth flows (OAuth or API keys)
  - Hooks (event handlers) and commands
  - Skills directories (workflow or tool packs)
- Load order mirrors Clawdbot: user installs, repo-local, bundled core (disabled by default).

## Skills model
- Add gating metadata to skillpacks: `requires.os`, `requires.bins`, `requires.env`,
  `requires.secrets`.
- Apply precedence tiers: bundled < org < project < workspace.
- Add install hints for missing dependencies; keep runtime safe by default.

## Control plane and UI
- Add WS/SSE endpoints to stream job/chat events and session lists.
- Build a “Job Console” UI for chat, logs, and run status.
- Use config schemas to render forms and validate edits.

## Fit with pipelines, workflows, jobs, triggers
- Channel message -> gateway -> event -> trigger -> workflow -> job -> worker -> agent.
- Command -> gateway -> pipeline run -> job output -> gateway -> channel.
- Bindings map channel/account/peer to assistant (workflow + env).
- Session references job attempts for continuity and auditability.

## Phased rollout
1. Gateway MVP: WebChat + one external channel + workflow-per-message.
2. Extensions + schema validation: install/enable channels and tools.
3. Sessions + commands: persistent chat sessions and command-triggered pipelines.
4. Hooks + providers: auth plugins, multi-agent routing, richer channel policies.

## Open questions
- Session store location: gateway-local vs Eve DB.
- Transcript storage: job logs, session store, or both.
- Secrets ownership: gateway-local only vs optional Eve secrets.
- Which channels require local-only deployment (iMessage, WhatsApp Web).

