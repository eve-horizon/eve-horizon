# Gateway Architecture

> **What**: Chat ingress/egress bridging external channels to Eve jobs and threads.
> **Why**: Channel-specific protocol handling stays out of the API; providers are pluggable.

## Overview

The gateway receives inbound messages (webhooks or subscriptions), resolves the org integration,
routes messages through the API's chat routing (agents, teams, workflows, pipelines), and delivers
outbound replies back to the channel.

## Components

- `src/chat/gateway-chat.service.ts` — inbound routing, `@agent` command parsing, reply formatting.
- `src/providers/` — provider plugins, instantiated per active DB integration (30s hot-reload):
  - `slack/` — webhooks, signature verify, mrkdwn formatting, interactive/slash endpoints
  - `webchat/` — embedded chat SDK backend (`@eve-horizon/chat`)
  - `nostr/` — relay subscriptions
  - `api/` — programmatic ingress (`eve chat simulate`)
- `src/webhook/webhook.controller.ts` — `POST /gateway/providers/:provider/webhook`, `/simulate`,
  Slack interactive/slash routes.
- `src/delivery/delivery.controller.ts` — `POST /internal/deliver` (outbound from API).

## Key Decisions (Why)

- **Provider registry pattern** — all plugins compiled in; instances only spin up for integrations
  present in the DB, so orgs opt in per channel.
- **Gateway is stateless** — threads/conversations are owned by the API.

## Navigation

- Chat gateway: [docs/system/chat-gateway.md](../../docs/system/chat-gateway.md)
- Integrations: [docs/system/integrations.md](../../docs/system/integrations.md)
