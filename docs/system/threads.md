# Threads (Current)

> Status: Current
> Last Updated: 2026-05-05
> Purpose: Explain thread primitives used for chat continuity.

## Overview

Threads provide **continuity** for chat-driven work. A thread captures the route, participants, and message history for a chat session.

Two identifiers matter:

- `thread_id`: Eve's stable thread ID (`thr_*`), used by API and CLI follow-up flows.
- `key`: the provider continuity key (`account_id:channel[:thread_id]`), used to correlate inbound provider events onto the same Eve thread.

## Core Fields

- `project_id`: owning project
- `key`: deterministic thread key (account + channel + optional thread id)
- `channel`: provider channel ID
- `peer`: provider user ID
- `policy_json`: permissions snapshot
- `summary`: optional rolling summary
- `workspace_key`: stable key for shared workspace context
- `metadata`: provider, continuation, embedded app, and product-specific metadata

## Org Threads (Current)

Org-scoped threads provide continuity for multi-project or cross-channel
coordination. They are keyed independently from project threads but follow the
same message schema.

API:

```
POST /orgs/{org_id}/threads
GET /orgs/{org_id}/threads
GET /orgs/{org_id}/threads/{thread_id}
GET /orgs/{org_id}/threads/{thread_id}/messages
POST /orgs/{org_id}/threads/{thread_id}/messages
```

CLI:

```bash
eve thread list --org org_xxx
eve thread show --org org_xxx --id thr_xxx
eve thread messages thr_xxx --org org_xxx --since 10m
eve thread post thr_xxx --body '{"kind":"directive","body":"focus on auth"}'
eve thread follow thr_xxx
```

## Org Thread Keys

Org thread keys are canonicalized as:

```
org:{org_id}:{user_key}
```

The `key_prefix` filter in `eve thread list` matches this canonical prefix.

## Scope Model

- `scope=project` threads belong to a project and emit project chat events.
- `scope=org` threads are org-wide and may not emit project events yet.

## Follow Behavior

`eve thread follow` now prefers `GET /threads/:thread_id/stream` for project threads and falls back to polling if SSE is unavailable. Org-scoped follow still uses polling via `GET /orgs/:org_id/threads/:thread_id/messages?since=...`.

## Thread Key Format

Thread continuity uses a canonical key format scoped to the integration account:

```
account_id:channel[:thread_id]
```

Examples:
- Slack: `T123ABC:C456DEF:1234567890.123456`
- Nostr: `<platform-pubkey>:<sender-pubkey>`
- Embedded app conversation: `app:{app_id}:sha256:{base64url_sha256_app_key}`

## Message Logging

Messages are recorded in `thread_messages` with direction, actor metadata, `kind`, and optional job linkage.

| Field | Purpose |
| --- | --- |
| `kind = message` | Normal inbound/outbound chat message or final agent result |
| `kind = progress` | Mid-job progress update emitted through chat delivery |
| `job_id` | Links a message or progress update to the originating job when available |

Final outbound result idempotency is scoped to `kind = message`; progress rows can share a job id and remain distinct messages.

## Project Thread Continuation

Project chat routes return both the Eve `thread_id` and the provider-facing `thread_key`.
Follow-up messages should continue by Eve thread ID:

```bash
eve chat send --thread thr_xxx --text "follow up"
```

API:

- `POST /threads/:thread_id/chat` — continue an existing routed project thread
- `GET /threads/:thread_id/stream` — SSE stream with `snapshot`, `message`, `progress`, and `heartbeat` events

Continuation uses metadata stored on the Eve thread. This preserves the original dispatch target and permissions snapshot instead of re-reading `chat.yaml` on every reply. That means a thread keeps talking to the same agent, team, workflow, or pipeline even if the project's routes change later.

Project thread streams include `id: <thread_messages.id>` on message/progress events. Clients can reconnect with the `Last-Event-ID` header to replay rows strictly after the supplied message id, including after an API restart.

## Embedded App Conversations

Embedded app conversations are project threads addressed by app-owned keys rather than provider channel ids. The conversations facade stores:

- canonical thread key: `app:{app_id}:sha256:{hash(app_key)}`
- raw `app_key`, `app_id`, provider `app`, `account_id`, and product metadata in thread metadata
- current dispatch target metadata after the first routed turn

Use:

```text
POST /projects/{project_id}/conversations
GET  /projects/{project_id}/conversations/{app_key}
POST /projects/{project_id}/conversations/{app_key}/turns
GET  /projects/{project_id}/conversations/{app_key}/stream
GET  /projects/{project_id}/conversations/{app_key}/messages
GET  /projects/{project_id}/conversations/{app_key}/events
GET  /projects/{project_id}/conversations/{app_key}/events/stream
POST /projects/{project_id}/conversations/{app_key}/events
```

The stream endpoint mirrors `GET /threads/:thread_id/stream`, including `Last-Event-ID` resume and progress events. See [Eve SDK](./eve-sdk.md#embedded-conversation-pane).

For richer product UIs, use the normalized event stream instead of parsing raw job logs:

```text
GET  /threads/{thread_id}/events
GET  /threads/{thread_id}/events/stream
POST /threads/{thread_id}/events
```

`conversation_events` is an ordered, durable timeline with cursor-based resume. Standard kinds include `user.message`, `assistant.message`, `text.delta`, `tool.call`, `tool.result`, `status.changed`, `progress`, `error`, `attachment.added`, `file.change`, `delivery.status`, and `final.result`. Apps can emit domain events such as `artifact.update`, `lint.finding`, or `preview.changed`; they appear in the same stream as thread messages and job events. List and stream endpoints accept `after`, `kind`, `job_id`, `attempt_id`, `workflow_step`, `source`, and `limit`.

The raw job log endpoints remain separate for debugging. Conversation events intentionally carry product-safe normalized payloads and source references (`message_id`, `event_id`, `log_id`, `attachment_id`) rather than embedding full harness logs.

## Listener Subscriptions

Passive listeners are stored in `thread_subscriptions` with:

- `thread_id`
- `subscriber_type` (currently `agent`)
- `subscriber_id` (agent ID)

Listeners are created via Slack commands:

```
@eve agents listen <agent-slug>
@eve agents unlisten <agent-slug>
@eve agents listening
```

Behavior:
- Channel-level listeners subscribe to the channel thread key (no `thread_ts`).
- Thread-level listeners subscribe to the thread key when the command is issued inside a thread.
- Multiple agents can listen to the same channel or thread.

## Coordination Threads

Coordination threads enable inter-agent communication within team dispatches. When a team dispatch creates child jobs, a coordination thread is automatically created and linked to the parent job.

### Key Convention

Coordination threads use the key pattern:

```
coord:job:{parent_job_id}
```

The thread ID is stored in the parent job's `hints.coordination.thread_id` field along with the `dispatch_mode`.

### Environment

Child agents receive `EVE_PARENT_JOB_ID` in their environment, allowing them to derive the coordination thread key via:

```
coord:job:${EVE_PARENT_JOB_ID}
```

### End-of-Attempt Relay

When a child job's attempt completes, the orchestrator automatically posts a summary message to the coordination thread:

```json
{
  "kind": "status",
  "job_id": "...",
  "assignee": "...",
  "body": "attempt summary text"
}
```

This gives the lead agent (and any other team members reading the thread) visibility into sibling progress.

### Coordination Inbox (Workspace)

When a coordination thread exists, the worker writes a lightweight inbox file
into the repo workspace for quick review:

```
.eve/coordination-inbox.md
```

This file is regenerated from recent coordination thread messages at job start.

### Supervision Stream

Lead agents can long-poll child events for a job:

```bash
eve supervise
eve supervise <job-id> --timeout 60
```

### Message Shape

Thread messages use the standard `thread_messages` table. Coordination messages use a JSON body with at minimum `kind` and `body` fields. Common kinds:

| Kind | Purpose |
|------|---------|
| `status` | Automatic end-of-attempt summary |
| `directive` | Lead-to-member instruction |
| `question` | Member-to-lead question |
| `update` | Progress update from a member |

### CLI Access

```bash
# List recent messages
eve thread messages <thread-id> --since 5m

# Post a message
eve thread post <thread-id> --body '{"kind":"directive","body":"focus on auth"}'

# Follow in real-time
eve thread follow <thread-id>
```

### API Endpoints

- `GET /threads/:id/messages?since=<iso>&limit=<n>` — list messages with optional time filter
- `POST /threads/:id/messages` — post a new message
- `GET /threads/:id/stream` — stream snapshot + new message/progress events over SSE
- `POST /threads/:id/chat` — continue routed chat by Eve thread ID

Both endpoints accept user tokens (RBAC) and job tokens (project-scoped).

## Related Docs

- [Chat Routing](./chat-routing.md)
- [Agents & Teams](./agents.md)
- [Agent Team Coordination Plan](../plans/agent-team-coordination-plan.md)
