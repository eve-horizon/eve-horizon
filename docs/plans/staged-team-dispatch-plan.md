# Staged Team Dispatch

> **Status**: Implemented
> **Date**: 2026-03-10
> **Author**: Adam / Claude
> **Scope**: Chat service (dispatch), Orchestrator (wake/promote), Schema (staged flag)
> **Dependencies**: `agent-team-coordination-plan.md` (Phase 1: coordination threads — implemented), `chat-file-materialization-plan.md` (file staging — in progress)

## Problem

A team lead can't prepare work before members start.

When someone drops a meeting recording in Slack with "@EveBot pm review this", the expert panel should transcribe the audio first, then fan the transcript out to seven domain experts, then synthesize their findings. Today's dispatch modes can't express this:

| Mode | Behavior | Why it fails |
|------|----------|-------------|
| **Fanout** | Lead + members start simultaneously | Experts get raw audio they can't read |
| **Council** | Same as fanout with supervising lead | Same problem — members start before lead can prepare |
| **Relay** | Sequential chain | 7 experts run one-by-one (21 min vs 3 min) |

The pattern we need is **prepare → fan out → synthesize**: the lead does pre-processing, members work in parallel on the prepared material, and the lead collects and synthesizes results.

This isn't unique to PM panels. The same shape appears in:
- **Code review councils** — lead identifies affected areas, reviewers analyze in parallel, lead synthesizes
- **Research teams** — lead gathers sources, analysts evaluate in parallel, lead writes brief
- **Investment committees** — lead prepares deal memo, evaluators assess in parallel, lead writes recommendation
- **Incident response** — lead triages, investigators work streams in parallel, lead writes RCA

## Design Principle

**Staged dispatch is not a new mode — it's an option on council mode.**

Council already establishes the right semantics: lead coordinates, members work the same problem, lead synthesizes. Staging just controls *when* members start. This keeps the mode taxonomy clean and avoids combinatorial explosion.

```yaml
dispatch:
  mode: council
  staged: true        # Lead prepares before members start
```

## Architecture

```
@EveBot pm review this + meeting.m4a
    │
    ▼  chat.yaml routes to team:expert-panel
    │
    ▼  Chat service creates:
    │    1. Lead job (ready phase, staged: true, supervising: true)
    │    2. 7 member jobs (backlog phase — won't be claimed)
    │    3. Coordination thread
    │
    ▼  Orchestrator claims lead job
    │
    ▼  LEAD: PREPARE
    │   reads .eve/attachments/index.json
    │   detects audio → transcribes via whisper-cli
    │   posts transcript to coordination thread
    │   returns eve.status = "prepared", eve.summary = "Transcript ready"
    │
    ▼  Orchestrator sees "prepared" on staged job:
    │    1. Promotes 7 backlog children → ready
    │    2. Requeues lead with wake_on: [children.all_done]
    │
    ▼  7 EXPERTS (parallel)
    │   each reads coordination thread → gets transcript
    │   each analyzes from their domain perspective
    │   each returns eve.summary → auto-relayed to coordination thread
    │
    ▼  Orchestrator wakes lead (all children done)
    │
    ▼  LEAD: SYNTHESIZE
    │   reads 7 summaries from coordination thread
    │   writes executive summary with consensus/dissent/actions
    │   returns eve.status = "success"
    │
    ▼  Result posted back to Slack
```

### Why `backlog` phase?

The `backlog` phase already exists in the job lifecycle (`idea → backlog → ready → active → review → done`). It means "defined but not ready to work." The orchestrator only claims `ready` jobs. Creating member jobs in `backlog`:

- Makes them **visible immediately** — `eve job list` shows the full team roster from dispatch time
- Requires **no new phases or states** — existing lifecycle, existing queries
- **Promotion is trivial** — a single SQL update: `UPDATE jobs SET phase = 'ready' WHERE parent_id = ? AND phase = 'backlog'`
- Follows the **progressive refinement** pattern — jobs move forward through phases, never backward

### Why not deferred member creation?

An alternative is to not create member jobs until the lead signals `prepared`, storing member configs in the lead's hints. Rejected because:

