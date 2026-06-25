# Agent Step Toolchains and Delegation Lifecycle Plan

> **Status**: Implemented
> **Date**: 2026-06-03
> **Source**: External gap report (via Codex) — "Agent workflow steps should expose declared toolchains and bounded delegation status"
> **Motivation**: A manifest workflow declared `toolchains: [python]` on a lead *agent* step. The runtime contract silently broke: `python3` was absent and the agent had to download a standalone runtime into the workspace. Separately, delegated sub-agent workers stuck at initialization left the lead waiting indefinitely with no bounded failure signal — the workflow root had to be cancelled by hand.
> **Scope**: Two independent but co-reported runtime contracts in the agent execution path:
> - **Part A** — Make declared `toolchains` actually available to the harness process in **inline** agent-runtime execution (the default in every environment), or fail clearly.
> - **Part B** — Bound the **initialization** lifecycle of delegated worker attempts so a hung sub-agent becomes an actionable error instead of an open-ended stuck run.
> **Review update (2026-06-03)**: Verified against current code. Important corrections folded into this plan:
> - `markExecutionStarted` is currently set very early in both inline execution paths, before secrets/workspace/toolchain/harness setup. Do not treat `execution_started_at` as "harness process started" unless the implementation moves that mark.
> - `CompleteAttemptResult` has no `errorCode` field today. Classified failures must either add durable attempt error-code storage or put the code in `result_json`/events and teach diagnose to read it.
> - Agent-runtime base/local manifests need the same toolchain env/cache wiring as the worker manifests, and generated local-k8s assets under `packages/cli/assets/local-k8s/` must be updated with the source manifests.
> **Implementation update (2026-06-03)**:
> - Inline agent-runtime now provisions declared toolchains with shared `ensureToolchains` before `markExecutionStarted`, injects toolchain PATH/env into the harness process, logs provisioning events, and fails fast with `result_json.error_code = "toolchain_unavailable"`.
> - Agent-runtime images/manifests now include `crane`, writable `/opt/eve/toolchains`, `EVE_TOOLCHAIN_*` env wiring, and local in-cluster registry overrides; local-k8s assets are mirrored from source.
> - Runner-pod execution and inline execution both populate `runtime_meta.toolchains`.
> - The orchestrator now reaps pre-acceptance and pre-harness-start wedges with `attempt_init_timeout` and `attempt_startup_timeout`, storing durable codes in `result_json.error_code` and rendering them through `eve job diagnose`.
> - Script/action worker jobs now call `markExecutionStarted` after executor acceptance so the startup watchdog does not misclassify healthy worker setup. The startup watchdog is additionally scoped to agent jobs, because script/action workers do not emit `lifecycle_harness_start`.
> - `completeAttempt(... resultJson ...)` now stores JSONB objects via `db.json(...)` instead of double-encoded JSON strings; `eve job diagnose` also tolerates older stringified `result_json` rows.

## Verification evidence (2026-06-03)

- `./bin/eh status`: passed at session start and after redeploy. The script still reports the existing sandbox `/bin/ps: Operation not permitted` warning, but exits 0 and identifies this checkout as the k3d owner.
- Targeted tests passed:
  - `pnpm --filter @eve/agent-runtime test -- --run src/invoke/toolchains.spec.ts`
  - `pnpm --filter @eve/orchestrator test -- --run src/loop/loop.service.test.ts` (14 files, 272 tests)
  - `pnpm --filter @eve/worker test -- --run src/script-executor/execution-started.spec.ts src/script-executor/script-executor.controller.spec.ts src/action-executor/action-executor.controller.spec.ts src/script-executor/script-executor.toolchains.spec.ts test/unit/action-executor-env-name.unit.test.ts` (21 files, 158 tests)
  - `pnpm --filter @eve-horizon/cli test -- --run test/job-result.test.ts test/local-k8s-assets.test.ts` (17 files, 51 tests)
  - `EVE_DB_NAME_TEST=eve_test_agent_toolchains_event ./bin/eh test integration --target test/integration/event-router.integration.test.ts` (6 tests)
- Builds passed:
  - `pnpm --filter @eve/agent-runtime build`
  - `pnpm --filter @eve/orchestrator build`
  - `pnpm --filter @eve/worker build`
  - `pnpm --filter @eve-horizon/cli build`
  - `pnpm --filter @eve/db build`
  - `pnpm build` (existing CLI `import.meta`/CJS warning only), rerun after the final DB/CLI patches.
