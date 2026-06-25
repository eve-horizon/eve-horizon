# Job Observability Gaps Plan

> **Status**: Draft (revised)
> **Origin**: During Eden agent testing, a job appeared "stuck" for ~4 minutes with no log output. The harness was actually alive and generating content — but the CLI had no way to show this.
> **Verification source**: Local API mode + non-running k3d stack (2026-03-24).

## Problem Statement

Operators rely on `eve` for most debugging. If something appears stalled, they need CLI parity with what k8s gives them via `kubectl`.

## Local Stack Verification (as of 2026-03-24)

Performed checks:

- `./bin/eh status` → local mode is running, K3s cluster is **stopped**.
- `eve system health --json` → API + DB healthy in local mode.
- `eve system status --json` → returns `api`, `orchestrator`, `worker`, `postgres`, `agent_runtime`.
- `eve system status` (non-JSON) failed because CLI table renderer expects `queue` field that this response no longer includes.
- `eve agents --help` → `runtime-status` subcommand exists today.

These checks indicate parts of this plan are already implemented, while several visibility gaps are still unresolved.

## What Is Already Fixed

### CLI already shows

| Command | Coverage |
|---|---|
| `eve agents runtime-status --org <org-id>` | Shows `agent runtime` pod list with heartbeat and age |
| `eve job diagnose` | Shows execution/lifecycle log summary and recent recent logs |
| `eve job runner-logs` | Uses `runtime_meta.pod_name` to stream pod logs |

### API already exists

- `GET /orgs/:org_id/agent-runtime/status` in `apps/api/src/agent-runtime/agent-runtime.controller.ts` + service
- Internal heartbeat ingest: `POST /internal/orgs/:org_id/agent-runtime/heartbeat`
- Runtime metadata is persisted with `pod_name` in `apps/agent-runtime/src/invoke/invoke.service.ts` for inline and k8s-runner paths

## What Is Still Missing

### Gap 1: Harness liveness signal during long thinking

**Problem**: During long generation windows (e.g., multiple minutes), `eve job follow` can be silent and `eve job diagnose` can only reason from elapsed time.

#### Status

- ✅ `lifecycle_harness_start` / `lifecycle_harness_end` exist.
- ❌ No periodic heartbeat during harness execution.

#### Fix

Add periodic, structured heartbeat lines while the harness child is alive.

- **Files**: `apps/agent-runtime/src/invoke/invoke.service.ts`
- Add a timer that emits log entries while `child` is running.
- Recommended event shape: reuse existing lifecycle model with `type: lifecycle_harness_log` and `content.kind = 'heartbeat'` (to avoid adding unsupported action values).
- Include `elapsed_ms`, `pid`, and heartbeat timing fields.

### Gap 1b: Surface heartbeat state in diagnosis/stuck checks

#### Files

- `packages/cli/src/commands/job.ts`

#### Fix

- Parse the latest heartbeat event for latest running attempt.
- Show:
  - `Last heartbeat: 15s ago` under latest attempt
  - status line:
    - `▶ Harness alive (last heartbeat 12s ago)`
    - `⚠ No harness heartbeat for 90s` (possible crash)

### Gap 2: Pre-harness startup observability

**Problem**: Failures in clone/auth/CLI setup are still mostly invisible in CLI logs.

#### Status

- ❌ No lifecycle logs around plain git clone or app CLI bootstrap.
- ❌ `writeEveCredentials` write failures are only console logs.

#### Fix

#### 2.1 Log git clone phases

- **Files**: `apps/agent-runtime/src/invoke/invoke.service.ts` + `packages/shared/src/invoke/git-utils.ts` (helper if shared abstraction is preferred)
- Emit `workspace` lifecycle start/end around:
  - clone URL resolution and command execution
  - checkout/branch creation paths

#### 2.2 Log credential materialization

- **Files**: `packages/shared/src/invoke/eve-credentials.ts`
- Emit start/end lifecycle logs for `writeEveCredentials`:
  - `{ success, auth_source, redacted_token_key }`
  - `{ success: false, error }`

#### 2.3 Log app CLI discovery/setup

- **Files**: `apps/agent-runtime/src/invoke/invoke.service.ts`
- Promote current console log in app-CLI discovery to CLI-visible lifecycle log lines (resolved path, chmod result, PATH export, or explicit failure reasons).

#### 2.4 Latency reporting

- Extend diagnose latency extraction in `packages/cli/src/commands/job.ts` to include newly added workspace/secrets/app-cli entries in the existing waterfall.

