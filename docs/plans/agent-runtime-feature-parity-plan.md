# Agent Runtime Feature Parity

> **Status**: Superseded by `invoke-parity-and-shared-module-plan.md` (shipped 224ffbd, 2026-03-11)
> **Created**: 2026-03-10
> **Scope**: agent-runtime, worker, CLAUDE.md, architecture docs
> **Priority**: P1 — features are being built on the wrong service

## Problem

The agent-runtime is the **primary execution path** for all agent/chat jobs in every deployed environment (k3d, staging, future production). The worker only handles pipeline actions, scripts, and legacy pipeline runs.

Despite this, agent-execution features have been built on the worker:

| Feature | Worker | Agent-Runtime | Impact |
|---|---|---|---|
| `EveMessageRelay` (eve-message parsing) | Full | None | Dead code — never runs for agent jobs |
| Budget enforcement (`llm.call` tracking) | Full | None | No cost caps in production |
| Carryover context (memory, docs, attachments) | Full | None | Agents miss context |
| Security policy CLAUDE.md | Full | None | No security sandbox for Claude harnesses |
| `writeCoordinationInbox` | Full | Full (just ported) | Fixed in e8f8de8 |
| `writeThreadContext` | Full | Full (just ported) | Fixed in e8f8de8 |

### Root Cause (5 Whys)

1. **Worker is bigger and looks primary** — 3,050 lines vs 1,594 lines. Developers see it first.
2. **Routing is invisible** — A single `if (process.env.EVE_AGENT_RUNTIME_URL)` at line 1640 of the orchestrator silently redirects all agent jobs. No docs explain this.
3. **CLAUDE.md is misleading** — Architecture summary says "Worker: invokes harness via eve-agent-cli" and shows `Orchestrator -> Worker -> Harness` as the primary flow. Agent-runtime is described as "warm pods for low-latency chat" — sounds optional, not primary.
4. **No shared code** — The invoke services are forks that diverge silently. No feature parity tracking.
5. **No architectural boundary docs** — Nothing says "if you're adding agent execution features, put them on the agent-runtime."

## Goals

1. Port missing agent-execution features to agent-runtime
2. Clean up misleading documentation and architecture diagrams
3. Prevent future divergence with clear guidance in CLAUDE.md
4. (Future) Extract shared invoke logic to eliminate the duplication

## Non-Goals

- Removing the worker (it's needed for builds, deploys, pipelines, scripts)
- Extracting a shared invoke module (important but separate effort)
- Adding new features (like chat progress updates — that comes after this)

## Implementation

### Phase 1: Port Features to Agent-Runtime

**1a. EveMessageRelay**

Port the `EveMessageRelay` class from `apps/worker/src/invoke/invoke.service.ts` to the agent-runtime's invoke service. Wire it into the `rl.on('line')` handler.

Files:
- `apps/agent-runtime/src/invoke/invoke.service.ts` — add EveMessageRelay class, wire into line processing

**1b. Budget Enforcement**

Port the `llm.call` aggregation and budget ceiling enforcement from worker. This includes:
- Token/cost aggregation per `llm.call` event
- Periodic budget check (every 2s)
- Kill-switch when ceiling exceeded
- `budget.exceeded` lifecycle event

Files:
- `apps/agent-runtime/src/invoke/invoke.service.ts` — add budget enforcement to harness execution loop

**1c. Carryover Context**

Port `writeCarryoverContext()` from worker. This materializes:
- Agent memory hints into `.eve/context/`
- Parent job attachments
- Org docs

Files:
- `apps/agent-runtime/src/invoke/invoke.service.ts` — add writeCarryoverContext method, call before harness launch

**1d. Security Policy CLAUDE.md**

Port security policy CLAUDE.md generation for Claude-family harnesses.

Files:
- `apps/agent-runtime/src/invoke/invoke.service.ts` — write security CLAUDE.md to CLAUDE_CONFIG_DIR

### Phase 2: Update Documentation

**2a. CLAUDE.md Architecture Summary**

Fix the misleading architecture diagram and service descriptions. Make it clear which service handles which job types.

**2b. Add CRITICAL section about job routing**

Add a new CRITICAL section that explains the routing boundaries and where to put agent execution features.

**2c. Update Key Decisions table**

Add a decision entry for "Agent-runtime is primary for agent jobs."

### Phase 3: Clean Up Worker (Low Priority)

The worker's `EveMessageRelay` and agent-specific features aren't harmful as dead code — they just add confusion. Options:

- **Option A**: Leave them as-is with a comment explaining they're vestigial (the worker path still works if `EVE_AGENT_RUNTIME_URL` is unset)
- **Option B**: Remove them and make the worker purely for actions/scripts/pipelines

Recommend **Option A** for now — the worker path is a valid fallback and removing it creates risk with no benefit.

## Verification

1. Deploy to k3d with agent-runtime features
2. Run chat job → verify `EveMessageRelay` fires on agent-runtime
3. Run budget-limited job → verify enforcement works
4. Run job with carryover context → verify `.eve/context/` materializes
5. Run Claude harness job → verify security CLAUDE.md exists

## Future: Shared Invoke Module

The real fix is extracting shared logic into `packages/shared/src/invoke/`:
- `EveMessageRelay`
- Budget enforcement
- Context materialization (coordination inbox, thread context, carryover)
- Security policy generation
- Codex auth handling

Both worker and agent-runtime would import from this shared module. This eliminates divergence at the source. But it's a larger refactor — do it after the immediate parity fixes.
