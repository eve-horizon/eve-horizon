# Script Step `env_overrides` Injection Plan

> **Status**: Implemented 2026-05-20
> **Scope**: Platform (eve-horizon)
> **Tracking**: `eve-horizon-569w`
> **Source**: Downstream-app gap report — "Script-step env_overrides are persisted but not injected into the script env"
> **Related**:
> - `docs/plans/workflow-env-overrides-plan.md` — shipped 2026-05-07; established `env_overrides` merge precedence and persistence on workflow step jobs
> - `docs/plans/workflow-script-step-materialization-plan.md` — shipped in `release-v0.1.284` (commit `c6f4424a`); made workflow `script:` / `run:` steps materialize as script jobs with scoped credentials
> - `docs/plans/script-action-step-toolchains-plan.md` — shipped 2026-05-19; the other half of script-step ↔ agent-step parity (declarative toolchains on script/action-run)
> - `docs/plans/per-job-harness-override-plan.md` — defines the `${secret.KEY}` interpolation, `missing_secret_override` relay, and reserved-key strip behaviour the script executor should mirror

## Problem

Workflow authors expect to pass per-invocation parameters into deterministic `script:` steps via `env_overrides` — paths, mount ids, tenant identifiers, etc. — and read them as bash environment variables inside the step's `run:`. That works for `agent:` steps today in the primary agent-runtime path (`apps/agent-runtime/src/invoke/invoke.service.ts:1178-1202`) and the worker fallback path (`apps/worker/src/invoke/invoke.service.ts:1322-1346`): both read `env_overrides`, interpolate `${secret.KEY}` placeholders, strip reserved keys, and merge resolved values into the harness env before exec. The script-executor does not.

A workflow author writes:

```yaml
workflows:
  example-workflow:
    env_overrides:
      TARGET_PATH: "/work/${secret.TENANT_SLUG}/inbox"
    steps:
      - name: stage-inputs
        permissions: [orgfs:read, cloud_fs:read]
        script:
          run: |
            : "${TARGET_PATH:?required}"
            ls "$TARGET_PATH"
```

`eve workflow run example-workflow` succeeds at job creation. `eve job show <step-job-id> --json | jq '.env_overrides'` returns `{"TARGET_PATH": "/work/.../inbox"}` — the row is correct. The bash process never sees the variable, so `${TARGET_PATH:?required}` fires, the step exits non-zero, and the author has to debug a silent shape mismatch between "what's on the job" and "what's in the script env".

### Root cause (where the wiring breaks)

1. `apps/api/src/workflows/workflows.service.ts` already does the workflow-side work: `mergeStepEnvOverrides` is defined at `:140-153`, called for each step at `:997-1001`, and persisted on the child job at `env_overrides: stepJobEnvOverrides` (`:1092`). This is correct and shipped in `workflow-env-overrides-plan.md`.
2. `apps/agent-runtime/src/invoke/invoke.service.ts:1178-1202` and `apps/worker/src/invoke/invoke.service.ts:1322-1346` are the two agent invoke implementations. They read job-level `env_overrides`, call `interpolateEnvOverrides(envOverridesRaw, resolvedSecrets)`, fail fast on `missing_secret_override` via `deliverProvisioningError`, defensively strip `isReservedEnvKey(...)` keys, and merge resolved values into the harness env before exec. This is the model we want.
3. `apps/worker/src/script-executor/script-executor.service.ts:378-445` (`runScript`) builds the bash env from a small hard-coded set: `PATH`, `HOME`, `EVE_JOB_ID`, `EVE_PROJECT_ID`, `EVE_ATTEMPT_ID`, optional `EVE_API_URL` / `EVE_PUBLIC_API_URL` / `EVE_JOB_TOKEN` / `EVE_RUN_ID` / `EVE_ENV_NAME` / `EVE_ENV_NAMESPACE`, plus the toolchain overlay merged at `:430-437`, then calls `execFileAsync('bash', ['-c', command], { env })` at `:440-445`. There is no read of `job.env_overrides`, no `interpolateEnvOverrides` call, no reserved-key strip, and no `missing_secret_override` relay.
4. `apps/worker/src/action-executor/action-executor.service.ts:1109-1137` (`handleRun`) has the same executor-side gap for any action job row that carries `env_overrides`. For pipeline `action: { type: run }` specifically, there is also a persistence gap: `apps/api/src/pipelines/pipeline-expander.service.ts:545` currently writes `env_overrides: null` for every materialized pipeline step. If this plan includes action-run parity, it must include that expander persistence work too.