### Gap 3: Agent runtime health via system commands

**Problem**: There is no system-level agent runtime status in one place for admins.

#### Status

- ✅ org-scoped command exists (`eve agents runtime-status`).
- ❌ no `system`-level equivalent; `eve system status` formatter is outdated.
- ✅ `GET /system/status` currently includes `agent_runtime` state (replicas/ready), but CLI ignores/does not render it safely.

#### Fix

#### 3.1 Add system-level agent runtime summary

- **Files**: `apps/api/src/system/*`, `packages/cli/src/commands/system.ts`
- Add system endpoint (if needed) or extend current `/system/status` shape with system-level counts/health for agent runtime pods.
- Update CLI formatter to handle missing fields defensively and include agent runtime health.

#### 3.2 Decide command shape

- Keep `eve agents runtime-status` (org-scoped) and add a true system command alias:
  - `eve system agents` (system admin scope)
  - or equivalent `eve system status --details` output block.

### Gap 4: Active job → pod health context in diagnose

**Status**

- ✅ `pod_name` is persisted in attempt `runtime_meta`.
- ❌ `eve job diagnose` does not render pod placement/health.

#### Fix

- **Files**: `packages/cli/src/commands/job.ts`
- Print pod name in latest attempt block.
- Optionally correlate with `eve agents runtime-status --org` to annotate pod health/last heartbeat.

### Gap 5: Follow-stream silence warning

**Problem**: `eve job follow` cannot help determine whether silence means progress or staleness.

#### Status

- ❌ No silence timer currently.

#### Fix

- **Files**: `packages/cli/src/commands/job.ts`
- Add wall-clock silence timer while SSE stream is active.
- At 60/120/300s without lines:
  - If heartbeat present: display elapsed heartbeat and liveness context.
  - If heartbeat missing: escalate to warning (possible stalled/crashed job).

## Implementation Order

| Phase | Gap | Effort | Impact |
|---|---|---|---|
| 1 | **Harness heartbeat** (Gap 1, 1b) | Medium | High |
| 2 | **Pre-harness startup logs** (Gap 2.1–2.3) | Medium | High |
| 3 | **Diagnose context + follow silence UX** (Gap 4, Gap 5) | Medium | High |
| 4 | **System-level agent runtime visibility** (Gap 3) | Medium | Medium |

Phases 1 + 2 remove the “is it alive?” blind spot. Phase 3 improves operator response time during active execution. Phase 4 standardizes admin workflows.

## Files Likely Changed

### Platform

| File | Change |
|---|---|
| `apps/agent-runtime/src/invoke/invoke.service.ts` | Add harness heartbeat + richer startup/CLI bootstrap lifecycle logs |
| `packages/shared/src/types/lifecycle.ts` | Add any new lifecycle phase/action if needed for heartbeat event shape |
| `packages/shared/src/invoke/eve-credentials.ts` | Credential write start/end events |
| `packages/shared/src/invoke/git-utils.ts` | Optional helper for clone logging with lifecycle callbacks |
| `apps/api/src/agent-runtime/*` | Verify/extend system-level status aggregation if we need admin-wide view |
| `packages/api/src/system/*` | Return agent runtime health in system status safely for CLI rendering |
| `packages/cli/src/commands/system.ts` | Render agent-runtime system status + avoid `/system/status` queue-contract crash |
| `packages/cli/src/commands/job.ts` | Diagnose pod/heartbeat display + follow silence timer |

### Skillpacks/docs

| File | Change |
|---|---|
| `references/cli-jobs.md` | Document heartbeat/stall diagnostics and `eve agents runtime-status` behavior |
| `references/deploy-debug.md` | Add “agent appears running but silent” playbook |
| `references/jobs.md` | Add heartbeat lifecycle/logging event guidance |
| `references/troubleshooting.md` | Add step-by-step triage flow with new commands |

## Success Criteria

After implementation, an agent can answer without kubectl:

1. **“Is my job’s harness alive?”** — `eve job diagnose` + `eve job follow` show heartbeat recency.
2. **“Did startup fail before harness launch?”** — pre-harness clone/credential/app-cli lifecycle events are visible in `eve job logs` and diagnose.
3. **“Is the agent runtime healthy?”** — org view via `eve agents runtime-status` and system/admin summary in `eve system status/agents`.
4. **“Which pod is running my job?”** — `eve job diagnose` includes pod_name and health context.
5. **“Should silent output concern me?”** — follow-mode silence timer gives explicit guidance and escalates if heartbeat is stale.
