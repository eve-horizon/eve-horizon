# Invoke Parity & Shared Module Plan

> **Status**: Complete (2026-03-11)
> **Created**: 2026-03-11
> **Supersedes**: `agent-runtime-feature-parity-plan.md` (Phase 1 items)
> **Scope**: `packages/shared/src/invoke/`, `apps/agent-runtime/`, `apps/worker/`
> **Priority**: P1 — parity gaps affect production agent jobs

## Problem

The worker (`apps/worker/src/invoke/invoke.service.ts`, 3,050 lines) and agent-runtime (`apps/agent-runtime/src/invoke/invoke.service.ts`, 1,907 lines) are divergent forks. ~1,050 lines of near-identical code are duplicated across them.

**All agent jobs route to agent-runtime.** The worker only runs builds, deploys, pipelines, and scripts. Features added to the worker's agent path are dead code that never executes.

### Current Parity Gaps

| # | Gap | Priority | Lines to Port |
|---|-----|----------|---------------|
| 1 | Budget enforcement (`max_tokens`/`max_cost`, `llm.call` tracking, kill) | P1 | ~290 |
| 2 | `writeCarryoverContext()` (memory, docs, parent attachments) | P2 | ~123 |
| 3 | Security CLAUDE.md to `CLAUDE_CONFIG_DIR` | P2 | ~11 |
| 4 | `resolveMclaudeAuth` missing `ANTHROPIC_API_KEY` check | P2 | ~5 |
| 5 | `extractResultText`/`extractTokenUsage` missing Codex formats | P3 | ~40 |
| 6 | `extractErrorMessage` (structured error extraction) | P3 | ~54 |
| 7 | Harness lifecycle events (start/end) | P3 | ~30 |
| 8 | Resource hydration events | P3 | ~22 |

Worker already has implementations for most of these behaviors. The extraction should start from worker’s implementations and remove duplication by using them from both services.

### Existing Shared Utilities

Some invoke utilities are already extracted into `packages/shared/src/harnesses/`:

| File | Functions | Notes |
|------|-----------|-------|
| `invoke-utils.ts` | `extractPrefixedEnv`, `sanitizeSecretFilename`, `writeEveCredentials`, `getInvocationJobToken`, `resolveInvocationJobToken` | Already used by both services |
| `security-policy.ts` | `buildSecurityPolicyPreamble`, `buildSecurityClaudeMd` | Content builders only — no I/O |

These must be absorbed into the new `packages/shared/src/invoke/` module (or re-exported from it) to avoid split discoverability.

### Root Cause

Porting features one-at-a-time into two 2,000+ line files guarantees future drift. We need a structural fix.

## Strategy

**Extract shared invoke logic into `packages/shared/src/invoke/`**, then close parity gaps as part of the extraction. Both services import from the shared module. New features are added once, in the shared module.

This is a composition-based approach (shared functions that accept explicit dependencies) — not a base class. The two services have different NestJS module structures and different execution environments (warm pods vs ephemeral containers). A base class would force artificial coupling.

## Architecture

```
packages/shared/src/invoke/
├── index.ts                    # barrel export
├── types.ts                    # shared interfaces (InvokeContext, LogSink, etc.)
├── result-extraction.ts        # extractResultText, extractResultJson, extractTokenUsage, extractErrorMessage
├── attachment-staging.ts       # stageAttachments
├── carryover-context.ts        # writeCarryoverContext
├── coordination.ts             # writeCoordinationInbox, writeThreadContext
├── security-policy.ts          # re-export from harnesses/ + add writeSecurityClaudeMd I/O helper
├── budget-enforcement.ts       # BudgetEnforcer class
├── harness-lifecycle.ts        # logHarnessStart, logHarnessEnd (wrappers around logLifecycleEvent)
├── workspace-hooks.ts          # runHook, runAcquireHooks, runReleaseHook
├── workspace-secrets.ts        # resolveSecrets, prepareGitAuth, materializeSecrets, cleanupSecretArtifacts, sanitizeSecretFilename
├── resource-hydration.ts       # hydrateResources (+ hydration events)
├── git-utils.ts                # runGit, getLocalRepoPath, redactRepoUrl, updateAttemptGitMeta
├── codex-auth.ts               # writeBackCodexAuth
├── eve-credentials.ts          # writeEveCredentials (absorb from harnesses/invoke-utils.ts)
├── env-utils.ts                # extractPrefixedEnv (absorb from harnesses/invoke-utils.ts)
└── eve-message-relay.ts        # EveMessageRelay (AR's superset version)
```

