# Chat Thread Continuity Plan

> Status: Draft
> Created: 2026-04-06
> Purpose: Let apps continue an existing Eve chat thread by `thr_*` ID without losing routing semantics, and close the adjacent observability gaps around thread-based chat.

## Problem Statement

Eve already has thread continuity internally, but it is exposed through the wrong handle.

Today, continuation works if the caller can repeat the same `thread_key` or provider-native thread handle:

- `POST /projects/:project_id/chat/simulate`
- `POST /internal/projects/:project_id/chat/route`
- `POST /internal/orgs/:org_id/chat/route`
- `eve chat simulate` default path via `/gateway/providers/simulate`

That is enough for Slack-style integrations, where the provider thread handle is deterministic. It is **not** enough for app/API clients, which usually receive an Eve `thread_id` like `thr_ABC` and expect that to be the conversation handle.

The missing primitive is:

> "Append a new inbound message to an existing Eve thread and trigger the same chat dispatch semantics that created that thread."

Without that primitive, apps have only two bad options:

1. Start a new thread for every message and lose context.
2. Persist opaque `thread_key` values or provider thread handles they should not need to understand.

The gap was surfaced by the Deck Builder app and documented in `docs/reports/chat-thread-routing-gap.md`.

## Current State

### What Exists

| Path | What it does today | Gap |
| --- | --- | --- |
| `POST /projects/:project_id/chat/simulate` | Project-scoped test hook that routes a message and records thread/event state | Can continue only by repeating `thread_key` |
| `POST /internal/projects/:project_id/chat/route` | Internal project chat routing | Same limitation |
| `POST /internal/orgs/:org_id/chat/route` | Internal direct agent/team routing by slug | Same limitation |
| `POST /threads/:thread_id/messages` | Appends a message to a known thread | Does not create jobs or route chat |
| `GET /threads/:thread_id` | Returns the thread, including `key` | Requires an extra round-trip and still exposes an opaque continuation handle |
| `eve thread follow` | Polls `GET /threads/:thread_id/messages` every ~3s | No server-push stream |

### Important Distinction: Two Different "Thread IDs"

The repo already uses `thread_id` in two incompatible ways:

- **Eve thread ID**: `thr_*`, the row ID in `threads`
- **Provider thread handle**: Slack `thread_ts`, webchat provider thread handle, etc.

This is already visible in the CLI:

- `eve chat simulate --thread-id ...` forwards an **external/provider** thread handle to gateway simulate
- `eve thread follow thr_xxx` uses an **Eve** thread ID

Any implementation plan must keep those two concepts separate. A continuation endpoint for apps must use the Eve `thread_id`, not reuse provider-thread semantics.

## Root Cause

The platform stores enough data to continue a thread, but not enough data to do it safely by Eve thread ID.

### 1. Continuation is key-based, not thread-ID-based

`recordThreadAndEvent()` already finds-or-creates by `thread_key`, and `buildThreadContext()` already loads prior messages. If the same `thread_key` comes back, context is preserved.

The problem is that:

1. App clients are given `thread_id`, not `thread_key`
2. `thread_key` is frequently provider-derived or otherwise opaque
3. The default CLI path goes through gateway simulate, where `thread_id` means provider thread handle, not Eve `thread_id`

### 2. Threads do not persist their continuation strategy

The current thread metadata is enough for **outbound delivery** (`provider`, `account_id`, `channel_id`, provider thread handle), but not for **inbound continuation**.

That is a problem because existing threads may have been created by different entry paths:

- `routeMessage()` via `chat.yaml`
- `routeMessageToAgent()` via direct slug routing
- `routeMessageToTeam()` via direct team routing

Those are not interchangeable. A continuation endpoint cannot blindly rerun `chat.yaml` matching and assume it will preserve the intended conversation target.

## Design Constraints

### Constraint 1: `thread_id` must be the app-facing conversation handle

After the first response returns `{ thread_id: "thr_ABC" }`, the client should be able to continue the conversation with that ID alone.

### Constraint 2: Continuation must preserve the original dispatch target

Continuing a thread should keep talking to the same agent/team/route target that created the thread. It should **not** silently rematch against the latest `chat.yaml` and drift to a different target.

If a caller wants a fresh routing decision, it should start a new thread.

### Constraint 3: Project chat threads only in Phase 1

This plan is about app-facing chat continuity for project threads. It does **not** make org-scoped coordination threads chat-continuable.

Phase 1 should reject:

- org-scoped threads
- coordination threads
- legacy threads that lack enough continuation metadata

### Constraint 4: Auth must follow chat semantics, not raw thread-write semantics

Appending a message and triggering jobs is closer to `chat:write` than `threads:write`.

The new endpoint should:

- require `chat:write`
- verify the caller has access to the thread's project
- reject cross-project job tokens

## Proposed Design

### Change 1: Add `POST /threads/:thread_id/chat`

Add a dedicated continuation endpoint:

```http
POST /threads/:thread_id/chat
```

This endpoint is for:

> "Continue this existing Eve conversation."

It is explicitly different from:

