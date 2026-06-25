# Agent Team Coordination Plan

> Status: Plan
> Last Updated: 2026-02-08
> Purpose: Close inter-agent communication, active lead coordination, dispatch topology, and team visibility gaps by extending threads, the CLI/API surface, and team dispatch.
> Inputs: `docs/ideas/agent-team-coordination-gap-analysis.md`

## Dependencies

- `docs/plans/agents-teams-threads-primitives-plan.md` (Completed — agents, teams, threads tables)
- `docs/plans/unified-permissions-plan.md` (Phases 4-5 — agent CLI credentials via per-job token minting)
- `packages/shared/src/schemas/agent-config.ts` (TeamsYamlSchema, TeamDispatchSchema)
- `apps/worker/src/invoke/invoke.service.ts` (streaming output parser, result extraction)
- `apps/worker/src/invoke/env-builder.ts` (harness env allowlist)
- `apps/api/src/chat/chat.service.ts` (team dispatch, fanout job creation)
- `apps/orchestrator/src/loop/loop.service.ts` (job claiming, waiting/deferral logic)
- `packages/db/src/queries/jobs.ts` (job queries, requeueReady, isBlocked)

## Parallel Implementation: Auth Migration Coordination

> **Important**: The unified permissions plan (`docs/plans/unified-permissions-plan.md`)
> is being implemented in parallel with this coordination work. It replaces the dual
> RBAC + scopes system with a single `@RequirePermission` decorator and `PermissionGuard`.
>
> **Rules for coordination implementers:**
>
> 1. **Do NOT use `@RequireRole` or `@RequireScope`** on new endpoints — both are
>    being replaced by `@RequirePermission`.
> 2. **New endpoints** should use `@RequirePermission` with the appropriate permission:
>    - Thread read endpoints: `@RequirePermission('threads:read')`
>    - Thread write endpoints: `@RequirePermission('threads:write')`
>    - Supervision endpoint: `@RequirePermission('jobs:read')`
>    - Job context extensions: `@RequirePermission('jobs:read')`
> 3. **The internal minting endpoint already exists**: `POST /internal/auth/mint-job-token`
>    in `apps/api/src/auth/auth.internal.controller.ts`. Use it for worker-side token minting.
> 4. **Job token claims** now include `project_id`, `job_id`, `sub`, and `permissions[]`
>    (currently `scopes[]`, will be renamed during auth migration Phase 3).
> 5. **Files the auth migration will touch**: All controllers (adding `@RequirePermission`),
>    `rbac.guard.ts` (replaced), `rbac.decorator.ts` (replaced), `auth.module.ts`.
>    Avoid modifying these files for coordination work — add new files/endpoints instead.

## Goals

- **Inter-agent messaging**: Agents in a team dispatch can share findings, challenge conclusions, and coordinate strategy mid-execution via coordination threads.
- **Active lead coordination**: Lead agents stay alive in their pod and react to child events in real-time, avoiding cold-start penalties on each wake.
- **Dispatch topologies**: `council` (N agents analyze same problem, lead synthesizes) and `relay` (sequential specialist chain) as first-class dispatch modes.
- **Team visibility**: Agents see their siblings' status and progress via the existing job context endpoint.
- **Human participation**: Users can post to coordination threads via Slack or CLI, steering agents mid-flight.
- **Minimal new surface area**: Extend existing primitives (threads, jobs, control envelope) rather than creating new services or tables.

## Non-Goals

- Separate message queue / mailbox system (threads already do this).
- Agent-to-agent RPC (async thread model is better for distributed agents).
- Raw API keys in harness env (security boundary stays intact).
- Shared mutable task list with locking (orchestrator centrally assigns work).
- Split-pane terminal multiplexing (`eve thread follow` + multiple `eve job follow` suffice).
- Session-scoped teams (Eve teams are persistent and config-driven).
- Agent CLI auth wiring (prerequisite handled by `unified-permissions-plan.md`).

---

## Design

### Extension 1: Coordination Threads + Dual Messaging

Every dispatch group gets a coordination thread. Agents communicate
through two complementary channels:

