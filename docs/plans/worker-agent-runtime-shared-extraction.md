# Worker / Agent-Runtime Shared Code Extraction Plan

## Scope

**Goal**: remove duplicated execution-path code between Worker and Agent Runtime so both services import from one source of truth.

**Outcome**: shared implementations in `packages/shared/` with clear ownership for future changes to harnesses, git policy, env building, and invocation helpers.

**Constraints**: no intentional behavior changes unless explicitly called out in phase notes.

## Context

Eve Horizon has two services that execute agent jobs: **Worker** (original, 2886-line invoke service) and **Agent Runtime** (newer warm-pod service, 1411-line invoke service). The agent-runtime was forked from the worker and has drifted. This caused a critical bug: commit `233743b` added git commit/push policies to Worker, but Agent Runtime was missed. Since Agent Runtime handles all jobs when `EVE_AGENT_RUNTIME_URL` is set (both k3d and staging), git auto-commit never worked in those environments. The fix (commit `fa481cf`) patched Agent Runtime, but the root cause — duplicated code — remains.

**Goal**: extract duplicated code into `packages/shared/` so both services import from one source of truth. Future changes to harnesses, git policies, env building, and invocation helpers should automatically apply to both execution paths.

## Success Criteria

- Both apps compile and use shared modules from `@eve/shared` for each extracted area.
- Git commit/push behavior matches across Worker and Agent Runtime.
- End-to-end job execution remains behaviorally equivalent after each batch.
- Shared tests are migrated from service-local locations and run in the standard test suite.
- Agent Runtime gains Worker's missing features: `ANTHROPIC_BASE_URL` passthrough (harnesses), `EVE_ENV_NAME`/`EVE_RESOURCE_INDEX` (env-builder), shallow clone + multi-stage checkout (git).

## Phase 1: Harness Adapters (Zero Risk)

**Move to `packages/shared/src/harnesses/adapters/`**

| File | Source | Notes |
|---|---|---|
| `types.ts` | Either (100% identical) | Rename `WorkerHarnessAdapter` → `HarnessAdapter`, `WorkerHarnessContext` → `HarnessContext`, `WorkerHarnessHelpers` → `HarnessHelpers` |
| `reasoning.ts` | Either (100% identical) | Pure logic |
| `index.ts` | Either (100% identical) | Rename `resolveWorkerAdapter` → `resolveHarnessAdapter` |
| `claude.ts` | **Worker** (canonical) | Has `ANTHROPIC_BASE_URL` passthrough (Agent Runtime missing since 2026-02-13) |
| `mclaude.ts` | **Worker** (canonical) | Has `ANTHROPIC_BASE_URL` passthrough |
| `zai.ts` | **Worker** (canonical) | Has `ANTHROPIC_BASE_URL` fallback to `Z_AI_BASE_URL` |
| `gemini.ts` | Either (100% identical) | |
| `code.ts` | Either (100% identical) | |
| `codex.ts` | Either (100% identical) | |

**Changes in each service**:
- Delete `apps/worker/src/invoke/harnesses/` (keep `__tests__/`, migrate to shared).
- Delete `apps/agent-runtime/src/invoke/harnesses/`.
- Update imports: `import { resolveHarnessAdapter } from '@eve/shared'`.
- Update type imports: `import type { HarnessAdapter, HarnessName, PermissionPolicy, HarnessHelpers, HarnessContext } from '@eve/shared'`.

**Test migration**: Move `apps/worker/src/invoke/harnesses/__tests__/anthropic-base-url.spec.ts` to `packages/shared/src/harnesses/__tests__/adapter-base-url.spec.ts`. Agent Runtime has no adapter tests — the migrated Worker tests cover both services after extraction.

**Behavior improvement**: Agent Runtime gains `ANTHROPIC_BASE_URL` support in claude, mclaude, and zai adapters. This fixes managed-model inference routing through LiteLLM bridges in Agent Runtime environments.

## Phase 2: API Client Modules (Zero Risk)

**Move to `packages/shared/src/api-client/`**

| File | Source | Notes |
|---|---|---|
| `event-emitter.ts` | Either (100% identical, 96 lines) | `emitRunnerEvent()` |
| `secret-client.ts` | Agent Runtime (cleaner imports) | Functionally identical; only import grouping differs |
| `auth-client.ts` | **Worker** (canonical, 82 lines) | Agent Runtime (62 lines) silently returns null on errors; Worker logs warnings |

**Consumers** (10 import sites total):
- Worker (7 files): `deployer`, `action-executor`, `pipeline-runner`, `invoke.service`, `invoke.controller`, `script-executor`, `registry-auth`
- Agent Runtime (3 files): `invoke.service`, `runtime.controller`