- `POST /projects/:project_id/chat/simulate` which is a routing/simulation entrypoint
- `POST /threads/:thread_id/messages` which is a low-level append primitive

**Request body** (`ThreadChatRequestSchema`):

```typescript
{
  text: string;
  actor_id?: string;                 // Optional external/provider actor override for logging
  metadata?: Record<string, unknown>; // Carries eve_user_id, files, app metadata, etc.
  dedupe_key?: string;               // Optional idempotency key for app retries
}
```

Notes:

- Do **not** overload `user_id` here. In current chat APIs, `user_id` means external/provider sender ID, while permission checks rely on `metadata.eve_user_id`.
- Provider/account/channel/thread delivery details should be recovered from the stored thread metadata, not re-supplied by the client.

**Response**: reuse `ChatRouteResponse` and add `thread_key`:

```typescript
{
  thread_id: string;
  thread_key: string | null;
  route_id: string | null;
  target: string | null;
  job_ids: string[];
  event_id: string | null;
}
```

**Behavior**:

1. Load thread by Eve `thread_id`
2. Reject if the thread does not exist, is not project-scoped, or has no continuation metadata
3. Verify the caller can write chat to the thread's project
4. Record the inbound message on the existing thread
5. Create a `chat.message.received` event for that thread
6. Dispatch using the thread's stored continuation binding
7. Return the same `thread_id` plus any created jobs

Recommended error semantics:

- `404` thread not found
- `400` thread is not project-scoped / has no project
- `409` thread exists but is not continuation-capable

### Change 2: Persist continuation binding on the thread

This is the critical design correction.

The thread needs to remember **how future messages should be routed**. Recomputing that from `thread_id` alone is not reliable.

Reuse `threads.metadata_json` and extend it with a continuation block:

```json
{
  "provider": "slack",
  "account_id": "T123",
  "channel_id": "C123",
  "user_id": "U123",
  "thread_id": "1773141918.681009",
  "continuation": {
    "kind": "route",
    "route_id": "route_default",
    "target": "team:ops"
  }
}
```

Possible continuation kinds:

- `route` — thread originated from `routeMessage()`
- `agent` — thread originated from direct agent routing
- `team` — thread originated from direct team routing

Store the **resolved target**, not just the route ID. That prevents route drift if `chat.yaml` changes after the thread begins.

This metadata should be written or refreshed by:

- `routeMessage()`
- `routeMessageToAgent()`
- `routeMessageToTeam()`

That keeps the continuation contract aligned with the actual dispatch path that created the conversation.

### Change 3: Return `thread_key` in `ChatRouteResponse`

This is not the core fix, but it is still worth doing.

`thread_key` is already available via `GET /threads/:thread_id`, so this is an ergonomics improvement, not a new primitive. Returning it inline avoids an immediate read-after-write lookup and helps callers that want to map Eve threads to provider-native threads.

Schema change:

```typescript
export const ChatRouteResponseSchema = z.object({
  thread_id: z.string(),
  thread_key: z.string().nullable(), // NEW
  route_id: z.string().nullable(),
  target: z.string().nullable(),
  job_ids: z.array(z.string()),
  event_id: z.string().nullable(),
  denied: z.boolean().optional(),
  denial_reason: z.string().optional(),
});
```

This must be reflected in:

- shared schema
- API controllers
- gateway-normalized CLI output
- generated OpenAPI docs

### Change 4: Add server-push thread streaming

Add:

```http
GET /threads/:thread_id/stream
```

This closes the current observability gap where `eve thread follow` and app UIs have to poll `GET /threads/:thread_id/messages`.

**Event types**:

| Event | Data | When |
| --- | --- | --- |
| `snapshot` | `{ thread, messages }` | Initial connect |
| `message` | `ThreadMessageResponse` | New message recorded |
| `heartbeat` | `{}` | Keepalive every 15s |

Implementation can initially mirror the existing jobs stream style: poll internally and emit SSE. That is acceptable for Phase 2.

### Change 5: CLI support

Add a new command:

```bash
eve chat send --thread thr_ABC --text "follow-up" --json
```

Behavior:

- calls `POST /threads/:thread_id/chat`
- prints the returned `thread_id`, `thread_key`, `job_ids`, `route_id`, and `target`

Also update `eve thread follow`:

- prefer `GET /threads/:thread_id/stream` for project threads
- keep the current polling fallback for org-scoped threads or older servers

## Implementation Notes

### Refactor around target dispatch, not route matching

Do not implement `continueThread()` as "routeMessage but skipping thread creation".

That would bake in the wrong abstraction. The shared logic is not "match route", it is "dispatch to a resolved target while attaching thread context and chat metadata".

Recommended split:

1. **Ingress helpers**
   - find/create thread
   - append inbound message
   - create event
   - update thread metadata

2. **Dispatch helpers**
   - dispatch to resolved agent
   - dispatch to resolved team
   - dispatch to resolved workflow/pipeline

3. **Continuation resolver**
   - read `thread.metadata_json.continuation`
   - turn it into the right dispatch call

### Preserve provider metadata for descriptions and delivery

