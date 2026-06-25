# Chat Outbound Delivery

> **Status**: Implemented (2026-03-10, commit 0e43841)
> **Created**: 2026-03-10
> **Scope**: orchestrator, gateway, API, db migrations
> **Relates to**: [chat-gateway-slack-plan.md](./chat-gateway-slack-plan.md), [agent-aliases-plan.md](./agent-aliases-plan.md)

## Problem

When a user sends a message to an agent via Slack, the gateway creates a job and replies with "Job routed! ID: xyz". The agent executes, produces a result, and the orchestrator marks the job as done. But the result is never posted back to the Slack thread. The user has to run `eve job result <id>` to see the response.

The inbound path is complete. The outbound path is a dead end.

```
Slack → Gateway → API → Job → Agent executes → Result stored → ???
                                                                 ↓
                                                    (never reaches Slack)
```

## Goals

1. Agent replies appear in the same Slack thread that triggered the job
2. Works for all providers (Slack, Nostr, WebChat) — same mechanism
3. Failures are visible and debuggable via CLI
4. No new infrastructure (no Redis, no message queue) — use what we have

## Non-Goals

- Streaming partial responses to Slack (future)
- Multi-message conversations within a single job (future)
- Rich formatting / Slack blocks (future — plain text first)
- Retry with exponential backoff (keep it simple, log failures)

## Design

### Architecture: Orchestrator Push → API → Gateway

The orchestrator already knows when jobs complete. It should tell the API, which tells the gateway to deliver. This follows the existing communication pattern: services talk through the API.

```
Orchestrator                    API                         Gateway
     │                           │                            │
     │ job done + has thread_id  │                            │
     ├──► POST /internal/projects/{project_id}/chat/deliver
     │    deliver                 │                            │
     │                           ├──► POST /gateway/internal/deliver
     │                           │    deliver                  │
     │                           │                            ├──► provider.sendMessage()
     │                           │                            │    (Slack/Nostr/WebChat)
     │                           │                            │
     │                           │◄── delivery result ────────┤
     │◄── ack ───────────────────┤                            │
```

**Why not gateway polling?** Polling adds latency, wastes cycles when no jobs are completing, and requires the gateway to understand job lifecycle. Push is simpler.

**Why not orchestrator → gateway direct?** The API owns thread/provider resolution. The orchestrator doesn't know which provider or credentials to use. The API is the single gateway — honor that.

### Data Flow

1. **Job completes** → orchestrator's `markJobDone()` path
2. **Check for chat origin** → job has `hints.thread_id` + label `chat`
3. **Read result** → use `result.resultText`; fallback to `extractEveControl(result.resultJson).summary` if absent
4. **Call API** → `POST /internal/projects/${projectId}/chat/deliver` with `{ job_id, thread_id, text, ...(agent_id?) }`
5. **API resolves delivery target** → thread → `metadata_json`; fallback parse key and/or current job metadata if metadata missing
6. **API calls gateway** → `POST /gateway/internal/deliver` with full `OutboundTarget` + content using `x-eve-internal-token`
7. **Gateway sends** → `provider.sendMessage(target, content)`
8. **Record outcome** → thread_message with direction `outbound` + delivery status

### Thread Key → Delivery Target Resolution

Thread keys currently contain:

```
key = "T06ABCDEF:C0AKFH4HXNF:1773141918.681009"
       ^^^^^^^^^  ^^^^^^^^^^^  ^^^^^^^^^^^^^^^^
       account_id  channel      thread_id
```

The thread record also stores `channel` directly. We still need explicit provider/account context, so delivery should use a thread-level metadata payload.

Options:

- **Option A (recommended)**: keep key parsing for legacy fallback only.
- **Option B**: add provider/account fields as discrete columns (not needed for V1 if `metadata_json` is used consistently).

For V1, use `metadata_json` as the authoritative source and fallback to key parsing only for legacy rows.

### Thread Metadata Enhancement

Add a `metadata_json` column to `threads` to store provider-specific delivery info:

```json
{
  "provider": "slack",
  "account_id": "T06ABCDEF",
  "channel_id": "C0AKFH4HXNF",
  "thread_id": "1773141918.681009"
}
```

This is set when the thread is created from an inbound message. The outbound delivery reads it and updates it if routing context changes (e.g., channel switch, provider route migration).

### Delivery Status Tracking

Add a `delivery_status` column to `thread_messages`:

```sql
ALTER TABLE thread_messages
  ADD COLUMN delivery_status TEXT,        -- 'pending' | 'delivered' | 'failed'
  ADD COLUMN delivery_error TEXT,         -- error message if failed
  ADD COLUMN delivered_at TIMESTAMPTZ;    -- when delivery succeeded
```

Outbound messages from chat jobs start as `pending`. The gateway updates to `delivered` or `failed`.

Internal coordination messages (team dispatch relays) stay `NULL` — they're never delivered externally.

### Message Truncation

Slack has a 4000-character limit per message. Agent results can be much longer.

