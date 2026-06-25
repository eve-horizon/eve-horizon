# Workflow Script Step Materialization Plan

> **Status**: Proposed 2026-05-16
> **Scope**: Platform (eve-horizon)
> **Source**: Downstream-app gap report (workflow `script:` steps materialize as agent jobs)
> **Related**: `docs/plans/workflow-env-overrides-plan.md` (env overrides plumbing), `docs/plans/non-agent-job-scoped-credentials-plan.md` reference work (commit `236428d7` shipped scoped credentials for script/action paths)

## Problem

A manifest workflow often needs deterministic setup, file staging, validation, or cleanup before an agent-authored step runs. Those operations should be ordinary `script:` workflow steps with explicit `permissions:` and narrowed `scope:`, not agent prompts that happen to run shell commands.

Today the workflow definition grammar is loose enough to accept a `script:` step, but the workflow expander never materializes it as a script job. The result is a silent trap: the manifest looks correct, but at runtime the agent runtime tries to execute the step and there is no `script_command` to run.

### Root cause (where the wiring breaks)

1. `packages/shared/src/schemas/workflow.ts:7` defines `WorkflowDefinitionSchema = z.record(z.unknown())`. Workflow step shape is not validated like pipeline steps.
2. `packages/shared/src/schemas/manifest.ts:665` validates manifest workflows with `PipelineDefinitionSchema` (which **does** allow `script:`), so a `script:` step survives manifest sync — it just never reaches the expander as a recognized execution type.
3. `apps/api/src/workflows/workflows.service.ts:829-834` iterates steps and resolves **agent** config for every step, regardless of whether the step declared `agent:` or `script:`.
4. `apps/api/src/workflows/workflows.service.ts:912` creates each child job with agent-oriented fields only.
5. `apps/api/src/workflows/workflows.service.ts:963` sets `execution_type: 'agent'` unconditionally.
6. `apps/api/src/workflows/workflows.service.ts:968` sets `script_command: null` unconditionally; `script_timeout_seconds: null` follows the same pattern.

The worker side is already complete:

- `apps/worker/src/script-executor/script-executor.service.ts:101` reads `script_command` off the job row.
- `apps/worker/src/script-executor/script-executor.service.ts:106` reads `script_timeout_seconds` and applies it to the shell process timeout.
- `apps/worker/src/script-executor/script-executor.service.ts:140-150` reads `jobs.token_permissions` / `jobs.token_scope` and mints `EVE_JOB_TOKEN` with the per-step scope.
- `apps/worker/src/script-executor/script-executor.service.ts:184-185` runs the script command in a workspace-scoped HOME with `~/.eve/credentials.json` populated.

And the orchestrator already routes on `execution_type`:

- `apps/orchestrator/src/loop/loop.service.ts:1882-1891` dispatches `action`/`script` jobs to `workerService.executeAction` / `workerService.executeScript`. `agent` (default) goes to agent-runtime.

The pipeline expander has done this materialization correctly for some time — see `apps/api/src/pipelines/pipeline-expander.service.ts:392-499`. It calls `getScriptConfig(step)` + `parseStepExecution(...)`, sets `execution_type` per step, and persists `script_command` / `script_timeout_seconds`. The workflow expander needs the same treatment.

### Why this matters

Without workflow script materialization, callers fall back to three bad shapes:

- Wrap deterministic shell in an agent harness just to get workflow orchestration + scoped credentials. Pays for an LLM turn to run `cp` and `ls`.
- Split setup into a pipeline (or hand-build child jobs with `eve job create` + `eve job dep add`). Loses `eve workflow retry --failed`, loses the manifest DAG as a source of truth, drags orchestration logic into application code.
- Push the deterministic step behind a small service. Adds a deployable for what should be a 20-line shell script.

All three move orchestration complexity out of the manifest, and all three weaken the workflow contract.

## Goal