Current job descriptions and delivery logic use provider/account metadata. `continueThread()` must reconstruct that context from stored thread metadata so descriptions and event payloads remain coherent.

### Keep permission behavior consistent

If a route/target has permission checks, continuation should keep enforcing them using the caller's `metadata.eve_user_id` (same convention as current routing), not silently bypass them because the thread already exists.

### Do not make org threads chat-continuable in this phase

Org threads are used for coordination and cross-project workflows. They do not currently map cleanly onto project chat dispatch and should remain out of scope here.

## Tests

Add integration coverage for the cases that are easy to miss:

### Test 1: Route-based thread continues by Eve `thread_id`

1. Call `POST /projects/:id/chat/simulate`
2. Capture `thread_id`
3. Call `POST /threads/:thread_id/chat`
4. Assert same `thread_id` is returned
5. Assert both inbound messages exist on the same thread
6. Assert follow-up job includes `thread_context`

### Test 2: Continuation preserves original target

1. Start a thread through a route that resolves to `team:ops`
2. Change synced `chat.yaml` so the same text would now match a different route
3. Continue the original thread by `thread_id`
4. Assert the continuation still dispatches to the stored target from the thread metadata

This is the regression the original plan missed.

### Test 3: Direct agent and direct team threads continue correctly

1. Create one thread through direct agent routing
2. Create one thread through direct team routing
3. Continue both via `POST /threads/:thread_id/chat`
4. Assert neither path falls back to `chat.yaml`

### Test 4: Legacy / non-continuable thread handling

1. Create or seed a project thread without continuation metadata
2. Call `POST /threads/:thread_id/chat`
3. Assert `409` with a clear error

### Test 5: Response includes `thread_key`

Assert all chat route responses now include `thread_key` when known.

### Test 6: Thread stream

1. Open `GET /threads/:thread_id/stream`
2. Assert snapshot event
3. Append or dispatch a new message
4. Assert `message` event arrives

### Test 7: Auth behavior

1. Caller with `threads:write` but without `chat:write` should be rejected
2. Job token for a different project should be rejected
3. Valid project member with `chat:write` should succeed

## Migration & Compatibility

No database migration is required if this reuses `threads.metadata_json`.

Compatibility notes:

- Existing simulate/route endpoints remain unchanged
- `thread_key` addition is backward compatible
- Legacy threads may not be continuation-capable until a new routed message refreshes their metadata

Recommended behavior for legacy data:

- write continuation metadata on every new routed message, not just on thread creation
- reject continuation for threads that still lack the metadata, rather than guessing

## Non-Goals

- Do not change Slack/gateway threading semantics
- Do not conflate provider `thread_id` with Eve `thread_id`
- Do not add WebSocket transport for this feature
- Do not make org/co-ordination threads chat-continuable in Phase 1
- Do not reroute an existing thread against the latest `chat.yaml`

## File Change Summary

| File | Change |
| --- | --- |
| `packages/shared/src/schemas/agent-primitives.ts` | Add `ThreadChatRequestSchema`, extend `ChatRouteResponseSchema` |
| `apps/api/src/threads/threads.controller.ts` | Add `POST :thread_id/chat` and `GET :thread_id/stream` |
| `apps/api/src/chat/chat.service.ts` | Persist continuation metadata; add continuation dispatch helpers |
| `apps/api/src/threads/threads.service.ts` | Add thread stream support if implemented there |
| `packages/cli/src/commands/chat.ts` | Add `send` subcommand and emit `thread_key` |
| `packages/cli/src/commands/thread.ts` | Prefer SSE in `follow`, keep polling fallback |
| `packages/cli/src/lib/help.ts` | Document `eve chat send` and updated follow behavior |
| `docs/system/threads.md` | Document continuation endpoint and stream |
| `docs/system/chat-routing.md` | Document continuation semantics and target preservation |
| `docs/system/chat-gateway.md` | Clarify provider thread handle vs Eve `thread_id` |
| `docs/system/openapi.yaml` / `docs/system/openapi.json` | Regenerate after API/schema changes |

## Sequencing

1. **Phase 1**: continuation metadata + `POST /threads/:thread_id/chat` + `thread_key` response + tests
2. **Phase 2**: thread SSE stream + CLI follow update
3. **Phase 3**: `eve chat send` UX polish and docs

Phase 1 is the actual platform fix. Phases 2-3 remove the polling and CLI ergonomics gaps around it.

## Success Criteria

After implementation, this must work:

```bash
# 1. Start a conversation through existing routing
RESULT=$(eve chat simulate --team-id T123 --text "hello" --json)
THREAD_ID=$(echo "$RESULT" | jq -r '.thread_id')

# 2. Continue the same conversation by Eve thread ID
eve chat send --thread "$THREAD_ID" --text "what about tests?" --json

# 3. The continuation stays on the same conversation target
# and the new job receives thread_context

# 4. Follow the thread without client-side polling glue
eve thread follow "$THREAD_ID"
```

If the caller wants a different routing decision, it should open a new thread instead of reusing the old one.