1. **Eve CLI** (primary, once unified auth Phases 4-5 land): `eve thread post`
   and `eve thread messages` for explicit, intentional coordination.
2. **Worker-mediated relay** (complement): `eve-message` fenced blocks
   in harness output, parsed and relayed by the worker. Works before
   CLI auth is wired, and useful for quick mid-stream status updates.

#### Thread Key Convention

Thread key: `coord:job:{parent_job_id}`. Lookup via `threads.project_id
+ threads.key` (already unique). Thread created lazily on first message
or at dispatch time.

No new database column on `jobs`. If a fast-path is needed later, cache
the thread ID in `jobs.hints.coordination.thread_id`.

#### Three Messaging Channels

**Channel 1: Direct CLI (primary, requires unified auth Phases 4-5)**

```bash
# Post a finding
eve thread post coord:job:$EVE_PARENT_JOB_ID \
  --body '{"kind":"finding","body":"Token middleware closes WS upgrade."}'

# Read recent messages
eve thread messages coord:job:$EVE_PARENT_JOB_ID --since 5m
```

Agents use the same CLI they already use for `eve job create` and
`eve job current`. Requires per-job token minting (unified auth
Phases 4-5) to populate `$HOME/.eve/credentials.json`.

**Channel 2: Worker-mediated relay (complement, works immediately)**

Define an `eve-message` fenced block convention in harness output:

````
```eve-message
{"kind":"finding","body":"Token middleware closes WS upgrade via res.end() when expired."}
```
````

The worker already parses streaming output for `json-result` blocks
(in `extractResultJson()` via `/```json-result\s*\n([\s\S]*?)\n```/g`).
Extending this to detect `eve-message` blocks is ~20 lines of parser
logic. Worker rate-limits (max 1 msg/5s per job, 4KB per message) and
inserts into `thread_messages`.

This channel is valuable even after CLI auth lands because:
- Zero API round-trip overhead (just emit text)
- Works as a bridge before unified auth Phases 4-5 are implemented
- Natural for quick status updates

**Channel 3: End-of-attempt relay (automatic, free)**

When a job attempt completes with `result_json.eve.summary`, the
worker posts it as a coordination message. Zero new harness behavior.

#### Message Shape

```json
{
  "kind": "finding|status|question|steer|handoff",
  "body": "string (<= 4KB)",
  "tags": ["optional", "strings"],
  "refs": { "job_id": "optional", "path": "optional" }
}
```

Store as the `body` field of `thread_messages` (JSON by convention).
If structure is needed later, add `thread_messages.meta_json JSONB`
(non-breaking).

#### Reading Messages

Three paths, depending on auth availability:

1. **Direct CLI read** (primary, requires unified auth Phases 4-5):
   `eve thread messages coord:job:$EVE_PARENT_JOB_ID --since 5m`

2. **Inbox file at attempt start** (works without CLI auth):
   Worker queries the coordination thread for recent messages and
   writes them to `.eve/coordination-inbox.md` in the workspace.

3. **Supervision response** (Extension 2): The `eve supervise` command
   returns an `inbox` field with recent messages.

#### Human Participation

The coordination thread is a regular thread. Humans can post via
Slack (if linked), the CLI (`eve thread post`), or the API. Messages
appear in the inbox on next supervision wake or CLI read.

#### CLI Commands

| Command | Description |
|---------|-------------|
| `eve thread messages <key-or-id> [--since ...]` | List messages |
| `eve thread post <key-or-id> --body <json>` | Post a message |
| `eve thread follow <key-or-id>` | SSE stream of messages |

#### What This Closes

| Gap | How |
|-----|-----|
| Gap 1 (inter-agent messaging) | `eve-message` blocks + CLI → thread messages |
| Gap 5 (real-time visibility) | `eve thread follow` streams team activity |
| Gap 6 (user steering) | Human posts to coordination thread |

---

### Extension 2: Stay-Alive Supervision (`eve supervise`)

The lead stays alive in its pod and blocks on an efficient long-poll
command while waiting for events — rather than returning control to the
orchestrator and suffering a full cold-start on each wake.