The asymmetry is mechanical for workflow script steps: the merge already runs at job creation, the value already sits on the job row, and the helpers (`interpolateEnvOverrides`, `isReservedEnvKey`, `deliverProvisioningError`) already live in `@eve/shared` and are exported. The script executor just doesn't call them. Pipeline action-run needs one extra API-side persistence step before the action executor can observe the same row value.

### Workaround in use today

Workflow authors fetch the persisted `env_overrides` via the job-show API inside the script body:

```bash
OVERRIDES=$(eve job show "$EVE_JOB_ID" --json | jq -r '.env_overrides // {}')
export TARGET_PATH=$(echo "$OVERRIDES" | jq -r '.TARGET_PATH // empty')
: "${TARGET_PATH:?required}"
```

Costs:

- Forces every parameterized script step to also declare `jobs:read` in `permissions:`, just so the scoped token can read its own job row. Step permission scopes drift wider than the actual work justifies.
- Adds an API round-trip and 6-10 lines of `eve job show ... | jq` boilerplate to every parameterized script step.
- `${secret.KEY}` placeholders inside the override value are never resolved in this workaround — the script sees the raw `${secret.TENANT_SLUG}` text because the API returns the un-interpolated row.
- Reserved-key safety is the script author's problem rather than the platform's.

## Goal

A workflow `script:` step with `env_overrides` declared at workflow level, step level, or invocation level sees those keys as bash environment variables when its `run:` executes — with `${secret.KEY}` placeholders already resolved against the project's secret set.

Concretely:

- The script-executor reads `job.env_overrides` from the job record at execution time.
- `${secret.KEY}` placeholders are interpolated against the resolved project secret set using the same `interpolateEnvOverrides` helper the agent paths use.
- Missing secret references fail fast with `missing_secret_override`, surface back to the originating chat/coordination thread via `deliverProvisioningError`, and write an `error` execution log line. The script does not run.
- Reserved keys (`PATH`, `HOME`, `SHELL`, `USER`, `TMPDIR`, `NODE_OPTIONS`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_HOME`, and the `EVE_*` prefix family — see `packages/shared/src/schemas/job.ts:44-66`) are stripped defensively even though Zod rejects them at API time.
- Resolved override values are merged into the `env` object passed to `execFileAsync('bash', ['-c', command], { env })` after the existing toolchain overlay, so override keys take precedence over toolchain-exported `env.sh` values when authors intentionally shadow them.
- Pipeline `action: { type: run }` steps inherit the same behaviour once the pipeline expander persists merged pipeline/step `env_overrides` onto those action-run jobs.

Empty / null `env_overrides` → identical to today's behaviour (no resolution, no relay, no log lines).

## Non-Goals

- New permissions or new secret resolution paths. The existing `${secret.KEY}` mechanism is reused as-is.
- New schema, new manifest field, new CLI flag. Workflow / pipeline schemas already accept `env_overrides:` and the column already exists on `jobs`.
- Pipeline `agent:`, `script:`, and `run:` shorthand `env_overrides`. The pipeline expander currently sets `env_overrides: null` for every step it materializes (`apps/api/src/pipelines/pipeline-expander.service.ts:545`). This plan adds expander persistence only for pipeline `action: { type: run }` because action-run executor parity is in scope. Pipeline agent/script/run-shorthand persistence is a separate follow-up; the executor fixes here make that follow-up small.
- Templating override values from workflow `inputs:` (`${inputs.brand}` in env values). Only `${secret.KEY}` is supported.
- Surfacing resolved override values in `eve job show` / `eve job tree`. Values stay resolved-in-memory only; the persisted row still carries the un-interpolated placeholder text.
- Removing the existing `eve job show | jq` workaround in downstream apps as part of this plan. They migrate on their own cadence once the platform fix lands.
- Workflow `action:` steps. Workflows currently reject `action:` at invoke time (per `workflow-script-step-materialization-plan.md`). When workflow actions land, they pick up the same injection automatically.

## Design Sketch

The minimum viable shape mirrors the existing agent-runtime / worker invoke blocks, lifted into a tiny shared helper so every executable path calls the same code:

1. **Shared helper** in `@eve/shared`. Single entry point for "take a job's `env_overrides`, the resolved project secret set, and a base env; return a merged env or throw `missing_secret_override`":

   ```ts
   export interface ApplyEnvOverridesOptions {
     envOverrides: Record<string, string> | null | undefined;
     resolvedSecrets: SecretResolveItem[];
     baseEnv: NodeJS.ProcessEnv;
     // Side-channel for callers that want to relay missing_secret_override
     // back to a chat / coordination thread. If omitted, callers just see
     // the thrown error and decide what to do.
     onMissingSecrets?: (missing: string[]) => Promise<void>;
   }

   export interface ApplyEnvOverridesResult {
     env: NodeJS.ProcessEnv;
     appliedKeys: string[];     // useful for log lines
     strippedKeys: string[];    // reserved keys filtered defensively
   }

   export async function applyEnvOverrides(
     opts: ApplyEnvOverridesOptions,
   ): Promise<ApplyEnvOverridesResult>;
   ```

   Implementation: short-circuit on empty `envOverrides`; call `interpolateEnvOverrides`; if `missing.length > 0`, call `onMissingSecrets?.(...)` and throw a typed `MissingSecretOverrideError` whose `code = 'missing_secret_override'` matches the current agent-path string. Otherwise iterate resolved entries, skip `isReservedEnvKey(k)` keys (collect them into `strippedKeys`), and write the rest into a fresh env object built from `baseEnv`.

   `interpolateEnvOverrides`, `extractSecretRefs`, `isReservedEnvKey`, `deliverProvisioningError`, and `SecretResolveItem` are already exported from `@eve/shared`; the helper is ~30 lines. The helper does not call the secrets API itself; callers pass the resolved secret set appropriate for their execution path.

2. **Agent invoke paths** (`apps/agent-runtime/src/invoke/invoke.service.ts:1178-1202` and `apps/worker/src/invoke/invoke.service.ts:1322-1346`) refactor to call `applyEnvOverrides` so there's exactly one copy of this logic. This is behaviour-preserving: same code, same error code, same relay call.

3. **Script executor** (`apps/worker/src/script-executor/script-executor.service.ts`) calls `applyEnvOverrides` inside `runScript` after the toolchain overlay merge at `:430-437` and before `execFileAsync('bash', ...)` at `:439`. The `onMissingSecrets` callback uses the same `deliverProvisioningError` + `buildRelayDb` shape the agent paths use; the script executor already has `db` in scope.

4. **Pipeline expander** (`apps/api/src/pipelines/pipeline-expander.service.ts`) persists merged pipeline-level + step-level `env_overrides` only for `action.type === 'run'` jobs. Pipeline runs do not currently accept request-supplied invocation overrides, so precedence is step > pipeline. All other pipeline action types continue to persist `env_overrides: null`.

5. **Action executor** (`apps/worker/src/action-executor/action-executor.service.ts:1109-1131` `handleRun`) does the same right after `buildRunEnv(...)` and the toolchain merge, before `execFileAsync('bash', ['-c', command], ...)` at `:1133`. Other action types (`build`, `release`, `deploy`, `notify`, `create-pr`, `env-ensure`, `env-delete`, `job`) are platform operations, not user-shell — they intentionally do not honour `env_overrides`.

Do not add an unconditional secrets API call to every script/action-run execution. `extractSecretRefs(job.env_overrides ?? {})` tells callers whether override interpolation actually needs resolved secrets. If secret refs exist, resolve project secrets before running bash and fail fast if the secrets API itself cannot resolve; do not misclassify a secrets API outage as `missing_secret_override`. If the repo clone also needs HTTPS git auth, reuse that same resolved secret set instead of calling `resolveProjectSecrets(projectId)` twice.

Override values land in the env **after** the toolchain `env.sh` overlay (`ensureToolchains` result), so an author can intentionally shadow a toolchain-exported var with `env_overrides: { PYTHONPATH: "..." }`. Reserved-key strip catches accidental shadowing of platform-controlled keys.

## Implementation Plan

### Phase 1 — Shared helper

**Files**

- `packages/shared/src/invoke/env-overrides.ts` (new) — `applyEnvOverrides` + `MissingSecretOverrideError`
- `packages/shared/src/invoke/index.ts` — re-export
- `packages/shared/src/invoke/__tests__/env-overrides.spec.ts` — extend with tests for the new helper (file already exists per `workflow-env-overrides-plan.md`)

Changes:

1. Implement `applyEnvOverrides` as sketched above. Re-use `interpolateEnvOverrides` and `isReservedEnvKey` from existing exports (`packages/shared/src/invoke/workspace-secrets.ts:206` and `packages/shared/src/schemas/job.ts:63`).
2. Add `MissingSecretOverrideError extends Error` with `code: 'missing_secret_override'` and a `missing: string[]` field, so callers can match by class rather than string-matching on `.message`.
3. Re-export from `packages/shared/src/invoke/index.ts` and (transitively) the root `packages/shared/src/index.ts`.

Unit tests:

- Empty / null / undefined `envOverrides` → returns an env equal to `baseEnv`, does not mutate `baseEnv`, `appliedKeys: []`, no interpolation.
- `envOverrides: { FOO: "bar" }` with no secret references → merges into env, `appliedKeys: ['FOO']`.
- `envOverrides: { FOO: "${secret.X}" }` with `X` in resolved secrets → resolved value lands in env, raw placeholder does not.
- `envOverrides: { FOO: "${secret.MISSING}" }` with no matching secret → throws `MissingSecretOverrideError` with `missing: ['MISSING']`, calls `onMissingSecrets(['MISSING'])` exactly once, does not mutate env.
- `envOverrides: { PATH: "/evil" }` → stripped, `strippedKeys: ['PATH']`, `appliedKeys: []`. Same for `HOME`, `EVE_API_URL`, `CLAUDE_CONFIG_DIR`.
- `envOverrides: { FOO: "${secret.A}", BAR: "${secret.B}" }` with both missing → throws once with `missing: ['A', 'B']` in declaration order.
- Reserved-key strip applies after interpolation, so a resolved value whose *key* (not value) shadows `PATH` is dropped.

### Phase 2 — Agent invoke path refactor

**Files**

- `apps/agent-runtime/src/invoke/invoke.service.ts`
- `apps/worker/src/invoke/invoke.service.ts`

Changes:

1. Replace the inline block at `apps/agent-runtime/src/invoke/invoke.service.ts:1178-1202` with a call to `applyEnvOverrides`, passing `invocationWithOptions.env_overrides`, the already-resolved `resolvedSecrets`, the current `adapterEnv`, and an `onMissingSecrets` callback that wraps `deliverProvisioningError(this.buildRelayDb(), ...)` with the same `errorCode`, `jobId`, `parentJobId`, `assignee`, and message as today.
2. Replace the inline block at `apps/worker/src/invoke/invoke.service.ts:1322-1346` with the same helper call, using `effectiveInvocation.env_overrides` and `harnessEnv`.
3. Catch `MissingSecretOverrideError` to preserve the exact `(err as Error & { code?: string }).code = 'missing_secret_override'` shape that downstream classifiers / log analysers may match on. (The helper already sets `code`, so this is belt-and-braces.)
4. No log output changes. No error-message-text changes. This is a pure refactor.

Tests: add focused regression coverage for both invoke services if practical. At minimum, the shared helper tests must lock the current literal override, missing-secret, and reserved-key semantics before the refactor, and one invoke-path test should prove an agent job with `env_overrides: { FOO: "bar" }` produces a harness invocation env containing `FOO=bar`.

### Phase 3 — Script-executor injection

**File**: `apps/worker/src/script-executor/script-executor.service.ts`

Changes:

1. In `execute()`, after fetching `job` at `:114`, read `job.env_overrides`. Use `extractSecretRefs(job.env_overrides ?? {})` to determine whether override interpolation needs resolved secrets. Literal-only overrides can pass `resolvedSecrets: []`; overrides with secret refs must resolve project secrets before bash runs.
2. Refactor `prepareWorkspace` / `injectGitAuth` so an HTTPS repo clone and `env_overrides` interpolation can share one resolved secret set. Do not add a secrets API call for jobs with no `env_overrides` and no HTTPS git-auth need. If override secret refs exist and `resolveProjectSecrets(job.project_id)` returns `resolved: false`, fail before bash with an execution log that names the secrets-resolution failure; do not report it as `missing_secret_override`.
3. Pass the resolved secret set, `job.env_overrides`, and a `relayMissingSecrets` callback through the `context` object of `runScript`.
4. In `runScript`, after the existing toolchain merge at `:430-437`, call `applyEnvOverrides`:

   ```ts
   const overridesResult = await applyEnvOverrides({
     envOverrides: context.envOverrides,
     resolvedSecrets: context.resolvedSecrets,
     baseEnv: env,
     onMissingSecrets: context.relayMissingSecrets,
   });
   env = overridesResult.env;
   if (overridesResult.appliedKeys.length > 0) {
     await this.appendLog(attemptId, 'status', {
       message: `Applied env_overrides: ${overridesResult.appliedKeys.join(', ')}`,
       timestamp: new Date().toISOString(),
     });
   }
   ```

5. `relayMissingSecrets` wires `deliverProvisioningError(this.buildRelayDb(), { jobId, parentJobId, assignee: null, errorCode: 'missing_secret_override', message: ... })`. `assignee` is null because script jobs have no agent identity; the chat / coordination relay still works off `parentJobId` and `jobs.hints.thread_id` (see `packages/shared/src/invoke/eve-message-relay.ts:23-75`).
6. The executor needs `buildRelayDb` — copy the small private method from `apps/worker/src/invoke/invoke.service.ts:200-212` into the script-executor, or lift it into a shared helper that takes a `Db` and returns a `RelayDb`. Recommend lifting; the function is 10 lines and identical between the two services.
7. Let `MissingSecretOverrideError` escape `runScript` instead of being converted by the generic `runScript` catch block. In `execute()`, catch that error, write `appendLog(attemptId, 'error', { code: 'missing_secret_override', message: 'missing_secret_override: ...', missing: [...] })`, return `success: false` / `exitCode: 1`, and do not invoke bash.
8. Wrap workspace cleanup in `finally` once `runScript` can throw typed pre-bash errors; otherwise a missing-secret failure after clone can leave `/tmp/eve-script-workspaces/<attemptId>` behind.
9. Reserved keys: `applyEnvOverrides` strips them. Add a `warning`-type log line if `strippedKeys.length > 0` so authors learn about the strip (Zod should have rejected them earlier, but legacy DB rows may exist).

Service tests:

- script job with `env_overrides: { FOO: "bar" }` runs bash with `FOO=bar` in the env, success path.
- script job with `env_overrides: { FOO: "${secret.X}" }` and `X` in resolved secrets sees resolved value in bash env.
- script job with `env_overrides: { FOO: "${secret.MISSING}" }` and no matching secret fails before bash runs, writes `error` log with `code: 'missing_secret_override'` and `missing: ['MISSING']`, calls `deliverProvisioningError` once.
- script job with no `env_overrides` is unchanged (regression guard — no `appendLog('status', ...)` for overrides, no extra secrets API call beyond what the git-auth path already triggers).
- script job whose `env_overrides` keys collide with toolchain-exported `env.sh` vars: override wins (e.g. `env_overrides: { PYTHONPATH: "/custom" }` with `toolchains: [python]` → bash sees `PYTHONPATH=/custom`).
- script job with `env_overrides: { PATH: "/evil" }` runs successfully and bash does **not** see `PATH=/evil`; warning log line records the strip.
- script job retry preserves `env_overrides` (already true via `apps/api/src/workflows/workflows.service.ts:1313` retry copy; add regression test asserting the retry job's executor merges the same keys into bash env).

### Phase 4 — Pipeline action-run persistence

**File**: `apps/api/src/pipelines/pipeline-expander.service.ts`

Changes:

1. Extend the local `PipelineStep` / `PipelineDefinition` interfaces to include `env_overrides?: unknown`.
2. Import `EnvOverridesSchema`, `mergeEnvOverrides`, and the `EnvOverrides` type from `@eve/shared`, mirroring the workflow service's validation semantics.
3. Parse and merge pipeline-level + step-level `env_overrides` before `this.runs.createRun(...)`, building a `stepName -> EnvOverrides | null` map. Invalid env keys or unsupported expressions should fail before any run/job rows are created, matching workflow invocation behaviour.
4. For `step.action?.type === 'run'`, persist the precomputed `mergeEnvOverrides(pipelineEnvOverrides, stepEnvOverrides, undefined)` result on the job row. Pipeline run requests have no invocation-level `env_overrides`, so there is no third precedence layer.
5. For all other pipeline step kinds and non-run action types, continue persisting `env_overrides: null`. Non-run actions are platform operations, not user-shell execution; pipeline agent/script/run-shorthand persistence is explicitly out of scope.
6. If dry-run job responses are intended to reflect persisted job rows, add `env_overrides` to the local `JobResponse` shape and dry-run output for action-run steps. If not, explicitly leave dry-run unchanged and cover only the persisted run path.

Tests:

- pipeline with top-level `env_overrides` and `action: { type: run }` persists the override on the action job.
- step-level `env_overrides` override pipeline-level keys for action-run.
- `action: { type: build|deploy|release|notify|create-pr|env-ensure|env-delete|job }` persists `env_overrides: null`.
- invalid reserved keys or unsupported `${...}` expressions fail before partial job creation, matching workflow validation errors.

### Phase 5 — Action-executor injection (pipeline `action: { type: run }`)

**File**: `apps/worker/src/action-executor/action-executor.service.ts`

Changes:

1. In `handleRun`, after the existing job re-fetch at `:1057`, read `job.env_overrides`. Use `extractSecretRefs(job.env_overrides ?? {})` to avoid a secrets API call for literal-only overrides.
2. Refactor `prepareWorkspace` / `injectGitAuth` so action-run git auth and override interpolation can share one resolved secret set, matching Phase 3.
3. After the existing toolchain overlay merge at `:1117-1131`, call `applyEnvOverrides` the same way the script executor will (Phase 3.4).
4. Wire `relayMissingSecrets` via `deliverProvisioningError` and the same `buildRelayDb` helper as Phase 3. The action-executor already imports `mintJobToken`, `resolveProjectSecrets`, and `AccessBindingScope` from `@eve/shared`; this adds `applyEnvOverrides`, `extractSecretRefs`, and `deliverProvisioningError`.
5. Let `MissingSecretOverrideError` escape the `handleRun` generic catch instead of wrapping it as `Command failed with exit code 1: ...`; the outer `execute()` catch then writes the action `error` log with the real `error_class` and message.
6. Other action types (`build`, `release`, `deploy`, `notify`, `create-pr`, `env-ensure`, `env-delete`, `job`) are intentionally **not** updated. Those are platform operations that don't run user-supplied bash, so `env_overrides` has no meaning there.

Service tests: mirror Phase 3 tests for the `handleRun` shape. Skip toolchain shadowing if redundant with the script-executor tests; keep the missing-secret relay test to confirm the action path also surfaces the error to chat/coordination.

### Phase 6 — Tests

**Unit (shared)**

- `applyEnvOverrides` cases listed in Phase 1.

**Service spec**

- `apps/worker/src/script-executor/script-executor.service.spec.ts` (new or extended).
- `apps/worker/src/action-executor/action-executor.service.spec.ts` — `handleRun` cases.
- `apps/api/src/pipelines/pipeline-expander.env-overrides.spec.ts` or integration coverage — pipeline action-run persistence.
- `apps/agent-runtime/src/invoke/invoke.service.spec.ts` and/or `apps/worker/src/invoke/invoke.service.spec.ts` — regression that agent invoke paths still inject overrides after the refactor.

**Integration**

- Extend `apps/api/test/integration/pipelines-workflows.integration.test.ts`: invoke a workflow with a `script: { run: 'test "$TARGET_PATH" = "/expected/path"' }` step and `env_overrides: { TARGET_PATH: "/expected/path" }` at workflow level. Assert step exit code 0. Add a second step with `env_overrides: { TOKEN: "${secret.PROJECT_API_KEY}" }` and assert the step sees the resolved secret value (via a script that hashes the value and echoes the hash, then compares against a hash computed from the test's secret import).
- Add a negative case: `env_overrides: { TOKEN: "${secret.NOT_SET}" }` invokes successfully at the API layer (per `workflow-env-overrides-plan.md` semantics — sync validation just checks placeholder shape), then the script step attempt fails with `missing_secret_override` and the step job's logs contain the missing key name.
- Add a pipeline run case where top-level + step-level `env_overrides` merge onto an `action: { type: run }` job, and the action command sees the step-level value in its bash env.

**Manual scenario**

- Add `tests/manual/scenarios/NN-script-step-env-overrides.md` after the integration test is green. Mirror existing manual workflow scenarios; run on k3d.

### Phase 7 — Documentation

Behaviour is user-facing; update both internal docs and the public agent skillpack:

- `docs/system/workflows.md` — note that `script:` steps now honour `env_overrides` end-to-end; remove any "agent steps only" caveat.
- `docs/system/pipelines.md` — same for pipeline `action: { type: run }` steps.
- `docs/system/secrets.md` — clarify that `${secret.KEY}` resolution in `env_overrides` applies to agent, script, and action-run steps uniformly.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/pipelines-workflows.md` — `env_overrides` works on workflow agent/script steps and pipeline action-run steps.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/secrets-auth.md` — same secret interpolation rule and missing-secret failure.

Do not update public docs before behaviour ships.

## File Change Summary

| Phase | File | Change |
|-------|------|--------|
| 1 | `packages/shared/src/invoke/env-overrides.ts` | New: `applyEnvOverrides`, `MissingSecretOverrideError` |
| 1 | `packages/shared/src/invoke/index.ts` | Re-export new symbols |
| 1 | `packages/shared/src/invoke/__tests__/env-overrides.spec.ts` | Extend with `applyEnvOverrides` unit tests |
| 2 | `apps/agent-runtime/src/invoke/invoke.service.ts` | Refactor `:1178-1202` to call `applyEnvOverrides`; preserve `code = 'missing_secret_override'` |
| 2 | `apps/worker/src/invoke/invoke.service.ts` | Refactor `:1322-1346` to call `applyEnvOverrides`; preserve `code = 'missing_secret_override'` |
| 3 | `apps/worker/src/script-executor/script-executor.service.ts` | Resolve secrets only when needed, call `applyEnvOverrides` in `runScript`, relay missing via `deliverProvisioningError` |
| 3 | `apps/worker/src/script-executor/script-executor.service.spec.ts` | Cover env_overrides injection, missing-secret, reserved-key strip, toolchain shadowing, retry preservation |
| 4 | `apps/api/src/pipelines/pipeline-expander.service.ts` | Persist merged env_overrides on pipeline action-run jobs only |
| 4 | `apps/api/test/integration/pipeline-expander.integration.test.ts` or focused spec | Pipeline action-run persistence cases |
| 5 | `apps/worker/src/action-executor/action-executor.service.ts` | Same injection inside `handleRun` only |
| 5 | `apps/worker/src/action-executor/action-executor.service.spec.ts` | Action-run cases mirroring Phase 3 |
| 6 | `apps/api/test/integration/pipelines-workflows.integration.test.ts` | End-to-end workflow script and pipeline action-run env_overrides tests |
| 6 | `tests/manual/scenarios/NN-script-step-env-overrides.md` | Manual scenario file |
| 7 | `docs/system/workflows.md`, `docs/system/pipelines.md`, `docs/system/secrets.md` | Behaviour notes |
| 7 | `../eve-skillpacks/eve-work/eve-read-eve-docs/references/pipelines-workflows.md`, `references/secrets-auth.md` | Public agent docs |

Optional refactor (recommended but not required):

- Lift `buildRelayDb` from `apps/worker/src/invoke/invoke.service.ts:200-212` into `packages/shared/src/invoke/relay-db.ts` so script-executor and action-executor share the same implementation.

## Acceptance Criteria

The implementation is shippable when:

- A workflow with `env_overrides: { FOO: "bar" }` at workflow level and a `script: { run: 'test "$FOO" = "bar"' }` step exits 0.
- A workflow with `env_overrides: { TOKEN: "${secret.PROJECT_API_KEY}" }` and a `script:` step that hashes `$TOKEN` produces the expected hash (resolved secret value, not placeholder text).
- A workflow with `env_overrides: { TOKEN: "${secret.NOT_SET}" }` fails the script step with `missing_secret_override` before bash runs. The originating chat / coordination thread receives the `⚠️ missing_secret_override: …` message via `deliverProvisioningError`. The step's execution logs include an `error` entry with the missing key name. The bash process is not invoked.
- A workflow with `env_overrides: { PATH: "/evil" }` runs successfully; bash does not see `PATH=/evil`; the step's execution logs include a `warning` entry naming the stripped key. (Zod should already reject this at API time; the strip is defensive against legacy rows.)
- Per-invocation overrides applied via `eve workflow run --env-override KEY=value` flow through to the script step's bash env with correct precedence (invocation > step > workflow), matching the agent-step semantics shipped in `workflow-env-overrides-plan.md`.
- `eve workflow retry --failed` on a failed script step with `env_overrides` retries with the same overrides and the same injection behaviour.
- A pipeline `action: { type: run }` step with pipeline-level + step-level `env_overrides` persists the merged row with step > pipeline precedence and the action command sees the resolved value in bash.
- An existing workflow with no `env_overrides` declared on any step continues to run with no behaviour change, no extra log lines, and no extra `resolveProjectSecrets` calls beyond what the git-auth path already triggers.
- The agent invoke paths' error code, log shape, and chat relay behaviour are byte-equivalent to today after the Phase 2 refactor (no regression in agent-runtime or worker fallback).
- `eve job show <step-job-id> --json | jq '.env_overrides'` continues to return the un-interpolated row (no change to persistence shape).

## Test Plan Summary

| Tier | What | Coverage |
| --- | --- | --- |
| Unit (shared) | `applyEnvOverrides` | empty/null short-circuit, secret resolve, missing-secret throw + relay, reserved-key strip, interpolation order |
| Service spec | script-executor `runScript` | injection, missing relay, reserved strip, toolchain shadowing, retry |
| Service/integration | pipeline expander | action-run env_overrides persistence, step > pipeline precedence, non-run action null |
| Service spec | action-executor `handleRun` | mirror of script-executor cases for `action.type=run` |
| Service spec | agent-runtime + worker `invoke.service` | no-regression of refactored agent paths |
| Integration | end-to-end workflow script + pipeline action-run | env_overrides resolved into bash env; missing secret fails with relay |
| Manual | k3d walkthrough | one scenario in `tests/manual/scenarios/` |

## Rollout

Backwards-compatible. No DB migration (`jobs.env_overrides` already exists per `workflow-env-overrides-plan.md`).

Suggested PR split:

1. **Phase 1 + Phase 2.** `applyEnvOverrides` helper + agent path refactor. Pure refactor; no behaviour change. Shippable on its own and easy to revert.
2. **Phase 3.** Script-executor injection + relay + tests. Closes the headline gap.
3. **Phase 4 + Phase 5.** Pipeline action-run persistence + action-executor injection. Closes the pipeline `action.type=run` parity gap end-to-end.
4. **Phase 6 manual scenario + Phase 7 docs.**

Verify after PR 2 on local k3d:

```bash
./bin/eh k8s start && ./bin/eh k8s deploy
./bin/eh status
eve workflow run env-overrides-smoke --env-override SMOKE=hello
eve job follow <step-job-id>   # should print "got: hello"
```

## Backwards Compatibility

Additive end-to-end:

- Existing workflows without `env_overrides` see no change. No new override log lines, and no new secrets API calls beyond existing git-auth needs.
- Existing scripts that already work around the gap with `eve job show | jq` keep working — the un-interpolated row is unchanged. They can migrate at their own cadence.
- Existing agent steps are byte-equivalent in error shape and chat relay after the Phase 2 refactor.
- Pipeline `action: { type: run }` steps that don't declare `env_overrides` keep their existing env.

## Open Questions

- Should `applyEnvOverrides` log applied/stripped keys at `info` level inside `@eve/shared`, or leave logging to the caller? Recommend caller-side logging (script-executor / action-executor / agent invoke) so the helper stays pure and testable without log-spy gymnastics.
- Should the `missing_secret_override` relay message include the workflow / step name for clearer chat output? The agent paths today only carry `errorCode` + `message`; adding workflow / step context here would help, but it's an extension to `deliverProvisioningError`'s shape and out of scope for this plan.
- Should the helper return resolved values in a `Map<string, string>` instead of writing them into a fresh env object, leaving the merge to the caller? Cleaner separation, but every caller wants the merged env at the end, so the convenience wins. Keep as-sketched.
- Pipeline `agent:`, `script:`, and `run:` shorthand `env_overrides` are still silently dropped because the pipeline expander writes `env_overrides: null` for those jobs (`apps/api/src/pipelines/pipeline-expander.service.ts:545`). Out of scope here; file a small follow-up to persist merged pipeline/step overrides for pipeline agent/script jobs now that the executors will be ready.

## References

| File | Why |
| --- | --- |
| `apps/api/src/workflows/workflows.service.ts` | `mergeStepEnvOverrides` (`:140-153`), per-step merge (`:997-1001`), job persistence (`:1092`) — workflow persistence side, already shipped |
| `apps/agent-runtime/src/invoke/invoke.service.ts` | Primary agent path injection — `:1178-1202` (the model) |
| `apps/worker/src/invoke/invoke.service.ts` | Worker fallback agent path injection — `:1322-1346` (same model) |
| `apps/worker/src/script-executor/script-executor.service.ts` | Script path `runScript` — `:378-445` (gap site) |
| `apps/api/src/pipelines/pipeline-expander.service.ts` | Pipeline jobs currently persist `env_overrides: null` — `:545` |
| `apps/worker/src/action-executor/action-executor.service.ts` | `handleRun` — `:1109-1137` (parallel executor gap) |
| `packages/shared/src/invoke/workspace-secrets.ts` | `interpolateEnvOverrides` — `:206` |
| `packages/shared/src/schemas/job.ts` | `isReservedEnvKey` — `:63` |
| `packages/shared/src/invoke/eve-message-relay.ts` | `deliverProvisioningError` — `:23-75` |
| `docs/plans/workflow-env-overrides-plan.md` | Merge precedence + persistence (already shipped) |
| `docs/plans/workflow-script-step-materialization-plan.md` | Workflow `script:` steps materialize as script jobs (already shipped) |
| `docs/plans/script-action-step-toolchains-plan.md` | The other half of script-step ↔ agent-step parity |

## Impact If Filled

- Removes the silent trap where workflow authors set `env_overrides` on a script step and watch the bash process not see it.
- Workflow `script:` steps reach declarative parity with `agent:` steps for parameterized work: scoped credentials (shipped), declarative toolchains (shipped), and now declarative env. The agent harness is no longer the only step kind that can read per-invocation secrets and parameters from `env_overrides`.
- Removes 6-10 lines of `eve job show | jq` boilerplate from every parameterized script step in downstream apps, and removes the forced-`jobs:read` permission widening that the workaround required.
- Aligns the script-executor and action-executor `handleRun` with the agent invoke paths' `missing_secret_override` semantics, so workflow and pipeline shell steps surface bad secret references uniformly instead of spending runtime on known-bad env.