### Dependency Injection Pattern

Shared functions accept an `InvokeContext` bag instead of reaching for `this`:

```typescript
// packages/shared/src/invoke/types.ts

/** Minimal logging sink — both worker and agent-runtime can provide this. */
export interface LogSink {
  appendLog(attemptId: string, type: string, content: unknown): Promise<void>;
}

/** Lifecycle event logger callback. */
export type LifecycleLogger = (
  attemptId: string,
  phase: LifecyclePhase,
  action: LifecycleAction,
  meta?: Record<string, unknown>,
) => Promise<void>;

/** Shared context bag passed to extracted functions. */
export interface InvokeContext {
  db: Db;
  logs: LogSink;
  logLifecycle: LifecycleLogger;
  apiUrl: string;
  internalToken: string;
}
```

Functions that need DB queries take the specific query object:

```typescript
// Example: attachment-staging.ts
export async function stageAttachments(
  workspacePath: string,
  files: ChatFile[],
  opts: { apiUrl: string; internalToken: string },
): Promise<void> { ... }
```

## Implementation Phases

### Phase 1: Extract & Close P1/P2 Gaps (one PR)

Extract the shared module AND close the top 4 parity gaps in a single coherent PR. This is the structural fix that prevents future drift.

**Step 1: Create `packages/shared/src/invoke/` with extractions from both services**

Extract these identical/near-identical methods (starting from easiest):