A workflow `script:` step at runtime is a **script job**: `execution_type='script'`, `script_command` is set, `script_timeout_seconds` is honored, scoped `EVE_JOB_TOKEN` is minted from `jobs.token_permissions` / `jobs.token_scope`, and the orchestrator dispatches it to the worker's script executor — not the agent runtime.

Workflow `agent:` steps continue to behave exactly as today.

## Non-Goals

- New permissions or new secret resolution paths. Scoped credentials already work for script/action jobs (commit `236428d7`).
- Runtime support for `action:` steps inside workflows. The schema may reserve `action:` as a future step kind so authors get exactly-one validation, but invoke should reject it with a clear "not yet supported" error until a dedicated plan lands.
- Cross-step output passing for scripts (a script can already read `EVE_*` env and call the API to fetch parent-step outputs).
- Sharing the workflow and pipeline expanders into one module. They already drift in helpful ways (workflows have `inputs`, `event.payload` scopes, retry semantics). Reuse the small detection helpers; do not unify the expanders.

## Design Sketch

The minimum viable shape mirrors the pipeline expander:

1. **Validate workflow step shape** with a `WorkflowStepSchema` so authors get an error at sync time rather than a silent agent step at runtime. Permit exactly one of `agent`, `script`, `run`, or (future) `action`.
2. **Detect execution type per step** during invoke. Reuse the existing script/action/agent detection logic from the pipeline expander, ideally factored into a shared semantic helper while keeping pipeline-specific title/description metadata local to the pipeline expander.
3. **Persist execution fields** on the child job: `execution_type`, `script_command`, `script_timeout_seconds`. For script steps, skip agent config resolution and leave `harness*`, `assignee`, agent-only hints null.
4. **Preserve everything else** that already works for workflow steps: `env_overrides`, `token_permissions`, `token_scope`, `git`, dependencies, `resource_refs`, `condition`, and the workflow root job container.

The orchestrator and worker already do the rest.

## Implementation Plan

### Phase 1 — Shared schemas (define what a workflow step is)

**Files**

- `packages/shared/src/schemas/workflow.ts`
- `packages/shared/src/schemas/manifest.ts`
- `packages/shared/src/schemas/__tests__/workflow.spec.ts` (new or extended)

Changes:

1. Introduce `WorkflowStepSchema`. Borrow shape from `PipelineStepSchema` (`packages/shared/src/schemas/pipeline.ts:46`) — it already declares `agent`, `script`, `run`, `action`, `requires`, `env_overrides`, `scope`, `permissions`, `depends_on`, `resource_refs`, `harness*`, and `git`. The workflow flavour additionally supports `condition` and existing workflow agent fields such as `with_apis` / `with-apis`.
2. Tighten the `refine` so the step declares exactly **one** of `agent`, `script`, `run`, or `action`. Today `PipelineStepSchema` only requires "at least one"; for workflows we want unambiguous routing.
3. Replace `WorkflowDefinitionSchema = z.record(z.unknown())` with an explicit `WorkflowDefinitionSchema` carrying `steps: z.array(WorkflowStepSchema).optional()`, plus existing workflow-level keys used by `WorkflowsService`: `inputs`, `db_access`, `env_overrides`, `scope`, `permissions`, `resource_refs`, `git`, `hints`, `trigger`, and `with_apis` / `with-apis`. Keep `passthrough()` so we don't break existing workflows that ride extra metadata.
4. Move or re-export workflow-only input declaration helpers (`WorkflowInputDeclarationSchema`, `WorkflowInputsSchema`) from the workflow schema module. They currently live in `pipeline.ts`, which is misleading once workflows stop using `PipelineDefinitionSchema`.
5. Update `packages/shared/src/schemas/manifest.ts:665` so manifest validation routes workflows through the new `WorkflowDefinitionSchema` rather than `PipelineDefinitionSchema`. This is backward-compatible for single-kind workflow steps and intentionally rejects ambiguous steps that currently validate accidentally (for example, a step with both `agent:` and `script:`).
6. Add schema tests:
   - workflow step accepts `agent:` alone, `script:` alone, `run:` alone;
   - workflow step accepts future `action:` alone at schema level;
   - workflow step rejects `{ agent: {...}, script: {...} }` ("ambiguous execution type");
   - workflow step rejects a step with none of agent/script/run/action;
   - workflow step accepts the standard cross-cutting keys (`requires`, `scope`, `permissions`, `env_overrides`, `depends_on`, `condition`);
   - workflow definition preserves workflow-level `git`, `hints`, `trigger`, and `with_apis` / `with-apis`.

