# Agent Team Coordination — Gap Analysis & Design (v2)

> Status: Idea
> Last Updated: 2026-02-08
>
> This is a v2 rewrite of `docs/ideas/agent-team-coordination-gap-analysis.md` with a cleaner,
> more implementable design that fits Eve Horizon’s **current security model**
> (sanitized harness env, no direct agent access to worker secrets).

## Executive Summary

Claude Code’s “agent teams” feels powerful primarily because it combines:

- A **shared coordination channel** (mailbox)
- A **lead that can wake up and steer** based on partial results
- A **shared view** of who is doing what

Eve already wins on persistence, orchestration, isolation, and review gates. The missing pieces are:

- A **coordination bus** that works even when agents cannot call the Eve API directly.
- A **general “wake on event”** mechanism (not just “wake when blockers clear”).
- A **first-class dispatch shape** for `fanout`, `council`, and `relay` that produces consistent wiring and visibility.

This v2 proposal is intentionally “boring infrastructure”: reuse Threads + Events + Jobs, but make them compose cleanly.

## What v2 Fixes vs v1

The v1 doc assumed jobs can `POST /threads/:id/messages` and `GET /threads/:id/messages` during execution.
Today:

- The Threads API supports `GET /threads/:id` and `POST /threads/:id/messages`, but **does not** expose message listing/streaming.
- Agent harness processes run in a **sanitized env** and should not receive privileged API keys, so “agents call the API” is not a safe baseline.

v2 makes coordination work with **worker/orchestrator mediation**, and uses the **event spine** for wakeups instead of polling thread tables.

## Constraints (From Current System Docs / Code)

- Control envelope only consumes `eve.status ∈ {waiting, success, failed}` today. `waiting` requeues the job and applies a short backoff when there are no blockers. (`docs/system/job-control-signals.md`)
- Threads exist as a durable primitive (`threads`, `thread_messages`, `thread_subscriptions`) but are currently used mainly for chat continuity. (`docs/system/threads.md`)
- The worker already parses streaming harness output and extracts the final `json-result` block. (`apps/worker/src/invoke/invoke.service.ts`)
- Agent harness env is allowlisted; worker secrets are intentionally excluded. (`apps/worker/src/invoke/env-builder.ts`)
- Thread message creation emits events (`chat.message.received` / `chat.message.sent`) when routed through the API. (`apps/api/src/threads/threads.service.ts`)
  - If the worker inserts coordination messages directly into `thread_messages`, it must also emit an `events` row for wakeups (or we fall back to polling).

## Gap Analysis (Same Gaps, Reframed)

### Gap 1: Inter-Agent Communication

Need: a shared coordination channel that supports “FYI”, “I found X”, “stop, that’s wrong”, “handoff to you”.

### Gap 2: Active Lead Steering

Need: lead wakes when something relevant happens (child finished, new message, user steer) without waiting for the whole fanout to complete.

### Gap 3: Dispatch Topologies (Council + Relay)

Need: first-class “same prompt, independent analyses” (council) and “sequential handoff” (relay) patterns.

### Gap 4: Shared Team Visibility

Need: every member can cheaply see siblings, status, and who is responsible.

### Gap 5: Real-Time Multi-Agent Visibility

Need: one stream a human can follow, not N terminals.

### Gap 6: Mid-Execution User Steering

Need: user can inject a steer into an in-flight coordination group.

## Design: Coordination Threads + Wake Subscriptions + Dispatch Templates

### 1) Coordination Threads (A Shared Bus That Already Exists)

**Core idea**: every dispatch group gets a single coordination thread, referenced by a deterministic key.

- Key format (proposal): `coord:job:{parent_job_id}` for a team dispatch rooted at a parent job.
- Thread record lives in `threads` (already unique per `project_id + key`).
- Messages live in `thread_messages`, linked back to `job_id` when relevant.

This makes Threads the general-purpose, persistent “mailbox” primitive (not just Slack continuity).

#### Why “thread key”, not “thread id on jobs”

Storing `dispatch_thread_id` on `jobs` is workable, but v2 prefers:

- Deterministic lookup: `threads.project_id + threads.key`
- Fewer schema changes
- Easier late binding (thread can be created lazily)

If we later want a fast-path, we can cache `coord_thread_id` in `jobs.hints.coordination.thread_id` without committing to a new first-class column.

### 2) Message Relay That Works With Sanitized Agent Envs

Agents should not need privileged credentials to participate in coordination.

**Mechanism**: the worker relays “coordination messages” extracted from harness output into `thread_messages`.

Two tiers:

1. **End-of-attempt relay (easy, high value)**:
   - If `result_json.eve.summary` exists, worker/orchestrator posts it as a coordination message for the job.
   - This gives immediate “what happened” visibility without any new harness behavior.

2. **Mid-attempt relay (optional, closes the real mailbox gap)**:
   - Define a small fenced block convention inside assistant text:
     ```text
     ```eve-message
     {"kind":"finding","body":"Token middleware closes WS upgrade via res.end() when expired."}
     ```
     ```
   - Worker parses these as they stream, rate-limits, and inserts them into `thread_messages`.

This preserves the “agents can talk” experience without handing agents an API token.

#### Message Shape (Proposal)

Store the human text in `body` and keep the JSON payload small and stable.

```json
{
  "kind": "finding|status|question|steer|handoff",
  "body": "string (<= 4KB)",
  "tags": ["optional", "strings"],
  "refs": { "job_id": "optional", "path": "optional", "url": "optional" }
}
```

