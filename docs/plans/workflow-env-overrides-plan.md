# Workflow `env_overrides` Propagation Plan

> **Status**: Implemented and verified on local k3d 2026-05-07
> **Scope**: Platform (eve-horizon)
> **Source**: Downstream-app gap report, reviewed against current Eve Horizon source
> **Tracking**: `eve-horizon-popy`
> **Related**: `docs/plans/workflow-step-optimization-plan.md` (parallel workflow plumbing fix for `resource_refs` and step result propagation), `docs/plans/per-job-harness-override-plan.md`

## Problem

Job-level `env_overrides` works end-to-end today: `eve job create --env-override KEY=${secret.NAME}` is accepted by `CreateJobRequestSchema`, persisted on `jobs.env_overrides`, resolved by `interpolateEnvOverrides()`, and merged into the harness process env by both worker invoke paths.

The workflow invoke path is inconsistent:

1. `WorkflowInvokeRequestSchema` only accepts `input` (`packages/shared/src/schemas/workflow.ts`).
2. Manifest workflow definitions are validated via `PipelineDefinitionSchema` and `PipelineStepSchema` (`packages/shared/src/schemas/pipeline.ts`), neither of which declares `env_overrides`.
3. `WorkflowsService.invoke()` hardcodes `env_overrides: null` on both the root/container job and every child step job (`apps/api/src/workflows/workflows.service.ts`).
4. The public workflow controller imports `WorkflowInvokeRequestSchema` but currently does not run `ZodValidationPipe` on the body, so adding a schema field alone will not validate public workflow invoke requests (`apps/api/src/workflows/workflows.controller.ts`).

Net effect: a workflow step's harness only receives the normal platform-allowed env and resolved project secret env. Non-harness override vars such as `WEB_SEARCH_API_KEY=${secret.WEB_SEARCH_API_KEY}` cannot be supplied through `eve workflow run` or workflow YAML. Tools that expect those vars fail with auth errors.

The chat and direct-job paths already establish the right precedent:

- Direct jobs gate `env_overrides` behind `jobs:harness_override` and, when `${secret.KEY}` placeholders are present, `secrets:read`.
- Chat hint dispatch uses the same permission model and rejects override hints when no Eve principal can be resolved.
- Workflow retry already preserves `source.env_overrides`, so once initial workflow step jobs carry env overrides, retries should preserve them without new retry-specific plumbing.

### Workarounds callers fall back to today

Callers build the DAG by hand with `eve job create --env-override KEY=${secret.K}` and `eve job dep add`.

Costs:

- `eve workflow retry --failed` ergonomics are lost.
- `eve job tree` still shows children, but without a single manifest workflow invocation as the source of truth.
- The workflow definition stops carrying the DAG shape.
- Caller-side orchestration grows by tens to hundreds of lines for workflows that should be declarative.

The other workaround is to put the third-party call behind a small Eve app service and give that service `${secret.*}` environment. That works, but adds a deployable service for a function that only needs a secret-backed env var in a workflow step.

## Goal

Plumb the existing `env_overrides` mechanism through workflow invocation so overrides can come from three places:

- Workflow YAML at workflow level.
- Workflow YAML at step level.
- Workflow invocation request or CLI flags.

Merge precedence should be:

1. Invocation request overrides.
2. Step-level workflow YAML overrides.
3. Workflow-level YAML defaults.

This is merge-by-env-key, not the same shape as `with_apis`: `with_apis` is currently step-overrides-workflow, while `env_overrides` should merge because individual keys compose naturally.

The resulting behavior is simple: each created workflow step job gets the merged `env_overrides` persisted on its job row. Existing worker/agent-runtime code then resolves `${secret.KEY}` placeholders and injects the resolved values. No new resolver, secret-store API, or database migration is needed.

## Non-Goals