#### Why Not Return-and-Wake?

Each new attempt = new pod + workspace + hooks + harness init:

| Phase | Cost |
|-------|------|
| Pod creation + image pull | 30-60s |
| Pod readiness + health check | 10-35s |
| Git clone (shallow) | 5-30s |
| Hooks (`on-clone` + `on-acquire`) | 30s-5min |
| Harness init | 2-5s |
| **Total cold start** | **~1.5-6 min** |

A council of 5 agents where the lead wakes 5 times = 7.5-30 minutes of
pure pod startup overhead, plus the lead loses all conversation context
on each wake.

Stay-alive comparison:

| | Return-and-wake | Stay-alive |
|---|---|---|
| Wake latency | 1.5-6 min (cold start) | < 1s (CLI command returns) |
| Context | Lost (new attempt) | Preserved (same session) |
| Token cost per wake | High (re-read all) | Zero (continues in-context) |
| Pod cost while idle | $0 (no pod) | ~$0.001/min (idle pod) |
| 5 wakes over 30 min | $15-50 tokens + 7-30 min overhead | ~$0.03 pod time |

#### The Supervision Primitive

Once unified auth Phases 4-5 land, agents use the Eve CLI directly:

```bash
# Inside a supervising lead's skill:
eve supervise --timeout 60
```

The CLI command:
1. Reads `EVE_JOB_ID` from env (already in harness allowlist)
2. Calls the Eve API's long-poll endpoint with credentials from
   `$HOME/.eve/credentials.json` (populated by worker via unified auth)
3. Blocks until an event or timeout
4. Returns JSON to the harness

**Prerequisite**: Requires unified auth Phases 4-5 (see
`docs/plans/unified-permissions-plan.md`). The `eve supervise` command
authenticates using the per-job token in `$HOME/.eve/credentials.json`.

#### Supervision Response Shape

```json
{
  "events": [
    {
      "type": "child_complete",
      "job_id": "abc-123",
      "title": "Security review",
      "phase": "done",
      "result_summary": "Found 2 critical vulnerabilities"
    },
    {
      "type": "thread_message",
      "message_id": "msg-456",
      "actor": "perf_reviewer",
      "body": "FYI: the auth module allocates 50MB per request"
    }
  ],
  "children": {
    "total": 3,
    "done": 1,
    "active": 2,
    "cancelled": 0
  },
  "inbox": [
    "perf_reviewer: FYI: the auth module allocates 50MB per request",
    "user: Focus on the WebSocket connection drop issue"
  ]
}
```

On timeout with no events: `{ "events": [], "children": {...}, "inbox": [] }`

The `inbox` field includes recent coordination thread messages in
human-readable form, so the harness can process them immediately.

#### What Happens During the Block

While the supervision endpoint is waiting:

- **No Claude API tokens consumed** — the tool call is pending, no
  model inference happening. The harness process is alive but idle.
- **Pod sits idle** — minimal resource usage (~100m CPU, 256Mi RAM).
- **Conversation context preserved** — when the command returns, the
  harness continues with full history.

This is the same pattern as any long-running Bash tool call (e.g.,
`pnpm test` taking 5 minutes). The harness is designed for this.

#### API Backing: `GET /jobs/:id/supervise`

Long-poll semantics (same pattern as existing deferred jobs):

```
GET /jobs/:id/supervise?timeout=60&since=<cursor>
```

1. Query child jobs for any in terminal phase since `since`
2. Query coordination thread for messages since `since`
3. If events found: return immediately
4. If no events: poll DB every 2s until timeout or event
5. Return events (or empty array on timeout)

Long-term, use the **event spine** for wakeups instead of polling.
Thread message insertion already emits `chat.message.*` events. Add
`job.phase.terminal` events on child completion. But polling is fine
for v1.

#### Orchestrator Awareness

The orchestrator must know a job is supervising (not stuck). Set
`hints.supervising = true` on the lead job at dispatch time. The
orchestrator's orphan-detection logic skips jobs with this flag.