- Full test gates passed after the final DB/CLI patches:
  - `pnpm test`
  - `EVE_DB_NAME_TEST=eve_test_agent_toolchains_full3 ./bin/eh test integration` (60 files passed, 6 skipped; 203 tests passed, 13 skipped). The default `eve_test` database had stale active jobs from an earlier interrupted run, so the full gate used an isolated test DB rather than dropping local state.
- Local k3d verification:
  - `./bin/eh k8s deploy` passed before manual checks, and was rerun after the result-json storage fix.
  - `EVE_API_URL=http://api.eve.lvh.me node packages/cli/bin/eve.js system health --json` returned `{"status":"ok","database":"connected"}` after redeploy and after cleanup.
  - `./bin/eh kubectl -n eve get pods -o wide` showed API, orchestrator, worker, agent-runtime, dashboard, SSO, gateway, registry, postgres, and auth services running, with migrate/bootstrap jobs completed.
- Inline agent toolchain manual proof:
  - Manual project `proj_example` (`atinline`) ran workflow `python-inline-smoke`, root `atinline-40c08ee8`, step `atinline-40c08ee8.1`.
  - The step completed `done` on the inline agent-runtime path with harness `claude`; logs included `Toolchain python cache hit`, `Loaded toolchain python environment`, and harness output `Python 3.11.2`.
  - Direct API attempt metadata for attempt `39db3735-61e1-410f-9e09-1665e703f8ec` recorded `runtime_meta.toolchains.execution_mode = "inline"`, `requested = ["python"]`, `resolved = ["python"]`, `missing = []`, and events `cache_hit`/`env_loaded`.
  - Workspace CLI `node packages/cli/bin/eve.js job diagnose atinline-40c08ee8.1` rendered `Accepted` plus the `Toolchains` block (`Mode: inline`, `Requested/Resolved: python`, `Missing: (none)`, `Source: cache_hit`).
  - Earlier `zai` and `codex` variants reached harness start but failed with provider 401s; the successful proof used the same workflow and toolchain request with the direct Claude harness.
- Delegated init-timeout manual proof:
  - With temporary local-only `EVE_ORCH_ATTEMPT_INIT_TIMEOUT_SECONDS=20` and `EVE_ORCH_ATTEMPT_STARTUP_TIMEOUT_SECONDS=30`, child `dinit-816f0483` was manually claimed by `delegated-worker` while the orchestrator was paused; its attempt had `execution_started_at: null`.
  - After restoring the orchestrator, the child was failed in the init window with structured result JSON `{ "error_code": "attempt_init_timeout" }`.
  - `node packages/cli/bin/eve.js job diagnose dinit-816f0483` rendered `Error Code: attempt_init_timeout` and the classified init-timeout hints.
  - Lead job `dinit-be70002b` that `waits_for` the child closed as cancelled with `Close Reason: Upstream job dinit-816f0483 failed`; it was not left in an unbounded wait.
  - The temporary orchestrator timeout env vars were removed after both timeout scenario runs and rollout was confirmed clean.

---

## TL;DR