- New permissions. Reuse the existing `jobs:harness_override` and `secrets:read` checks used by direct jobs, chat, and harness validation.
- A new secret resolution API. `interpolateEnvOverrides()` and `resolveForProject()` stay the runtime resolution path.
- A `secrets:read-plaintext` job-token capability. Secret values remain resolved only inside provisioning/invoke code and must not be exposed through API responses or logs.
- Templating env values from workflow inputs, such as `${inputs.brand}` in env values. The only supported interpolation remains `${secret.KEY}`.
- Surfacing raw `env_overrides` in `eve job tree` or other read paths. Readers may later render redacted metadata, but this is not required to close the runtime gap.
- `eve workflow run --dry-run`. File separately if useful.

## Implementation Plan

### Phase 1 - Shared schemas and manifest validation

**Files**

- `packages/shared/src/schemas/job.ts`
- `packages/shared/src/schemas/workflow.ts`
- `packages/shared/src/schemas/pipeline.ts`
- `packages/shared/src/schemas/manifest.ts`
- `packages/shared/src/schemas/__tests__/`

Changes:

1. Export and reuse `EnvOverridesSchema` / `EnvOverrides` as the canonical type. Do not duplicate validation.
2. Extend `WorkflowInvokeRequestSchema`:

   ```ts
   import { EnvOverridesSchema } from './job.js';

   export const WorkflowInvokeRequestSchema = z.object({
     input: z.record(z.unknown()).optional(),
     env_overrides: EnvOverridesSchema.optional(),
   }).optional();
   ```

3. Add `env_overrides: EnvOverridesSchema.optional()` to `PipelineDefinitionSchema` so workflow-level YAML is validated and preserved in `validated.data`.
4. Add `env_overrides: EnvOverridesSchema.optional()` to `PipelineStepSchema` so step-level YAML is validated and preserved. This matters because `PipelineStepSchema` currently strips unknown step keys during `ManifestSchema.safeParse()`.
5. Add `getManifestEnvOverrideSecretRefs(manifest)` or extend `getManifestRequiredSecrets()` so `${secret.KEY}` references inside workflow env overrides are available to `eve manifest validate --validate-secrets` and `eve project sync --validate-secrets`.
6. Add schema tests for:
   - workflow invoke request accepts valid `env_overrides`;
   - manifest workflow-level and step-level `env_overrides` survive parsing;
   - invalid keys, reserved keys, payloads over 4 KB, and `${env.X}` are rejected from workflow invoke and manifest paths.

### Phase 2 - API controller validation and permission gating

**Files**

- `apps/api/src/workflows/workflows.controller.ts`
- `apps/api/src/workflows/workflows.internal.controller.ts`
- `apps/api/src/workflows/workflows.service.ts`
- Possibly a shared permission helper near the existing job/chat/harness logic.

Changes:

1. Add `@Body(new ZodValidationPipe(WorkflowInvokeRequestSchema))` to the public workflow invoke controller. The schema import is already present; it needs to be enforced.
2. Gate request-supplied `env_overrides` using the same policy as direct job creation:
   - always require `jobs:harness_override`;
   - additionally require `secrets:read` if any value references `${secret.KEY}`.
3. Keep manifest-declared `env_overrides` validated at manifest sync/validate time, but do not require a new workflow-specific permission.
4. Decide and document internal invocation behavior:
   - event-router internal invokes currently send only `{ input }`;
   - internal requests should not introduce request-supplied `env_overrides` unless an authenticated user/principal is explicitly threaded through;
   - manifest-declared workflow/step `env_overrides` should still apply to internal event-triggered workflows.
5. Add controller tests that prove invalid request bodies are rejected and privileged request overrides require the same permissions as direct jobs.

### Phase 3 - Workflow service merge and persistence

**File**: `apps/api/src/workflows/workflows.service.ts`

Add helpers near the existing workflow extraction helpers:

```ts
private parseEnvOverrides(
  value: unknown,
  path: string,
): EnvOverrides | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = EnvOverridesSchema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException(`Invalid ${path}: ${parsed.error.message}`);
  }
  return parsed.data;
}

private mergeEnvOverrides(
  workflowEnv: EnvOverrides | undefined,
  stepEnv: EnvOverrides | undefined,
  invocationEnv: EnvOverrides | undefined,
): EnvOverrides | null {
  const merged = {
    ...(workflowEnv ?? {}),
    ...(stepEnv ?? {}),
    ...(invocationEnv ?? {}),
  };
  if (Object.keys(merged).length === 0) return null;
  return EnvOverridesSchema.parse(merged);
}
```