- **Duplicates dispatch logic** — the orchestrator would need to understand agent resolution, harness profiles, and member ordering (currently only the chat service knows this)
- **Invisible members** — nobody can see the team roster until the lead finishes
- **Larger blast radius** — changes touch orchestrator job creation, which has complex budget/quota interactions

Creating in `backlog` is simpler, more visible, and reuses existing primitives.

## Implementation

### Change 1: Schema — `staged` flag

**File**: `packages/shared/src/schemas/agent-config.ts`

```typescript
const TeamDispatchSchema = z.object({
  mode: z.enum(['fanout', 'council', 'relay']).optional(),
  staged: z.boolean().optional(),              // ← new, only valid for council
  max_parallel: z.number().int().min(1).optional(),
  merge_strategy: z.string().optional(),
  lead_timeout: z.number().int().positive().optional(),
  member_timeout: z.number().int().positive().optional(),
}).passthrough()
  .superRefine((dispatch, ctx) => {
    if (dispatch.staged === true && dispatch.mode !== 'council') {
      ctx.addIssue({
        code: 'custom',
        path: ['mode'],
        message: "dispatch.staged=true is only valid when dispatch.mode is 'council'",
      });
    }
  });
```

**Validation**: `staged: true` is only valid with `mode: council`; unsupported combos should be rejected at schema validation.

### Change 2: Chat service — create members in `backlog`

**File**: `apps/api/src/chat/chat.service.ts` (lines ~268-289)

When `staged: true` and `mode: council`:

```typescript
const isStaged = dispatch?.staged === true && dispatchMode === 'council';
const shouldStageMembers = isStaged && effectiveMemberIds.length > 0;
if (isStaged && effectiveMemberIds.length === 0) {
  console.warn(`Team ${team.id} dispatch is staged but has no members; falling back to normal council flow.`);
}

// Existing lead job creation unchanged (already sets supervising: true for council)
// Add staged hint to lead job:
hints: {
  ...threadHints,
  ...(isSupervisingLead ? { supervising: true } : {}),
  ...(isStaged ? { staged: true } : {}),
  ...(leadTimeout ? { timeout_seconds: leadTimeout } : {}),
},

// Member creation — change initial phase for staged dispatch:
const child = await this.jobsService.create(projectId, {
  parent_id: parent.id,
  description: this.buildJobDescription(data, route, thread.id),
  assignee: memberId,
  // ... existing fields ...
  phase: shouldStageMembers ? 'backlog' : 'ready',  // ← new
});
```

**Note**: `jobs.create()` already accepts `phase` (`CreateJobRequest.phase`) and defaults to `ready`.

### Change 3: Orchestrator — recognize `prepared` and promote children

**File**: `apps/orchestrator/src/loop/loop.service.ts` (~line 1694, in the attempt completion handler)

After extracting `eveControl` from the result, before the existing status handling:

```typescript
// Staged council: lead signals "prepared" → promote backlog children to ready
if (
  eveControl.status === 'prepared' &&
  (job.hints as Record<string, unknown>)?.staged === true
) {
  // Promote all backlog children to ready
  const promoted = await this.db`
    UPDATE jobs
    SET phase = 'ready', updated_at = NOW()
    WHERE parent_id = ${job.id}
      AND phase = 'backlog'
    RETURNING id
  `;
  console.log(`Staged dispatch: promoted ${promoted.length} children for job ${job.id}`);

  const currentHints = (job.hints ?? {}) as Record<string, unknown>;
  if (promoted.length === 0) {
    // Defensive: avoid sleeping indefinitely on an empty roster.
    await this.db`
      UPDATE jobs
      SET hints = ${this.db.json({ ...currentHints, staged: false } as never)}, updated_at = NOW()
      WHERE id = ${job.id}
    `;
    await jobs.requeueReady(job.id, 'orchestrator', {
      reason: 'Staged dispatch fallback: no children to run',
    });
  } else {
    // Requeue lead with children.all_done wake condition
    await this.db`
      UPDATE jobs SET
        hints = ${this.db.json({
          ...currentHints,
          staged: false,              // Clear staged flag (prepare phase done)
          wait: { wake_on: ['children.all_done'] },
        } as never)},
        updated_at = NOW()
      WHERE id = ${job.id}
    `;
    await jobs.requeueReady(job.id, 'orchestrator', {
      reason: 'Staged dispatch: waiting for members',
    });
  }

  return; // Skip normal status handling
}
```

