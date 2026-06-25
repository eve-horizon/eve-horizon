# Agent Team Coordination — Gap Analysis & Design

> Status: Idea
> Last Updated: 2026-02-08
>
> Inputs:
> - Claude Code Agent Teams documentation (experimental feature)
> - docs/system/agents.md, threads.md, job-api.md, job-context.md
> - docs/system/job-control-signals.md, orchestration-skill.md
> - docs/plans/agents-teams-threads-primitives-plan.md (Completed)
> - docs/ideas/automated-software-factory-v3.md
> - docs/ideas/agent-team-coordination-gap-analysis-v2.md (incorporated)
>
> Purpose: Map Eve Horizon's multi-agent coordination primitives against
> Claude Code's agent teams feature. Identify gaps. Propose solutions that
> extend existing primitives rather than creating new ones.
>
> Incorporates ideas from v2 analysis: worker-mediated message relay,
> deterministic thread keys, `eve.wait.wake_on` envelope extension, and
> event-spine-driven wakeups. Adds stay-alive supervision to address
> cold-start costs that v2 does not account for.
>
> **Auth Update (2026-02-08)**: Investigation confirmed that agents
> currently cannot authenticate via the Eve CLI (harness env is sanitized,
> `~/.eve/credentials.json` is not populated). A **unified permission
> model** (`docs/plans/unified-permissions-plan.md`) is being implemented
> in parallel with this coordination work. It replaces the dual RBAC +
> scopes system with a single `@RequirePermission` decorator and mints
> per-job tokens with explicit permissions. The worker will write these
> credentials to `$HOME/.eve/credentials.json` before harness launch.
>
> **Parallel implementation note**: If you are implementing coordination
> features (threads, dispatch, wake subscriptions) at the same time as
> the auth migration, be aware:
> - **Do NOT add `@RequireRole` or `@RequireScope` to new endpoints** —
>   the unified plan replaces both with `@RequirePermission`.
> - New thread/coordination API endpoints should use `@RequirePermission`
>   from `docs/plans/unified-permissions-plan.md` (e.g., `threads:read`,
>   `threads:write`, `jobs:read`).
> - The `AuthInternalController` (`POST /internal/auth/mint-job-token`)
>   already exists — use it for worker-side token minting.
> - Job token claims now include `project_id`, `job_id`, and `sub` fields
>   (see `auth.service.ts:mintJobToken`). The `scopes` field will be
>   renamed to `permissions` during the auth migration.

---

## Context

Claude Code shipped an experimental "agent teams" feature: a lead session
coordinates teammate sessions that work in parallel, message each other,
share a task list, and self-claim work. It's local, ephemeral, and
terminal-scoped — but it demonstrates coordination patterns that matter
for autonomous software engineering.

Eve Horizon already has stronger fundamentals (persistent jobs, server-side
orchestration, review workflows, git integration, K8s isolation). What it
lacks is **communication richness** — agents working in parallel can't talk
to each other, and leads can't steer teammates mid-flight.

This document proposes closing those gaps with minimal new surface area
by extending three existing primitives: **threads**, **the CLI/API
surface**, and **team dispatch**.

---

## Where Eve Is Already Stronger

Before the gaps: Eve's primitives are architecturally superior to CC's
agent teams in several dimensions. These are not gaps — they're strengths
to preserve.

| Dimension | Claude Code Agent Teams | Eve Horizon |
|---|---|---|
| **Persistence** | Session-scoped; dies with terminal | Jobs persist indefinitely; survive restarts |
| **Orchestration** | Local process management | Server-side scheduler with concurrency control |
| **Task model** | Flat list | Hierarchical jobs (3 levels), typed relations |
| **Dependencies** | Simple task blocking | `blocks`, `waits_for`, `conditional_blocks`, cascade-cancel |
| **Quality gates** | `TaskCompleted` hook | First-class review phase (submit/approve/reject) |
| **Isolation** | Shared filesystem | K8s pods per job; ephemeral workspaces |
| **Git** | Shared worktree | Per-job branches, commit/push policies |
| **Triggers** | Manual only | GitHub events, manual, system events (cron planned) |
| **Agent identity** | Anonymous "teammate" | Named agents with skills, policies, harness profiles |
| **Scalability** | Single machine | Multi-node, multi-org, concurrent projects |