**Changes**: Delete `apps/worker/src/api-client/` and `apps/agent-runtime/src/api-client/`. Update all 10 import sites to `import { resolveProjectSecrets, mintJobToken, emitRunnerEvent } from '@eve/shared'`. Use explicit exports in the shared index (not wildcard re-exports).

**No tests to migrate** — neither service has api-client tests.

## Phase 3: Environment Builder (Low Risk)

**Move to `packages/shared/src/harnesses/env-builder.ts`**

Use Worker's version (superset). Worker has 2 extra optional params (`envName`, `resourceIndexPath`) that Agent Runtime doesn't currently pass — that's fine since they're optional and the conditional output logic handles `undefined` gracefully.

**Latent bug fix**: Agent Runtime's `invoke.service.ts` already sets `env_name` on invocations via `applyManifestDefaults()` but never passes it to `buildSanitizedHarnessEnv()`. After extraction, Agent Runtime should wire `envName` and `resourceIndexPath` through to the shared function so agents get `EVE_ENV_NAME` and `EVE_RESOURCE_INDEX` in their environment. This is a minor follow-up change in Agent Runtime's caller, not in the shared module itself.

**Test migration**: Move `apps/worker/src/invoke/__tests__/env-sanitization.spec.ts` (248 lines, comprehensive coverage including both extra params) to `packages/shared/src/harnesses/__tests__/env-sanitization.spec.ts`. Agent Runtime has no env-builder tests.

## Phase 4: Git Workspace (Medium Risk)

**Move to `packages/shared/src/git/git-workspace.ts`**

Use Worker's 644-line implementation as base (15 public methods, 3 private), add `setResolvedMetadata()` from Agent Runtime (375 lines, 14 public methods).

