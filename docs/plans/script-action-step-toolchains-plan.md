# Script And Action-Run Step Toolchains Plan

> **Status**: Implemented 2026-05-19
> **Scope**: Platform (eve-horizon)
> **Source**: Downstream-app gap report, "Script and action-run steps should accept the same declarative `toolchains:` field as agents"
> **Related**:
> - `docs/plans/worker-toolchain-on-demand-plan.md` — implemented 2026-03-06 (commit `efb9e99`); established the toolchain init-container primitive for agent jobs
> - `docs/plans/workflow-script-step-materialization-plan.md` — workflow `script:` step materialization (the other half of script-step parity with agents)
> - `docs/plans/workflow-env-overrides-plan.md` — shipped 2026-05-07; the merge-precedence pattern for layered step config
> - Shipped: non-agent declarative-credentials (commit `236428d7`) and workflow `script:` materialization (`release-v0.1.284`)
> **Review fixes applied 2026-05-19**: workflow `action:` steps remain out of scope; Mode A requires a real `crane` binary plus a registry reachable from the worker pod; local k3d toolchain images must be pushed to the in-cluster registry, not only imported into node image cache.
> **Implementation fixes applied 2026-05-19**: script/action-run commands use `bash -c` so the toolchain `PATH` exported by `env.sh` is preserved; extracted toolchain payloads preserve relative symlinks so links like `python3 -> python3.11` do not point at the deleted extraction directory; local publish uses `crane push --insecure` through a short-lived port-forward because Docker push defaults to HTTPS for the local HTTP registry.
> **Local verification 2026-05-19**: k3d workflow script step resolved `/opt/eve/toolchains/python/bin/python3` and printed `PYTHON_TOOLCHAIN_OK`; a no-toolchain step printed `BASE_NO_PYTHON`; pipeline `action: { type: run }` resolved `/opt/eve/toolchains/python/bin/python3` and printed `ACTION_RUN_PYTHON_TOOLCHAIN_OK`.

## Problem

Workflow and pipeline authors increasingly want to do deterministic, tested platform-side work (validate, scaffold, transcode, parse, ETL) from a workflow/pipeline `script:` or shorthand `run:` step, and from a **pipeline** `action: { type: run }` step. When that work has a tested implementation in a typed language — a Python package with pytest coverage, a Rust binary, a Kotlin tool — the natural shape is to call it from the step body: `python -m my_package.scaffold "$DEAL_ID"`.

That shape works today for **agent** steps. An agent declares `toolchains: [python]` (or `[media, rust]`, etc.) and the runtime provisions the requested toolchains into the runner pod via init containers — no per-cluster image baking, no agent-side workarounds. Script and pipeline action-run steps have no equivalent: they run in whatever worker variant happens to be deployed, with whatever bins that variant ships.

Workflow `action:` steps are still reserved for future support and are rejected at workflow invocation time. This plan must not silently enable workflow `action.type=run`; it only covers workflow `script:` / `run`, pipeline `script:` / `run`, and pipeline `action.type=run`.

### Root cause (where the wiring breaks)

The toolchain primitive is fully built — it just isn't reachable from non-agent steps.

1. `packages/shared/src/schemas/agent-config.ts:60` defines `VALID_TOOLCHAINS = ['python', 'media', 'rust', 'java', 'kotlin']`.
2. `packages/shared/src/schemas/agent-config.ts:77` adds `toolchains: z.array(z.enum(VALID_TOOLCHAINS)).optional()` to `AgentEntrySchema`.
3. `packages/shared/src/schemas/workflow.ts:17` `WorkflowStepSchema` has no `toolchains` field. `packages/shared/src/schemas/pipeline.ts:46` `PipelineStepSchema` has no `toolchains` field. Neither does the root `WorkflowDefinitionSchema` / `PipelineDefinitionSchema`.
4. `apps/api/src/workflows/workflows.service.ts:1677-1688` (`resolveStepAgentFromStep`) only resolves `toolchains` for agent steps, reading from `step.toolchains ?? agent.toolchains`. The workflow script/run branch added by `workflow-script-step-materialization-plan.md` skips toolchain resolution entirely; workflow action steps are still rejected before job creation. The pipeline expander (`apps/api/src/pipelines/pipeline-expander.service.ts`) has the same gap for script/run and action-run steps.
5. `apps/api/src/workflows/workflows.service.ts:1025` persists toolchains on **agent** step jobs as `jobs.hints.toolchains`. Script and pipeline action-run step jobs persist no toolchain hint.
6. `apps/orchestrator/src/loop/loop.service.ts:1975-1976` reads `job.hints.toolchains` and forwards it on the `HarnessInvocation`, but this codepath only runs for `execution_type='agent'` jobs (the inline-runner branch at `:1892+`). Script (`:1887-1891`) and pipeline action (`:1882-1886`) jobs are dispatched via `WorkerService.executeScript` / `executeAction`, which post `{ jobId, attemptId }` to the worker's `/scripts/execute` / `/actions/execute` endpoints. There is no point in that path at which toolchains are consulted.
7. `apps/worker/src/script-executor/script-executor.service.ts:345-401` `runScript()` calls `execFileAsync('bash', ['-lc', command], { env, cwd: repoPath })` against the bare worker image with no provisioning step. The same shape applies to `apps/worker/src/action-executor/action-executor.service.ts:1085` `handleRun()`.
8. `apps/agent-runtime/src/invoke/k8s-runner.ts:228-244` is the active agent-job init-container injection path that provisions `${EVE_TOOLCHAIN_IMAGE_PREFIX}<tc>:${EVE_TOOLCHAIN_IMAGE_TAG}` into the runner pod and extends `PATH`. `apps/worker/src/invoke/k8s-runner.ts` has a parallel worker-side copy used by the legacy/fallback invoke path and is the likely starting point for Mode B, but script/action-run executors never enter either path today.
9. `docs/system/worker-types.md` documents that the worker pod variant (`base` / `python` / `media` / `rust` / `java` / `kotlin` / `full`) is a deploy-time choice. Empirically, a fresh script-executor pod on staging today has `bash`, `node`, `eve`, `curl`, `jq`, `git` — but **not** `python3` or `python` (`base` variant). So script steps have no language-toolchain access today unless the cluster is running the `full` variant.

