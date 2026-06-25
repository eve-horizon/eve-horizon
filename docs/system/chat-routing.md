# Chat Routing (Current)

> Status: Current
> Last Updated: 2026-05-05
> Purpose: Describe `chat.yaml` routes and dispatch behavior.

## chat.yaml (Shape)

```yaml
version: 1
default_route: route_default
routes:
  - id: embedded-designer
    match: "design|review"
    target: agent:designer
    providers: [app]
    account_ids: [open-design]

  - id: route_default
    match: ".*"
    target: team:ops
    permissions:
      project_roles: [member, admin, owner]
```

## Targets

- `agent:<id>` — dispatch to a single agent
- `team:<id>` — dispatch using team mode
- `workflow:<name>` — invoke workflow
- `pipeline:<name>` — launch pipeline

## Matching Rules

1. Routes evaluated in order.
2. First regex match wins.
3. Optional `providers` and `account_ids` predicates must match the incoming route context when present.
4. If none match, `default_route` is used.

Route selection happens when a new provider message creates or resolves a thread. Once a project thread exists, follow-up replies continue by Eve `thread_id` and preserve the original resolved target; they do not re-run `chat.yaml` on every message.

Provider predicates let one route file distinguish Slack, Nostr, WebChat, generic API, and embedded app origins:

```yaml
routes:
  - id: embedded-designer
    match: "design|review"
    providers: [app]
    account_ids: [open-design]
    target: agent:designer
```

Embedded app conversations send provider `app` and `account_id = app_id`. Generic REST clients can use provider `api`; direct browser-to-gateway sockets use `webchat`.

## Org-Wide Agent Slugs

Gateway `@eve <agent-slug> <command>` mentions resolve the agent slug across the org and dispatch directly to that agent’s project. This bypasses `chat.yaml` matching and is intended for cross-project routing.

If the first word is not a known slug, Eve uses the org `default_agent_slug` and passes the full message as the command.

Directory: `@eve agents list` returns available slugs.

## Listening (Passive)

Slack channels/threads can be “listened to” by agents for passive ingestion.

Commands:

```text
@eve agents listen <agent-slug>
@eve agents unlisten <agent-slug>
@eve agents listening
```

Behavior:
- Listen command in a channel creates a channel-level listener.
- Listen command in a thread creates a thread-level listener.
- When messages arrive, all listeners for the channel/thread receive a job in their project.

## Simulation

```bash
eve chat simulate --project <id> --team-id T123 --channel-id C123 --user-id U123 --text "hello" --json
```

The simulate response returns:

- `thread_id`: Eve thread ID for future follow-ups
- `thread_key`: provider continuity key
- `job_ids`

To continue the same routed thread later:

```bash
eve chat send --thread <thread_id> --text "follow up"
```

## Embedded App Conversation Facade

For same-origin app panes, prefer the conversations facade over calling `chat/route` directly:

```text
POST /projects/{project_id}/conversations
POST /projects/{project_id}/conversations/{app_key}/turns
GET  /projects/{project_id}/conversations/{app_key}/stream
GET  /projects/{project_id}/conversations/{app_key}/messages
```

The facade canonicalizes app keys into thread keys, preserves product metadata in thread metadata, applies `chat.yaml` route matching or explicit agent/team/route targets, and exposes resumable SSE for messages and progress. See [Eve SDK](./eve-sdk.md#embedded-conversation-pane).

## Related Docs

- [Agents & Teams](./agents.md)
- [Threads](./threads.md)
- [Eve SDK](./eve-sdk.md)