Key improvements Agent Runtime gains:
- Shallow clone optimization (`--depth 1`) + full-clone fallback on branch checkout failure.
- `detectUnpushedCommits()` — uses `git rev-list` to catch all unpushed commits including agent-made ones (fixes a real bug where Agent Runtime's `push()` only pushes if `this.commits.length > 0`).
- Git user config at `init()` instead of redundant per-`commit()` config.
- Multi-stage checkout fallback (direct → remote tracking branch → detached HEAD).
- `ensureInitialized()` safety guard called by checkout, createBranch, commit, etc.
- Remote branch checking in `branchExists()` (Agent Runtime only checks local).

Key addition from Agent Runtime:
- `setResolvedMetadata()` — needed because Agent Runtime invoker sets metadata externally.

**Return type decision**: Worker's `getResolvedMetadata()` always returns an object (never `undefined`). Agent Runtime's returns `undefined` if ref/sha not set. The shared version should return `ResolvedGitMetadata | undefined` (nullable) and update Worker callsites to handle `undefined`. This is safer — callers that assume non-null metadata on an uninitialized workspace would get a compile-time error instead of a runtime surprise.

**Changes**: Delete `apps/worker/src/git/` and `apps/agent-runtime/src/git/`. Update imports to `import { GitWorkspace } from '@eve/shared'`.

**Risk controls**:
- Keep behavior parity by adding focused tests for clone strategy fallback, metadata roundtrip (`setResolvedMetadata` + `getResolvedMetadata`), push-detection edge cases (`detectUnpushedCommits` with agent-made commits), and shallow-clone fallback.

## Phase 5: Git Policy Functions (Low Risk)

**Move to `packages/shared/src/git/git-policies.ts`**

Extract `handleCommitPolicy()` (~25 lines), `handlePushPolicy()` (~18 lines), and `formatCommitMessage()` (~8 lines) as standalone functions. These are 100% identical between services except one minor difference: Worker's `handlePushPolicy` reads `workspace.getResolvedMetadata().pushed` (assumes non-null), while Agent Runtime uses `workspace.getResolvedMetadata()?.pushed` (optional chaining). The shared version should use optional chaining to be safe with the nullable return type from Phase 4.

Zero dependency on `this.db` or NestJS — these methods only interact with `GitWorkspace` and a `Logger` instance.

**Function signatures** (standalone, not class methods):
```typescript
function handleCommitPolicy(workspace: GitWorkspace, gitConfig: JobGit, jobId: string, logger: Logger): Promise<void>
function handlePushPolicy(workspace: GitWorkspace, gitConfig: JobGit, logger: Logger): Promise<void>
function formatCommitMessage(template: string | undefined, jobId: string): string
```

**Changes**: Remove these methods from both `InvokeService` classes. Import from shared: `import { handleCommitPolicy, handlePushPolicy } from '@eve/shared'`.

## Phase 6: Invoke Utilities (Medium Risk)

**Move to `packages/shared/src/harnesses/invoke-utils.ts`**

**Directly extractable** (identical between services, file-level functions, no `this` dependency):
- `extractPrefixedEnv()` — both services have identical file-scope implementations
- `sanitizeSecretFilename()` — both services have identical file-scope implementations
- `writeEveCredentials()` — both services have near-identical async methods (Worker has slightly more verbose logging)

**Requires reconciliation** (different implementations for different deployment models):
- Worker has `resolveEveAgentCliCommand()` — **async**, checks for local dev path at `packages/eve-agent-cli/dist/index.js`
- Agent Runtime has `resolveHarnessBinary()` — **sync**, checks for containerized path at `/app/packages/eve-agent-cli/bin/eve-agent-cli.js`
- Agent Runtime has `buildHarnessArgs()` — **only in Agent Runtime**, no Worker equivalent
- These are NOT aliases for the same function. The shared version should provide a unified `resolveEveAgentCli()` that accepts a deployment context (local dev vs container) or use environment detection. Alternatively, keep binary resolution service-specific and only extract the truly shared utilities.

**What stays service-specific** (legitimate differences):
- Worker: `runReleaseHook()`, `writeCoordinationInbox()` (uses `this.db`), `writeCarryoverContext()` (uses `this.db`), billing/cost tracking, `resolveMclaudeAuth()`.
- Agent Runtime: `materializeScopedOrgFsMount()`, `ensureOrgRoot()`, `runAcquireHooks()`.
- Both (different): `execute()` (different lifecycles), `prepareWorkspaceWithGitControls()` (different ref resolution).

## Phase 7 (Optional): K8s Runner Rationalization

**Move shared infra to `packages/shared/src/k8s/runner-infra.ts`**

Extract:
- `pollForCompletion()`
- `execKubectl()`
- name utilities
- pod lifecycle
- `LifecycleLogger` type.

Keep service-specific:
- `buildRunnerManifests()` (legitimate env/security differences).

## Out of Scope

- Pipeline/build/release logic.
- Orchestration/job-state semantics.
- CLI command surface changes.

## Batching and Sequencing

```
Batch 1 (Phases 1-3): ~2 hours — Pure file moves, no logic changes, one PR
Batch 2 (Phases 4-5): ~2.5 hours — Git workspace merge + policy extraction, separate PR
Batch 3 (Phase 6):    ~1.5 hours — Invoke utility extraction, separate PR
Batch 4 (Phase 7):    ~2 hours — Optional, do when K8s runner next needs changes
```

Phases 1-3 can be done in parallel. Phases 4-5 depend on shared package being stable. Phase 6 depends on Phases 1-5. Phase 7 is independent but low priority.

## Verification Strategy

For each batch:
1. `pnpm build` — both apps compile with updated imports.
2. `pnpm test` — all unit tests pass (including migrated tests).
3. `./bin/eh test integration` — full invoke flow works end-to-end.
4. **For Batch 2**: Manual smoke test on k3d with `git.commit: auto` + `git.push: on_success`, verify `resolved_git.pushed: true`.

**Suggested minimal smoke flow for Batch 2**
- Submit one job that triggers file edits and auto commit/push.
- Verify orchestrator/job logs show correct policy branches and git metadata.
- Verify remote branch visibility for that job is updated as expected.

## Rollback Strategy

- Keep each batch small and stop at a green boundary.
- If a batch introduces regression, revert only that batch's imports and shared module additions, then reapply incrementally.

## Critical Files

| File | Role | Lines |
|---|---|---|
| `packages/shared/src/index.ts` | Shared package export point; update as modules are added | 22 exports |
| `apps/worker/src/invoke/invoke.service.ts` | Largest consumer (git policies at ~L971-1026, utilities scattered) | 2886 |
| `apps/agent-runtime/src/invoke/invoke.service.ts` | Second consumer (git policies at ~L1166-1218) | 1411 |
| `apps/worker/src/git/git-workspace.ts` | Canonical git workspace | 644 |
| `apps/agent-runtime/src/git/git-workspace.ts` | Simpler fork (has `setResolvedMetadata`, lacks optimizations) | 375 |
| `apps/worker/src/invoke/harnesses/` | Canonical harness adapters (8 files + tests) | ~280 |
| `apps/agent-runtime/src/invoke/harnesses/` | Stale adapters (missing `ANTHROPIC_BASE_URL`, no tests) | ~250 |
| `apps/worker/src/invoke/env-builder.ts` | Canonical env builder (superset with 2 extra params) | ~120 |
| `apps/worker/src/api-client/` | Canonical API client (3 files, better logging) | ~265 |

## Existing Shared Package State

`packages/shared/src/harnesses/` already contains 712 lines of harness infrastructure (auth, capabilities, registry, security policy, config) but **not** adapters, env-builder, or invoke-utils. The adapters directory will be a new subdirectory within the existing harnesses module.

`packages/shared/src/k8s/` already contains 353 lines (namespace hardening, apply-hardening) but **not** runner infrastructure. Phase 7 adds to this existing module.

`packages/shared/src/git/` and `packages/shared/src/api-client/` do not exist yet.