| Module | Functions | Source Lines | Notes |
|--------|-----------|-------------|-------|
| `git-utils.ts` | `runGit`, `getLocalRepoPath`, `redactRepoUrl`, `updateAttemptGitMeta` | ~60 | Pure functions + one DB helper. `updateAttemptGitMeta` exists in both services (~25 lines each) |
| `result-extraction.ts` | `extractResultText`, `extractResultJson`, `extractTokenUsage`, `extractErrorMessage`, `extractResults` | ~200 | Pure functions. **Port Worker's complete version** including Codex format support — closes gap #5, #6 |
| `attachment-staging.ts` | `stageAttachments` | ~85 | Already identical in both files (ported to AR in `41271732`) |
| `coordination.ts` | `writeCoordinationInbox`, `writeThreadContext` | ~70 | Already identical (ported to AR in `e8f8de81`), need `Db` param |
| `workspace-hooks.ts` | `runHook`, `runAcquireHooks`, `runReleaseHook` | ~110 | Near-identical. Worker calls them `runWorkspaceHooks`/`runReleaseHook` — normalize to AR naming |
| `workspace-secrets.ts` | `resolveSecrets`, `prepareGitAuth`, `materializeSecrets`, `cleanupSecretArtifacts` | ~120 | Near-identical. `prepareGitAuth` (~35 lines) exists in both services but was missing from the original table |
| `codex-auth.ts` | `writeBackCodexAuth` | ~40 | Near-identical |
| `eve-message-relay.ts` | `EveMessageRelay` | ~170 | Use AR's superset version (with `deliverToChat` + `relayToCoordinationThread`) |
| `resource-hydration.ts` | `hydrateResources`, `emitResourceHydrationEvent` | ~220 | **Not identical** — worker has `emitResourceHydrationEvent()` (gap #8) that AR lacks. Extract both together — closes gap #8 |
| `harness-lifecycle.ts` | `logHarnessStart`, `logHarnessEnd` | ~30 | Thin wrappers around `logLifecycleEvent('harness', 'start'/'end', ...)`. Worker has these calls; AR does not — closes gap #7 |
| `security-policy.ts` | `writeSecurityClaudeMd` | ~15 | I/O helper only. `buildSecurityClaudeMd` already exists at `packages/shared/src/harnesses/security-policy.ts` — re-export, don't duplicate — closes gap #3 |
| `carryover-context.ts` | `writeCarryoverContext` | ~123 | Port from Worker — closes gap #2 |
| `budget-enforcement.ts` | `BudgetEnforcer` class | ~290 | Port from Worker — closes gap #1 |
| `eve-credentials.ts` | `writeEveCredentials`, `getInvocationJobToken`, `resolveInvocationJobToken` | ~80 | **Absorb** from existing `packages/shared/src/harnesses/invoke-utils.ts` |
| `env-utils.ts` | `extractPrefixedEnv`, `sanitizeSecretFilename` | ~20 | **Absorb** from existing `packages/shared/src/harnesses/invoke-utils.ts` |

**Step 2: Wire shared module into agent-runtime**

Replace duplicated methods with imports from `@eve/shared/invoke`. Add missing calls:

```typescript
// Before harness launch:
await writeCarryoverContext(repoPath, invocationWithOptions, ctx);    // NEW — gap #2
await stageAttachments(repoPath, chatFiles, ctx);                     // EXISTING (now shared)
await writeCoordinationInbox(invocationWithOptions, repoPath, db);    // EXISTING (now shared)
await writeThreadContext(invocationWithOptions, repoPath, db);        // EXISTING (now shared)

// In harness options resolution:
resolveMclaudeAuth: add ANTHROPIC_API_KEY check before OAuth         // FIX — gap #4

// After harness options resolution:
const claudeConfigDir = harnessOptionsResolved.env?.CLAUDE_CONFIG_DIR;
if (claudeConfigDir) {
  await writeSecurityClaudeMd(repoPath, claudeConfigDir); // NEW — gap #3
}

// Harness execution:
logHarnessStart(attemptId, harnessName, ...);                        // NEW — gap #7
const budgetEnforcer = new BudgetEnforcer(config, ...);              // NEW — gap #1
// ... in rl.on('line'): budgetEnforcer.processEvent(parsed);
// ... on close: budgetEnforcer.stop();
logHarnessEnd(attemptId, harnessName, code, durationMs);             // NEW — gap #7
```

**Step 3: Wire shared module into worker**

Replace duplicated methods with imports from `@eve/shared/invoke`. The worker keeps its build/deploy-specific code but imports all shared invoke utilities. Use AR's `EveMessageRelay` (superset) to replace the worker's simpler version.

**Step 4: Fix `resolveMclaudeAuth` in agent-runtime (gap #4)**

Add `ANTHROPIC_API_KEY` check before OAuth fallback. Note: the worker checks `env.ANTHROPIC_API_KEY` (already materialized into process env), while the agent-runtime's helper receives `resolvedSecrets` directly. The fix uses the AR's pattern:

```typescript
resolveMclaudeAuth: async (options) => {
  const authEnv: Record<string, string | undefined> = {};
  const apiKeySecret = resolvedSecrets.find(s => s.key === 'ANTHROPIC_API_KEY');
  if (apiKeySecret) {
    authEnv.ANTHROPIC_API_KEY = apiKeySecret.value;
  } else if (oauthTokens?.accessToken) {
    authEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthTokens.accessToken;
  }
  return { env: authEnv };
},
```

**Step 5: Deprecate `packages/shared/src/harnesses/invoke-utils.ts`**

After absorption into the new `invoke/` module, update the old file to re-export from the new location with a deprecation comment. Update all existing import sites in a follow-up.

### Phase 2: Clean Up & Verify (follow-up PR)

1. **Delete dead agent-execution code from worker** — The worker's `EveMessageRelay`, `writeCarryoverContext`, budget enforcement, and security CLAUDE.md code in the agent path are dead code. Now that both services import from the shared module, remove the worker's duplicated versions entirely.

2. **Migrate import sites for old `invoke-utils.ts`** — Update all consumers that import from `@eve/shared` harnesses/invoke-utils to use the new `@eve/shared/invoke` paths. Then delete the old file.

3. **Close duplicate beads** — Close eve-horizon-664, 665, 666 as duplicates of 672, 671, 673.

4. **Update documentation**:
   - `CLAUDE.md` — Add note about shared invoke module and where to add new features
   - `docs/system/agent-runtime.md` — Document all agent-execution features now available
   - Close `agent-runtime-feature-parity-plan.md` as superseded

5. **Verification loop** — See [Verification Loop](#verification-loop) section below. Run the full loop after Phase 2 cleanup, not just after Phase 1.

## Verification Loop

Three-tier verification confirms correctness across both agent-runtime and worker after extraction.

### Tier 1: Build & Unit Tests (~5 min)

Gate: nothing else runs if this fails.

```bash
pnpm install && pnpm build && pnpm test
```

**What this catches**: import breakage, type errors, missing exports from the new `packages/shared/src/invoke/` barrel, circular dependencies.

### Tier 2: Integration Tests (~10 min)

```bash
./bin/eh test integration
```

**What this catches**: API contract regressions, job lifecycle flow, DB query failures from refactored methods. Both agent-runtime and worker start as local pnpm processes — any broken import or missing DI provider crashes on startup.

### Tier 3: K8s Manual Scenarios (~40 min)

Deploy to k3d, then run targeted scenarios that exercise both runtimes and every parity gap.

```bash
# 0. Rebuild and deploy
./bin/eh k8s deploy                # Full rebuild: images + manifests + migration

# 1. Verify stack health
./bin/eh status
eve system health --json           # Must return {"status":"ok"}

# 2. Ensure test org + secrets
eve org ensure "manual-test-org" --slug manual-test-org --json
eve secrets import --org org_manualtestorg --file manual-tests.secrets
```

#### Group A: Agent-Runtime Verification (parallel, ~4 min)

These scenarios create agent jobs → routed to agent-runtime. They confirm the shared module works when called from agent-runtime.

| Scenario | Feature Under Test | Parity Gaps Covered |
|----------|--------------------|---------------------|
| **02 — Job Execution** | Full agent job lifecycle: create → execute (LLM) → complete. Result text extraction, token usage reporting. | #5 (extractResultText), #6 (extractTokenUsage) |
| **09 — Agent Security** | Env allowlist, security policy preamble, CLAUDE.md generation to CLAUDE_CONFIG_DIR, no `.eve/secrets.env` in workspace. | #3 (security CLAUDE.md) |

```bash
# Run in parallel
# Scenario 02: agent job lifecycle
eve project ensure --org org_manualtestorg --slug iparity-02 \
  --repo-url https://github.com/eve-horizon/eve-horizon-starter --branch main
eve job create --project proj_iparity02 --prompt "Say hello" --agent default --json
# → eve job follow <id>
# ✓ Job completes with phase "done"
# ✓ eve job result <id> returns extracted result text (not empty)
# ✓ eve job show <id> --verbose shows token usage > 0

# Scenario 09: security isolation
# (follow tests/manual/scenarios/09.md)
# ✓ Security CLAUDE.md written to CLAUDE_CONFIG_DIR
# ✓ No forbidden env vars (DATABASE_URL, EVE_SECRETS_MASTER_KEY)
# ✓ Security policy preamble in agent prompt
```

#### Group B: New Parity Gap Verification (sequential, ~8 min)

Targeted jobs that exercise the four P1/P2 gaps. These don't map to existing scenarios — they're purpose-built for this refactor.

**B1: Budget Enforcement (Gap #1)**

```bash
eve project ensure --org org_manualtestorg --slug iparity-budget \
  --repo-url https://github.com/eve-horizon/eve-horizon-starter --branch main

# Create a job with a tight token budget
eve job create --project proj_iparitybudget \
  --prompt "Write a very long essay about the history of computing" \
  --agent default \
  --hint max_tokens=500 \
  --json
# → eve job follow <id>
# ✓ Job terminates before exhausting full response
# ✓ eve job show <id> --verbose shows budget.exceeded log entry
# ✓ Token usage in attempt metadata ≤ budget + small overshoot
```

**B2: Carryover Context (Gap #2)**

```bash
eve project ensure --org org_manualtestorg --slug iparity-ctx \
  --repo-url https://github.com/eve-horizon/eve-horizon-starter --branch main

# Seed an org doc that carryover will materialize
eve docs put --org org_manualtestorg --path "memory/test-context.md" \
  --content "Remember: the secret code is PARITY-OK"

# Create an agent with context block referencing org docs
# (requires agent YAML with context: docs: paths: ["memory/"])
eve job create --project proj_iparityctx \
  --prompt "What is the secret code from your context?" \
  --agent default \
  --json
# → eve job follow <id>
# ✓ Job output references "PARITY-OK" (context was materialized)
# ✓ .eve/context/docs/ directory was created in workspace
```

**B3: resolveMclaudeAuth ANTHROPIC_API_KEY (Gap #4)**

```bash
# Verify that a project with ANTHROPIC_API_KEY secret uses it for auth
# (not OAuth fallback)
eve secrets set --org org_manualtestorg --key ANTHROPIC_API_KEY --value "$ANTHROPIC_API_KEY"

eve job create --project proj_iparity02 \
  --prompt "Say hello" \
  --agent default \
  --harness claude \
  --json
# → eve job follow <id>
# ✓ Job completes successfully (auth worked)
# ✓ No OAuth token errors in logs
# ✓ Attempt logs show ANTHROPIC_API_KEY auth path (not CLAUDE_CODE_OAUTH_TOKEN)
```

#### Group C: Worker Regression Verification (sequential, ~10 min)

These scenarios create pipeline/build/deploy jobs → routed to worker. They confirm the shared module works when called from the worker, and that build/deploy-specific code is untouched.

| Scenario | Feature Under Test | Why It Matters |
|----------|--------------------|----------------|
| **05 — Deploy Flow** | Full pipeline: build → release → deploy. Worker-only code path. | Confirms worker build/deploy logic survived extraction. |
| **07 — Sentinel Deploy** | Sentinel app deploy with DB migration, self-update, smoke test. | Exercises worker's K8s provisioning, manifest application, and health checks. |

```bash
# Scenario 05: deploy flow (follow tests/manual/scenarios/05.md)
# ✓ Build step completes, image pushed to k3d registry
# ✓ Release step generates artifact
# ✓ Deploy step applies manifests, pods reach Ready
# ✓ App accessible via ingress

# Scenario 07: sentinel deploy (follow tests/manual/scenarios/07.md)
# ✓ Sentinel app deploys to sandbox env
# ✓ DB migration runs successfully
# ✓ Health endpoint returns 200
# ✓ Self-update flow triggers and completes
```

#### Group D: Cross-Cutting Verification (parallel, ~6 min)

Features that span both runtimes or exercise the shared module's utility layer.

| Scenario | Feature Under Test | Shared Module Coverage |
|----------|--------------------|----------------------|
| **10 — AgentPacks & Skills** | Pack resolution, on-clone hooks, skills auto-discovery | workspace-hooks.ts, env-utils.ts |
| **12 — Cost Tracking** | Pricing, llm.call events, balance ledger, receipts | result-extraction.ts (token usage), budget-enforcement.ts (rate cards) |
| **16 — Resource Refs** | Resource resolver + workspace hydration + diagnostics | resource-hydration.ts (events) |
| **27 — Claude Harness Auth** | CLAUDE_CODE_OAUTH_TOKEN auth, credential handling | eve-credentials.ts, codex-auth.ts |

```bash
# Run 10, 12, 16, 27 in parallel (follow respective scenario .md files)
# Key assertions per scenario:

# 10: ✓ on-clone hooks execute, ✓ skills.sh installs in workspace
# 12: ✓ llm.call events emitted, ✓ receipt generated with correct token counts
# 16: ✓ resource hydration events (started/completed) in event log
# 27: ✓ Claude harness authenticates via OAuth token, ✓ job completes
```

#### Group E: Harness Lifecycle & Error Extraction (sequential, ~4 min)

Validates the P3 gaps that are observable only through logs and events.

```bash
# E1: Harness lifecycle events (Gap #7)
eve job create --project proj_iparity02 \
  --prompt "Say hello" --agent default --json
# → eve job follow <id>
# ✓ Job logs contain harness.start event with harness name, model, permission
# ✓ Job logs contain harness.end event with exit_code=0, duration_ms > 0

# E2: Error extraction (Gap #6)
eve job create --project proj_iparity02 \
  --prompt "This will fail" --agent default \
  --harness zai \
  --hint max_tokens=1 \
  --json
# → eve job follow <id>
# ✓ If job fails: eve job show <id> --verbose shows structured error message
# ✓ Error message extracted from system_error or spawn_error (not raw log dump)

# E3: Resource hydration events (Gap #8)
# (covered by scenario 16 in Group D, but verify events explicitly)
eve events list --org org_manualtestorg --type system.resource.hydration.completed --json
# ✓ At least one hydration event present from Group D run
```

### Verification Summary

| Tier | Time | Catches | Run When |
|------|------|---------|----------|
| 1 — Build & Unit | ~5 min | Import breakage, type errors, circular deps | Every commit |
| 2 — Integration | ~10 min | API contracts, job lifecycle, DI failures | Every PR |
| 3 — K8s Manual | ~40 min | Runtime correctness, parity gaps closed, worker regression | Phase 1 merge + Phase 2 merge |

**Total wall-clock for Tier 3** (with parallelism): ~25 min

```
Time  0    5    10   15   20   25 min
      ├────┤                           Group A (02 + 09, parallel)
      ├─────────┤                      Group D (10 + 12 + 16 + 27, parallel)
           ├─────────────┤             Group B (budget + ctx + auth, sequential)
                ├─────────────┤        Group C (05 + 07, sequential)
                         ├────┤        Group E (lifecycle + error, sequential)
```

### Pass/Fail Criteria

**All of the following must be true** before merging:

- [ ] `pnpm build` — zero errors
- [ ] `pnpm test` — all unit tests pass
- [ ] `./bin/eh test integration` — all integration tests pass
- [ ] Group A — Agent jobs complete, result text + token usage extracted
- [ ] Group B — Budget kills job, carryover context materializes, ANTHROPIC_API_KEY auth works
- [ ] Group C — Build → release → deploy pipeline completes, sentinel deploys
- [ ] Group D — Hooks execute, llm.call events emitted, hydration events fire, Claude auth works
- [ ] Group E — Harness start/end lifecycle events logged, error messages structured
- [ ] No worker regression — scenarios 05 + 07 behave identically to pre-refactor baseline

### Failure Triage

| Symptom | Likely Cause | Check |
|---------|-------------|-------|
| Service won't start in k3d | Missing export from `packages/shared/src/invoke/index.ts` | `kubectl -n eve logs deployment/eve-agent-runtime` |
| Agent job stuck in `active` | agent-runtime crashed during invoke | `eve job diagnose <id>`, check pod restarts |
| Build/deploy fails | Worker import broke | `kubectl -n eve logs deployment/eve-worker` |
| Budget not enforced | `BudgetEnforcer` not wired into agent-runtime's harness loop | Check `rl.on('line')` handler for `budgetEnforcer.processEvent()` |
| Carryover context empty | `writeCarryoverContext` not called before harness launch | Check call order in AR's `invoke()` method |
| Security CLAUDE.md missing | `writeSecurityClaudeMd` not called after options resolution | Check for `CLAUDE_CONFIG_DIR` in AR's env setup |
| Token usage = 0 | `extractTokenUsage` not handling the harness's event format | Check which event format the harness emits (llm.call vs raw.message.usage) |
| Hydration events missing | `emitResourceHydrationEvent` not wired in AR | Check `hydrateResources()` callsites |

## Line Count Impact

| Location | Before | After | Delta |
|----------|--------|-------|-------|
| `packages/shared/src/invoke/` | 0 | ~1,550 | +1,550 |
| `packages/shared/src/harnesses/invoke-utils.ts` | 137 | 0 | -137 |
| `apps/agent-runtime/.../invoke.service.ts` | 1,907 | ~850 | -1,057 |
| `apps/worker/.../invoke.service.ts` | 3,050 | ~1,950 | -1,100 |
| **Net** | 5,094 | ~4,350 | **-744** |

The agent-runtime drops to ~45% of current size. The worker drops to ~64% (it retains build/deploy/pipeline-specific code). The shared module becomes the single source of truth for agent-execution logic.

## Preventing Future Drift

After extraction, the rule is simple:

> **Agent-execution features go in `packages/shared/src/invoke/`.** Both services import them. If you add a feature to one invoke service's local code, you're doing it wrong.

Add this to `CLAUDE.md`:

```markdown
## CRITICAL: Shared Invoke Module

Agent-execution features (attachments, context, budget, security, message relay,
hooks, secrets, result extraction) live in `packages/shared/src/invoke/`.

**Rules:**
1. New agent-execution features → `packages/shared/src/invoke/`
2. Both `agent-runtime` and `worker` import from the shared module
3. Service-specific code stays local (K8s runner pods, build provisioning, etc.)
4. Never duplicate invoke logic between the two services
```

## Beads

| Issue | Title | Status |
|-------|-------|--------|
| eve-horizon-672 | Port budget enforcement to agent-runtime | open (P1) |
| eve-horizon-671 | Port writeCarryoverContext to agent-runtime | open (P2) |
| eve-horizon-673 | Port security policy CLAUDE.md write path to agent-runtime | open (P2) |
| eve-horizon-674 | Fix resolveMclaudeAuth to check ANTHROPIC_API_KEY | open (P2) |

All four will be closed by Phase 1 of this plan.

**Duplicate beads to close:** eve-horizon-664 (dup of 672), eve-horizon-665 (dup of 671), eve-horizon-666 (dup of 673). These are older beads for the same work items — close them as duplicates when starting Phase 1.

## Risks

1. **Large refactor surface** — Moving ~1,050 lines across module boundaries in one PR is significant. Mitigated by: each extraction is a pure mechanical move with minimal logic changes, and integration tests cover the critical paths.

2. **Worker regression** — The worker's build/deploy path must not break. Mitigated by: we only extract the shared agent-execution code, leaving build/deploy logic untouched in the worker.

3. **Import cycles** — `packages/shared` already exports invoke-related utilities. Adding more must not create circular dependencies. Mitigated by: the new `invoke/` directory only imports from other `@eve/shared` modules and external deps, never from `apps/*`.

4. **Existing import site migration** — `packages/shared/src/harnesses/invoke-utils.ts` is already imported by both services and possibly other packages. Moving these functions requires updating all import sites or maintaining re-exports. Mitigated by: Phase 1 keeps the old file as a re-export shim; Phase 2 cleans up.