---

## Constraints (From Current System)

Any design must respect these realities:

1. **Agent CLI access is planned but not yet wired**: The Eve CLI is
   intended as a first-class tool for agents (the orchestration skill
   already uses `eve job create`, `eve job current --json`, etc.). The
   CLI can resolve the API URL from `.eve/profile.yaml` in the repo.
   However, the auth plumbing is incomplete today:
   - Harness env is sanitized (`env-builder.ts`): `EVE_API_URL` and
     `EVE_INTERNAL_API_KEY` are on the runner pod but **not** forwarded.
   - `$HOME/.eve/credentials.json` is not populated inside runner pods.
   - The **unified permissions plan** (`docs/plans/unified-permissions-plan.md`,
     Phases 4-5) will fix this: the worker mints a per-job token via
     `POST /internal/auth/mint-job-token` and writes it to
     `$HOME/.eve/credentials.json` before harness launch. The token carries
     explicit permissions (e.g., `jobs:read`, `threads:write`, `events:read`).
   - **Design implication**: Build for direct CLI access as the primary
     path; use worker-mediated relay as a complementary mechanism that
     works even before CLI auth lands.

2. **Worker already parses streaming output**: The worker extracts the
   final `json-result` fenced block from harness output. Extending
   this to parse additional block types mid-stream is natural.

3. **Thread messages emit events**: `POST /threads/:id/messages` emits
   `chat.message.*` events to the event spine. Worker-inserted
   coordination messages should also emit events for consistency.

4. **Cold start per attempt**: Each new attempt = new pod + workspace +
   hooks + harness init = 1.5-6 minutes. No pod or workspace reuse
   exists between attempts. Return-and-wake patterns pay this cost
   on every wake.

5. **Control envelope is minimal**: Only `eve.status` and `eve.summary`
   are consumed today. Additional fields in the `eve` block are
   permitted but ignored unless explicitly implemented.

---

## Gap Analysis

### Gap 1: Inter-Agent Communication (HIGH)

**CC has**: A direct mailbox. Any teammate messages any other teammate.
This enables debate ("I found X which contradicts your theory"), knowledge
sharing ("FYI the auth module uses JWT, not sessions"), and convergence.

**Eve has**: No job-to-job messaging. Jobs are isolated execution units.
Communication paths are:

- `result_json` — structured, read-only after attempt completion
- Thread messages — designed for Slack chat, not inter-agent coordination
- Shared repo files — slow, git-mediated, not real-time
- Child job descriptions — one-way, at creation time

**Impact**: Agents working in parallel can't share intermediate findings,
challenge each other, or coordinate strategy. The "competing hypotheses"
pattern — CC's most compelling use case — is impossible.

---

### Gap 2: Active Lead Coordination (HIGH)

**CC has**: The lead actively observes teammate progress, synthesizes
partial findings, redirects approaches, and spawns additional work
throughout execution.

**Eve has**: Batch coordination. The lead creates child jobs, returns
`eve.status = "waiting"`, and resumes only after *all* children
complete. It's a fire-and-forget pattern — the lead is blind to what
happens between dispatch and completion.

**Impact**: The lead can't course-correct a struggling agent, redistribute
work when one agent finishes early, or synthesize findings incrementally.
Long-running team dispatches are fragile: if one child goes sideways,
the lead only discovers this after the full wait.

---

### Gap 3: Dispatch Topologies — Council & Relay (MEDIUM)

**CC has**: Implicit support for council patterns (multiple agents review
and debate the same problem) and relay patterns (one agent's output feeds
the next).

**Eve has**: Only `fanout` mode implemented. `council` and `relay` are
documented as "reserved for future expansion" in the teams.yaml schema
but have no implementation.