If we want to avoid any schema changes, we store the JSON as the literal `body` string and treat it as structured by convention.
If we want cleanliness later, add `thread_messages.meta_json JSONB` (non-breaking).

### 3) Wake Subscriptions (Generalizing “waiting” Without Inventing New Phases)

The platform already supports: “yield control, requeue to `ready`” via `eve.status = waiting`.

What’s missing: **why** and **when** to wake again, beyond “blockers cleared”.

**Proposal**: extend the `json-result` envelope with an optional `eve.wait` block that instructs the orchestrator how to wake the job.

```json-result
{
  "eve": {
    "status": "waiting",
    "summary": "Dispatched 3 investigators; watching for early findings.",
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

Semantics:

- `waiting` keeps its current meaning (attempt completes, job requeued to `ready`, no review submit).
- `wait.wake_on` augments the wake condition:
  - `child.terminal`: wake when *any* child reaches a terminal phase.
  - `thread.message`: wake when a new message arrives in the coordination thread.
- `backoff_ms` replaces the hard-coded “waiting without blockers” backoff for this job.

Implementation note:

- Prefer using the **event spine** as the trigger source for `thread.message`.
  - Thread message creation emits `chat.message.*` events containing `thread_id` when routed through the API.
  - For worker-relayed coordination messages, also emit an `events` row (either insert directly or add an internal API path) so the orchestrator has a clean trigger source.
  - Orchestrator can match events to supervising jobs and clear `defer_until` (or directly enqueue).
- This avoids polling `thread_messages` and keeps wakeups deterministic.

This makes “supervising mode” a **preset** (a skill convention) rather than a new control status.

### 4) Dispatch Templates (fanout / council / relay)

All dispatch modes share the same foundation:

- Parent/child job hierarchy for membership
- Coordination thread keyed off the parent
- Wake subscriptions for the lead (when needed)

#### fanout (current, but make it consistent)

Template:

- Create parent job (lead) + children (members).
- Add `waits_for` relations from parent to children (optional default, configurable).
- Coordination thread exists for the group.

#### council (parallel independent analysis + synthesis)

Template:

- Same as fanout, plus:
  - All children receive the *same* core prompt.
  - Each child receives a role framing (security/perf/tests/etc).
  - Lead yields `waiting` with `eve.wait.wake_on = [child.terminal, thread.message]` to synthesize incrementally.

#### relay (sequential specialist handoff)

Template:

- Create a linear chain via `blocks` relations in member order.
- Each step writes a structured `handoff` message to the coordination thread.
- Next step’s prompt includes “read latest handoff messages” (worker injects inbox).
- Lead does not need “wake on message” semantics; relay is naturally sequential.

### 5) Visibility: “Dispatch Context” As a First-Class Read Path

Instead of making every skill stitch together siblings/children/threads:

**Proposal**: extend `/jobs/:id/context` with a `coordination` block when the job has a parent or children.

```json
{
  "coordination": {
    "thread_key": "coord:job:myproj-a3f2dd12",
    "thread_id": "thr_01...",
    "siblings": [{ "id": "...", "assignee": "...", "effective_phase": "active", "result_summary": "..." }]
  }
}
```

This closes “shared team visibility” without inventing a new API surface.

### 6) CLI/UX: One Stream to Follow

To make this feel real for humans, add thin CLI wrappers:

- `eve thread messages <thread-id> [--since ...]`
- `eve thread follow <thread-id>` (SSE)
- `eve job follow --tree <job-id>` (multiplex child completions + coordination thread)

These are deliberately incremental: we can start by listing/following thread messages and later add richer multiplexing.

## Implementation Plan (Phased)

### Phase 1: Coordination Thread + End-of-Attempt Relay

- Define coordination thread key convention (`coord:job:{parent_job_id}`).
- Ensure thread exists on first use (worker or API path).
- Post `result_summary` (and optionally a condensed `result_json`) into the coordination thread at attempt completion.
- Add read APIs to list thread messages (and SSE follow).

Closes: Gap 1 (partially), Gap 5 (basic), Gap 6 (basic).

### Phase 2: Wake Subscriptions via Events

- Extend control envelope with `eve.wait`.
- Orchestrator: when a waiting job has `wait.wake_on`, wake on:
  - child terminal transitions
  - `chat.message.*` events for the coordination thread

Closes: Gap 2.

### Phase 3: Council + Relay Templates

- Implement dispatch modes in the team dispatch builder (or orchestration skill helper).
- Add consistent job wiring (relations + coordination key).

Closes: Gap 3.

### Phase 4: Context Enrichment + Better CLI Multiplexing

- Add `coordination` block to `/jobs/:id/context` (thread + siblings summary).
- Add `eve job follow --tree` or a dedicated `eve dispatch follow`.

Closes: Gap 4, improves Gap 5.

## Open Questions

1. **Thread message listing + streaming API shape**:
   - Add `GET /threads/:id/messages` + `GET /threads/:id/messages/stream`?
   - Or reuse a generic events stream filtered by `payload.thread_id`?

2. **Message typing without schema changes**:
   - Is “JSON body by convention” acceptable for MVP?
   - If not, add `thread_messages.meta_json JSONB` early to avoid future churn.

3. **Wakeup cursors**:
   - Store “last seen message id / event id” in job state (new JSON column) to avoid repeated wakeups?
   - Or accept idempotent wakes initially and rely on backoff?

4. **Human steering UX**:
   - For Slack-initiated dispatches, reuse the existing Slack thread as the coordination thread.
   - For non-Slack dispatches, define a “link coordination thread to Slack channel” command later.