Use the helpers once per invoke:

- parse workflow-level `workflow.definition.env_overrides`;
- parse each step's `step.env_overrides`;
- merge with `request?.env_overrides`;
- persist the merged result on each step job.

Replace the hardcoded nulls:

| Site | Current | Change |
| --- | --- | --- |
| Root job creation | `env_overrides: null` | Persist workflow plus invocation env, or leave `null` if we choose root jobs to remain metadata-only |
| Step job creation | `env_overrides: null` | `env_overrides: mergedStepEnvOverrides` |

Recommendation: persist env overrides on the root job as redacted placeholders only if it is useful for audit and retry context. It will not be resolved because the root job is not a harness invocation. The shippable runtime behavior depends on the child step jobs.

Keep the existing retry behavior:

- `workflow retry` already copies `source.env_overrides`;
- add a regression test so future refactors do not break it.

### Phase 4 - CLI env override parsing for workflows

**Files**

- `packages/cli/src/lib/env-overrides.ts` (new)
- `packages/cli/src/commands/job.ts`
- `packages/cli/src/commands/harness.ts`
- `packages/cli/src/commands/workflow.ts`
- `packages/cli/src/lib/help.ts`

Changes:

1. Extract the duplicate `--env-override KEY=VALUE` parser from `job.ts` and `harness.ts` into `packages/cli/src/lib/env-overrides.ts`.
2. Reuse it in all three call sites:
   - `eve job create`;
   - `eve harness validate`;
   - `eve workflow run`;
   - `eve workflow invoke`.
3. Include parsed env overrides in the workflow invoke body for both `run` and `invoke`:

   ```ts
   const envOverrides = parseEnvOverrideFlags(flags);
   if (envOverrides) {
     body.env_overrides = envOverrides;
   }
   ```

4. Update workflow command usage/help examples to show `--env-override`.
5. Add CLI tests for repeatable `--env-override`, underscore alias `--env_override`, last-write-wins duplicate keys, and both workflow subcommands.

### Phase 5 - Manifest secret validation

**Files**

- `packages/shared/src/schemas/manifest.ts`
- `apps/api/src/projects/projects.service.ts`
- `apps/api/src/secrets/secrets.service.ts`
- `packages/shared/src/schemas/__tests__/manifest-build-helpers.spec.ts`

Changes:

1. Include secret refs from workflow-level and step-level `env_overrides` in manifest required-secret collection.
2. `eve manifest validate --validate-secrets` and `eve project sync --validate-secrets` should warn on missing referenced secrets.
3. `--strict` should fail when referenced env override secrets are missing, matching existing required-secret behavior.
4. Invalid env override syntax should be a schema error even without `--validate-secrets`.

This phase belongs in shared/API validation, not in `packages/cli/src/commands/project.ts`; the CLI already forwards manifest validation to the API.

### Phase 6 - Workflow-aware harness validation

**Files**

- `packages/shared/src/schemas/harnesses.ts`
- `apps/api/src/harnesses/harnesses.controller.ts`
- `apps/api/src/harnesses/harnesses.service.ts`
- `packages/cli/src/commands/harness.ts`

Preferred shape:

- Add a workflow validation request/response that returns one report per workflow step.
- Use the same merge helper semantics as workflow invocation so the preflight validates what will actually run.
- Include workflow-level, step-level, and optional invocation-level env overrides.

Minimal viable alternative:

- Have the CLI fetch `eve workflow show`, merge env overrides client-side with the shared parser, and call the existing harness validation endpoint once per step.
- This is acceptable only if the merge code is shared or covered by tests; otherwise the preflight can drift from server behavior.

CLI target:

```bash
eve harness validate --project <proj_xxx> --workflow <name>
eve harness validate --project <proj_xxx> --workflow <name> --env-override KEY=${secret.KEY}
```

The output should group `SecretRefReport` results by step and should not create jobs.

### Phase 7 - Documentation