If orphan false-positives become a problem later, add heartbeat: each
`eve supervise` poll iteration updates `job_attempts.last_heartbeat_at`.

#### Skill Pattern for Supervision

The lead's skill instructions include a supervision loop:

```
## Supervision Protocol

After dispatching child jobs:

1. Post status to coordination thread
2. Enter supervision loop:
   a. Run: `eve supervise --timeout 60`
   b. Read the JSON result
   c. Read `inbox` for peer messages — respond or redirect
   d. For each child_complete event:
      - Assess the result_summary
      - Post synthesis/redirect to coordination thread
      - Spawn follow-up work if findings warrant it
   e. Check children.done == children.total → if yes, break
   f. Otherwise, loop back to (a)
3. Synthesize all findings into final result.
```

This is a **skill-level pattern**, not a platform primitive. Different
skills can implement different supervision strategies.

#### Complementary: Return-and-Wake via `eve.wait.wake_on`

For coordination that doesn't need sub-second latency (relay chains,
daily check-ins), extend the control envelope:

```json
{
  "eve": {
    "status": "waiting",
    "summary": "Dispatched 3 investigators; watching for findings.",
    "wait": {
      "wake_on": [
        { "type": "child.terminal" },
        { "type": "thread.message" }
      ],
      "backoff_ms": 5000
    }
  }
}
```

This augments `waiting` (no new status value) with explicit wake
conditions. The orchestrator clears `defer_until` when a matching
event arrives. Implementation uses the event spine — the orchestrator
matches incoming events to jobs with `wake_on` subscriptions.

**When to use which:**

| Pattern | Wake latency | Context | Pod cost while idle | Best for |
|---------|-------------|---------|-------------------|----------|
| Stay-alive (`eve supervise`) | < 1s | Preserved | ~$0.001/min | Active councils, real-time steering |
| Return-and-wake (`eve.wait`) | 1.5-6 min | Lost | $0 | Relay chains, daily check-ins, long waits |

#### Job Timeout Handling

Supervising jobs need extended timeouts. Dispatch logic sets
`hints.timeout_seconds` appropriately:

```yaml
teams:
  security_council:
    lead: lead_reviewer
    members: [security_reviewer, perf_reviewer, test_reviewer]
    dispatch:
      mode: council
      lead_timeout: 3600   # 1 hour for the supervising lead
      member_timeout: 1800  # 30 min per member
```

The orchestrator already respects `hints.timeout_seconds`.

#### What This Closes

| Gap | How |
|-----|-----|
| Gap 2 (active lead coordination) | Lead stays alive, reacts to events in real-time |

---

### Extension 3: Sibling Context

Enrich the job context endpoint so that jobs in a team dispatch can
see their siblings.

#### Current `/jobs/:id/context` Response

```json
{
  "job": { ... },
  "parent": { ... },
  "children": [ ... ],
  "relations": { "dependencies": [], "dependents": [], "blocking": [] },
  "latest_attempt": { ... },
  "blocked": false,
  "waiting": false,
  "effective_phase": "active"
}
```

#### Proposed Additions

```json
{
  "job": { ... },
  "parent": { ... },
  "children": [ ... ],
  "siblings": [
    { "id": "...", "title": "Security review", "phase": "active",
      "assignee": "security_reviewer", "effective_phase": "active" },
    { "id": "...", "title": "Perf review", "phase": "done",
      "assignee": "perf_reviewer", "effective_phase": "done",
      "result_summary": "No performance regressions found" }
  ],
  "dispatch_thread_id": "uuid-of-dispatch-thread",
  "dispatch_mode": "council",
  "relations": { ... },
  "latest_attempt": { ... },
  "blocked": false,
  "waiting": false,
  "effective_phase": "active"
}
```

New fields:
- `siblings`: Other jobs sharing the same parent (lightweight: id,
  title, phase, assignee, result_summary). Only populated when the
  job has a parent.
- `dispatch_thread_id`: Thread ID for the dispatch group (if exists).
- `dispatch_mode`: The team dispatch mode that created this job.

This is a **read-path-only change** to the existing context endpoint.
No new API endpoints.

