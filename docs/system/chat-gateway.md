# Chat Gateway (Current)

> Status: Current
> Last Updated: 2026-04-06
> Purpose: Describe the gateway service and provider-based chat event flow.

## Overview

The Gateway service uses a pluggable provider architecture to normalize external chat events into Eve events. Providers implement the `GatewayProvider` interface and register via factories at startup. Two transport models are supported: webhook (HTTP push, e.g., Slack) and subscription (persistent connection, e.g., Nostr relays).

### Slack (Webhook Transport)

Slack was refactored into the provider framework as the first webhook-based provider.

- **Webhook endpoint**: `POST /gateway/providers/slack/webhook`
- **Interactive endpoint**: `POST /gateway/providers/slack/interactive`

1. Slack event arrives at the webhook endpoint
2. Signature validated with signing secret
3. Duplicate check against `event_id` cache (see [Deduplication](#deduplication))
4. Integration resolved (`team_id -> org_id`)
5. Identity interception (see [Identity Interception Flow](#identity-interception-flow))
6. `app_mention` messages parsed as `@eve <agent-slug> <command>`
7. If the first word is not a known slug, Eve routes to the org `default_agent_slug`
8. Agent slug resolves to `{project_id, agent_id}` (unique per org)
9. Job created directly for that agent (thread + event recorded)
10. `message` events (no mention) can be dispatched to channel/thread listeners

### Nostr (Subscription Transport)

The Nostr provider connects to relay(s) via WebSocket and subscribes to events:
- **Kind 4** (NIP-04 encrypted DMs) addressed to the platform pubkey
- **Kind 1** (public mentions) tagging the platform pubkey

Inbound flow:
1. Relay broadcasts event matching subscription filters
2. Provider verifies Schnorr signature
3. Kind 4 events are decrypted (NIP-04)
4. Message normalized to standard inbound format
5. Agent slug extracted from DM prefix (`/slug` or `slug:`) or first word of mention
6. Routed through same chat dispatch as Slack

Outbound replies:
- DMs: Kind 4 encrypted event published to relays
- Public: Kind 1 with NIP-10 reply threading tags

Cross-relay dedup: Event IDs tracked in a bounded set (10k entries).

## Deduplication

Slack may deliver the same event more than once (retries on slow response, network glitches). The gateway tracks `event_id` values in a short-lived in-memory cache:

- On receipt, the `event_id` from the Slack event envelope is checked against the cache.
- If already seen, the gateway returns `200 OK` immediately with no further processing.
- If new, the `event_id` is stored in the cache and normal processing continues.
- Cache entries expire after a short TTL (order of minutes) — long enough to cover Slack's retry window.

## Timeout Handling

Slack retries webhook deliveries if it does not receive a response within **3 seconds**. To avoid duplicate deliveries:

- The webhook handler acknowledges the request (returns `200`) as quickly as possible.
- Any slow work (identity resolution, agent routing, job creation) is performed asynchronously after the HTTP response is sent.
- This ensures the 3-second deadline is met even when downstream operations are slow or under load.

## Identity Interception Flow

Before agent routing, the gateway resolves the Slack user to an Eve identity. This happens after integration lookup (`team_id -> org_id`) but before any agent slug parsing:

1. The sender's Slack user ID is checked against known identity links for the org.
2. If the identity **is** resolved, processing continues to agent routing.
3. If the identity **cannot** be resolved, the user receives a helpful error message explaining how to link their Slack account (not a generic "Unable to route command" error).

### Reserved Commands

The `link` command is **reserved** and checked before agent slug resolution. When a user sends `@eve link`, the gateway initiates the identity linking flow regardless of whether a `link` agent exists:

```
@eve link          # Start identity linking flow
```

This ensures new users can always link their accounts, even before any agents are configured.

## Interactive Endpoint

`POST /gateway/providers/slack/interactive` handles Slack interactive components (buttons, modals, menus).

**Request format:**
- Content-Type: `application/x-www-form-urlencoded`
- Body contains a single `payload` field whose value is a JSON string

**Processing:**
1. Parse URL-encoded form body and extract `payload` JSON field
2. Validate Slack request signature (same signing secret as the webhook endpoint)
3. Route by `action_id` to the appropriate handler

**Supported action IDs:**
- `membership_approve` — approve a pending org membership request
- `membership_deny` — deny a pending org membership request

**Response:** Returns `200 OK` with an optional message update to replace the interactive message in Slack.

## Gateway Provider Interface

All providers implement the `GatewayProvider` contract:

- **`name`**: Unique provider identifier (e.g., `slack`, `nostr`)
- **`transport`**: `'webhook'` | `'subscription'`
- **`capabilities`**: Declares supported features (e.g., threads, reactions, file uploads)
- **`initialize(config)`** / **`shutdown()`**: Lifecycle hooks for setup and teardown

Webhook-specific methods:
- **`validateWebhook(req)`** → validation result (signature check, challenge handling)
- **`parseWebhook(req)`** → parsed result: `message`, `handshake`, or `ignored`

Shared methods:
- **`sendMessage(target, content)`**: Send outbound message to a provider-specific target
- **`resolveIdentity(externalUserId, accountId)`**: Map external user to Eve identity

## Provider Registry

- Factories are registered at startup in `app.module.ts`
- Instances are created per integration (one instance per org integration)
- `WebhookController` dispatches `POST /gateway/providers/:provider/webhook` to initialized provider instances
- Subscription providers start their connections on `initialize()` and tear down on `shutdown()`

## Multi-Tenant Mapping

- `team_id -> org_id` is stored at integration connect time.
- Agent slugs (`agents.yaml`) are unique per org and select the target project/agent.

## Thread Keys

Thread continuity uses a canonical key scoped to the integration account:

```
account_id:channel[:thread_id]
```

Examples:
- Slack: `T123ABC:C456DEF:1234567890.123456`
- Nostr: `<platform-pubkey>:<sender-pubkey>`

The gateway uses that canonical key to resolve the correct Eve thread, but follow-up API and CLI calls should use the Eve `thread_id` (`thr_*`). Route responses now return both values.

## Gateway Exposure Policy

Agents can control how they appear to gateway clients via `agents.yaml`:

- `none`: hidden (not listed, not routable)
- `discoverable`: listed in `@eve agents list` but not routable
- `routable`: listed and routable via `@eve <agent-slug> <command>`

## Listener Commands (Slack)

```text
@eve agents listen <agent-slug>     # listen in this channel (or thread if run inside a thread)
@eve agents unlisten <agent-slug>   # remove listener
@eve agents listening              # show active listeners for this channel/thread
@eve agents list                   # directory of slugs
```

Notes:
- Listening uses `message.channels` events; explicit commands still use `app_mention`.
- Multiple agents can listen to the same channel or thread.
- Thread-scoped listeners are set when the command is issued inside a thread.

## WebChat Provider

Browser-native agent chat via WebSocket. Follows the subscription transport model (like Nostr).

**Connection:**
```
ws://gateway:4820/?token=<jwt>
```

**Send message:**
```json
{"type": "message", "text": "Hello", "agent_slug": "coder", "thread_id": "optional"}
```

**Receive reply:**
```json
{"type": "message", "text": "Queued 1 job(s)...", "thread_id": "...", "timestamp": "..."}
```

**Features:**
- JWT auth in WebSocket handshake using Eve JWKS verification (`RS256`, `exp`, `nbf`, `kid`)
- Heartbeat ping/pong (30s interval)
- Thread continuity across reconnections
- Multi-tab support (same user, multiple connections)

**Registration:** Configured as an integration with `provider: webchat`.

For same-origin embedded app panes, prefer provider `app` and the project conversations facade. Use WebChat when the browser needs a direct WebSocket to the gateway; use provider `api` for generic REST-originated chat clients without browser push.

## Simulation

Use CLI simulation for tests:

```bash
eve chat simulate --project <id> --team-id T123 --channel-id C123 --user-id U123 --text "hello"
```

## Notes

- `@eve agents list` returns the org agent directory (slug -> project).
- Set the default agent with `eve org update <org_id> --default-agent <slug>`.

## Related Docs

- [Integrations](./integrations.md)
- [Chat Routing](./chat-routing.md)
- [Identity Providers](./identity-providers.md)