**Key behaviors**:
- `prepared` is a new `eve.status` value, distinct from `waiting`/`success`/`failed`
- After promotion, the lead is requeued with `children.all_done` — the existing wake machinery handles the rest
- The `staged` flag is cleared so the lead's synthesis phase uses normal completion logic
- `relayToCoordinationThread` already runs for all completed attempts, so members receive the lead’s summary automatically
- If no staged children were created, the lead is requeued immediately to avoid waiting on `children.all_done`

### Change 5: Orchestrator — normalize `prepared` status

**File**: `apps/orchestrator/src/loop/loop.service.ts` (~line 98)

Add `prepared` to the status extraction:

```typescript
// In extractEveControl():
const status = typeof statusRaw === 'string' ? statusRaw.toLowerCase() : undefined;
// 'prepared' is handled specially for staged dispatch (Change 4)
// All other statuses flow through existing logic
```

Update `EveControlStatus` and `resolveOrchestrationOutcome` so `prepared` is allowed in typing, and so staged flow lands in the dedicated prepared branch above.

## Team YAML Example

```yaml
# teams.yaml
version: 1
teams:
  expert-panel:
    lead: pm-coordinator
    members:
      - tech-lead
      - ux-advocate
      - biz-analyst
      - gtm-advocate
      - risk-assessor
      - qa-strategist
      - devils-advocate
    dispatch:
      mode: council
      staged: true
      lead_timeout: 3600
      member_timeout: 300
```

## Agent Skill Pattern

### Lead agent (coordinator) — three-phase lifecycle

```markdown
## Execution Protocol

You have three phases. Return the correct `eve.status` for each.

### Phase 1: PREPARE (first attempt)

1. Read `.eve/attachments/index.json` — check if the user attached files
2. For audio/video files:
   - Transcribe using whisper-cli
   - Write transcript to a file in the workspace
3. For all file types:
   - Summarize the content and key discussion points
4. Post the prepared content to the coordination thread:
   ```eve-message
   {"kind":"status","body":"## Prepared Content\n\n{transcript or summary here}"}
   ```
5. Return with:
   ```json
   {"eve": {"status": "prepared", "summary": "Content prepared for expert review"}}
   ```

### Phase 2: WAIT (automatic)

The platform promotes your team members and wakes you when they're all done.
You don't need to do anything for this phase.

### Phase 3: SYNTHESIZE (second attempt, after children.all_done)

1. Read `.eve/coordination-inbox.md` for all expert summaries
2. Synthesize into an executive summary:
   - Key consensus points
   - Areas of disagreement
   - Critical risks identified
   - Recommended actions
3. Return with:
   ```json
   {"eve": {"status": "success", "summary": "Executive summary: ..."}}
   ```
```

### Member agents (experts) — read coordination thread

```markdown
## Context

You are part of a staged expert panel. The coordinator has already prepared
the content for your review.

1. Read `.eve/coordination-inbox.md` — this contains the coordinator's
   prepared content (transcript, summary, or extracted text)
2. Also check `.eve/attachments/` for any files you can read directly
   (PDFs, images, text files)
3. Analyze from your domain perspective
4. Return with:
   ```json
   {"eve": {"status": "success", "summary": "Your expert analysis here"}}
   ```
```

## Coordination Thread Flow

```
Time    Thread Messages
─────   ──────────────────────────────────────────────────
t=0     [system] Team expert-panel dispatched (staged council)
t=30    [pm-coordinator] {"kind":"status","body":"## Transcript\n\nAlice: ..."}
t=30    [pm-coordinator] eve.summary: "Content prepared for expert review"
        ── members promoted to ready ──
t=60    [tech-lead] eve.summary: "Technical feasibility: medium risk..."
t=65    [ux-advocate] eve.summary: "UX concerns: navigation flow..."
t=70    [biz-analyst] eve.summary: "Business impact: revenue uplift..."
t=72    [gtm-advocate] eve.summary: "Market positioning: competitive..."
t=75    [risk-assessor] eve.summary: "Risk assessment: 3 critical..."
t=78    [qa-strategist] eve.summary: "Test strategy: integration..."
t=80    [devils-advocate] eve.summary: "Counterarguments: assumptions..."
        ── lead wakes (children.all_done) ──
t=110   [pm-coordinator] eve.summary: "Executive Summary: ..."
```