#### What This Closes

| Gap | How |
|-----|-----|
| Gap 4 (shared team visibility) | Siblings visible in job context |

---

### Extension 4: Dispatch Topologies

Implement `council` and `relay` as dispatch topology presets built
entirely on existing primitives (jobs, relations, threads). No new
orchestration concepts — just different wiring patterns.

#### Council Mode

Use case: N agents analyze the same problem, then a synthesis step
reconciles their findings.

```
                  +-- Agent A (review: security) --+
Prompt --> Lead --+-- Agent B (review: perf)     --+--> Lead (synthesis)
                  +-- Agent C (review: tests)    --+
```

Implementation:
1. Fanout as today: root job + child jobs per member agent.
2. All children receive the **same prompt** (the original dispatch
   message), each interpreted through their agent's skill/persona.
3. Lead uses `eve supervise` loop to monitor progress.
4. Dispatch thread carries inter-agent messages.
5. When all children complete, lead reads all results + thread history
   and produces a unified synthesis.

The difference from fanout is **semantic**: children share a prompt, a
thread, and a synthesis expectation. The orchestrator wiring is identical
— the difference is in the lead's skill instructions.

Config:
```yaml
teams:
  security_council:
    lead: lead_reviewer
    members: [security_reviewer, perf_reviewer, test_reviewer]
    dispatch:
      mode: council
      merge_strategy: lead_summarize
```

`mode: council` tells the dispatch logic to:
- Pass the original prompt to all children (not just the lead)
- Create a dispatch thread
- Set `hints.supervising = true` on the lead (extended timeout)

#### Relay Mode

Use case: Sequential specialist chain where each agent builds on the
previous agent's output.

```
Prompt -> Agent A (analyst) -> Agent B (architect) -> Agent C (implementer)
```

Implementation:
1. Create child jobs in sequence, chained by `blocks` relations:
   `job_C.blocks = [job_B]`, `job_B.blocks = [job_A]`.
2. Each subsequent job's description includes a reference to the
   previous job's output: "Continue from the analysis produced by
   job {prev_id}. Read its result via `eve job show {prev_id}`."
3. Lead uses `waiting` (not supervising) — relay is inherently
   sequential, no mid-flight coordination needed.
4. Dispatch thread still created for observability and human steering.

Config:
```yaml
teams:
  feature_pipeline:
    lead: pm_agent
    members: [analyst, architect, implementer]
    dispatch:
      mode: relay
```

`mode: relay` tells the dispatch logic to:
- Create child jobs in sequence with `blocks` relations
- Inject previous job reference into each child's description
- Create a dispatch thread for observability
- Lead waits for the final member to complete

#### What This Closes

| Gap | How |
|-----|-----|
| Gap 3 (council/relay topologies) | First-class dispatch modes built on existing primitives |

---

## How the Extensions Compose

Concrete example: **Competing Hypotheses Investigation**

```
User: "The app exits after one message instead of staying connected."
Route: team:debugging_council (mode: council)
```

1. **Dispatch**: Orchestrator creates root job (lead) + 3 child jobs
   (socket, auth, lifecycle investigators). Coordination thread created.

2. **Lead enters supervision loop**: Creates children via
   `eve job create`. Posts status to thread. Runs
   `eve supervise --timeout 60` — blocks, zero token cost.

3. **Investigators work in parallel**: Socket investigator posts finding
   to coordination thread. Auth investigator reads thread, sees the
   socket finding, pivots investigation. Lifecycle investigator posts
   negative finding.

4. **Socket investigator completes**: `eve supervise` returns. Lead
   reads event + inbox. Posts steering message to auth investigator.
   Loops back to `eve supervise`.

5. **All complete**: Lead breaks out of loop. Synthesizes unified
   finding. Returns `success`.

This is the exact "competing hypotheses" pattern from CC agent teams —
but persistent, scalable, and server-side.

---

## Implementation Phases

### Phase 0: Unified Auth (prerequisite, in parallel)

**See**: `docs/plans/unified-permissions-plan.md` for full design.