Behavior is user-facing once implemented. Update both internal docs and the public agent docs skillpack:

- `docs/system/manifest.md` - workflow-level and step-level `env_overrides` grammar.
- `docs/system/job-cli.md` - `eve workflow run|invoke --env-override`.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/manifest.md`.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/pipelines-workflows.md`.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/cli-pipelines.md`.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/harnesses.md` if workflow validation lands there.

Do not update public docs before behavior ships.

## Acceptance Criteria

The implementation is shippable when:

- `eve workflow run <name> --env-override WEB_SEARCH_API_KEY='${secret.WEB_SEARCH_API_KEY}'` creates step jobs whose persisted `env_overrides` include the request override.
- `eve workflow invoke <name> --env-override KEY='${secret.KEY}'` behaves the same as `run`, including wait/no-wait behavior.
- Workflow-level `env_overrides` declared in YAML reach every step job.
- Step-level `env_overrides` declared in YAML reach only that step and override workflow-level keys.
- Invocation `env_overrides` win over both YAML layers for shared keys.
- The final merged env override object is validated against `EnvOverridesSchema`, including the 4 KB cap.
- A workflow with an env override referencing a missing secret fails fast at runtime with `missing_secret_override` and names the missing key.
- `eve manifest validate` rejects unsupported env override expressions such as `${env.X}`.
- `eve manifest validate --validate-secrets` reports missing `${secret.KEY}` refs from workflow env overrides.
- `eve harness validate --workflow <name> --project <id>` reports per-step resolved/missing secret refs without creating jobs.
- `eve workflow retry --failed` on a workflow that uses env overrides reproduces the env overrides on retry attempts.
- Existing workflows without `env_overrides` still produce step jobs with `env_overrides: null`.
- Request-supplied workflow env overrides require `jobs:harness_override` and, for `${secret.KEY}` placeholders, `secrets:read`.
- Event-triggered workflows continue to work through the internal invoke path and apply manifest-declared env overrides.

## Test Plan

### Unit

- `WorkflowInvokeRequestSchema` accepts and rejects env overrides exactly like `CreateJobRequestSchema`.
- `PipelineDefinitionSchema` and `PipelineStepSchema` preserve valid env overrides and reject invalid ones.
- Manifest required-secret collection includes workflow and step env override secret refs.
- `mergeEnvOverrides` covers workflow-only, step-only, invocation-only, all-three, duplicate keys, empty merge, and final merged size over 4 KB.
- Shared CLI parser covers repeatable flags, underscore alias, malformed entries, invalid keys, and duplicate-key behavior.

### API/service

- Public workflow invoke body is validated by `ZodValidationPipe`.
- Public workflow invoke permission checks match direct job creation.
- Workflow invoke persists merged env overrides on step jobs.
- Workflow invoke still writes `null` for workflows without overrides.
- Workflow retry copies env overrides from source step jobs.
- Internal event-router workflow invocation still works when only manifest-declared env overrides are present.

### Worker/runtime

- Worker and agent-runtime tests should cover an invocation with persisted env overrides and prove resolved vars reach the harness env.
- Missing secret refs should still throw `missing_secret_override` and deliver the existing provisioning error.
- Logs and structured events must not include resolved secret values.

### CLI/integration

- `eve workflow run` and `eve workflow invoke` send `env_overrides` in the request body.
- `eve manifest validate --validate-secrets` warns on missing workflow env override secrets.
- `eve harness validate --workflow` reports per-step secret ref status.
- A local k3d/manual smoke can run a small workflow step that prints only the presence of an env var, not the value.

### 2026-05-07 verification

- Focused shared/API/CLI tests passed for workflow env override parsing, permission checks, merge/persist behavior, and CLI flag handling.
- Full `pnpm build`, `pnpm test`, and `./bin/eh test integration` gates passed.
- Local k3d was rebuilt/redeployed and smoke-tested by syncing a temporary workflow manifest, invoking it with `eve workflow run --env-override`, and confirming child step jobs persisted the expected workflow < step < invocation merge.
- `eve harness validate --workflow` returned OK for the synced workflow, and final k3d health checks reported HTTP 200, database connected, and all pods running.