### Phase 2 — Shared execution-type detection

**Files**

- `packages/shared/src/workflow/step-execution.ts` (new) — or co-locate inside `packages/shared/src/schemas/pipeline.ts` and re-export.
- `packages/shared/src/workflow/index.ts` and `packages/shared/src/index.ts` if using the new `workflow/` directory.
- `apps/api/src/pipelines/pipeline-expander.service.ts` (refactor to import the shared helper)

Changes:

1. Extract `getScriptConfig(step)` and the execution-kind detection from `apps/api/src/pipelines/pipeline-expander.service.ts:716-873` into `packages/shared`. Do **not** move pipeline-specific title/description/metadata rendering as-is; the current `parseStepExecution(...)` returns pipeline job presentation data, while workflows need semantic data:

   ```ts
   type StepExecution = {
     executionType: 'agent' | 'script' | 'action';
     scriptCommand: string | null;
     scriptTimeoutSeconds: number | null;
     actionType: string | null;
     actionInput: Record<string, unknown> | null;
     agentConfig: Record<string, unknown> | null;
   };
   ```

2. Update both pipeline call sites (`apps/api/src/pipelines/pipeline-expander.service.ts:397-400` and the dry-run path at `:933-934`) to use the shared semantic helper, then keep the existing pipeline title/description/metadata output byte-for-byte equivalent.
3. Add unit tests for the shared helper covering: `script: { run: ... }`, `script: { command: ..., timeout_seconds: ... }`, top-level `run: '...'`, `agent: { prompt: ... }`, `action: { type: ..., ... }`, and ambiguous steps rejected by `WorkflowStepSchema` before they reach the helper.

This is the only refactor that touches existing pipeline code. It is mechanical (move + re-export), so it stays in its own commit for easy review and rollback.

### Phase 3 — Workflow expander materializes the right job type

**File**: `apps/api/src/workflows/workflows.service.ts`

Changes:

1. In the step loop at `:829`, call the shared helper first:

   ```ts
   const stepExecution = parseWorkflowStepExecution(step, stepName);
   ```

