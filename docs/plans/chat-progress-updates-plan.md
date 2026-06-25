# Chat Progress Updates — Real-Time Agent Status to Channels

> **Status**: Implemented (2026-03-11, commit b537370)
> **Created**: 2026-03-10
> **Scope**: agent-runtime, API, shared schemas
> **Depends on**: [agent-runtime-feature-parity-plan.md](./agent-runtime-feature-parity-plan.md) (EveMessageRelay must exist on agent-runtime first)
> **Relates to**: [chat-outbound-delivery-plan.md](./chat-outbound-delivery-plan.md), [agent-team-coordination-plan.md](./agent-team-coordination-plan.md)

## Problem

When a user sends a message to an agent via Slack, they see "Job routed! ID: xyz" and then... silence. The agent may work for 2–10 minutes before posting a final result. During that time, the user has zero visibility into what's happening.

The outbound delivery pipeline (merged in `0e43841`) solved the **result** path. This plan solves the **progress** path.

```
User: @eve pm "analyze last week's metrics"
Eve:  Job routed! ID: proj-a3f2dd12

         ← 7 minutes of silence →

Eve:  Here are your metrics...
```

**What we want:**

```
User: @eve pm "analyze last week's metrics"
Eve:  Job routed! ID: proj-a3f2dd12
Eve:  📊 Pulling metrics data from the warehouse...       ← NEW
Eve:  📊 Found 847 records, analyzing trends...           ← NEW
Eve:  Here are your metrics...
```

## Goals

1. Agents can send progress updates to the originating Slack thread (or any chat channel) **during** execution
2. Uses the existing `eve-message` fenced-block mechanism — no new harness protocol
3. Works for both single-agent jobs and team dispatch child jobs
4. Rate-limited to prevent Slack spam and API exhaustion
5. No new infrastructure (reuses the delivery pipeline from chat outbound delivery)

## Non-Goals