| Gap | Today | After |
| --- | --- | --- |
| **A. Toolchains inline** | Declared toolchains on agent steps are accepted, forwarded to the invocation, then **silently dropped** in inline execution (warn-only). The runner-pod path that mounts them is never used by default. | Inline execution provisions + injects declared toolchains into the harness PATH/env (reusing the worker's `ensureToolchains`). Unsatisfiable toolchains **fail the attempt** with a clear error. Per-attempt runtime metadata records what was requested/resolved and how the job ran. |
| **B. Delegation init bound** | An attempt is `running` from claim time. If the runtime never acknowledges startup, `execution_started_at` remains null; if it does acknowledge, current code sets it before setup is complete. The only generic watchdog fires at ~15 min idle. A delegated worker hung at init blocks the lead with no short, structured signal. | A short **dispatch/init watchdog** bounds claim → `execution_started_at IS NOT NULL`. Setup/toolchain wedges are either kept before that mark or covered by a separate startup watchdog. Failures surface as classified `attempt_init_timeout`/`attempt_startup_timeout` dependency failures. |

Neither part touches provider credentials, application logic, secret resolution, or workspace clone — those completed fine in the reported run.

---

## Part A — Declared toolchains must reach the inline harness

### A.1 What already works

The declaration and routing plumbing is complete and tested:

- **Schema accepts toolchains on agent/script/run steps.** `WorkflowStepSchema.toolchains` is a top-level optional field (`packages/shared/src/schemas/workflow.ts:42`) typed by `ToolchainsSchema = z.array(z.enum(['python','media','rust','java','kotlin']))` (`packages/shared/src/schemas/agent-config.ts:60-62`). Tests assert toolchains are valid on `agent`, `script`, and `run` steps and rejected only on `action` steps (`packages/shared/src/schemas/__tests__/workflow.spec.ts:49-75`). **No schema change is needed for agent steps.**
- **Workflow expansion forwards step toolchains into `job.hints.toolchains`** (covered by `apps/api/src/pipelines/pipeline-expander.toolchains.spec.ts`).
- **The orchestrator forwards hints onto the invocation.** `loop.service.ts:2011-2012` reads `job.hints?.toolchains` and `:2039` attaches `{ toolchains }` to the `HarnessInvocation` (`toolchains?: string[]` on the type).

The chain is intact right up to the agent-runtime. The break is at the final hop.

### A.2 Root cause — inline is the default, and inline ignores toolchains

Agent jobs choose between two execution placements in `apps/agent-runtime/src/invoke/invoke.service.ts`:

```ts
private shouldRunInK8sRunnerPod(): boolean {
  if (process.env.EVE_RUNTIME !== 'k8s') return false;
  const mode = (process.env.EVE_AGENT_RUNTIME_EXECUTION_MODE ?? 'inline').trim().toLowerCase();
  return mode === 'runner';
}
```

`EVE_AGENT_RUNTIME_EXECUTION_MODE` defaults to `inline` and is **explicitly set to `inline`** in the base deployment (`k8s/base/agent-runtime-deployment.yaml:48`). Local k3d and staging inherit that default. So in practice **all agent jobs run inline**, and the runner-pod path is the road not taken.

- **Runner-pod path** (`apps/agent-runtime/src/invoke/k8s-runner.ts:228-250`) does the right thing: it adds a `tc-<name>` init container per toolchain, copies the image's `/toolchain/.` into `/opt/eve/toolchains/<name>/`, sets `EVE_TOOLCHAIN_PATHS`, and the worker entrypoint (`docker/worker/entrypoint.sh:157-171`) prepends those paths to `PATH` and sources each `env.sh`. The harness inherits a correct environment. **This path is unused by default.**
- **Inline path** (`apps/agent-runtime/src/invoke/invoke.service.ts:795-808`) merely probes for `${EVE_TOOLCHAIN_ROOT}/<tc>/env.sh` and **logs a warning** if missing, then proceeds. It never provisions the toolchain, never extends `binPaths`, and never merges toolchain env vars into the harness env built at `:1264` via `buildSanitizedHarnessEnv({ binPaths, ... })`. Declared toolchains are silently dropped.

This is the observed contract failure: a `python` toolchain was declared, forwarded, and then ignored because the job ran inline.

### A.3 The fix already exists for scripts — reuse it for agents

The worker's script and action executors already solve exactly this problem on-demand:

```ts
// apps/worker/src/script-executor/script-executor.service.ts:740
if (context.toolchains && context.toolchains.length > 0) {
  const provisioned = await ensureToolchains({
    toolchains: context.toolchains,
    baseEnv: env,
    logger: context.logToolchainEvent,
  });
  env = provisioned.env;
}
```

`ensureToolchains` (`packages/shared/src/invoke/toolchain-cache.ts:60`) pulls `eve-horizon/toolchain-<name>:<tag>` via `crane`, untars `/toolchain` into a content-addressed cache under `EVE_TOOLCHAIN_ROOT`, sources each `env.sh`, and returns `{ resolved, missing, pathPrefix, envOverlay, env }`. Failures raise `ToolchainProvisionError`. It is concurrency-safe (per-toolchain lock + `.installed` marker) and idempotent (cache hits are cheap). The worker uses this in the script path and the action-run path (`apps/worker/src/action-executor/action-executor.service.ts:1189-1192`). This was shipped in `docs/plans/worker-toolchain-on-demand-plan.md` (Implemented 2026-03-06).

**The agent-runtime inline path should use the same primitive.** Composition, not duplication.

### A.4 Proposed change

**A.4.1 — Provision and inject toolchains inline (primary).**
Replace the warn-only block at `invoke.service.ts:795-808` with real provisioning, then carry the provisioned result into the harness env build at `:1158` (`binPaths`) / `:1264` (`buildSanitizedHarnessEnv`).

Recommended implementation shape:

1. Hoist `requestedToolchains` and a `provisionedToolchains` variable in the inline branch.
2. If Part B's init watchdog is meant to catch stuck `crane export` / registry pulls, call `ensureToolchains` **before** `markExecutionStarted`. Use a minimal process-derived `baseEnv` plus `DOCKER_CONFIG`/registry env, then store the returned `pathPrefix`/`envOverlay` for later injection. If implementers decide provisioning must happen after resolved adapter env is built, add an explicit provisioning timeout or the startup watchdog below; otherwise a stuck pull is already past `execution_started_at` in today's code and falls back to the long stale watchdog.
3. Use a logger that writes `execution_logs` (`status` lines, ideally reusing the worker's `formatToolchainEvent` wording) so `eve job logs` shows `install_start`/`cache_hit`/`env_loaded` per toolchain.
4. Push `provisionedToolchains.pathPrefix` entries into `binPaths` (split on `path.delimiter`) so the toolchain `bin` dirs lead the harness `PATH`.
5. Merge `provisionedToolchains.envOverlay` into `adapterEnv` before `applyEnvOverrides` if preserving worker precedence matters: toolchain env first, user/manifest env overrides win. `envOverlay` excludes `PATH` (handled via `binPaths`), so no collision.

This makes `python3` / `cargo` / `java` resolvable from the harness command and any subprocess it spawns, satisfying the report's primary acceptance shape ("make the requested toolchain binaries available in the harness process PATH").

**A.4.2 — Fail fast, do not warn-and-continue.**
If `ensureToolchains` throws `ToolchainProvisionError`, fail the attempt before spawning the harness with a classified, actionable error (e.g. `toolchain_unavailable`, message naming the toolchain and image). Current attempt completion only persists `error_message`/`result_json`; it does not persist an `errorCode` field. The implementation must either:

- add durable attempt error-code storage and expose it through API/CLI responses, or
- store `{ "error_code": "toolchain_unavailable", "toolchain": "...", "image": "..." }` in `result_json`, emit the same code in `system.job.failed`, and update `eve job diagnose` to render it.

This honors the report's alternative acceptance ("fail validation or job startup clearly instead of accepting the manifest and then leaving the harness without the runtime") and the project rule "every error must propagate; no workarounds." It removes the trap where the agent silently improvises a runtime download.

**A.4.3 — Image prerequisite for inline provisioning.**
`ensureToolchains` shells out to `crane` + `tar` (`toolchain-cache.ts:267-268`). The agent-runtime image does **not** install `crane` today (`apps/agent-runtime/Dockerfile` installs `ca-certificates curl git bash jq poppler-utils` and ffmpeg build deps, but no crane). To make A.4.1 real:

- Add `crane` to the agent-runtime production image (mirror the worker image: `FROM gcr.io/go-containerregistry/crane:v0.20.3 AS crane` + `COPY --from=crane /ko-app/crane /usr/local/bin/crane`).
- Ensure `EVE_TOOLCHAIN_ROOT` is a writable, ideally node-local cache dir. The image creates `/opt/eve/toolchains`, but the agent-runtime StatefulSet currently lacks the worker's explicit `EVE_TOOLCHAIN_ROOT` env and `emptyDir`/cache volume.
- Wire `EVE_TOOLCHAIN_IMAGE_PREFIX`, `EVE_TOOLCHAIN_IMAGE_TAG`, and local insecure-registry settings into the agent-runtime manifests. The worker has these in `k8s/base/worker-deployment.yaml` and `k8s/overlays/local/worker-registry.patch.yaml`; agent-runtime does not.
- Update both source manifests under `k8s/` and generated local assets under `packages/cli/assets/local-k8s/`, because local cluster bootstrapping consumes the generated copies.
- For staging/private registries, verify whether the agent-runtime pod can read the published toolchain images through existing image-pull auth or needs a mounted/generated `DOCKER_CONFIG` for `crane`. Local k3d uses the in-cluster registry prefix and `EVE_TOOLCHAIN_REGISTRY_INSECURE=true`.

**A.4.4 — Decision fork (Eve team owns the call).**
Two viable strategies; this plan recommends the first:

- **Recommended: provision inline (A.4.1–A.4.3).** Keeps the default inline placement, lowest latency, reuses shipped machinery. Cost: `crane` + a registry-readable agent-runtime pod.
- **Alternative: auto-promote toolchain jobs to runner pods.** Make `shouldRunInK8sRunnerPod()` return true whenever `invocation.toolchains?.length`, so the existing init-container path runs. Cost: requires `EVE_RUNNER_IMAGE` set for agent-runtime (not in base; local overlay sets it, staging/infra must be verified), adds pod-spawn latency per toolchain job, and the runner toolchain path is comparatively unexercised. Keep this documented as the fallback if hardening the agent-runtime image is undesirable.

Whichever is chosen, the warn-and-continue behavior must be replaced by either real provisioning or a clean failure. The status quo — accept, forward, then ignore — is the bug.

**A.4.5 — Structured runtime metadata.**
Today `runtime_meta` only carries `{ runtime, pod_name, namespace }` (`invoke.service.ts` `currentRuntimeMeta()`; runner callback in `k8s-runner.ts:507-512`). Extend the per-attempt `runtime_meta` (via the existing `updateRuntimeMeta` merge) with a `toolchains` block:

```jsonc
"toolchains": {
  "execution_mode": "inline",          // or "runner"
  "requested": ["python"],
  "resolved": ["python"],
  "missing": [],
  "source": "cache_hit"                 // or "installed"; use per-toolchain detail if mixed
}
```

This lets `eve job show --verbose` / diagnose answer "did this attempt actually have the runtime, and how did it run?" without log spelunking — the report's third acceptance shape.

### A.5 Part A acceptance criteria

- An agent step with `toolchains: [python]` running inline can invoke `python3` from the harness command and from subprocesses it spawns.
- A toolchain that cannot be provisioned fails the attempt with a classified `toolchain_unavailable` error naming the toolchain/image — no silent continue, no agent-side runtime download.
- `eve job logs` shows per-toolchain provisioning events; `runtime_meta.toolchains` records requested/resolved/missing + execution_mode.
- Repeated invocations hit the toolchain cache (no re-pull) and add negligible startup latency.
- Behavior is identical whether the job runs inline (provisioned) or in a runner pod (init containers); both expose the same `EVE_TOOLCHAIN_*` contract.

---

## Part B — Delegated worker initialization must be bounded

### B.1 The reported failure

A lead agent created child jobs (delegated sub-agent workers), returned `eve.status = "waiting"` with `waits_for` relations, and was requeued to wait. One or more delegated workers never progressed past initialization. The lead received no bounded failure signal and the workflow root had to be cancelled manually.

### B.2 Root cause — attempts are "running" from claim, but init is unbounded

The attempt lifecycle has a blind spot between claim, runtime acceptance, setup, and harness start:

1. **Claim** inserts an attempt with `status='running'`, `started_at=NOW()`, `execution_started_at=NULL`, `runtime_meta={}` and flips the job to `active` (`packages/db/src/queries/jobs.ts:1300-1338`).
2. **`markExecutionStarted`** sets `execution_started_at=NOW()` with an idempotent guard (`jobs.ts:1782-1786`), but current direct inline paths call it early:
   - agent-runtime inline: immediately after the warn-only toolchain check (`apps/agent-runtime/src/invoke/invoke.service.ts:810-812`), before secrets, workspace prep, toolchain injection, and harness spawn.
   - worker inline: before secret resolution and workspace prep (`apps/worker/src/invoke/invoke.service.ts:1108-1113`).
3. The **only** watchdog, `recoverStaleRunningAttempts` (`loop.service.ts:731-785`) → `evaluateRunningAttemptHealth` (`loop.service.ts:185-220`), keys solely off `started_at` and `last_log_at`:
   - hard timeout: `elapsed >= timeout_seconds(+grace)` (`timeout_seconds` from `hints` or default **1800s**),
   - idle stale: `elapsed >= EVE_ORCH_STALE_RUNNING_SECONDS (900)` **and** `idle >= EVE_ORCH_STALE_IDLE_SECONDS (900)`.

So there are two distinct failure classes:

- **Dispatch/init never acknowledged**: the orchestrator claims the attempt, but the target runtime never reaches `markExecutionStarted`. This is currently only reaped after **~15 minutes** at the earliest.
- **Accepted but setup/harness startup wedges**: `execution_started_at` may already be set, so a null-`execution_started_at` watchdog alone will not catch it. Today these failures also rely on the long stale/hard watchdog unless the implementation moves the mark later or adds a setup/startup-specific bound.

This correction matters for Part A: if inline toolchain provisioning runs after today's `markExecutionStarted`, a stuck `crane export` is not an `attempt_init_timeout`; it is a normal running-attempt stall. Keep provisioning before the mark or add a separate startup watchdog.

Because the lead is requeued on a 15s cadence and re-blocks on the not-yet-terminal child each tick, "no bounded init" on the child becomes "unbounded wait" for the lead.

### B.3 Proposed change

**B.3.1 — Dispatch/init watchdog.**
Add a second, short-horizon recovery pass (sibling to `recoverStaleRunningAttempts`) that targets attempts which claimed but never reached runtime acceptance:

- Select `job_attempts` where `status='running' AND execution_started_at IS NULL AND started_at < NOW() - INTERVAL '<init timeout>'`.
- Fail them via the existing `completeAttempt(attemptId, 'failed', { exitCode, errorMessage, resultJson: { error_code: 'attempt_init_timeout' } })` + `markJobFailed` shape unless a first-class attempt error-code field is added. Reuse the same finalize/emit path the stale watchdog already uses (`loop.service.ts:822-838`), including `emitJobFailureEvent` and `tryCloseWorkflowRoot`.
- Gate the window on a new env var, e.g. `EVE_ORCH_ATTEMPT_INIT_TIMEOUT_SECONDS` (proposed default **300s**), well under the 1800s hard timeout. Pull the in-flight dispatch bookkeeping cleanup (`inFlightJobs` / `limiter.release()`) exactly as the stale path does so a force-failed init also releases its slot.

This gives every delegated worker a bounded terminal state for the pre-acceptance phase: initialize within N seconds or be failed with `attempt_init_timeout`.

**B.3.2 — Startup/setup bound for accepted-but-not-harnessed attempts.**
Because current code marks `execution_started_at` before setup, decide explicitly how setup wedges are bounded:

- **Recommended with Part A**: run inline `ensureToolchains` before `markExecutionStarted`; toolchain provisioning hangs are classified by the init watchdog.
- **If provisioning/setup stays after `markExecutionStarted`**: add a sibling `attempt_startup_timeout` that selects running attempts with `execution_started_at IS NOT NULL`, no `lifecycle_harness_start` log, and elapsed setup time over `EVE_ORCH_ATTEMPT_STARTUP_TIMEOUT_SECONDS` (proposed default 600s). Fail through the same finalize/emit path, with the code persisted in the chosen durable attempt error-code surface and emitted in `system.job.failed`.

**B.3.3 — Surface to the waiting lead as a normal dependency failure.**
No new parent-notification channel is required, but the plan should name the actual mechanisms:

- `markJobFailed` cascade-cancels downstream jobs that depend through `blocks`, `conditional_blocks`, or `waits_for` (`jobs.ts:2391-2418`) and clears gates.
- `recoverStaleRunningAttempts` already calls `gates.releaseGates(job_id)` and `tryCloseWorkflowRoot(parent_id)` after force-failing; the init/startup recovery path must do the same.
- `tryCloseWorkflowRoot` only closes workflow-root parents (`hints.workflow_root === true`), so tests must cover both workflow-root rollup and generic `waits_for` lead unblocking.

Confirm (and add coverage) that a child failed via `attempt_init_timeout` or `attempt_startup_timeout` deterministically unblocks/fails the waiting lead rather than leaving it in a perpetual requeue loop. The lead then receives a structured, classified error it can act on (retry, re-fan-out, or report).

**B.3.4 — Record the failure cause.**
Persist `attempt_init_timeout` / `attempt_startup_timeout` in a durable place that `eve job diagnose` can read. Current attempt completion has no `errorCode` field, so this must be part of the implementation: add an attempt error-code field/API surface, or store the code in `result_json` and event payloads and render it in the CLI. Also keep a concise human reason (e.g. `"Watchdog: attempt did not start within 300s of claim"`) so diagnose distinguishes init timeout from stale running timeout or hard timeout.

### B.4 Part B acceptance criteria

- A delegated worker that claims but never sets `execution_started_at` is failed within `EVE_ORCH_ATTEMPT_INIT_TIMEOUT_SECONDS` (default ~300s), not ~15 min.
- Any accepted attempt that can wedge during setup/toolchain provisioning is either kept before `markExecutionStarted` or covered by `attempt_startup_timeout`.
- The failure carries a durable `attempt_init_timeout` / `attempt_startup_timeout` code and a human-readable reason surfaced by `eve job diagnose`.
- A lead `waits_for`-ing that child stops waiting on the next orchestrator tick through cascade cancellation/gate release/workflow-root rollup — it fails or re-plans on a structured signal, never hangs unbounded.
- A normally-initializing attempt (sets `execution_started_at` before the init window) is never touched by the init watchdog; the existing hard/idle watchdog continues to own the running phase.
- The init watchdog releases the dispatch slot/limiter for any attempt it force-fails.

---

## Cross-cutting work

### Tests

- **Unit** — `evaluateRunningAttemptHealth` sibling for init timeout: cases for (running + `execution_started_at` null + past window → stale `attempt_init_timeout`), (running + started but within window → healthy), (already initialized → not eligible). If `attempt_startup_timeout` is implemented, add cases for initialized/no `lifecycle_harness_start`/past window. Mirror `apps/orchestrator/src/loop/loop.service.test.ts:129+`.
- **Unit** — inline toolchain injection: given `ensureToolchains` returns `{ pathPrefix, envOverlay }`, assert `buildSanitizedHarnessEnv` receives the toolchain `binPaths` and the env overlay, env precedence matches worker script/action behavior, and runtime metadata is updated; given `ToolchainProvisionError`, assert the attempt fails with `toolchain_unavailable` and the harness is never spawned.
- **Unit** — manifest asset parity: source `k8s/` agent-runtime toolchain env/cache changes are mirrored under `packages/cli/assets/local-k8s/`.
- **Integration** (`./bin/eh test integration`, API-first) — invoke a workflow whose agent step declares `toolchains: [python]`; assert the step can run `python3` (or fails cleanly if provisioning is disabled in CI), and that `runtime_meta.toolchains` is populated.
- **Manual** (k3d, `tests/manual/`) — (a) a toolchain-backed lead agent step that delegates file-writing to sub-agents and uploads outputs; (b) a deliberately wedged delegated worker, asserting it is reaped via `attempt_init_timeout` or `attempt_startup_timeout` (depending on where the wedge is injected) and the lead unblocks.

### Docs (eve-skillpacks sync obligation)

Per CLAUDE.md, platform behavior changes must update the public references:

- `references/harnesses.md` — inline toolchain provisioning contract; that agent steps honor `toolchains` like script steps; `EVE_TOOLCHAIN_*` env surface.
- `references/jobs.md` — new `attempt_init_timeout` / `attempt_startup_timeout` failure codes and what they mean for delegated/`waits_for` workers; `runtime_meta.toolchains` shape.
- `references/pipelines-workflows.md` — agent-step `toolchains` is a real runtime contract, not just schema-accepted.
- `docs/system/agent-runtime.md` + `docs/system/orchestrator.md` — document the init watchdog and the inline toolchain path; cross-link `worker-toolchain-on-demand-plan.md`.

### Telemetry / observability

- Toolchain provisioning events already exist as `ToolchainCacheEvent`; route them to `execution_logs` for agent jobs so they appear in `eve job logs`.
- Count `attempt_init_timeout` / `attempt_startup_timeout` failures (alongside `attempt_timeout` / `attempt_stale`) so init/setup wedges are visible in analytics rather than discovered by a stuck workflow.

---

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| `crane`/registry not reachable from agent-runtime → inline provisioning fails | Fail fast with `toolchain_unavailable` (clear, classified). Gate behind image hardening; until then, document the runner-pod fallback (A.4.4) and keep `toolchains`-declaring jobs from silently degrading. |
| Init watchdog fires too eagerly on legitimately slow runtime dispatch | Default 300s is well above normal worker/agent-runtime acceptance; make it env-tunable per environment. If setup is intentionally moved before `markExecutionStarted`, revisit the default or use a separate startup watchdog. |
| First-pull toolchain latency counts against the init/startup window | `ensureToolchains` caches by content; only the cold pull is slow. Consider pre-warming common toolchain images on nodes. If provisioning stays before `markExecutionStarted`, size `EVE_ORCH_ATTEMPT_INIT_TIMEOUT_SECONDS` for cold pulls; otherwise enforce `EVE_ORCH_ATTEMPT_STARTUP_TIMEOUT_SECONDS`. |
| Double-reaping (init watchdog + stale watchdog racing) | Both finalize via `completeAttempt`, which is guarded and returns null if already finalized (`loop.service.ts:827-830`); the second pass no-ops. |
| Behavior drift between inline and runner toolchain paths | Assert the same `EVE_TOOLCHAIN_*` / `PATH` contract in both; share the path/env assembly so they cannot diverge. |

## Rollout

Ship **Part A and Part B together** as one coordinated release — they are the two halves of a single runtime-contract fix (a toolchain that hangs at install is itself an init wedge, so the init watchdog is the safety net for the new provisioning path). Land them in one `release-v*` so staging gets both at once and we never run inline toolchain provisioning without the init bound that catches a stuck pull.

Internal build order within the release (so each layer rests on the one below):

1. **Init/startup watchdogs (Part B).** Additive, no image changes. `recoverInitTimeoutAttempts` sibling + durable `attempt_init_timeout` code + tests; add `attempt_startup_timeout` if setup/toolchain provisioning remains after `markExecutionStarted`. Gated by `EVE_ORCH_ATTEMPT_INIT_TIMEOUT_SECONDS` (default ~300s) and, if used, `EVE_ORCH_ATTEMPT_STARTUP_TIMEOUT_SECONDS` (default ~600s).
2. **Agent-runtime image prep (Part A).** Add `crane` + `EVE_TOOLCHAIN_*` / registry wiring to the agent-runtime image and deployment; mirror local-k8s generated assets; verify a manual toolchain pull works in the pod.
3. **Inline injection (Part A).** Replace warn-only with `ensureToolchains` provisioning + fail-fast (`toolchain_unavailable`) + `runtime_meta.toolchains`; place provisioning relative to `markExecutionStarted` according to the Part B decision.
4. **Docs + skillpack sync** for both parts, in the same change set.

Validate the whole release end-to-end in local k3d (toolchain-backed lead step that delegates to sub-agents, plus a deliberately wedged worker) before tagging staging. The two `EVE_ORCH_ATTEMPT_INIT_TIMEOUT_SECONDS` and `EVE_TOOLCHAIN_*` knobs ship permissive and are tightened after observation — but both behaviors go out in the same tag.

## Out of scope

- Provider credentials / application logic / secret resolution / workspace clone (worked correctly in the reported run).
- Toolchains on workflow `action` steps (intentionally rejected by schema; actions are unimplemented — `workflow.ts:62-68`).
- A new push/webhook parent-notification channel — existing `waits_for` + workflow-root rollup is sufficient once children reach a bounded terminal state.
- Net-new toolchains beyond the current `VALID_TOOLCHAINS` set.

## Key references

- `packages/shared/src/schemas/workflow.ts:42` — agent-step `toolchains` field
- `packages/shared/src/schemas/agent-config.ts:60-62` — `VALID_TOOLCHAINS` / `ToolchainsSchema`
- `packages/shared/src/schemas/__tests__/workflow.spec.ts:49-75` — toolchains accepted on agent/script/run steps
- `apps/orchestrator/src/loop/loop.service.ts:2011-2039` — hints→invocation toolchain forwarding
- `apps/agent-runtime/src/invoke/invoke.service.ts:795-808` — inline warn-only toolchain check (the gap)
- `apps/agent-runtime/src/invoke/invoke.service.ts:1158,1264` — harness `binPaths` / `buildSanitizedHarnessEnv`
- `apps/agent-runtime/src/invoke/k8s-runner.ts:228-250` — runner-pod toolchain init containers + `EVE_TOOLCHAIN_PATHS`
- `docker/worker/entrypoint.sh:157-171` — runner entrypoint PATH/env sourcing
- `packages/shared/src/invoke/toolchain-cache.ts:60-116` — `ensureToolchains` (reuse target)
- `apps/worker/src/script-executor/script-executor.service.ts:740` — existing on-demand provisioning pattern
- `apps/worker/src/action-executor/action-executor.service.ts:1189-1192` — existing action-run provisioning pattern
- `k8s/base/agent-runtime-deployment.yaml:48,56` — `EVE_AGENT_RUNTIME_EXECUTION_MODE=inline`, `EVE_RUNTIME=k8s`
- `k8s/overlays/local/agent-runtime-org-id.patch.yaml:19-22` — local runner fallback env for agent-runtime (not toolchain env/cache)
- `packages/cli/assets/local-k8s/` — generated local cluster manifests to keep in sync with `k8s/`
- `packages/db/src/queries/jobs.ts:1300-1338` — claim inserts attempt `running` / `execution_started_at=NULL`
- `packages/db/src/queries/jobs.ts:1782-1786` — `markExecutionStarted`
- `apps/agent-runtime/src/invoke/invoke.service.ts:810-812` — current early mark in agent-runtime inline path
- `apps/worker/src/invoke/invoke.service.ts:1108-1113` — current early mark in worker inline path
- `packages/db/src/queries/jobs.ts:247-256` — `CompleteAttemptResult` currently lacks an `errorCode`
- `apps/orchestrator/src/loop/loop.service.ts:185-220` — `evaluateRunningAttemptHealth`
- `apps/orchestrator/src/loop/loop.service.ts:731-838` — `recoverStaleRunningAttempts` (init watchdog sibling target)
- `docs/plans/worker-toolchain-on-demand-plan.md` — prior toolchain-cache work
