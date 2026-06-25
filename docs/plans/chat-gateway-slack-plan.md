# Chat Gateway + Slack Integration Plan

> Status: Completed
> Last Updated: 2026-02-04
> Purpose: Implement hosted gateway (Slack first) with identity mapping and approvals.
> Order: 3 (provider integration)

## Dependencies
- v3 plan: docs/ideas/channel-integrations-unified-plan-v3.md
- Agents/Teams/Threads primitives plan

## Goals
- Hosted gateway service inside Eve cluster.
- Slack OAuth + Events API ingestion.
- Admin approvals in Slack for membership requests.
- Multi-tenant mapping by Slack `team_id` -> org.
- Test mode for simulation (no real Slack creds).

## Non-goals
- Other providers (Nostr planned later).
- Full UI console (optional later).

## Gateway Responsibilities
- Verify provider signatures / auth.
- Normalize inbound messages to `chat.message.received`.
- Resolve identity -> Eve user (or create membership request).
- Route via `chat.yaml` and create jobs.
- Send outbound replies.

## Data Model (Additions)
- `integrations` (provider, account_id, org_id, tokens_json, status)
- `external_identities` (provider, account_id, external_user_id, eve_user_id)
- `membership_requests` (org_id, external_identity_id, status, approved_by)

## API Endpoints (Sketch)
- `POST /orgs/:id/integrations/slack/connect` (OAuth start / test)
- `POST /integrations/slack/events` (Slack Events API)
- `POST /integrations/slack/interactive` (approvals)
- `POST /projects/:id/chat/simulate` (test-only)
- `GET /orgs/:id/integrations`
- `POST /integrations/:id/test`

## Slack Approval Flow
1) Unknown user sends message or `/eve join`.
2) Gateway creates `membership_request`.
3) Admins receive Slack message with Approve/Deny buttons.
4) On approve: create Eve user, bind identity, apply role.

> Note: Interactive approvals are currently stubbed; full approve/deny handling is deferred.

## Work Breakdown

### Phase 1: Gateway Service
- [x] Add `eve-gateway` app (HTTP + webhook handlers).
- [x] Slack signature verification.
- [x] Multi-tenant mapping by `team_id` -> org.

### Phase 2: Identity + Approvals
- [x] External identity mapping table.
- [x] Membership request lifecycle.
- [x] Slack interactive approvals (stub).

### Phase 3: Outbound Messaging
- [x] Send replies to channels/DMs.
- [x] Threaded reply support.

### Phase 4: Test Mode
- [x] `chat simulate` endpoint for CLI/manual tests.
- [x] Golden test payloads.

## Tests
- Unit: signature verification, route resolution, identity binding.
- Integration: Slack event -> job created -> response sent.
- Manual: simulated Slack scenario (no credentials).

## Spec Appendix

### Slack Scopes (minimum)
- `chat:write`
- `app_mentions:read`
- `channels:history`
- `groups:history`
- `im:history`

### Slack Event Types
- `message.channels`, `message.groups`, `message.im`
- `app_mention`

### Identity Mapping
Key: `(provider, team_id, user_id)` -> Eve user.
Team mapping: `team_id -> org_id` (hard isolation).

### Approval Message (Slack UI)
- Text: "Approve access for <user> to <org>?"
- Buttons: Approve / Deny
- Role selection: member | admin | owner

### Test Mode Endpoint (required)
`POST /projects/:id/chat/simulate`
Payload includes: provider, team_id, channel_id, user_id, text.