- Streaming token-by-token to Slack (too noisy, Slack isn't a terminal)
- Automatic progress updates injected by the system (agent decides when to update)
- Interactive control via Slack replies during execution (future: wake subscriptions)
- Delivery retry with backoff (same fire-and-forget semantics as result delivery)

## Design

### Prerequisite: EveMessageRelay on Agent-Runtime

All agent jobs (including chat) route to the **agent-runtime**, not the worker. See `docs/plans/agent-runtime-feature-parity-plan.md`. The `EveMessageRelay` must be ported to the agent-runtime before this plan can be implemented.

### How It Works Today

The `EveMessageRelay` class exists on the worker (`apps/worker/src/invoke/invoke.service.ts:381-484`) but **never runs for agent jobs** because `EVE_AGENT_RUNTIME_URL` is always set, routing all agent jobs to the agent-runtime. The agent-runtime has no message relay.

Once ported to the agent-runtime, the relay will:
1. Parse `eve-message` fenced blocks from streaming harness output
2. Rate-limit to 1 message per 5 seconds
3. Write messages to the coordination thread (internal, for team dispatch visibility)

But it needs two additions for progress updates:
- Remove the `if (!this.parentJobId) return;` guard — allow single-agent jobs to emit messages
- Add external delivery — route messages to the originating chat channel via the delivery pipeline

### What Changes

Extend `EveMessageRelay` (on the agent-runtime) to also deliver to the originating chat channel when the job was chat-initiated.

```
Harness emits ```eve-message block
          ↓
Agent-Runtime EveMessageRelay detects it
          ↓
     ┌────┴────────────────────┐
     ↓                         ↓
Coordination thread        Chat channel
(existing, if team job)    (NEW, if chat job)
     ↓                         ↓
DB write only              POST /internal/.../chat/deliver
                               ↓
                           API → Gateway → Slack thread
```

### Architecture: Agent-Runtime-Side Delivery

The agent-runtime is the right place to trigger progress delivery because:
- It runs ALL agent jobs (the worker does not)
- It already streams harness output via readline
- It has DB access to look up job hints (thread_id, labels)
- It has access to `EVE_API_URL` and internal API key for the delivery endpoint

Alternative considered: having the agent call the API directly via job token. Rejected because:
- Job tokens aren't fully wired yet
- Requires every harness to understand the API
- `eve-message` blocks work across all harnesses (any LLM can emit markdown fences)

### Data Model Changes

**Schema** (`ChatDeliverRequestSchema`): Make `job_id` optional and add `progress` flag.

```typescript
export const ChatDeliverRequestSchema = z.object({
  job_id: z.string().min(1).optional(),   // optional for progress messages
  thread_id: z.string().min(1),
  text: z.string().min(1),
  agent_id: z.string().optional(),
  progress: z.boolean().optional(),       // NEW: marks this as a progress update
});
```

**Database**: No schema changes. Progress messages are stored as `thread_messages` with:
- `direction = 'outbound'`
- `job_id = NULL` (no idempotency constraint — multiple progress messages per job allowed)
- `delivery_status` tracked as usual

The existing unique index `idx_thread_messages_job_outbound_unique` only applies `WHERE job_id IS NOT NULL`, so `NULL` job_id rows bypass it naturally.

### Rate Limiting

| Context | Interval | Max Messages | Rationale |
|---|---|---|---|
| Coordination thread | 5s | unlimited | Internal, no API limits |
| Chat delivery (progress) | 30s | 10 per job | Slack rate limits, user experience |

30-second intervals for chat delivery prevent noise. A 10-minute job gets at most ~10 updates, which feels right. The max cap prevents runaway agents from flooding channels.

### Message Format

Agents emit progress updates as `eve-message` fenced blocks:

```
```eve-message
📊 Pulling metrics data from the warehouse...
```
```

For structured progress (optional, for future rich formatting):

```
```eve-message
{"kind":"progress","body":"Found 847 records, analyzing trends..."}
```
```

The relay treats any `eve-message` block content as the progress text. If the content is valid JSON with a `body` field, it extracts the body. Otherwise, the raw content is the message text.

## Implementation

### Phase 1: Extend EveMessageRelay

**File**: `apps/agent-runtime/src/invoke/invoke.service.ts`

After the EveMessageRelay is ported from the worker (see agent-runtime-feature-parity-plan.md), add chat context to the relay constructor and a second delivery path:

```typescript
class EveMessageRelay {
  private buffer: string[] | null = null;
  private lastCoordRelayTime = 0;
  private lastChatDeliveryTime = 0;
  private chatDeliveryCount = 0;
  private threadMessages: ReturnType<typeof threadMessageQueries>;

  // Chat delivery config
  private static CHAT_DELIVERY_INTERVAL_MS = 30_000;
  private static CHAT_DELIVERY_MAX_PER_JOB = 10;

  constructor(
    private db: Db,
    private jobId: string,
    private parentJobId: string | null,
    private assignee: string | null,
    // NEW: chat delivery context
    private chatContext: {
      threadId: string | null;
      projectId: string;
      isChatJob: boolean;
    } | null = null,
  ) {
    this.threadMessages = threadMessageQueries(db);
  }

  // ... processLine() and processEvent() unchanged ...

  private async relay(body: string): Promise<void> {
    if (!body.trim()) return;

    // Path 1: Coordination thread relay (existing behavior)
    if (this.parentJobId) {
      await this.relayToCoordinationThread(body);
    }

    // Path 2: Chat channel delivery (NEW)
    if (this.chatContext?.isChatJob && this.chatContext.threadId) {
      await this.deliverToChat(body);
    }
  }

  private async relayToCoordinationThread(body: string): Promise<void> {
    // ... existing relay() logic, with parentJobId check moved here ...
  }

  private async deliverToChat(body: string): Promise<void> {
    // Rate limit (30s for chat)
    const now = Date.now();
    if (now - this.lastChatDeliveryTime < EveMessageRelay.CHAT_DELIVERY_INTERVAL_MS) {
      console.log(`[eve-message] Chat delivery rate-limited for job ${this.jobId}`);
      return;
    }

    // Max messages cap
    if (this.chatDeliveryCount >= EveMessageRelay.CHAT_DELIVERY_MAX_PER_JOB) {
      console.log(`[eve-message] Chat delivery max reached for job ${this.jobId}`);
      return;
    }

    // Size limit (keep progress messages short for chat)
    const maxLen = 500;
    const text = body.length > maxLen
      ? body.slice(0, maxLen) + '...'
      : body;

    // Extract body from JSON if structured
    let displayText = text;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.body === 'string') {
        displayText = parsed.body;
      }
    } catch { /* not JSON, use raw text */ }

    this.lastChatDeliveryTime = now;
    this.chatDeliveryCount++;

    try {
      const config = loadConfig();
      const url = `${config.EVE_API_URL}/internal/projects/${this.chatContext!.projectId}/chat/deliver`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-eve-internal-token': config.EVE_INTERNAL_API_KEY ?? '',
        },
        body: JSON.stringify({
          thread_id: this.chatContext!.threadId,
          text: displayText,
          agent_id: this.assignee ?? undefined,
          progress: true,
        }),
      });

      if (!response.ok) {
        const respBody = await response.text();
        console.error(`[eve-message] Chat delivery failed for job ${this.jobId}: HTTP ${response.status} — ${respBody}`);
        return;
      }

      console.log(`[eve-message] Delivered progress to chat thread for job ${this.jobId}`);
    } catch (err) {
      console.error(`[eve-message] Chat delivery error for job ${this.jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
```

### Phase 2: Update Relay Instantiation

**File**: `apps/agent-runtime/src/invoke/invoke.service.ts`

The agent-runtime has the invocation. We need to look up the job's hints and labels to determine chat context:

```typescript
// Before constructing EveMessageRelay, look up chat context
const jobRow = await this.db<{ hints: Record<string, unknown> | null; labels: string[] | null }[]>`
  SELECT hints, labels FROM jobs WHERE id = ${invocation.jobId}
`;
const jobHints = jobRow[0]?.hints ?? {};
const jobLabels = jobRow[0]?.labels ?? [];
const isChatJob = jobLabels.includes('chat');
const chatThreadId = typeof jobHints.thread_id === 'string' ? jobHints.thread_id : null;

const messageRelay = new EveMessageRelay(
  this.db,
  invocation.jobId,
  invocation.parentJobId ?? null,
  invocation.agentId ?? null,
  // NEW: chat context
  {
    threadId: chatThreadId,
    projectId: invocation.projectId,
    isChatJob,
  },
);
```

### Phase 3: Update API Delivery Endpoint

**File**: `packages/shared/src/schemas/agent-primitives.ts`

```typescript
export const ChatDeliverRequestSchema = z.object({
  job_id: z.string().min(1).optional(),   // optional for progress
  thread_id: z.string().min(1),
  text: z.string().min(1),
  agent_id: z.string().optional(),
  progress: z.boolean().optional(),       // NEW
});
```

**File**: `apps/api/src/chat/chat.service.ts`

Modify `deliverChatResult()` to handle progress messages:

```typescript
async deliverChatResult(input: {
  projectId: string;
  job_id?: string;          // optional for progress
  thread_id: string;
  text: string;
  agent_id?: string;
  progress?: boolean;       // NEW
}): Promise<{ delivered: boolean; message_id?: string; error?: string }> {
  const thread = await this.threads.findById(input.thread_id);
  if (!thread) {
    return { delivered: false, error: `Thread ${input.thread_id} not found` };
  }

  if (input.progress) {
    // Progress messages: no idempotency guard, no job_id
    const outbound = await this.threadMessages.create({
      id: crypto.randomUUID(),
      thread_id: input.thread_id,
      direction: 'outbound',
      actor_type: 'agent',
      actor_id: input.agent_id ?? null,
      body: input.text,
      job_id: null,
    });

    // Deliver to gateway (same path as result delivery)
    return this.deliverToGateway(thread, outbound, input.text);
  }

  // ... existing result delivery logic (idempotent by job_id) ...
}
```

### Phase 4: Harness Prompt Integration

**File**: `packages/shared/src/harnesses/security-policy.ts`

Add progress update guidance to the system prompt preamble injected into all harnesses:

```
## Progress Updates

When working on chat-initiated tasks, you can send progress updates to the user's channel
by emitting eve-message fenced blocks:

\`\`\`eve-message
Currently analyzing the authentication flow...
\`\`\`

Use progress updates for:
- Acknowledging receipt of complex requests ("Looking into this...")
- Milestone completions ("Found the issue, now working on a fix...")
- Long-running tasks (every few minutes of work)

Do NOT use progress updates for:
- Every minor step (too noisy)
- Internal reasoning or debugging notes
- Asking questions (use the final result for that)
```

## Files Modified

| File | Change |
|---|---|
| `apps/agent-runtime/src/invoke/invoke.service.ts` | Add `EveMessageRelay` with chat delivery path (ported from worker + extended); wire into `rl.on('line')` handler |
| `packages/shared/src/schemas/agent-primitives.ts` | Make `job_id` optional in `ChatDeliverRequestSchema`, add `progress` field |
| `apps/api/src/chat/chat.service.ts` | Handle `progress` flag: create outbound without job_id, deliver to gateway |
| `packages/shared/src/harnesses/security-policy.ts` | Add progress update guidance to system prompt preamble |

## Verification

1. **Unit test**: EveMessageRelay delivers to chat when `isChatJob=true` and `threadId` is set
2. **Unit test**: Rate limiting — second message within 30s is dropped
3. **Unit test**: Max cap — 11th message is dropped
4. **Unit test**: Non-chat jobs don't trigger chat delivery (only coordination thread)
5. **Integration test**: Full round-trip — chat job emits `eve-message` block → message appears in thread_messages with delivery_status
6. **Manual test**: Slack message → agent emits progress → progress appears in Slack thread before final result

```bash
# Manual verification
eve org ensure manual-test-org --slug manual-test-org
# In Slack: @eve pm "do a thorough analysis of the project structure"
# Watch for progress messages in the Slack thread
# Then verify via CLI:
eve thread messages <thread_id>
# Should show: progress messages (no job_id, delivered) + final result (with job_id, delivered)
```

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Slack rate limiting (1 msg/sec/channel) | 30s minimum interval between progress deliveries |
| Noisy agents flooding channels | 10 message cap per job; 500 char limit on progress text |
| Delivery failures blocking execution | Fire-and-forget; errors logged but don't affect job |
| Gateway down during long job | Progress messages lost silently; final result delivery is independent |

## Future Extensions

- **Configurable intervals**: Per-agent or per-team rate limit overrides in agents.yaml
- **Slack message editing**: Update a single "status" message instead of posting new ones
- **Rich progress**: Slack blocks with progress bars, task lists, etc.
- **Interactive progress**: User replies to progress message → agent receives mid-job