Strategy:
- If result ≤ 3900 chars: send as-is
- If result > 3900 chars: truncate with `"...\n\n[Truncated — full result: eve job result {job_id}]"`
- Future: split into multiple messages or use Slack file upload for long results

## Implementation

### Phase 1: Database Migration

**File**: `packages/db/migrations/00077_chat_outbound_delivery.sql`

```sql
-- Add delivery tracking to thread_messages
ALTER TABLE thread_messages
  ADD COLUMN IF NOT EXISTS delivery_status TEXT,
  ADD COLUMN IF NOT EXISTS delivery_error TEXT,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- Add provider metadata to threads for outbound routing
ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS metadata_json JSONB;

-- Index for pending deliveries (gateway polling fallback)
CREATE INDEX IF NOT EXISTS idx_thread_messages_pending_delivery
  ON thread_messages(thread_id, job_id, delivery_status)
  WHERE delivery_status = 'pending';

-- Prevent duplicate outbound rows per job (idempotency guard)
CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_messages_job_outbound_unique
  ON thread_messages(job_id)
  WHERE direction = 'outbound' AND job_id IS NOT NULL;

-- Backfill null metadata values for older threads
UPDATE threads
SET metadata_json = COALESCE(metadata_json, '{}'::jsonb)
WHERE metadata_json IS NULL;
```

### Phase 2: API Chat Delivery Endpoint

**File**: `apps/api/src/chat/chat.internal.controller.ts`

New internal endpoint:

```typescript
// POST /internal/projects/:project_id/chat/deliver
async deliverOutbound(
  @Param('project_id') projectId: string,
  @Headers('x-eve-internal-token') token: string | undefined,
  @Body(new ZodValidationPipe(ChatDeliverRequestSchema)) body: ChatDeliverRequest,
) {
  this.requireInternalToken(token);

  return this.chatService.deliverChatResult({
    projectId,
    job_id: body.job_id,
    threadId: body.thread_id,
    text: body.text,
    agentId: body.agent_id,
  });
}

// Supporting service API in chat.service.ts
async deliverChatResult(input: {
  projectId: string;
  job_id: string;
  thread_id: string;
  text: string;
  agent_id?: string;
}) {
  // 1. Load thread, extract metadata_json (fallback parse key for legacy)
  // 2. Create outbound thread_message with delivery_status = 'pending' (idempotent by job_id)
  // 3. Forward to gateway: POST /gateway/internal/deliver
  // 4. Update delivery_status / delivered_at / delivery_error
  // 5. Return outbound message row for operator visibility
}
```

### Phase 3: API Stores Thread Metadata on Inbound

**File**: `apps/api/src/chat/chat.service.ts`

When `recordThreadAndEvent()` creates or updates a thread, store provider metadata:

```typescript
// In recordThreadAndEvent():
const metadata = {
  provider: data.provider,
  account_id: data.account_id,
  channel_id: data.channel_id,
  thread_id: data.thread_id,
  user_id: data.user_id,
};

// On create:
thread = await this.threads.create({
  ...existing,
  metadata_json: metadata,
});

// On existing thread: keep metadata current for routing safety
await this.threads.updateMetadata(thread.id, metadata);
```

### Phase 4: Gateway Internal Delivery Endpoint

**File**: `apps/gateway/src/internal/chat-delivery.controller.ts` (new) + `apps/gateway/src/app.module.ts`

The existing webhook controller is path-scoped to `/gateway/providers`, so a new internal controller avoids mixing webhook and internal routes.

```typescript
// POST /gateway/internal/deliver
async handleDelivery(
  @Headers('x-eve-internal-token') token: string | undefined,
  @Body() body: {
    provider: string;
    account_id: string;
    channel_id: string;
    thread_id?: string;
    text: string;
  },
) {
  if (!token) {
    throw new UnauthorizedException('Missing internal token');
  }

  const provider = this.providerRegistry.getByProvider(body.provider);
  if (!provider) throw new Error(`Unknown provider: ${body.provider}`);

  const target: OutboundTarget = {
    provider: body.provider,
    accountId: body.account_id,
    channel: body.channel_id,
    threadId: body.thread_id,
  };

  await provider.sendMessage(target, { text: body.text });
  return { delivered: true };
}
```

### Phase 5: Orchestrator Triggers Delivery

**File**: `apps/orchestrator/src/loop/loop.service.ts`

After `markJobDone()` in the success path (~line 1737), add:

```typescript
await jobs.markJobDone(job.id);
console.log(`Marked job ${job.id} as done`);
attemptSucceeded = true;

// --- NEW: Deliver result to chat thread if this was a chat-originated job ---
void this.deliverChatResult(job, result);
```

New private method:

```typescript
private async deliverChatResult(
  job: { id: string; project_id: string; org_id?: string; hints: Record<string, unknown> | null; labels: string[] | null },
  result: { resultText?: string; resultJson?: Record<string, unknown> } | undefined,
): Promise<void> {
  // Only for chat-originated jobs
  const labels = job.labels ?? [];
  if (!labels.includes('chat')) return;

  const threadId = (job.hints as Record<string, unknown>)?.thread_id as string | undefined;
  if (!threadId) return;

  const text =
    result?.resultText?.trim() ||
    extractEveControl(result?.resultJson).summary ||
    'Job completed with no output.';

  try {
    await this.apiClient.post(
      `/internal/projects/${job.project_id}/chat/deliver`,
      { job_id: job.id, thread_id: threadId, text, agent_id: (job as { agent_id?: string })?.agent_id },
    );
    console.log(`Delivered chat result for job ${job.id} to thread ${threadId}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Failed to deliver chat result for job ${job.id}: ${msg}`);
    // Don't throw — delivery failure shouldn't block job completion
  }
}
```

### Phase 6: CLI Visibility

**File**: `packages/cli/src/commands/thread.ts`

`eve thread messages <thread_id>` already exists. Update its formatter to include delivery status and failure reason:

```
$ eve thread messages thr_01kkbqx2kheh2vbb9kd99z28et

Thread: thr_01kkbqx2kheh2vbb9kd99z28et
Channel: C0AKFH4HXNF (slack)

  [2026-03-10 09:31] ← user: @pm hello, summarize today's issues
  [2026-03-10 09:31] → system: Job routed! ID: proj_xxx-ca4730a4
  [2026-03-10 09:33] → agent(pm): Here's a summary of today's issues...  ✓ delivered
```

## Files Modified

| File | Change |
| --- | --- |
| `packages/db/migrations/00077_chat_outbound_delivery.sql` | New migration: delivery columns + thread metadata |
| `packages/db/src/queries/threads.ts` | Add `updateMetadata()`, add thread-message delivery status fields, and status helper methods |
| `apps/api/src/chat/chat.service.ts` | Store `metadata_json` on thread creation, create/update outbound delivery records |
| `apps/api/src/chat/chat.internal.controller.ts` | New `POST /internal/projects/:project_id/chat/deliver` endpoint |
| `apps/gateway/src/internal/chat-delivery.controller.ts` | New `POST /gateway/internal/deliver` endpoint |
| `apps/gateway/src/app.module.ts` | Register internal delivery controller |
| `apps/orchestrator/src/loop/loop.service.ts` | Call `deliverChatResult()` after `markJobDone()` |
| `packages/shared/src/schemas/agent-primitives.ts` | Extend thread message schemas with delivery fields |
| `apps/api/src/threads/threads.service.ts` | Include delivery fields in thread message response |
| `packages/cli/src/commands/thread.ts` | Show delivery status and failure reason in `thread messages` |

## Verification

1. **Unit test**: Orchestrator calls delivery for chat jobs, skips non-chat jobs
2. **Integration test**: Full round-trip — create chat job, complete it, verify thread_message delivery_status
3. **Integration test**: Ensure duplicate delivery attempts are deduplicated by `job_id` (idempotent) and do not create duplicate outbound rows
4. **Integration test**: Legacy thread fallback parses old key format when `metadata_json` is absent
5. **Manual test**: Send Slack message → agent replies in same thread
6. **Failure test**: Gateway down → delivery_status = 'failed', error logged, job still marked done
7. **Contract test**: `POST /internal/projects/:project_id/chat/deliver` with missing/invalid `x-eve-internal-token` returns 401
8. **Contract test**: `POST /gateway/internal/deliver` without `provider`/`account_id`/`channel_id` returns 400

```bash
# Manual verification
eve org ensure manual-test-org --slug manual-test-org
# Send a message in Slack: @eve pm hello
# Wait for job to complete
eve job list --all --phase done | head -5
eve thread messages <thread_id>   # Should show delivered outbound message
# Check Slack thread — agent reply should appear
```

## Alternatives Considered

**Gateway polling**: Gateway periodically queries for pending outbound messages. Rejected — adds latency (polling interval), wastes resources, and the gateway shouldn't need to understand job lifecycle.

**WebSocket event bus**: Real-time push via WebSocket between orchestrator and gateway. Over-engineered for v1 — HTTP POST is sufficient and simpler to debug.

**Orchestrator calls Slack directly**: Rejected — violates the architecture (API is single gateway). Orchestrator doesn't have provider credentials and shouldn't.

**Store result in thread_messages, let gateway poll**: Hybrid approach. Rejected for v1 — push is simpler. Could add polling as a fallback later (the `idx_thread_messages_pending_delivery` index supports this).

## Future Extensions

- **Streaming**: Post partial results as the agent works (requires harness log streaming → gateway)
- **Rich formatting**: Slack blocks, markdown rendering, code fences
- **Multi-message**: Split long results into multiple Slack messages
- **File attachments**: Agent produces files → upload to Slack
- **Delivery retry**: Exponential backoff for transient Slack API failures
- **Delivery webhook**: Notify external systems when delivery succeeds/fails
- **Read receipts**: Track when user has seen the reply (Slack read status)