## What Exists vs What's New

| Component | Status | Change |
|-----------|--------|--------|
| `backlog` phase | **Exists** | Used as "not ready" state for members |
| Coordination threads | **Exists** | Created at dispatch time (already implemented) |
| `eve.summary` relay | **Exists** | Auto-posted to coordination thread on completion |
| `children.all_done` wake | **Exists** | Clears deferral when all children done |
| `supervising` flag | **Exists** | Skips orphan detection for lead |
| `.eve/coordination-inbox.md` | **Worker only** | Agent runtime does NOT write it (see prerequisite below) |
| `staged` dispatch flag | **New** | ~1 line schema, ~5 lines chat service |
| `initial_phase` on job create | **New** | ~3 lines jobs service (pass through to INSERT) |
| `prepared` status handling | **New** | ~25 lines orchestrator |
| Backlog child cleanup | **New** | ~10 lines orchestrator (cancel backlog children on parent done/fail) |

**Total new code**: ~47 lines of platform changes, plus the agent-runtime prerequisite below.

## Prerequisite: Agent Runtime Coordination Inbox

**Blocker for staged dispatch when `EVE_AGENT_RUNTIME_URL` is set.**

The worker writes `.eve/coordination-inbox.md` at attempt start (`writeCoordinationInbox()` at `apps/worker/src/invoke/invoke.service.ts:520`). It also writes `.eve/thread-context.json` and `.eve/context/` (carryover context). The agent runtime (`apps/agent-runtime/src/invoke/invoke.service.ts`) implements **none of these** — no coordination inbox, no thread context, no carryover context.

When `EVE_AGENT_RUNTIME_URL` is set, ALL jobs route to agent-runtime warm pods. This means:
- Coordinator runs in agent-runtime → no inbox materialized (but coordinator reads `.eve/attachments/` directly, so this is tolerable)
- **Experts run in agent-runtime → no inbox → experts can't see the coordinator's transcript** (this breaks the flow)

**Fix**: Port `writeCoordinationInbox()` from worker to agent-runtime. The method:
1. Reads `hints.coordination.thread_id` from the parent job
2. Queries `thread_messages` for that thread (needs `threadMessageQueries` import)
3. Formats messages as markdown
4. Writes to `.eve/coordination-inbox.md` in the workspace

~50 lines, plus importing `threadMessageQueries` from `@eve/db`.

Ideally, extract the three workspace context methods (`writeCoordinationInbox`, `writeThreadContext`, `writeCarryoverContext`) into a shared module in `packages/shared/` to avoid continued divergence between worker and agent-runtime. But the immediate fix is to port just `writeCoordinationInbox`.

## Edge Cases

### Lead completes solo (success without prepared)

The most important edge case. If the coordinator returns `eve.status = "success"` without ever returning `"prepared"`:
- Children remain in `backlog` — never promoted, never claimed
- Parent job marked done (existing logic)
- **Backlog children must be cancelled.** Currently, neither `markJobDone` nor `markJobFailed` cascades to `parent_id` children. There is no child cancellation logic anywhere in the orchestrator or jobs queries.

**Fix (Change 5)**: After marking a staged lead as done or failed, cancel any children still in `backlog`:

```typescript
// In handleAttemptCompletion, after markJobDone/markJobFailed for staged leads:
if ((job.hints as Record<string, unknown>)?.staged === true) {
  const cancelled = await this.db`
    UPDATE jobs
    SET phase = 'cancelled', updated_at = NOW(),
        close_reason = 'Parent completed without promotion'
    WHERE parent_id = ${job.id} AND phase = 'backlog'
    RETURNING id
  `;
  if (cancelled.length > 0) {
    console.log(`Staged cleanup: cancelled ${cancelled.length} backlog children for job ${job.id}`);
  }
}
```

This covers all non-promotion paths:
- Solo success (coordinator answers directly)
- Failure (coordinator crashes)
- Timeout (no signal returned)