The unified plan replaces the dual RBAC + scopes system with a single
`@RequirePermission` decorator. For agent access specifically (Phases 4-5):
the worker mints a per-job JWT via `POST /internal/auth/mint-job-token`
(already implemented in `auth.internal.controller.ts`) and writes it to
`$HOME/.eve/credentials.json`. The token carries explicit `permissions[]`
(e.g., `jobs:read`, `threads:write`, `events:read`).

This unblocks all Eve CLI usage from within agent harnesses.

**Not in scope for this plan** — prerequisite owned by the auth migration.
Infrastructure already partially in place (`auth.service.ts:mintJobToken`,
`auth.internal.controller.ts`).

---

### Phase 1: Coordination Threads + End-of-Attempt Relay

> Closes Gaps 1 (partial), 5, 6 (partial). Highest value, lowest risk.
> Works with existing skills immediately.

#### Deliverables

1. **Thread key convention**: `coord:job:{parent_job_id}`. Document in
   `docs/system/threads.md`.

2. **Thread creation at dispatch time**: When `chat.service.ts` creates
   child jobs in a team fanout, also create (or ensure) the coordination
   thread. Store thread ID in parent job's `hints.coordination.thread_id`.

3. **End-of-attempt relay**: When an attempt completes with
   `result_json.eve.summary`, the orchestrator posts it as a
   `thread_message` in the coordination thread. Emits
   `coordination.message.created` event.

   Implementation in `apps/orchestrator/src/loop/loop.service.ts`:
   after extracting `eveControl` from the result, if a coordination
   thread exists for the job's parent, insert the summary.

4. **Thread messages API**: Ensure `GET /threads/:id/messages` and
   `POST /threads/:id/messages` exist (they should from the
   agents-teams-threads plan). Add filtering by `since` timestamp.

5. **CLI commands**:
   - `eve thread messages <key-or-id> [--since <duration>]`
   - `eve thread post <key-or-id> --body <json-string>`
   - `eve thread follow <key-or-id>` (SSE stream)

6. **`EVE_PARENT_JOB_ID` in harness env**: Add to the allowlist in
   `env-builder.ts` so agents can derive the coordination thread key.

#### Files Changed

| File | Change |
|------|--------|
| `apps/api/src/chat/chat.service.ts` | Create coordination thread at dispatch |
| `apps/orchestrator/src/loop/loop.service.ts` | Post `eve.summary` to coordination thread on attempt completion |
| `apps/worker/src/invoke/env-builder.ts` | Add `EVE_PARENT_JOB_ID` to allowlist |
| `packages/cli/src/commands/thread/` | New `messages`, `post`, `follow` commands |
| `docs/system/threads.md` | Document coordination thread convention |

#### Estimated Scope

~100 lines dispatch logic, ~50 lines orchestrator relay, 1 API
endpoint enhancement (since filter), 3 CLI commands, doc updates.

---

### Phase 2: Worker Relay + Stay-Alive Supervision

> Closes Gaps 1 (full), 2. The real mailbox + active coordination.

#### Deliverables

1. **Worker `eve-message` parser**: Extend the streaming output parser
   in `invoke.service.ts` to detect `eve-message` fenced blocks.
   Rate-limit (max 1 msg/5s per job, 4KB per message). Insert into
   coordination thread via internal API call. Emit
   `coordination.message.created` event.

   The parser currently handles line-by-line JSON streaming. For
   `eve-message` blocks, accumulate lines between `` ```eve-message ``
   and `` ``` `` markers, then parse and relay.

2. **Inbox file at attempt start**: Worker queries the coordination
   thread for recent messages and writes them to
   `.eve/coordination-inbox.md` in the workspace before harness launch.
   Useful even with CLI access as seed context.

3. **`eve supervise` CLI command**: Long-polls the API for child
   terminal transitions + coordination thread messages. Returns JSON
   with `events`, `children`, `inbox` fields.

4. **`GET /jobs/:id/supervise` API endpoint**: Backing endpoint for
   the CLI command. Long-poll semantics:
   - Query child jobs for terminal phase changes since cursor
   - Query coordination thread for new messages since cursor
   - If events found: return immediately
   - If no events: poll DB every 2s until timeout or event
   - Return events or empty array on timeout