The asymmetry is mechanical, not architectural: every primitive needed is already present and wired up for agent jobs. Script/action steps just don't read from any of it.

### Why this matters

Today's workarounds are all ugly:

- **Duplicate the deterministic logic in bash inside the script step body**, paralleling the tested Python module. Two sources of truth → drift → silent divergence.
- **Wrap the Python in an agent step** purely to get the toolchain side-effect — adds an agent harness, a model invocation, and an LLM-cost line item to deterministic work that needs none of them.
- **Switch the cluster's worker pool to `full`**, heavier pods for everyone, including pure-bash script steps that need nothing more than the base image.
- **Bundle a portable interpreter into the repo** and shell out to it from bash — couples the repo to a specific distribution and adds a check-in step.

All four push platform shape into application code or platform deployment. They either duplicate work or warp the agent contract.

## Goal

A workflow or pipeline `script:` / `run:` step, plus a pipeline `action: { type: run }` step, accepts the same **top-level step field** as an agent step:

```yaml
- name: run-python
  toolchains: [python]
  script:
    run: python -m my_package.scaffold "$DEAL_ID"
```

When the step declares toolchains, the executing process sees those toolchains on `PATH` and receives the environment exported by each toolchain's `env.sh` (`JAVA_HOME`, `CARGO_HOME`, `RUSTUP_HOME`, `PYTHONPATH`, `LD_LIBRARY_PATH`, `WHISPER_MODELS_DIR`, etc.) for the duration of the step. Empty / unset `toolchains:` → identical to today's behavior (no provisioning, no PATH change, no new pods).

`toolchains` is intentionally step-level, not nested inside `action`. A pipeline step shaped as `action: { type: run, command: ..., toolchains: [...] }` should be rejected with a clear "use step-level toolchains" validation error rather than silently ignored.

Toolchain precedence:

1. Non-agent steps (`script`, shorthand `run`, pipeline `action.type=run`): step-level `toolchains:` > workflow/pipeline-root `toolchains:` > empty.
2. Agent steps: step-level `toolchains:` > agent config `toolchains:` > workflow/pipeline-root `toolchains:` > empty. This preserves the existing agent precedence and only uses the root value as a final default.
3. Invocation-level — **not** supported (parity with how agent toolchains aren't request-overridable; toolchain selection is a manifest-level decision, not a per-invocation override).

For agent steps this plan is otherwise a no-op (the existing resolution at `workflows.service.ts:1677-1688` keeps the step > agent precedence it already implements; the new workflow-root default is used only when neither step nor agent declares one).

## Non-Goals

- New toolchain images. `python`, `media`, `rust`, `java`, `kotlin` are sufficient for now. New entries to `VALID_TOOLCHAINS` are out of scope.
- New permissions or secret-resolution paths. Toolchain provisioning needs no project-secret access.
- Custom toolchain composition (`toolchains: [python+rust]` as a single unit, fused container). Use a multi-element array — `[python, rust]` — and let the init-container path resolve each individually.
- Per-invocation toolchain overrides (`eve workflow run --toolchain python`). Toolchain is a manifest-shape concern, not a per-call concern.
- Workflow `action:` step support, including workflow `action.type=run`. Workflows currently accept `action:` as a reserved schema shape but reject it at invoke time. This plan should reject `toolchains:` on workflow `action:` steps at manifest validation until workflow actions have their own implementation plan.
- Removing the worker variant dimension (`base` / `python` / `full` / etc.). Variant selection at deploy time stays as an operator escape hatch and as the substrate for the agent-runtime warm pod (handled by `worker-toolchain-on-demand-plan.md` Phase 5).
- Worker-pool routing by toolchain (`worker_class: python` style). The gap spec explicitly prefers per-step composability over per-workflow worker-class selection.
- Surfacing `toolchains` on `eve job tree` or `eve job show` summary output. Already covered by `eve job diagnose`'s structured output (Phase 4 here).

## Design

The minimum viable shape mirrors the agent path:

1. **Schemas accept `toolchains:`** at step level for `WorkflowStepSchema` and `PipelineStepSchema`, and at root for `WorkflowDefinitionSchema` and `PipelineDefinitionSchema`. Validate against the existing `VALID_TOOLCHAINS` enum. Workflow action steps remain reserved: `toolchains:` is valid on workflow agent/script/run only.
2. **Expanders resolve the effective list** using the precedence above and persist it on the child job's `jobs.hints.toolchains`. This matches how agent step toolchains are persisted today (`workflows.service.ts:1025`) — no new column, no DB migration.
3. **Executors honor `jobs.hints.toolchains`** at execution time. This is the part that takes real design work; see Execution Modes below.

### Execution modes

Agent jobs run through the agent-runtime path; when the runtime uses Kubernetes runner pods, `apps/agent-runtime/src/invoke/k8s-runner.ts` injects toolchains into those pods. Script and pipeline action-run jobs today run **in-process** inside the worker pod via HTTP endpoints — there is no per-job pod to attach init containers to.

There are two viable shapes for closing this gap. The plan ships them in sequence: Mode A first as a quick win that closes most cases, Mode B as the durable parity-with-agents path.

#### Mode A — Inline runtime install on the worker pod (Phase 3a)

When the script/action-run executor receives a job with `hints.toolchains` non-empty, it checks `/opt/eve/toolchains/<tc>/.installed` and:

- if already present at the matching version: no-op (cache hit).
- if missing or version-mismatched: pulls the toolchain payload from the configured image (`${EVE_TOOLCHAIN_IMAGE_PREFIX}<tc>:${EVE_TOOLCHAIN_IMAGE_TAG}`) into the local toolchain root, then extends `PATH` and applies the toolchain `env.sh` exports for the lifetime of the `execFileAsync` call.

This mirrors Phase 5b of `worker-toolchain-on-demand-plan.md` (the agent-runtime warm-pod approach), with three concrete shapes for "pulls the toolchain payload":

- **Sidecar `kubectl run` into the worker namespace, then `kubectl cp` the contents out**. Tractable but high-latency on cold cache (~10s + image-pull time).
- **In-cluster registry mirror + `crane export`** (or a tiny `oci-pull` helper) to extract the toolchain image into `/opt/eve/toolchains/<tc>/` from inside the worker pod.
- **A `toolchain-installer` initContainer added to the worker Deployment itself**, unioning all toolchains that may be needed cluster-wide. Coarsest but zero per-job latency.

The plan recommends **`crane export` from within the worker pod** for Mode A — it is single-binary, doesn't require the worker pod to talk to the K8s API, and respects the existing `EVE_TOOLCHAIN_IMAGE_PREFIX` / `EVE_TOOLCHAIN_IMAGE_TAG` env vars. This is a new worker-image requirement: `apps/worker/Dockerfile` must install or copy the `crane` binary; the current `runtime-setup` stage ships `kaniko`, `buildctl`, `kubectl`, and `gh`, but **not** `crane`.

Mode A also requires the configured toolchain image reference to be pullable from inside the worker pod. Local k3d's current `./bin/eh k8s-image push-toolchains` path imports `eve-horizon/toolchain-*:local` into node image cache, which is enough for kubelet init-container pulls but **not** enough for an in-pod `crane export`. The local rollout must either push toolchain images into the in-cluster registry through a host-reachable endpoint (for example a temporary port-forward to `localhost:5000`) and set worker pods to pull via `eve-registry.eve.svc.cluster.local:5000/...`, or choose Mode B for local parity. If the registry is HTTP/insecure, `ensureToolchains` needs an explicit insecure-registry option (for example `EVE_TOOLCHAIN_REGISTRY_INSECURE=true` or reuse the existing insecure-registry list).

The cold-cache penalty is bounded (each toolchain image is 50-300MB per `worker-toolchain-on-demand-plan.md`). Warm-cache cost is one `stat` call.

Trade-offs of Mode A:

- ✅ No new pod spawns; no orchestrator-side wiring changes.
- ✅ Cache warms across consecutive script steps on the same worker pod — fast on hot path.
- ✅ Backwards-compatible with the existing single-worker-pod model.
- ⚠️ State accumulates on the worker pod's emptyDir; not isolated per-job. Acceptable for the toolchain primitive (read-only, hermetic) but worth flagging.
- ⚠️ Concurrent installs of the same toolchain need a file-lock to avoid races.
- ⚠️ Worker-pod pull traffic scales with cold misses; not a problem at current volumes.

#### Mode B — Per-step ephemeral pod via `k8s-runner.ts` (Phase 3b, follow-up)

Make script/action-run jobs that declare `toolchains:` route through a per-job-pod path equivalent to the active agent-runtime runner path. The worker-side copy at `apps/worker/src/invoke/k8s-runner.ts:228-244` already has the right init-container template and can be refactored for this purpose. The bash command runs inside that pod's runtime container.

This requires:

- A new dispatch verb on the worker (or a refactor of `k8s-runner.ts` into a runner-pod builder that the script-executor can invoke).
- Streaming logs back from the runner pod to the worker for the existing `appendLog` shape.
- Plumbing `job.script_command` and `job.action_input` into the runner-pod entrypoint.

It is the durably-correct shape (parity with agent jobs, per-job isolation, no worker-pod state accumulation), but it is meaningfully larger than Mode A. The plan recommends shipping Mode A first to close the gap end-to-end, then optionally migrating to Mode B once the schema/persistence side has bedded in.

When a step has `toolchains: []` (default), both modes are no-ops — execution remains exactly as today.

## Implementation Plan

### Phase 1 — Shared schemas

**Files**

- `packages/shared/src/schemas/workflow.ts`
- `packages/shared/src/schemas/pipeline.ts`
- `packages/shared/src/schemas/agent-config.ts` (verify existing export only)
- `packages/shared/src/schemas/__tests__/workflow.spec.ts`
- `packages/shared/src/schemas/__tests__/pipeline.spec.ts`

Changes:

1. Import `VALID_TOOLCHAINS` and the `Toolchain` type from `agent-config.ts`; no new export is currently required because `packages/shared/src/schemas/index.ts` already re-exports `agent-config.ts`, and the root `packages/shared/src/index.ts` already re-exports schemas.
2. Extend `WorkflowStepSchema`:

   ```ts
   toolchains: z.array(z.enum(VALID_TOOLCHAINS)).optional(),
   ```

   This becomes valid on workflow agent / script / run steps. Add a `superRefine` guard so workflow `action:` steps with `toolchains:` fail validation until workflow actions are implemented.
3. Extend `WorkflowDefinitionSchema` with the same optional `toolchains` field at the root. This is the workflow-level default that applies to any step that does not declare its own.
4. Mirror both additions on `PipelineStepSchema` and `PipelineDefinitionSchema`. For pipeline action steps, `toolchains:` is valid only when `action.type === 'run'`; other action types must fail manifest validation if they declare top-level `toolchains:`.
5. Add validation that rejects nested `action.toolchains` with a message that points authors to the top-level step field.
6. Schema tests:
   - workflow step accepts `toolchains: ['python']` alongside `script: {...}`.
   - workflow step rejects `toolchains: ['rubber']` (unknown enum value).
   - workflow step rejects `toolchains: []` only if we want to disallow empty arrays — recommend allowing `[]` and treating as "no toolchains" for parity with omission.
   - workflow root accepts `toolchains: [python, media]` and the field survives `passthrough()` serialization.
   - pipeline equivalents.
   - agent step with `toolchains: [media]` still parses (no regression).
   - workflow action step with `toolchains: [python]` is rejected as unsupported.
   - pipeline `action.type=run` with top-level `toolchains: [java]` parses.
   - pipeline `action.type=deploy` with top-level `toolchains: [java]` is rejected.
   - pipeline `action: { type: run, toolchains: [java] }` is rejected with "use step-level toolchains".

### Phase 2 — Expander resolution and persistence

**Files**

- `apps/api/src/workflows/workflows.service.ts`
- `apps/api/src/pipelines/pipeline-expander.service.ts`
- (possibly) `packages/shared/src/workflow/step-execution.ts` if the shared step-execution helper from `workflow-script-step-materialization-plan.md` has landed

Changes:

1. **Workflow expander.** In `workflows.service.ts`, today's `resolveStepAgentFromStep()` returns `toolchains` for agent steps. For script/run steps, add a small helper that returns the merged toolchain list without touching agent config:

   ```ts
   function resolveStepToolchains(
     workflowDefaults: string[] | undefined,
     stepToolchains: string[] | undefined,
   ): string[] {
     if (stepToolchains && stepToolchains.length > 0) return stepToolchains;
     if (workflowDefaults && workflowDefaults.length > 0) return workflowDefaults;
     return [];
   }
   ```

   The workflow agent path keeps its existing `step ?? agent` resolution; add the workflow-root fallback only when neither step nor agent declares toolchains. This helper exists for non-agent paths.

2. In the workflow step expansion at `workflows.service.ts:912`-ish (the child-job creation site for script/run steps introduced by `workflow-script-step-materialization-plan.md`), thread the resolved toolchains through to `hints.toolchains`, matching the agent-step shape at `:1025`:

   ```ts
   ...(toolchains.length > 0 ? { toolchains } : {}),
   ```

3. **Pipeline expander.** Apply the same change to `pipeline-expander.service.ts` for script/run steps and pipeline `action.type=run` steps. Pipeline agent steps can use step/root toolchains; do not invent named-agent lookup for pipelines unless a separate plan adds that behavior. The pipeline expander already has its own per-step hint-building pass — add `toolchains` there in the same shape.
4. **Workflow retry.** Today retry copies `source.hints` verbatim, so a retried script step carrying `hints.toolchains` will retain it. Add a regression test rather than code.
5. **Schema-level rejection of unknown toolchains** happens at Phase 1 (manifest sync). At expansion time, defensively dedupe and re-validate against `VALID_TOOLCHAINS` to harden against legacy DB rows.

Expander unit tests:

- workflow script step `toolchains: [python]` produces child job with `hints.toolchains = ['python']`.
- workflow step with no `toolchains` and workflow root `toolchains: [media]` produces child job with `hints.toolchains = ['media']`.
- workflow root `toolchains: [media]` and step `toolchains: [python]` resolves to `['python']` (step wins; not merged — same as today's agent step semantics).
- pipeline equivalents.
- mixed workflow (agent step + script step) — each step gets its own resolved toolchains independently.
- agent step still resolves through `resolveStepAgentFromStep`'s existing path; no regression.
- workflow action step with toolchains remains rejected; no child job is created.
- pipeline action-run with top-level toolchains gets `hints.toolchains`; nested `action.toolchains` is rejected.

### Phase 3a — Inline runtime install in script/action-run executors

**Files**

- `apps/worker/src/script-executor/script-executor.service.ts`
- `apps/worker/src/action-executor/action-executor.service.ts`
- `packages/shared/src/invoke/toolchain-cache.ts` (new) — shared helper to materialize a toolchain payload into a known root
- `apps/worker/Dockerfile` — add the `crane` binary (or chosen OCI extraction helper) to the worker image
- `docker/worker/entrypoint.sh` — confirm `EVE_TOOLCHAIN_ROOT` is set in the worker pod (it is on the agent-runtime / runner side via `apps/worker/src/invoke/k8s-runner.ts:221`; verify in the worker Deployment env)
- `k8s/base/worker-deployment.yaml` — ensure `/opt/eve/toolchains` exists as an emptyDir mount on the worker pod, so the cache survives across script-step invocations on the same pod but is dropped on pod restart
- `packages/cli/assets/local-k8s/base/worker-deployment.yaml` — mirror the local packaged manifest
- `k8s/overlays/local/worker-registry.patch.yaml` — set local `EVE_TOOLCHAIN_IMAGE_PREFIX` / tag / insecure registry options when Mode A uses the in-cluster registry
- `bin/eh-commands/k8s-image.sh` — publish local toolchain images to a registry reachable from worker pods for Mode A

Changes:

1. **Worker image prerequisites.** Add an OCI image export helper to the worker image before wiring runtime installs. Recommended: copy `crane` from `gcr.io/go-containerregistry/crane` or install a pinned release in `apps/worker/Dockerfile`. Also choose and document the auth path:
   - Public ECR toolchain images: no auth.
   - Eve-native/private registry: build a temporary Docker config and run `crane` with `DOCKER_CONFIG`, using the same credential conventions as `RegistryAuthService` where possible.
   - Local k3d HTTP registry: pass `--insecure` or equivalent based on explicit env, not by guessing from the image string.

2. **Shared toolchain-cache helper** in `@eve/shared`. Single entry point that the worker, action-executor, and (later) the agent-runtime warm-pod path can all call:

   ```ts
   export interface EnsureToolchainsOptions {
     toolchains: readonly string[];
     toolchainRoot?: string;           // defaults to process.env.EVE_TOOLCHAIN_ROOT ?? '/opt/eve/toolchains'
     imagePrefix?: string;             // defaults to process.env.EVE_TOOLCHAIN_IMAGE_PREFIX
     imageTag?: string;                // defaults to process.env.EVE_TOOLCHAIN_IMAGE_TAG
     dockerConfigDir?: string;          // optional DOCKER_CONFIG for private registry pulls
     insecureRegistry?: boolean;        // passes crane's insecure flag for local HTTP registries
     logger?: (event: ToolchainCacheEvent) => void;
   }

   export interface ToolchainProvisionResult {
     resolved: string[];               // subset that is now installed
     missing: string[];                // requested but unavailable (no image, fetch failed)
     pathPrefix: string;               // effective PATH additions after sourcing env.sh files
     envOverlay: Record<string, string>; // env exported by env.sh files, excluding PATH
   }

   export async function ensureToolchains(opts: EnsureToolchainsOptions): Promise<ToolchainProvisionResult>;
   ```

   Implementation pulls each requested toolchain image via `crane export` into a tmpdir, atomically renames into `<root>/<tc>/`, and writes a `.installed` file containing the full image ref or image digest. Subsequent calls check that marker and short-circuit.

   File-lock the install path so two concurrent script steps on the same worker pod don't race. Prefer a Node-level atomic lock directory (`mkdir <root>/<tc>.lock`) with stale-lock cleanup so the helper does not require `flock`; if using `flock`, add `util-linux` to the worker image and test the binary exists.

   Do not hard-code PATH to `<root>/<tc>/bin` only. Each toolchain already ships an `env.sh`; source the env files in deterministic order and compute the resulting PATH/env overlay. This matters for Java/Kotlin (`JAVA_HOME/bin`), Rust (`CARGO_HOME/bin`), Python (`PYTHONPATH`), and media (`LD_LIBRARY_PATH`, `WHISPER_MODELS_DIR`).

3. **Script executor.** In `script-executor.service.ts:runScript()`:
   - Read `job.hints?.toolchains` (added to the job-fetch shape at `:90-94`).
   - If non-empty, call `ensureToolchains(...)` before building `env`.
   - Prepend `result.pathPrefix` to `env.PATH`. Merge `result.envOverlay` into `env`. Log a structured `appendLog(attemptId, 'toolchain', { resolved, missing })` entry for `eve job diagnose` to surface.
   - If any toolchain is in `result.missing`, emit a warning log line in the format `agent-runtime/src/invoke/invoke.service.ts:795-805` uses ("requested but not available"). The script still runs — it's the caller's responsibility to handle a missing binary on `PATH`. Do not fail the step on missing toolchains; the script may have a `command -v python3 || exit 0` fallback.
4. **Action executor.** Repeat the same shape in `action-executor.service.ts:handleRun()` (the pipeline `type: run` action path). Other action types (`build`, `release`, `deploy`, `notify`, `create-pr`, `env-ensure`, `env-delete`, `job`) are intentionally **not** toolchain-aware — those are platform operations, not user-shell. Schema validation should reject top-level `toolchains:` on pipeline `action:` steps that aren't `type: run`, reject nested `action.toolchains`, and reject all workflow action steps with toolchains until workflow actions are implemented.
5. **Worker Deployment**. Verify or add:
   - `EVE_TOOLCHAIN_ROOT=/opt/eve/toolchains` in the worker container env, or rely on the existing Dockerfile env only if no Deployment override is needed.
   - `EVE_TOOLCHAIN_IMAGE_PREFIX` and `EVE_TOOLCHAIN_IMAGE_TAG` in the worker container env, matching the values used for runner-pod init containers.
   - Local-only insecure registry env if `crane` must pull from `eve-registry.eve.svc.cluster.local:5000`.
   - `volumeMounts: [{ name: 'toolchains', mountPath: '/opt/eve/toolchains' }]` and `volumes: [{ name: 'toolchains', emptyDir: {} }]` so the cache is process-local to the pod and dropped on restart.
   - Mirror the same additions into `packages/cli/assets/local-k8s/base/worker-deployment.yaml`; the repo carries a packaged local k8s copy as well as `k8s/base`.
   - Same additions to the worker StatefulSet/Deployment in `eve-horizon-infra` (file an issue or PR against the infra repo as part of rollout — do **not** mutate AWS directly).
6. **Local k3d image publication.** Update `bin/eh-commands/k8s-image.sh` so Mode A has a pullable local image path:
   - Keep node-image import for Mode B/init-container compatibility.
   - Add a registry-push path that pushes toolchain images into the in-cluster registry through a host-reachable endpoint (for example a temporary port-forward to `localhost:5000`), while configuring worker pods to pull the same repository path via `eve-registry.eve.svc.cluster.local:5000`.
   - Set local worker env to the cluster-DNS pull prefix. Without this, `crane export eve-horizon/toolchain-python:local` inside the worker pod will not see the k3d node image cache.

Service tests:

- script-executor test with stub `ensureToolchains`: `hints.toolchains=['python']` → calls helper with `['python']` and merges resulting PATH prefix and env overlay before invoking bash.
- script-executor test with `hints.toolchains=[]` or missing: no helper call, no PATH change (regression guard).
- action-executor `handleRun` parity tests.
- `ensureToolchains` unit tests for: warm-cache short-circuit, version-mismatch invalidate, missing-image-graceful-degrade, concurrent-install locking.
- `appendLog(..., 'toolchain', ...)` entry is written exactly once per step.
- worker image test or smoke command confirms `crane version` works in the built base worker image.

Integration test (k3d):

- Sync a manifest with a workflow that has two steps:
  1. `script: { run: 'command -v python3' }` with `toolchains: [python]` — assert it exits 0.
  2. `script: { run: 'command -v python3 && echo no' }` with no toolchains — assert it exits 1 (or 0 with "no", depending on the worker variant).
- Before the k3d run, execute the updated local toolchain publication path (for example `./bin/eh k8s-image --toolchains python push-toolchains`) and verify the worker pod can `crane export` from the configured in-cluster registry.
- Verify `eve job diagnose <id>` surfaces the resolved toolchains.

### Phase 3b — Per-step runner pod (follow-up)

Out of scope for the initial PR; documented here so the design space stays open.

If/when the worker-pod runtime-install model proves insufficient (concurrent step volume, isolation requirements, worker pod restart churn), migrate script/action-run steps that declare `toolchains:` to per-step runner pods. The wiring already exists:

- Refactor `apps/worker/src/invoke/k8s-runner.ts` so the runner-pod manifest builder is callable from the script-executor and action-executor.
- Keep the active agent-runtime runner path (`apps/agent-runtime/src/invoke/k8s-runner.ts`) as the behavior baseline; share or duplicate only the pod-manifest construction needed by worker script/action-run jobs.
- Add a new entrypoint script in the runner image that reads `EVE_JOB_KIND=script|action-run` and `EVE_SCRIPT_COMMAND` (passed via downward API or env), executes the command, and exits with the captured status.
- The orchestrator continues to dispatch to the worker; the worker spawns the runner pod via the existing path; logs stream back through the existing executionLog channel.

When this lands, Phase 3a's `ensureToolchains` helper still serves the warm-pod / agent-runtime case. Both modes coexist.

### Phase 4 — CLI and diagnostics

**Files**

- `apps/api/src/jobs/jobs.controller.ts` (or wherever `GET /jobs/:id/diagnose` lives)
- `packages/cli/src/commands/job.ts` (no code change; verify `eve job diagnose` formatter renders the new log entry)
- `packages/cli/src/commands/env.ts` (no code change; verify `eve env diagnose` rolls up step toolchain hints)

Changes:

1. `eve job diagnose <id> --json` surfaces `hints.toolchains` and (if Phase 3a's `appendLog('toolchain', ...)` is present on the attempt) the per-attempt `resolved` / `missing` arrays.
2. `eve env diagnose <project> <env>` already surfaces `.workflows[].steps[].agent`. Append `.toolchains` to that step view so manifest authors can see at a glance which steps will need toolchain provisioning.
3. Add a one-line "toolchains: python, media" hint to `eve job show --verbose` output if non-empty.
4. CLI tests: `eve job diagnose` JSON output includes the new fields; human-readable formatter renders them when present, omits when empty.

### Phase 5 — Documentation

Behavior is user-facing. Update both internal docs and the public agent docs skillpack:

- `docs/system/pipelines.md` — pipeline step grammar table includes top-level `toolchains:` on agent / script / run / `action.type=run` steps, and explicitly rejects nested `action.toolchains`.
- `docs/system/workflows.md` — workflow step field table; add example showing a Python-backed script step; note workflow `action:` remains unsupported and cannot use `toolchains:`.
- `docs/system/manifest.md` — workflow- and pipeline-root-level `toolchains:` default.
- `docs/system/worker-types.md` — clarify that toolchain selection is now per-step for the in-pod cache path; worker variants remain as an operator escape hatch for clusters that prefer pre-baked images.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/pipelines-workflows.md` — step grammar.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/manifest.md` — workflow / pipeline schema.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/agents-teams.md` — note that `toolchains` is no longer agent-only.

Do not update public docs before behavior ships.

## File Change Summary

| Phase | File | Change |
|-------|------|--------|
| 1 | `packages/shared/src/schemas/workflow.ts` | Add `toolchains` to `WorkflowStepSchema` and `WorkflowDefinitionSchema` |
| 1 | `packages/shared/src/schemas/pipeline.ts` | Add `toolchains` to `PipelineStepSchema` and `PipelineDefinitionSchema` |
| 1 | `packages/shared/src/schemas/agent-config.ts` | (No change; `VALID_TOOLCHAINS` / `Toolchain` already exported) |
| 1 | `packages/shared/src/index.ts` | (No change expected; root index already re-exports schemas) |
| 1 | `packages/shared/src/schemas/__tests__/workflow.spec.ts` | New: shape tests |
| 1 | `packages/shared/src/schemas/__tests__/pipeline.spec.ts` | New: shape tests |
| 2 | `apps/api/src/workflows/workflows.service.ts` | Resolve toolchains for workflow script/run steps and root defaults; thread through to `hints.toolchains` |
| 2 | `apps/api/src/pipelines/pipeline-expander.service.ts` | Same resolution and persistence for pipeline script/run and `action.type=run` steps |
| 2 | `apps/api/src/workflows/workflows.service.spec.ts` | Resolution and persistence tests |
| 2 | `apps/api/src/pipelines/pipeline-expander.service.spec.ts` | Same for pipeline expander |
| 3a | `packages/shared/src/invoke/toolchain-cache.ts` | New: `ensureToolchains` helper |
| 3a | `apps/worker/src/script-executor/script-executor.service.ts` | Call `ensureToolchains`; extend env before bash |
| 3a | `apps/worker/src/action-executor/action-executor.service.ts` | Same for `handleRun` |
| 3a | `apps/worker/Dockerfile` | Add pinned `crane` or selected OCI export helper |
| 3a | `k8s/base/worker-deployment.yaml` | Add toolchain image env + `toolchains` emptyDir mount |
| 3a | `packages/cli/assets/local-k8s/base/worker-deployment.yaml` | Mirror local packaged worker deployment changes |
| 3a | `k8s/overlays/local/worker-registry.patch.yaml` | Configure local toolchain image prefix/tag/insecure registry for Mode A |
| 3a | `bin/eh-commands/k8s-image.sh` | Push toolchain images to a worker-pullable local registry, not only k3d import |
| 3a | (infra repo) worker deployment | Mirror env + volume change in `deployment-instance-repo` via Terraform-backed infra PR; no direct AWS mutation |
| 4 | `apps/api/src/jobs/jobs.controller.ts` | `diagnose` JSON includes `hints.toolchains` (already present; verify) |
| 4 | `packages/cli/src/commands/job.ts` | Human-readable formatter renders toolchain hint |
| 5 | `docs/system/pipelines.md`, `docs/system/workflows.md`, `docs/system/manifest.md`, `docs/system/worker-types.md` | Grammar, examples, workflow-action caveat, and local-registry note |
| 5 | `../eve-skillpacks/eve-work/eve-read-eve-docs/references/{pipelines-workflows,manifest,agents-teams}.md` | Public agent docs |

## Acceptance Criteria

The implementation is shippable when:

- A manifest workflow with `script: { run: 'python -m my_pkg.scaffold' }` and `toolchains: [python]` at the step runs `python -m my_pkg.scaffold` with `python3` resolvable on `PATH`, against a `base`-class worker pod.
- A manifest workflow with `toolchains: [media]` at the workflow root and a step with no step-level `toolchains:` applies `media` to that step.
- A step-level `toolchains:` overrides workflow-root `toolchains:` (step wins, no merge — same shape as agent toolchains today).
- A pipeline `script:` step with `toolchains: [rust]` runs `cargo --version` successfully.
- A pipeline step with top-level `toolchains: [java]` and `action: { type: run, command: ... }` runs with `java` resolvable.
- A workflow `script:` step with `toolchains: ['unknown']` is rejected at manifest sync time with a clear path and the list of valid values.
- A workflow with `toolchains:` on any `action:` step is rejected at manifest sync time because workflow actions remain unsupported.
- A pipeline with top-level `toolchains:` on an `action:` step whose `type` is not `run` (e.g. `type: deploy`) is rejected at manifest sync time.
- A pipeline with nested `action.toolchains` is rejected with guidance to use top-level step `toolchains:`.
- A workflow step with no `toolchains:` continues to run exactly as today (no PATH change, no install attempt, no extra log lines).
- `eve workflow retry --failed` on a failed script step with `toolchains: [python]` retries it with the same toolchain hint.
- `eve job diagnose <id>` JSON output includes `hints.toolchains` and (when an attempt has run) the resolved / missing arrays.
- Worker pod restart drops the toolchain cache (emptyDir behavior); subsequent steps re-install from the configured image registry without manual intervention.
- The base worker image contains the selected OCI export helper (`crane` in Mode A), and the helper can export the configured toolchain image from inside the worker pod.
- Local k3d Mode A uses a registry reachable from the worker pod; importing toolchain images into node cache alone is not considered passing for Mode A.
- Two concurrent script-executor jobs on the same worker installing the same toolchain race only on the install lock, not on a partial-copy state.
- Existing agent-step toolchain behavior is unchanged: same hint shape (`jobs.hints.toolchains`), same resolution precedence (step > agent), same runner-pod init-container path.

## Test Plan Summary

| Tier | What | Coverage |
| --- | --- | --- |
| Unit (shared) | `VALID_TOOLCHAINS` enum export | Existing export/import surface remains usable |
| Unit (shared) | `WorkflowStepSchema`, `PipelineStepSchema` | toolchains validation, workflow action rejection, pipeline action-run-only refinement, nested `action.toolchains` rejection |
| Unit (shared) | `ensureToolchains` | warm cache, version invalidate, missing image, env.sh PATH/env extraction, concurrent install lock |
| Service spec | Workflow expander | step/root resolution for script/run, agent path unaffected, workflow action remains rejected |
| Service spec | Pipeline expander | step/root resolution for script/run/action-run, non-run action rejected |
| Service spec | Script executor | hints.toolchains → ensureToolchains → env merged; empty hints → no-op |
| Service spec | Action executor | same for `handleRun`; other action types unaffected |
| Image smoke | worker base image | `crane version` or selected OCI helper is present |
| Integration | k3d | python script step on base worker resolves `python3` using worker-pullable registry image; missing toolchain emits warn log; retry preserves hint |
| Manual | `tests/manual/scenarios/NN-script-step-toolchains.md` | one happy-path scenario |

## Rollout

Backwards-compatible. No DB migration (`jobs.hints` is JSONB; toolchains is just a new key under it).

Suggested PR split:

1. **Phase 1 + Phase 2 schema and expander persistence.** Manifest authors can declare top-level `toolchains:` on workflow/pipeline script/run steps and pipeline action-run steps; child jobs get `hints.toolchains` populated. **No execution effect yet** — the step still runs in the worker pod's current PATH. This is shippable on its own as a no-op-at-runtime change that unblocks downstream manifest writers from declaring intent.
2. **Phase 3a inline runtime install.** The worker image helper (`crane`), `ensureToolchains` helper, worker pod volume/env, local registry publication, and executor wiring. This is the runtime-behavior change.
3. **Phase 4 CLI/diagnostics + Phase 5 docs.** Behavior-following.
4. (Future) Phase 3b — per-step runner pod migration if/when warranted.

Verify after PR 2: publish toolchain images with the updated local path, then run a script step with `toolchains: [python]` on a freshly-rebuilt k3d (`./bin/eh k8s start && ./bin/eh k8s deploy`) and confirm `python3` is resolvable. Smoke-test on staging with a synthetic manifest before rolling to deploy-flow workflows.

## Backwards Compatibility

This is additive:

- `toolchains:` is optional everywhere.
- Steps without `toolchains:` produce step jobs with no `hints.toolchains` (same shape as today's non-agent step rows).
- Direct job creation (`eve job create`) is unchanged. Job hints can already carry `toolchains` — that path remains untouched.
- Agent step behavior is unchanged; the new workflow-root default fills in only when neither step nor agent declares one.
- Pipeline `script:` steps that currently pre-exist continue to work; their hint shape gains an optional `toolchains` key when authors opt in.

The main compatibility risks are the new `WorkflowStepSchema` / `PipelineStepSchema` refinements that reject `toolchains:` on workflow action steps, reject `toolchains:` on non-run pipeline action steps, and reject nested `action.toolchains`. Audit existing manifests before merging the schema PR to confirm no manifest uses those shapes today.

## Open Questions

- Should the workflow-root `toolchains:` default also feed agent steps that don't declare `toolchains:` (current proposal: yes)? Or restrict the root default to non-agent steps to avoid surprising agents that work fine on `base` (alternative: keep agent step semantics step ?? agent only, ignore root default)? Recommend yes-feed-agents; the root default is opt-in at manifest level and surprises are visible at sync time.
- Should `ensureToolchains` resolve toolchains in parallel (`Promise.all`) or sequentially? Sequential is simpler; parallel may help when a step declares two large toolchains and the worker pod has cold cache for both. Default sequential; revisit if cold-start latency is a real issue.
- Should the worker pod's toolchain emptyDir be sized? Default emptyDir has no limit; cumulative toolchain footprint is ~2GB for all five. Consider `sizeLimit: 4Gi` to align with the runner-pod workspace cap.
- Should we surface installed toolchains in `eve system health` so operators can see which worker pods are warm for which toolchains? Probably not for v1 — health is for fail-fast diagnosis, not capacity planning.

## References

| File | Why |
| --- | --- |
| `packages/shared/src/schemas/agent-config.ts` | `VALID_TOOLCHAINS`, `Toolchain`, agent `toolchains:` precedent |
| `packages/shared/src/schemas/workflow.ts` | `WorkflowStepSchema`, `WorkflowDefinitionSchema` — gap site |
| `packages/shared/src/schemas/pipeline.ts` | `PipelineStepSchema`, `PipelineDefinitionSchema` — gap site |
| `apps/api/src/workflows/workflows.service.ts` | Workflow expander: agent toolchain resolution at `:1677-1688`, child-job persistence at `:1025` |
| `apps/api/src/pipelines/pipeline-expander.service.ts` | Pipeline expander — same gap |
| `apps/agent-runtime/src/invoke/k8s-runner.ts` | Active agent-job init-container provisioning path — `:228-244` |
| `apps/worker/src/invoke/k8s-runner.ts` | Worker-side runner-pod builder copy; candidate for Mode B script/action-run pods |
| `apps/worker/src/script-executor/script-executor.service.ts` | Script-job in-process bash entrypoint — `:345-401` |
| `apps/worker/src/action-executor/action-executor.service.ts` | Action-run in-process bash entrypoint — `:989-1095` (`handleRun`) |
| `apps/worker/Dockerfile` | Worker image currently lacks `crane`; Mode A needs an OCI export helper |
| `bin/eh-commands/k8s-image.sh` | Local toolchain image build/import path; Mode A needs worker-pullable registry publication |
| `k8s/base/worker-deployment.yaml` and `packages/cli/assets/local-k8s/base/worker-deployment.yaml` | Worker env/volume surfaces for the toolchain cache |
| `apps/orchestrator/src/loop/loop.service.ts` | Dispatch routing: script (`:1887`), action (`:1882`), agent (`:1892+`); reads `job.hints.toolchains` at `:1975-1976` for the agent path |
| `apps/agent-runtime/src/invoke/invoke.service.ts` | Inline-mode toolchain check — `:795-805` (the model for Phase 3a's warn-on-missing behavior) |
| `docs/system/worker-types.md` | Worker variant catalog; toolchain rationale |
| `docs/plans/worker-toolchain-on-demand-plan.md` | Phase 5b runtime-install pattern (the model for Phase 3a here) |
| `docs/plans/workflow-script-step-materialization-plan.md` | The other half of script-step ↔ agent-step parity |
| `docs/plans/workflow-env-overrides-plan.md` | Layered merge precedence pattern |

## Impact If Filled

- Removes a real source of drift: deterministic platform-side work in a typed/tested language can now be called from workflow/pipeline `script:` / `run:` and pipeline `action.type=run` without forcing the step into an agent harness.
- Composes with `workflow-env-overrides-plan.md` and the non-agent declarative-credentials work: together, workflow and pipeline script steps reach declarative parity with agent steps for secrets, scoped credentials, and toolchains.
- Makes the existing `worker-types.md` worker variants useful at the step level — they remain available as an operator escape hatch but stop being the only way to get Python or Rust into a script step.
- Unblocks an emerging pattern in downstream apps: "tested Python package + thin workflow shell" without the bash heredoc duplication that today's gap forces.