**Note**: The `staged` flag is only cleared in the `prepared` handler (Change 4). If the lead completes via any other path, `staged` is still `true` — which is exactly what we need to trigger cleanup.

### Lead preparation fails

If the lead returns `eve.status = "failed"` instead of `"prepared"`:
- Same cleanup as solo success — backlog children cancelled by Change 5
- Parent job marked failed (existing logic)

### Lead preparation times out

If the lead's attempt times out (no `prepared` signal):
- Same as failure — children stay in `backlog`, lead is retried or marked failed
- If lead exhausts retries and is marked failed, Change 5 cancels backlog children
- The existing attempt timeout logic handles this

### No files attached (text-only message)

The coordinator skill handles this gracefully:
1. Checks `.eve/attachments/index.json` — no files
2. Prepares the text content directly (no transcription needed)
3. Returns `prepared` immediately (~5 seconds)
4. Members fan out on the original text

Staged dispatch still adds value even without files — the coordinator can analyze the request, identify key questions, and frame the problem for experts.

### Mixed file types

Some files Claude can read natively (PDF, images, text), some need transcription (audio, video). The coordinator:
1. Transcribes audio/video → posts transcript
2. Summarizes PDFs/text → posts summary
3. Notes which files are available directly in `.eve/attachments/`

Members get both the coordinator's summary AND direct file access.

### Staged with no members

If `staged: true` but the team has no members (only a lead), the lead runs normally:
1. Prepare phase returns `prepared`
2. Orchestrator detects no promoted children and requeues lead immediately
3. Lead moves to phase 2 without waiting for wake conditions
4. Lead has no member summaries to consume — effectively a single-agent job

This is harmless but wasteful. The chat service should log a warning.

## Future Extensions

### `prepared` with member selection

The lead could return which members should run, enabling dynamic team composition:

```json
{
  "eve": {
    "status": "prepared",
    "summary": "This is a technical proposal, not a market analysis",
    "promote": ["tech-lead", "risk-assessor", "qa-strategist"]
  }
}
```

Members not in the `promote` list stay in `backlog` and get cancelled when the lead completes.

**Not in v1** — all members are promoted. But the `backlog` pattern makes this trivial to add later.

### Staged relay

A lead prepares, then a relay chain runs sequentially:

```yaml
dispatch:
  mode: relay
  staged: true
```

Same `prepared` signal, but children are promoted in sequence (each blocks on the previous). Low priority — relay is already sequential, so the lead can just be the first link in the chain.

### Multi-stage preparation

Some workflows need multiple preparation steps (e.g., transcribe → translate → summarize). This is a skill-level concern — the coordinator runs multiple tools in its prepare phase and only returns `prepared` when everything is ready. The platform doesn't need to know about sub-steps.

## Relationship to Other Plans

| Plan | Relationship |
|------|-------------|
| `agent-team-coordination-plan.md` | Staged dispatch builds on Phase 1 (coordination threads, already implemented) and complements Phase 2 (stay-alive supervision). When `eve supervise` lands, staged council leads can use stay-alive instead of return-and-wake for the synthesis phase. |
| `chat-file-materialization-plan.md` | Staged dispatch is the natural consumer of materialized files. The coordinator reads `.eve/attachments/` and transforms the content for the team. |
| `agents-teams-threads-primitives-plan.md` | Provides the teams, threads, and job hierarchy that staged dispatch wires together. |

## Implementation Order

| Step | What | Lines | Unblocks |
|------|------|-------|----------|
| 0 | **Port `writeCoordinationInbox` to agent-runtime** | ~50 | Experts can read coordinator's prepared content |
| 1 | Add `staged` to `TeamDispatchSchema` | ~2 | Schema validation |
| 2 | Chat service: create members in backlog when staged | ~10 | Staged dispatch wiring |
| 3 | Orchestrator: handle `prepared` status, promote children | ~25 | The full panel flow |
| 4 | Orchestrator: cancel backlog children on parent done/fail | ~10 | Solo path + error handling |

Step 0 is the prerequisite — without it, experts in agent-runtime warm pods can't see the coordinator's transcript. Steps 1-2 can be done in one commit. Steps 3-4 are the core orchestrator changes (can be one commit).

**Total**: ~97 lines of platform code. The rest is skill authoring in agent packs.