5. **Orchestrator supervising flag**: Dispatch logic sets
   `hints.supervising = true` on lead jobs. Orchestrator orphan-detection
   skips jobs with this flag.

#### Files Changed

| File | Change |
|------|--------|
| `apps/worker/src/invoke/invoke.service.ts` | `eve-message` block parser + rate limiter |
| `apps/worker/src/invoke/invoke.service.ts` | Inbox file writer at attempt start |
| `apps/api/src/jobs/jobs.controller.ts` | `GET /jobs/:id/supervise` endpoint |
| `apps/api/src/jobs/jobs.service.ts` | Supervision query logic |
| `packages/cli/src/commands/supervise.ts` | New `eve supervise` command |
| `apps/api/src/chat/chat.service.ts` | Set `hints.supervising` on lead jobs |
| `apps/orchestrator/src/loop/loop.service.ts` | Skip supervising jobs in orphan detection |

#### Estimated Scope

~30 lines parser extension, ~50 lines rate limiter, ~100 lines CLI
command, ~150 lines API endpoint, ~30 lines inbox writer, ~20 lines
orchestrator change, doc updates.

---

### Phase 3: Sibling Context

> Closes Gap 4. Read-path enrichment only.

#### Deliverables

1. **Sibling query in job context**: When the job has a `parent_id`,
   also fetch sibling jobs (same parent, different ID) with lightweight
   fields: `id`, `title`, `phase`, `assignee`, `effective_phase`,
   `result_summary`.

2. **Dispatch metadata in context**: Add `dispatch_thread_id` (from
   parent's `hints.coordination.thread_id`) and `dispatch_mode` (from
   parent's team dispatch config).

3. **Doc update**: Update `docs/system/job-context.md` with new fields.

#### Files Changed

| File | Change |
|------|--------|
| `packages/db/src/queries/jobs.ts` | Add sibling query to `getJobContext()` |
| `apps/api/src/jobs/jobs.service.ts` | Include siblings + dispatch metadata in context response |
| `docs/system/job-context.md` | Document new fields |

#### Estimated Scope

1 query addition (~15 lines), ~10 lines response mapping, doc updates.

---

### Phase 4: Council & Relay Dispatch Topologies

> Closes Gap 3. Topology presets using Phase 1-3 primitives.

#### Deliverables

1. **Council mode**: Modify fanout dispatch in `chat.service.ts`:
   - Pass original prompt to all children (not just the lead)
   - Create coordination thread at dispatch
   - Set `hints.supervising = true` on lead
   - Set `hints.timeout_seconds` from `dispatch.lead_timeout`
   - Add `merge_strategy` to parent job hints

2. **Relay mode**: New dispatch path in `chat.service.ts`:
   - Create child jobs in array order
   - Chain with `blocks` relations: each job blocks on the previous
   - Inject previous job reference into each child's description
   - Create coordination thread for observability
   - Lead waits for final member to complete

3. **Schema validation**: Validate `mode` field against
   `['fanout', 'council', 'relay']` in `TeamDispatchSchema` (already
   defined, just needs runtime enforcement).

4. **Extended dispatch config**: Support `lead_timeout` and
   `member_timeout` in dispatch config. Map to `hints.timeout_seconds`
   on the appropriate jobs.

5. **Doc update**: Update `docs/system/agents.md` with new dispatch
   modes, examples, and when to use each.

#### Files Changed

| File | Change |
|------|--------|
| `apps/api/src/chat/chat.service.ts` | Council + relay dispatch paths |
| `packages/shared/src/schemas/agent-config.ts` | Extend TeamDispatchSchema with timeout fields |
| `docs/system/agents.md` | Document council/relay modes |

#### Estimated Scope

~150 lines of dispatch logic per mode, schema additions, doc updates.

---

### Phase 5: Return-and-Wake via `eve.wait.wake_on` (Optional)

> Complementary to stay-alive supervision. For long-lived coordination
> where pod idle cost matters.

#### Deliverables

1. **Envelope extension**: Orchestrator reads `eve.wait.wake_on` from
   the control envelope when `eve.status = "waiting"`.

2. **Event-driven deferral clearing**: Orchestrator subscribes to the
   event spine for `coordination.message.created` and
   `job.phase.terminal` events. When a matching event arrives, clears
   `defer_until` for jobs with matching `wake_on` subscriptions.

3. **Wake subscription storage**: Store `wake_on` in
   `jobs.hints.wait.wake_on` (set from the control envelope, cleared
   on next claim).

#### Files Changed

| File | Change |
|------|--------|
| `apps/orchestrator/src/loop/loop.service.ts` | Parse `wake_on`, subscribe to events, clear deferral |
| `packages/db/src/queries/jobs.ts` | Query for jobs with matching `wake_on` |
| `docs/system/job-control-signals.md` | Document `eve.wait.wake_on` envelope extension |

#### Estimated Scope

~80 lines orchestrator event matching, ~20 lines query, doc updates.

---

## Phase Dependencies

```
Phase 0 (Unified Auth)     ← in parallel, see unified-permissions-plan.md
    |
    v
Phase 1 (Coordination Threads + End-of-Attempt Relay)
    |
    +--> Phase 2 (Worker Relay + Stay-Alive Supervision)
    |        |
    |        +--> Phase 4 (Council & Relay Topologies)
    |
    +--> Phase 3 (Sibling Context)
    |
    +--> Phase 5 (Return-and-Wake, optional)
```

Phase 1 is the foundation. Phases 2, 3, and 5 can proceed in parallel
after Phase 1. Phase 4 depends on Phase 2 (council needs supervision).

**Note**: Phase 1 can start before the auth migration completes — the
worker-mediated relay and end-of-attempt relay don't require agent CLI
auth. Direct CLI access (Channel 1) requires auth Phases 4-5.

---

## Relationship to Software Factory v3

The factory's MVP pipeline (PM interview -> brief -> investigate -> plan ->
implement -> review -> verify) is a **relay** topology. The optional
multi-reviewer phase is a **council** topology. Both benefit directly
from dispatch threads and supervising mode.