2. Branch:

   - **Script step** (`stepExecution.executionType === 'script'`): skip `resolveStepAgentFromStep`. Leave `harness`, `harness_profile`, `harness_profile_override`, `harness_options`, `harness_profile_source`, `harness_profile_hash`, and `assignee` null. Skip `app_apis`/`resolved_app_apis` resolution (scripts don't get app API instruction blocks). Build the step description from `stepExecution.scriptCommand` plus the optional `Workflow input:` summary that workflows already inject (see `:839-848`).
   - **Agent step** (`executionType === 'agent'`): keep the current behaviour exactly.
   - **Action step** (`executionType === 'action'`): defer to a follow-up; for now, treat as an explicit `BadRequestException("workflow action steps not yet supported — use a pipeline")`. This is a non-goal of this plan.

3. Replace the hardcoded fields at `:963-969` with values from `stepExecution`:

   ```ts
   execution_type: stepExecution.executionType, // 'agent' | 'script'
   action_type: null,
   action_input: null,
   script_command: stepExecution.scriptCommand,
   script_timeout_seconds: stepExecution.scriptTimeoutSeconds,
   ```

4. Preserve everything that already works at the step level:
   - `env_overrides` merge chain per `workflow-env-overrides-plan.md` (workflow defaults, step overrides, invocation overrides).
   - `token_scope` intersection semantics (`workflow` ∩ `step` ∩ `invocation`).
   - `token_permissions` current winner semantics (`step` > `invocation` > `workflow`, per `mergeStepTokenPermissions`). These are the scoped-credentials fields the script executor already reads; this is the property that makes the gap shippable end-to-end.
   - `git`, `resource_refs`, `depends_on`, `condition`, and labels.
5. Update workflow `hints` for script steps to drop the agent-only entries (`permission_policy`, `toolchains`, `app_apis`, `resolved_app_apis`). Keep `workflow_name`, `step_name`, `step_index`, `condition`, `db_access`, `request_json`, and the resource-ref summary keys.
6. Leave the workflow **root** job untouched (`execution_type: 'agent'` for the container is fine; it never invokes a harness — it stays in `active` until children complete).
7. Audit the retry path (`workflow retry`). Today retry copies the source job's fields, so a script step retrying as a script step should be free. Add a regression test (see Phase 5).

### Phase 4 — Internal consistency: invoke-side validation and error messages

**Files**

- `apps/api/src/workflows/workflows.controller.ts`
- `apps/api/src/workflows/workflows.internal.controller.ts`
- `apps/api/src/workflows/workflows.service.ts`
- `packages/shared/src/schemas/manifest.ts`

Changes:

1. Both invoke controllers already run `ZodValidationPipe(WorkflowInvokeRequestSchema)` — request shape is fine. The new validation is at manifest sync time, gated by `WorkflowDefinitionSchema`.
2. Update `parseWorkflows` (`workflows.service.ts:83`) to validate parsed definitions through `WorkflowDefinitionSchema` and throw `BadRequestException` with the path of the offending step on failure. Today it returns the raw `Record<string, unknown>` — the new schema makes this safer for downstream consumers.
3. Improve the existing `validateStepGraph` to also reject a workflow step that fails the new "exactly-one-execution-type" rule. (It currently only checks name/dep/cycle/condition rules.) Keep this runtime check even though manifest validation catches new manifests, because old manifests may already be stored.
4. Make sure `eve manifest validate` surfaces the new errors. The validate path imports the same shared schema, so this should be automatic — add a test to confirm.
5. Check `analyzeManifestCoherence` in `packages/shared/src/schemas/manifest.ts` after splitting workflow schemas. It currently iterates `manifest.pipelines` and `manifest.workflows` together; preserve any useful shared checks without re-coupling workflows to `PipelineDefinitionSchema`.

### Phase 5 — Tests

**Unit / service tests**

- `apps/api/src/workflows/workflows.service.spec.ts`:
  - workflow with a single `script:` step creates a child job with `execution_type='script'`, non-null `script_command`, correct `script_timeout_seconds`, `harness=null`, `assignee=null`.
  - mixed workflow (`script` setup → `agent` work → `script` cleanup) creates the expected three jobs with the right `execution_type` each and correct `depends_on` wiring.
  - workflow step with `scope:` and `permissions:` produces a script job whose `jobs.token_scope` and `jobs.token_permissions` match the merged chain (so the script executor's existing mint path picks them up).
  - workflow `script:` step rejects `{ agent: {...}, script: {...} }` at manifest validate time with a clear path.
  - workflow `action:` step is accepted by schema but invoke returns the explicit "not yet supported" `BadRequestException`.
  - workflow retry of a failed `script:` step produces a new job with `execution_type='script'` and identical `script_command`/`script_timeout_seconds`.

**Schema tests**

- `packages/shared/src/schemas/__tests__/workflow.spec.ts`:
  - the shape tests listed in Phase 1.

**Integration test**

- Extend `apps/api/test/integration/pipelines-workflows.integration.test.ts`: invoke a two-step workflow where step 1 is `script: { run: 'echo hello && eve job list --json' }` with `permissions: [ 'jobs:read' ]` and step 2 is an `agent:` step depending on step 1. Assert:
  - step 1 child job has `execution_type='script'`, non-null `script_command`, `token_permissions=['jobs:read']`.
  - step 1 runs through the worker's script executor (check the routing log entry).
  - step 1 succeeds; step 2 remains dependent on step 1 before completion and is schedulable only after the dependency is done.

**Manual scenario** (lower priority, ship after integration test is green)

- Add `tests/manual/scenarios/NN-workflow-script-step.md` mirroring the existing manual workflow scenarios. Run on k3d.

### Phase 6 — Documentation

Update both the internal docs and the public agent docs skillpack:

- `docs/system/pipelines.md` — note that workflow `script:` steps materialize as script jobs and inherit the same scoped-credentials model as pipeline `script:` steps.
- `docs/system/workflows.md` — update the workflow step field table from agent-only to `agent` / `script` / `run`, with the exactly-one rule.
- `docs/system/manifest.md` and `docs/system/workflow-invocation.md` — update workflow grammar and runtime materialization notes.
- `docs/system/job-cli.md` — example: `eve workflow run my-workflow` with a manifest that uses `script:` setup.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/pipelines-workflows.md` — workflow step grammar table includes `script:`.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/manifest.md` — workflow step shape.

Do not update public docs before behaviour ships.

## Acceptance Criteria

The implementation is shippable when:

- A manifest workflow with a `script: { run: ... }` step invokes to a child job with `execution_type='script'`, non-null `script_command`, and the declared `script_timeout_seconds`.
- That child job is dispatched to the worker's script executor (not the agent runtime). The routing log entry confirms `target: 'worker'` and `execution_type: 'script'`.
- The script runs in a workspace-scoped HOME with `EVE_JOB_TOKEN` minted from per-step `permissions:` and `scope:` declared on the workflow step. (This is the property the related shipped commit `236428d7` made possible.)
- A workflow with mixed `script:` and `agent:` steps preserves `depends_on` wiring across execution types.
- A manifest workflow with `{ agent: {...}, script: {...} }` on the same step is rejected at sync time with an unambiguous error.
- A workflow `action:` step is not silently treated as an agent step; invoke fails with the explicit "not yet supported" error.
- `eve workflow retry --failed` on a failed `script:` step retries it as a `script:` step (not as an agent step).
- Existing all-agent workflows still produce step jobs with `execution_type='agent'` and no behaviour change.
- `eve manifest validate` and `eve project sync` reject workflow steps with no execution type and workflow steps with more than one execution type.

## Test Plan Summary

| Tier | What | Coverage |
| --- | --- | --- |
| Unit (shared) | step-execution helper | script/agent/run/action detection, timeout parsing |
| Unit (shared) | workflow schema | shape, exactly-one rule, passthrough |
| Service spec | workflow expander | script + agent + mixed + retry + scope/permissions merge |
| Integration | end-to-end invoke | API integration stack: script step materializes as a worker-routed job, agent step materializes as an agent-runtime job, deps wire correctly |
| Manual | k8s walkthrough | one scenario file in `tests/manual/scenarios/` |

## Rollout

This is a backward-compatible change for workflows that don't declare `script:` steps. No DB migration needed — `jobs.execution_type`, `jobs.script_command`, `jobs.script_timeout_seconds`, `jobs.token_permissions`, and `jobs.token_scope` all already exist.

Stage the rollout in three commits:

1. Phase 2 refactor (move detection helpers to shared, no behaviour change).
2. Phase 1 schema + Phase 4 validation (rejects new error cases at sync time; pre-existing manifests are unaffected).
3. Phase 3 expander change + tests (the actual feature) + Phase 6 docs.

## Out of Scope (Captured for Follow-Up)

- Workflow `action:` steps. The schema in Phase 1 should already accept `action:` as a step kind to keep the door open, but Phase 3 throws `BadRequestException` until a dedicated plan covers it. File a follow-up issue once this lands.
- A workflow-aware `eve harness validate` for script steps. Scripts don't go through the harness selector, so the existing `eve harness validate --workflow` (see `workflow-env-overrides-plan.md` Phase 6) should skip script steps cleanly. Verify with a test rather than a code change.
- Sharing step expansion between pipelines and workflows beyond the small detection helpers. The two expanders should stay independent.
