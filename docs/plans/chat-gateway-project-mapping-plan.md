# Chat Gateway Project Mapping Plan

> Status: Plan
> Last Updated: 2026-02-05
> Purpose: Replace single-project gateway routing with org/integration channel bindings that resolve to projects (and optional route overrides).

## Problem
- Gateway currently uses `EVE_GATEWAY_PROJECT_ID` (one project) for all Slack events.
- This breaks multi-project orgs and conflicts with the v3 plan (channel bindings per org).

## Goals
- Map Slack team/channel -> project (and optional route) in the API DB.
- Keep the gateway stateless; it only verifies/normalizes and asks the API to route.
- Preserve default behavior via explicit default binding (not an env var).
- Provide CLI + manual scenario coverage.

## Non-goals
- Full admin UI, OAuth flow changes, or new providers.

## Design (General Case Mapping)
- Mapping is owned by the API (system of record) via a channel-binding table.
- Bindings are scoped to an integration (provider + account/team_id) and optionally a channel.
- Resolution order:
  1. Exact channel binding (provider/account/channel)
  2. Default binding for the integration (channel_id null)
  3. No route (drop + optional "no binding" reply)
- Optional route override: binding may pin a `route_id` to bypass regex matching.

### Data Model
Table: `chat_channel_bindings`
- `id` (text)
- `org_id` (fk orgs)
- `integration_id` (fk integrations)
- `channel_id` (nullable)
- `project_id` (fk projects)
- `route_id` (nullable)
- `created_at`, `updated_at`

Indexes:
- Unique (integration_id, channel_id) for channel-specific bindings
- Unique default binding per integration (channel_id is null)
- Index on org_id, project_id

### API
External:
- `POST /orgs/:org_id/chat/bindings` (admin) create binding
- `GET /orgs/:org_id/chat/bindings` (member) list
- `DELETE /orgs/:org_id/chat/bindings/:binding_id` (admin)

Optional admin test route:
- `POST /orgs/:org_id/chat/route` (admin) route using bindings; returns `project_id` + `ChatRouteResponse`.

Internal (gateway):
- `POST /internal/integrations/:integration_id/chat/route`
  - payload: provider/account/channel/user/text/metadata/thread_key
  - resolves binding -> project -> `ChatService.routeMessage`
  - response includes `project_id`, `thread_id`, `job_ids`, `route_id`, `event_id`

### Gateway
- Remove `EVE_GATEWAY_PROJECT_ID` dependency.
- After integration resolve + external identity:
  - call internal binding route endpoint with `integration_id` and message payload
- If no binding found: log and optionally reply "No chat binding configured."
- Keep `EVE_GATEWAY_PROJECT_ID` as fallback for one release (warn) to avoid breakage.

### CLI
New commands:
- `eve chat bindings list --org <org>`
- `eve chat bind --org <org> --team-id <T> --channel-id <C> --project <proj> [--route <route>]`
- `eve chat bind --org <org> --team-id <T> --default --project <proj> [--route <route>]`
- `eve chat binding delete <binding_id>`
- Optional: `eve chat route --org <org> ...` to hit org-level test route.

### Docs/Config
- Update `docs/system/chat-gateway.md` and `docs/system/integrations.md` to remove the single-project env var.
- Update manual scenario 08 to create bindings and test routing.
- Deprecate `EVE_GATEWAY_PROJECT_ID` in docs and system secrets.

## Work Breakdown
1. DB migration + queries for `chat_channel_bindings`.
2. API: bindings CRUD + resolver + internal route endpoint.
3. Gateway: switch to binding route endpoint; remove env var dependency.
4. CLI: add bind/list/delete commands (and optional route test).
5. Docs + manual scenarios updates.
6. Tests.

## Tests
- Unit: binding resolution order, default binding, missing binding.
- Integration:
  - Create integration + binding; route via internal endpoint; job created in correct project.
  - Channel-specific binding overrides default.
- Manual:
  - Update Scenario 08:
    - connect Slack integration
    - create default binding (or channel binding)
    - route via new `eve chat route` (or gateway) and verify job/thread
  - Optional Scenario 09: two projects, two bindings; messages route to correct project.

## Migration / Compatibility
- If `EVE_GATEWAY_PROJECT_ID` is set and no binding exists, treat it as a temporary default with a warning.
- Provide a one-time CLI helper to create a default binding from the env var.