- Factory v3's `factory_planner` agent uses `eve supervise` to monitor
  parallel implementation streams without cold-start penalties.
- The review council gets coordination threads for free — reviewers can
  challenge each other's findings mid-review.
- Human-in-the-loop gates can post to coordination threads instead of
  requiring separate Slack interactions.

---

## Open Questions

1. **Supervise endpoint: polling vs event spine**: Start with DB polling
   (2s interval, proven in deferred job handling). Add event-driven
   wakeups when latency matters.

2. **Coordination thread lifetime**: Keep open indefinitely (threads are
   cheap). Useful for post-mortem review. Add `closed_at` field for
   eventual cleanup.

3. **Message rate limiting**: Worker rate-limits `eve-message` blocks
   at max 1 msg/5s per job, 4KB per message. Excess messages buffered
   and flushed at attempt end.

4. **Inbox delivery for non-supervising agents**: Only via
   `.eve/coordination-inbox.md` at attempt start. Mid-execution inbox
   is a supervision concern. Regular agents get end-of-attempt
   visibility via their summaries in the coordination thread.

5. **Supervising job resource limits**: Add a `supervising` resource
   profile in the k8s runner (50m CPU, 128Mi RAM) for idle pods.

6. **Council merge strategy alternatives**: Start with `lead_summarize`
   only. `vote` and `consensus` are skill-level concerns.

7. **Relay with branching**: Conditional routing (if A finds X, go to B;
   else go to C) is not in v1. Orchestration skill concern.

8. **Human steering UX**: For Slack-initiated dispatches, reuse the
   existing Slack thread as the coordination thread. For non-Slack
   dispatches, add "link coordination thread to Slack channel" later.

9. **`eve.wait.wake_on` cursor management**: Store "last seen event ID"
   in `jobs.hints` to avoid re-delivering events on subsequent wakes.
   Or accept idempotent wakes with backoff for v1.