**Impact**: Can't do multi-reviewer deliberation (council where N agents
analyze the same PR and a synthesis step reconciles their findings) or
sequential specialist chains (relay where analyst → architect → implementer
each build on the previous agent's output) as first-class dispatch
patterns.

---

### Gap 4: Shared Team Visibility (MEDIUM)

**CC has**: All teammates see the shared task list. Each knows what others
are working on and what's left to do.

**Eve has**: Jobs know their own context (parent, children, relations via
`/jobs/:id/context`) but not their *siblings*. An agent in a team fanout
can't see what its peer agents are working on or their progress.

**Impact**: Agents can't avoid duplicate work, can't pick up related
context from a peer's partial findings, and can't reason about overall
team progress. Skills that want team-awareness must make multiple API
calls to discover siblings — possible but undiscoverable and fragile.

---

### Gap 5: Real-Time Multi-Agent Visibility (LOW)

**CC has**: Split-pane terminal view. User watches all teammates
simultaneously.

**Eve has**: `eve job follow <id>` (single job stream) and `eve job tree`
(hierarchy snapshot). No multiplexed view of a team's work.

**Impact**: Operational UX gap. Users monitoring a factory run or team
dispatch can't watch the team work in real time without opening N
terminal tabs.

---

### Gap 6: Mid-Execution User Steering (LOW)

**CC has**: User selects any teammate and types a message during execution.

**Eve has**: `@eve <agent-slug>` in Slack creates a new thread/job. No
mechanism to inject a message into a *running* job's context.

**Impact**: Can't redirect an agent mid-execution without cancelling and
restarting the job.

---

## Design Proposal

Four extensions to existing primitives. No new services, no new tables.
Once the unified permissions plan lands (Phases 4-5 of
`unified-permissions-plan.md`), agents communicate via the Eve CLI (`eve thread post`,
`eve thread messages`, `eve supervise`). Worker-mediated relay provides
a complementary channel for mid-stream messages and works as a bridge
before CLI auth is wired. The security model is preserved — agents get
per-job tokens with explicit permissions, not raw API keys.

### Extension 1: Coordination Threads + Dual Messaging

**Core idea**: Every dispatch group gets a coordination thread
(deterministic key, lazy creation). Agents communicate through two
complementary channels:

1. **Eve CLI** (primary, once unified auth lands): `eve thread post`
   and `eve thread messages` for explicit, intentional coordination.
2. **Worker-mediated relay** (complement): `eve-message` fenced blocks
   in harness output, parsed and relayed by the worker. Works before
   CLI auth is wired, and useful for quick mid-stream status updates
   without a full API round-trip.

#### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Coordination Thread                          │
│                                                                  │
│  Lead (CLI or worker relay) ←→ Thread ←→ Agent A (CLI or relay) │
│                                       ←→ Agent B (CLI or relay) │
│                                       ←→ Human (Slack / CLI)    │
│                                                                  │
│  Primary: agents use `eve thread post/messages` directly         │
│  Complement: worker parses eve-message blocks from output        │
└─────────────────────────────────────────────────────────────────┘
```

#### Deterministic thread keys (not a schema column)

Thread key: `coord:job:{parent_job_id}`. Lookup via `threads.project_id
+ threads.key` (already unique). Thread created lazily on first message
or at dispatch time.

This avoids a new column on `jobs`. If we want a fast-path later, cache
the thread ID in `jobs.hints.coordination.thread_id`.

#### Three messaging channels

**Channel 1: Direct CLI (primary, requires unified auth Phases 4-5)**

Agents use the Eve CLI to read and write coordination messages:

```bash
# Post a finding
eve thread post coord:job:$EVE_PARENT_JOB_ID --body '{"kind":"finding","body":"Token middleware closes WS upgrade."}'

# Read recent messages
eve thread messages coord:job:$EVE_PARENT_JOB_ID --since 5m
```

This is the most natural interface — agents use the same CLI they
already use for `eve job create` and `eve job current`. Requires
the unified permissions plan (Phases 4-5 of `unified-permissions-plan.md`)
to populate `$HOME/.eve/credentials.json`.

**Channel 2: Worker-mediated relay (complement, works immediately)**

Define an `eve-message` fenced block convention in harness output:

````
```eve-message
{"kind":"finding","body":"Token middleware closes WS upgrade via res.end() when expired."}
```
````

The worker already parses streaming harness output for `json-result`
blocks. Extending this to detect `eve-message` blocks is ~20 lines of
parser logic. Worker rate-limits (e.g., max 1 msg/5s) and inserts into
`thread_messages`.

This channel is valuable even after CLI auth lands because:
- Zero API round-trip overhead (just emit text)
- Works as a bridge before unified auth Phases 4-5 are implemented
- Natural for quick status updates that don't need a full CLI call

**Channel 3: End-of-attempt relay (automatic, free)**

When a job attempt completes with `result_json.eve.summary`, the
worker/orchestrator posts it as a coordination message. Zero new
harness behavior — works with existing skills immediately.

#### Message shape

```json
{
  "kind": "finding|status|question|steer|handoff",
  "body": "string (<= 4KB)",
  "tags": ["optional", "strings"],
  "refs": { "job_id": "optional", "path": "optional" }
}
```

Store as the `body` field of `thread_messages` (JSON by convention).
If we want structure later, add `thread_messages.meta_json JSONB`
(non-breaking).

#### Reading messages

Three paths, depending on auth availability:

1. **Direct CLI read** (primary, requires unified auth Phases 4-5):
   `eve thread messages coord:job:$EVE_PARENT_JOB_ID --since 5m`
   — agents read the thread whenever they want, just like they read
   job context with `eve job current --json`.

2. **Inbox file at attempt start** (works without CLI auth):
   Worker queries the coordination thread for recent messages and
   writes them to `.eve/coordination-inbox.md` in the workspace.
   The harness reads this as part of its initial context.

3. **Supervision response** (Extension 2): The `eve supervise`
   command returns an `inbox` field with recent messages. Agents
   in supervision loops get messages inline without a separate read.

#### Human participation

The coordination thread is a regular thread. Humans can post to it
via Slack (if linked to a channel), the CLI (`eve thread post`), or
the API. These messages appear in the inbox on the next supervision
wake or can be read by agents that DO have API access (e.g., in
local dev mode).

#### CLI follow

- `eve thread messages <key-or-id> [--since ...]`
- `eve thread follow <key-or-id>` (SSE stream)

These close Gap 5 (real-time visibility) for human operators.

#### What this closes

| Gap | How |
|-----|-----|
| Gap 1 (inter-agent messaging) | `eve-message` blocks → thread messages |
| Gap 5 (real-time visibility) | `eve thread follow` streams team activity |
| Gap 6 (user steering) | Human posts to coordination thread |

---

### Extension 2: Stay-Alive Supervision (`eve supervise`)

**Core idea**: The lead stays alive in its pod and blocks on an efficient
long-poll command while waiting for events — rather than returning control
to the orchestrator and suffering a full cold-start on each wake.

#### Why not return-and-wake?

Each job re-execution (new attempt) is catastrophically expensive:

| Phase | Cost |
|-------|------|
| Pod creation + image pull | 30-60s |
| Pod readiness + health check | 10-35s |
| Git clone (shallow) | 5-30s |
| Hooks (`on-clone` + `on-acquire`) | 30s-5min |
| Harness init | 2-5s |
| **Total cold start** | **~1.5-6 min** |

A council of 5 agents where the lead wakes 5 times = **7.5-30 minutes
of pure pod startup overhead**. Meanwhile, the lead loses all
conversation context on each wake (new attempt = new harness session).

Contrast with stay-alive:

| | Return-and-wake | Stay-alive |
|---|---|---|
| Wake latency | 1.5-6 min (cold start) | < 1s (CLI command returns) |
| Context | Lost (new attempt) | Preserved (same session) |
| Token cost per wake | High (re-read all context) | Zero (continues in-context) |
| Pod cost while idle | $0 (no pod) | ~$0.001/min (idle pod) |
| 5 wakes over 30 min | $15-50 in tokens + 7-30 min overhead | ~$0.03 in pod time |

The economics are overwhelming. Stay-alive wins on latency, token cost,
and developer experience.

#### The supervision primitive

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
authenticates using the job-scoped token in `$HOME/.eve/credentials.json`.

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

The `inbox` field includes recent coordination thread messages in
human-readable form, so the harness can process them immediately
without a separate read step.

On timeout with no events:

```json
{
  "events": [],
  "children": { "total": 3, "done": 0, "active": 3, "cancelled": 0 },
  "inbox": []
}
```

#### What happens during the block

While the supervision endpoint is waiting:

- **No Claude API tokens consumed** — the tool call is pending, no
  model inference is happening. The harness process is alive but idle.
- **Pod sits idle** — minimal resource usage (~100m CPU reservation,
  256Mi memory). Cost: negligible.
- **Conversation context preserved** — when the command returns, the
  harness continues with full history of what it was doing and why.

This is the same pattern as any long-running Bash tool call (e.g.,
`pnpm test` taking 5 minutes). The harness is designed for this.

#### API backing: `GET /jobs/:id/supervise`

The runner's local `/supervise` endpoint calls through to the Eve API:

```
GET /jobs/:id/supervise?timeout=60&since=<cursor>
```

Long-poll semantics (same pattern as existing `/jobs/:id/wait`):
1. Query child jobs for any in terminal phase since `since`
2. Query coordination thread for messages since `since`
3. If events found: return immediately
4. If no events: poll DB every 2s until timeout or event
5. Return events (or empty array on timeout)

Long-term, use the **event spine** for wakeups instead of polling.
Thread message insertion already emits `chat.message.*` events. Add
`job.phase.terminal` events on child completion. The API supervise
endpoint subscribes to these events instead of polling — giving
sub-second wake latency. But polling is fine for v1.

#### Skill pattern for supervision

The lead's skill instructions include a supervision loop:

```
## Supervision Protocol

After dispatching child jobs:

1. Post status: `eve thread post coord:job:$EVE_JOB_ID --body '{"kind":"status","body":"Dispatched N jobs."}'`
2. Enter supervision loop:
   a. Run: `eve supervise --timeout 60`
   b. Read the JSON result
   c. Read `inbox` for new peer messages — respond or redirect
   d. For each child_complete event:
      - Assess the result_summary
      - Post synthesis/redirect to coordination thread
      - Spawn follow-up work if findings warrant it
   e. Check children.done == children.total → if yes, break
   f. Otherwise, loop back to (a)
3. Synthesize all findings into final result.
```

This is a **skill-level pattern**, not a platform primitive. Different
skills can implement different supervision strategies. The platform
provides the blocking command; the skill decides what to do with
the events.

#### Complementary: return-and-wake via `eve.wait.wake_on`

For coordination that doesn't need sub-second latency (relay chains,
daily check-ins), extend the control envelope instead of staying alive:

```json-result
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
conditions. The orchestrator clears `defer_until` when:
- `child.terminal`: any child reaches `done` or `cancelled`
- `thread.message`: a new message appears in the coordination thread

Implementation uses the event spine — the orchestrator matches incoming
events to jobs with `wait.wake_on` subscriptions and clears their
deferral. No polling needed.

**When to use which:**

| Pattern | Wake latency | Context | Pod cost while idle | Best for |
|---------|-------------|---------|-------------------|----------|
| Stay-alive (`eve-supervise`) | < 1s | Preserved | ~$0.001/min | Active councils, real-time steering |
| Return-and-wake (`eve.wait`) | 1.5-6 min | Lost | $0 | Relay chains, daily check-ins, long waits |

#### Job timeout handling

Supervising jobs need extended timeouts. The dispatch logic should set
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

The orchestrator already respects `hints.timeout_seconds`. No new
timeout mechanism needed.

#### Orchestrator awareness

The orchestrator should know a job is supervising (not stuck). Two
options:

**Option A: Hints flag** (simpler). The dispatch logic sets
`hints.supervising = true` on the lead job. The orchestrator's
orphan-detection logic skips jobs with this flag (they're expected
to be long-running).

**Option B: Heartbeat from `eve supervise`**. Each poll iteration
updates `job_attempts.last_heartbeat_at`. The orchestrator considers
jobs with recent heartbeats as healthy regardless of runtime.

Option A is simpler and sufficient for v1. Option B is more robust
and should be added if orphan false-positives become a problem.

#### Future: return-and-wake as a complement

For very-long-lived coordination (factory PM that checks in daily),
a return-and-wake model makes sense — you don't want a pod sitting
idle for 24 hours. This could be added later as `eve.status =
"supervising"` in the control signal, with the orchestrator waking
the lead on child completions. But that's a different use case from
active team coordination and can wait.

#### What this closes

| Gap | How |
|-----|-----|
| Gap 2 (active lead coordination) | Lead stays alive, reacts to events in real-time |

---

### Extension 3: Dispatch Topologies

**Core idea**: Implement `council` and `relay` as dispatch topology
presets built entirely on existing primitives (jobs, relations, threads).
No new orchestration concepts — just different wiring patterns.

#### Council Mode

Use case: N agents analyze the same problem, then a synthesis step
reconciles their findings.

```
                  ┌── Agent A (review: security) ──┐
Prompt ──→ Lead ──┤── Agent B (review: perf)     ──├──→ Lead (synthesis)
                  └── Agent C (review: tests)    ──┘
```

Implementation:
1. Fanout as today: root job + child jobs per member agent.
2. **All children receive the same prompt** (the original dispatch
   message), each interpreted through their agent's skill/persona.
3. Lead uses `eve supervise` loop to monitor progress.
4. Dispatch thread carries inter-agent messages (agents can read and
   challenge each other's findings during execution).
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
      merge_strategy: lead_summarize  # lead synthesizes on completion
```

`mode: council` tells the dispatch logic to:
- Pass the original prompt to all children (not just the lead)
- Create a dispatch thread
- Set `hints.supervising = true` on the lead (extended timeout,
  skill uses `eve supervise` loop)

#### Relay Mode

Use case: Sequential specialist chain where each agent builds on the
previous agent's output.

```
Prompt → Agent A (analyst) → Agent B (architect) → Agent C (implementer)
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
      # members execute in array order, each receiving prior output
```

`mode: relay` tells the dispatch logic to:
- Create child jobs in sequence with `blocks` relations
- Inject previous job reference into each child's description
- Create a dispatch thread for observability
- Lead waits for the final member to complete

#### What this closes

| Gap | How |
|-----|-----|
| Gap 3 (council/relay topologies) | First-class dispatch modes built on existing primitives |

---

### Extension 4: Sibling Context

**Core idea**: Enrich the job context endpoint so that jobs in a team
dispatch can see their siblings.

#### Current `/jobs/:id/context` response

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

#### Proposed additions

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
- `siblings`: Other jobs sharing the same parent (lightweight: id, title,
  phase, assignee, result_summary). Only populated when the job has a
  parent.
- `dispatch_thread_id`: Thread ID for the dispatch group (if one exists).
- `dispatch_mode`: The team dispatch mode that created this job.

This is a read-path-only change to the existing context endpoint.
No new API endpoints.

#### What this closes

| Gap | How |
|-----|-----|
| Gap 4 (shared team visibility) | Siblings visible in job context |

---

## How the Extensions Compose

A concrete example: **Competing Hypotheses Investigation**

```
User: "The app exits after one message instead of staying connected."
Route: team:debugging_council (mode: council)
```

**Step 1**: Orchestrator creates dispatch.
- Root job for lead agent
- Child jobs for 3 investigators (socket, auth, lifecycle)
- Dispatch thread created, all jobs linked

**Step 2**: Lead dispatches and enters supervision loop.
- Lead skill creates 3 child jobs via `eve job create`.
- Posts to coordination thread: `eve thread post coord:job:$EVE_JOB_ID --body '{"kind":"status","body":"Investigating 3 hypotheses in parallel."}'`
- Runs `eve supervise --timeout 60` — blocks, zero token cost.

**Step 3**: Investigators work in parallel.
- Each reads the prompt through their specialist skill.
- Socket investigator posts finding:
  `eve thread post coord:job:$PARENT --body '{"kind":"finding","body":"WebSocket handshake succeeds, but server sends FIN after first message frame."}'`
- Auth investigator reads thread: `eve thread messages coord:job:$PARENT --since 5m`
  Sees the socket finding, pivots investigation.
- Auth investigator posts: `{"kind":"status","body":"Interesting — checking if token middleware closes the connection."}`
- Lifecycle investigator posts: `{"kind":"finding","body":"Process exit handler registered but not the issue — no SIGTERM in logs."}`

**Step 4**: Socket investigator completes. `eve supervise` returns.
- Lead reads the event + inbox: socket found FIN, auth pivoting.
- Lead posts steer: `eve thread post coord:job:$EVE_JOB_ID --body '{"kind":"steer","body":"Socket found the FIN. Auth — focus on whether token middleware intercepts WS frames."}'`
- Auth investigator sees it on next `eve thread messages` read.
- Lead runs `eve supervise --timeout 60` again — blocks.

**Step 5**: Lifecycle investigator completes (no finding).
- `eve supervise` returns. Lead notes it, loops.

**Step 6**: Auth investigator completes.
- `eve supervise` returns with `children.done == children.total`.
- Lead breaks out of loop.
- Synthesizes: root cause is token middleware, socket investigator
  identified the symptom, auth investigator confirmed the cause.
- Returns `success` with unified finding.

This is the exact "competing hypotheses" pattern from CC agent teams —
but persistent, scalable, and server-side.

---

## Implementation Sequence

### Phase 0: Agent Auth via Unified Permissions (prerequisite — in parallel)

**See**: `docs/plans/unified-permissions-plan.md` (Phases 1-5) for full design.

The unified plan replaces the dual RBAC + scopes system with a single
`@RequirePermission` decorator and `PermissionGuard`. For agent access
specifically (Phases 4-5): the worker mints a per-job JWT via
`POST /internal/auth/mint-job-token` and writes it to
`$HOME/.eve/credentials.json`. The auth guard routes `type: 'job'` tokens
through `resolveJobTokenAuth`, which maps the token's `permissions[]`
array to the same permission checks used for user tokens.

**Coordination with auth implementation**: The auth migration touches
every controller (annotating ~162 endpoints with `@RequirePermission`).
If you are adding new endpoints for coordination features (e.g.,
`GET /threads/:id/messages`, `GET /jobs/:id/supervise`), annotate them
with `@RequirePermission` from the start — do not use `@RequireRole`.
Permissions to use: `threads:read`, `threads:write`, `jobs:read`.

This unblocks all Eve CLI usage from within agent harnesses, not just
coordination — including the orchestration skill's existing `eve job
create`, `eve job dep add`, etc.

### Phase 1: Coordination Threads + End-of-Attempt Relay (closes Gaps 1, 5, 6 partially)

Highest value, lowest risk. Works with existing skills immediately.

1. Define thread key convention: `coord:job:{parent_job_id}`.
2. Ensure thread exists at dispatch time (or lazily on first message).
3. When an attempt completes with `eve.summary`, worker posts it as a
   coordination message in the thread.
4. Add `GET /threads/:id/messages` API (list) and `eve thread messages`
   / `eve thread post` / `eve thread follow` CLI commands.
5. Add `coordination` block to `/jobs/:id/context` (thread key + ID).
6. Expose `EVE_PARENT_JOB_ID` in the harness env allowlist (so agents
   can derive the coordination thread key).

**Estimated scope**: ~100 lines dispatch logic, ~50 lines worker relay,
1 API endpoint, 3 CLI commands, doc updates.

### Phase 2: Worker Relay + Stay-Alive Supervision (closes Gaps 1, 2)

The real mailbox + active coordination.

1. Extend worker's streaming parser to detect `eve-message` fenced
   blocks. Rate-limit and insert into coordination thread. Emit
   `coordination.message.created` event to the event spine.
2. At attempt start, write recent coordination messages to
   `.eve/coordination-inbox.md` in the workspace (useful even with
   CLI access as seed context).
3. Add `eve supervise` CLI command (long-polls the API for child
   terminal transitions + coordination thread messages).
4. Add `GET /jobs/:id/supervise` on the Eve API (backing endpoint).
5. Set `hints.supervising = true` on lead jobs; orchestrator
   orphan-detection skips these.

**Estimated scope**: ~30 lines parser extension, ~100 lines CLI command,
~150 lines API endpoint, ~30 lines inbox writer, doc updates.

### Phase 3: Sibling Context (closes Gap 4)

Read-path enrichment only.

1. In the job context query: when the job has a `parent_id`, also fetch
   sibling jobs (same parent, different ID) with lightweight fields.
2. Add `dispatch_mode` from the team dispatch metadata (stored in
   parent job's `hints` or a dedicated field).
3. Update job-context.md.

**Estimated scope**: 1 query addition (~10 lines), doc updates.

### Phase 4: Council & Relay (closes Gap 3)

Topology presets using Phase 1-3 primitives.

1. **Council**: Modify fanout dispatch to pass original prompt to all
   children (not just lead). Set lead to `supervising` by default.
   Add `merge_strategy` handling.
2. **Relay**: New dispatch path that creates sequential `blocks` chains.
   Inject previous job reference into child descriptions.
3. Validate `mode` field in teams.yaml schema.
4. Update agents.md with new dispatch modes.

**Estimated scope**: ~150 lines of dispatch logic per mode, doc updates.

---

## What We Deliberately Don't Build

- **Separate message queue / mailbox system**: Threads already do this.
- **Agent-to-agent RPC**: The thread model is async and persistent,
  which is better for distributed agents than synchronous RPC.
- **Raw API keys in harness env**: The sanitized env is a security
  boundary. Rather than passing `EVE_INTERNAL_API_KEY` to agents, the
  unified permissions plan gives agents per-job tokens with explicit
  permissions in their `$HOME`. Worker-mediated relay complements CLI access for
  mid-stream updates. The security model stays intact.
- **Shared mutable task list with locking**: Eve's orchestrator centrally
  assigns work, which is more robust than CC's self-claiming model.
  Sibling context gives agents visibility without the complexity of
  distributed locking.
- **Split-pane terminal multiplexing**: `eve thread follow` gives a
  unified stream. If users want N terminals, they can run N
  `eve job follow` commands. The platform doesn't need to manage
  terminal layout.
- **Session-scoped teams**: Eve's teams are persistent and config-driven.
  Ephemeral ad-hoc teams (CC's model) aren't needed when you have
  named agents with declared skills and policies.

---

## Open Questions

1. **Supervise endpoint: polling vs event spine**: The API backing
   endpoint can poll the DB every 2s (proven in `/jobs/:id/wait`) or
   subscribe to the event spine for `coordination.message.created` and
   `job.phase.terminal` events. Proposal: start with polling, add
   event-driven wakeups when latency matters.

2. **Coordination thread lifetime**: Should the thread be closed when
   the root job completes? Proposal: keep open indefinitely (threads
   are cheap), useful for post-mortem review. Add `closed_at` field
   for eventual cleanup.

3. **Message rate limiting**: `eve-message` blocks could be emitted
   rapidly. Worker should rate-limit (e.g., max 1 msg/5s per job,
   4KB per message). Excess messages buffered and flushed at
   attempt end.

4. **Inbox delivery for non-supervising agents**: The supervision
   endpoint returns an `inbox` field. But regular (non-supervising)
   agents only get `.eve/coordination-inbox.md` at attempt start.
   Should the worker also update the inbox file mid-execution?
   Proposal: no — mid-execution inbox is a supervision concern.
   Regular agents get end-of-attempt visibility via their own
   result summaries in the coordination thread.

5. **Supervising job resource limits**: Idle pods consume reservation
   (~100m CPU, 256Mi RAM). Proposal: add a `supervising` resource
   profile in the k8s runner (e.g., 50m CPU, 128Mi RAM).

6. **Council merge strategy alternatives**: Beyond `lead_summarize`,
   support `vote` or `consensus`? Proposal: start with
   `lead_summarize` only. Others are skill-level concerns.

7. **Relay with branching**: Conditional routing (if A finds X, go to
   B; else go to C)? Proposal: not in v1. Orchestration skill concern.

8. **Human steering UX**: For Slack-initiated dispatches, reuse the
   existing Slack thread as the coordination thread. For non-Slack
   dispatches, add a "link coordination thread to Slack channel"
   command later.

9. **`eve.wait.wake_on` cursor management**: When using return-and-wake,
   store "last seen event ID" in `jobs.hints` to avoid re-delivering
   events on subsequent wakes? Or accept idempotent wakes with
   backoff for v1?

---

## Relationship to Software Factory v3

The factory's MVP pipeline (PM interview → brief → investigate → plan →
implement → review → verify) is a **relay** topology. The optional
multi-reviewer phase is a **council** topology. Both benefit directly
from dispatch threads and supervising mode.

Specifically:
- Factory v3's `factory_planner` agent can use `eve supervise` to
  monitor parallel implementation streams (when the MVP is extended
  beyond single-stream) without cold-start penalties.
- The review council (post-MVP) gets coordination threads for free —
  reviewers can challenge each other's findings mid-review via
  `eve thread post` or `eve-message` blocks.
- Human-in-the-loop gates can post to coordination threads instead of
  requiring separate Slack interactions.

These extensions don't change the factory design — they make it more
capable without additional complexity.
