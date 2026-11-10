# Webhooks

> Status: Current
> Last Updated: 2026-11-10
> Purpose: Document webhook subscriptions, deliveries, and replay workflows.

## Overview

Eve supports org-wide and project-scoped webhook subscriptions. Each webhook
receives event payloads emitted by the system (job lifecycle, pipeline runs,
deploys, etc.). Deliveries are logged and can be replayed.

Webhook payloads are sent using a CloudEvents 1.0 envelope.

## Endpoints (Current)

Org-scoped subscriptions:

```
POST   /orgs/{org_id}/webhooks
GET    /orgs/{org_id}/webhooks
GET    /orgs/{org_id}/webhooks/{wh_id}
DELETE /orgs/{org_id}/webhooks/{wh_id}
PATCH  /orgs/{org_id}/webhooks/{wh_id}/enable
GET    /orgs/{org_id}/webhooks/{wh_id}/deliveries
POST   /orgs/{org_id}/webhooks/{wh_id}/test
```

Project-scoped subscriptions:

```
POST /projects/{project_id}/webhooks
```

Replays:

```
POST /orgs/{org_id}/webhooks/{wh_id}/replays
GET  /orgs/{org_id}/webhooks/{wh_id}/replays/{replay_id}
```

## Response Shapes

Collection endpoints return the canonical list envelope:

```json
{
  "data": [
    { "id": "wh_123", "url": "https://example.com/hook" }
  ]
}
```

This applies to:
- `GET /orgs/{org_id}/webhooks`
- `GET /orgs/{org_id}/webhooks/{wh_id}/deliveries`

## CLI Reference

```
eve webhooks list --org org_xxx
eve webhooks create --org org_xxx --url https://example.com/hook --events job.completed,job.failed --secret <secret>
eve webhooks show wh_xxx --org org_xxx
eve webhooks delete wh_xxx --org org_xxx
eve webhooks enable wh_xxx --org org_xxx
eve webhooks deliveries wh_xxx --org org_xxx --limit 50
eve webhooks test wh_xxx --org org_xxx
eve webhooks replay wh_xxx --org org_xxx --from-event evt_xxx --max-events 100 --dry-run
eve webhooks replay-status wh_xxx rep_xxx --org org_xxx
```

## Payload Format (CloudEvents)

Webhook deliveries use a CloudEvents 1.0 envelope:

```json
{
  "specversion": "1.0",
  "type": "job.completed",
  "source": "eve://orgs/org_xxx/projects/proj_xxx",
  "id": "evt_...",
  "time": "2026-02-12T12:00:00Z",
  "data": { "job_id": "myproj-a3f2dd12", "status": "done" }
}
```

## Creating a Subscription

Request body:

```json
{
  "url": "https://example.com/hook",
  "events": ["job.completed", "job.failed"],
  "filter": { "project_id": "proj_xxx" },
  "secret": "<min-16-chars>"
}
```

Notes:
- `events` supports wildcards (e.g., `system.job.*`).
- `secret` must be 16-256 characters.
- `url` must use `http` or `https` and reach the public internet. The API
  resolves the host and answers `400 webhook_url_not_allowed` for loopback,
  private (RFC 1918), carrier-grade NAT, link-local (including cloud metadata
  addresses), multicast and reserved addresses, their IPv4-mapped IPv6 forms,
  IPv6 unique-local and link-local addresses, hosts that do not resolve, and
  internal names (`localhost`, single-label names, `*.local`, `*.internal`,
  `*.svc`, `*.home.arpa`).

## Destination Rules

The same check runs again before every delivery attempt, and the request
connects to the address that was checked, so a later DNS answer cannot move
it. Redirects are not followed: a `3xx` response is a failed delivery and is
retried like any other failure. A refused destination is recorded on the
delivery as `Webhook URL not allowed: ...`.

For local development only, `EVE_WEBHOOKS_ALLOW_PRIVATE_TARGETS=true` on the
API lets subscriptions and deliveries reach private and loopback receivers.
It is off by default and must stay off on shared or hosted instances.

## Delivery + Retry

- Retry schedule: 1m → 5m → 30m → 2h → 12h (max 5 attempts).
- HTTP timeout: 30s per delivery.
- Only `2xx` responses count as delivered; redirects are not followed.
- Response bodies are truncated to 4096 bytes for storage.
- Subscriptions auto-disable after 10 consecutive failures.

## Signature Verification

Each delivery includes:

- `X-Eve-Signature-256: sha256=<hex>`
- `X-Eve-Delivery: <delivery_id>`

Compute the HMAC using the webhook secret and compare to the signature header.

## Replay Semantics

- Replays can be dry-run to show how many deliveries would be enqueued.
- Replay status is tracked by replay ID and exposes progress and counts.
- `max_events` defaults to 5000 (range 1–10000).
- `from` can anchor by event ID; `to` can limit by time.
- Deduplication is enforced per `(subscription_id, event_id)`.
- A subscription allows up to 3 concurrent replays.

## Error Responses

Common error codes:

- `resource_conflict` (replay already running, subscription disabled)
- `webhook_replay_window_invalid` (invalid window or max_events)
- `webhook_url_not_allowed` (subscription URL does not reach the public internet)
- `resource_not_found`