## Backwards Compatibility

This is additive:

- `env_overrides` is optional everywhere.
- Workflows without env overrides keep the same persisted job shape.
- Direct job `env_overrides` behavior is unchanged.
- Runtime secret interpolation remains inside worker/agent-runtime provisioning.
- No database migration is required because `jobs.env_overrides` already exists.

The main compatibility risk is permission behavior. Direct request-supplied workflow overrides must be privileged like direct jobs. Manifest-declared overrides should be validated at sync time and resolved at run time without adding a new workflow-specific permission.

## Estimated Size

Suggested PR split:

1. Schema, manifest validation, API controller permission gates, workflow service merge/persist, and service tests.
2. CLI parser extraction plus `workflow run|invoke --env-override` support and CLI help/tests.
3. Workflow-aware harness validation and docs.

Expected size is closer to a medium change than the original estimate because the controller, manifest schema, permission gates, and harness validation surfaces all need to be kept in sync.

## Impact If Filled

- Removes caller-side hand-built workflow DAGs just to pass third-party API keys.
- Lets workflow YAML remain the source of truth for workflows that need secret-backed environment variables.
- Makes workflow retry useful for rate limits or transient third-party failures.
- Avoids creating extra service-shaped wrappers around third-party APIs when a workflow step only needs env-based auth.
- Aligns workflow behavior with direct jobs and chat-dispatched jobs.

## References

| File | Why |
| --- | --- |
| `packages/shared/src/schemas/job.ts` | `EnvOverridesSchema`, `CreateJobRequestSchema`, `jobs.env_overrides` response shape |
| `packages/shared/src/schemas/workflow.ts` | `WorkflowInvokeRequestSchema` |
| `packages/shared/src/schemas/pipeline.ts` | Manifest pipeline/workflow definition and step schemas |
| `packages/shared/src/schemas/manifest.ts` | `ManifestSchema`, `getManifestRequiredSecrets()`, `analyzeManifestCoherence()` |
| `apps/api/src/workflows/workflows.controller.ts` | Public workflow invoke route and missing body validation pipe |
| `apps/api/src/workflows/workflows.internal.controller.ts` | Internal event-router workflow invoke route |
| `apps/api/src/workflows/workflows.service.ts` | Root/step job creation and retry preservation |
| `apps/api/src/jobs/jobs.controller.ts` | Existing direct-job permission gate for env overrides |
| `apps/api/src/chat/chat.service.ts` | Existing chat hint permission gate and env override persistence precedent |
| `apps/api/src/harnesses/harnesses.controller.ts` | Existing harness validation permission gate |
| `apps/api/src/harnesses/harnesses.service.ts` | Existing secret-ref report generation |
| `packages/shared/src/invoke/workspace-secrets.ts` | `interpolateEnvOverrides()` |
| `apps/worker/src/invoke/invoke.service.ts` | Worker env override interpolation and harness env injection |
| `apps/agent-runtime/src/invoke/invoke.service.ts` | Agent-runtime env override interpolation and harness env injection |
| `packages/cli/src/commands/job.ts` | Existing CLI env override parser to extract |
| `packages/cli/src/commands/harness.ts` | Duplicate CLI env override parser to replace |
| `packages/cli/src/commands/workflow.ts` | Add workflow env override flag handling |
| `packages/cli/src/lib/args.ts` | Repeatable `env-override` / `env_override` flag support already exists |
| `apps/orchestrator/src/events/event-router.service.ts` | Internal event-triggered workflow invocation sends `{ input }` |

## Open Questions

- Should root/container workflow jobs persist merged env override placeholders for audit, or should env overrides live only on executable step jobs?
- Should manifest-declared env overrides require `jobs:harness_override` at manifest sync time, or is `projects:write` sufficient for project maintainers? The direct request path must still require `jobs:harness_override`.
- Should `eve harness validate --workflow` be a first-class API endpoint or a CLI composition over `workflow show` plus existing harness validation?
- Should the final docs expose workflow-level env overrides, or should the user-facing grammar start with step-level only to keep secret scope more explicit?
