# Deploy Error Surfacing Plan

> **Status**: Draft
> **Last Updated**: 2026-04-21
> **Origin**: Pierre's Limelee staging deploy failed repeatedly on 2026-04-21 with `HTTP request failed` and no further context. The real first cause was a Flyway migration crash loop in the app, but the platform's deploy pipeline leaked a raw `@kubernetes/client-node` placeholder error, silently left the env in a split state (manifest applied in-cluster, DB release pointer not advanced), and gave the project owner no CLI path from symptom to cause. Pressing further surfaced a second platform failure: the nginx admission webhook was rejecting staging's ingress because `bindToEnvironment` in the custom-domain path unconditionally clobbers across envs, so staging and production were both trying to own the same host in their own namespaces. Fixing that via an env override in the manifest (Limelee commit `6dceee6`) then surfaced a third gap: pipeline runs freeze `manifest_hash` at create-time from `findLatestByProject`, so env overrides pushed with the same commit were silently ignored for that deploy.
> **Verification source**: Staging cluster `example-cluster`, pipeline runs `prun_01kpr8613yferr8754ynh7fr48`, `prun_01kpr7rvejferr874rcgp7xfac`, `prun_01kpra941hferr875y7bhzyr74` (env override silently dropped), and `prun_01kprae3s7ferr8774fbb21ndn` (after `eve project sync` forced the new manifest as latest — succeeded). Attempts `64565949-9a74-47dd-b36d-28a79fee00fe` and `13480820-2454-45e5-b6b8-5e0c7f707026`.

## Problem Statement

When a deploy step in `eve-worker` fails, the project owner sees:

```
Step: deploy (deploy)
Status: failed
Error: HTTP request failed
```

…which is the default `.message` of `@kubernetes/client-node` errors. It carries no `statusCode`, no response body, no resource kind/name, no stack trace. Grepping `kubectl logs deploy/eve-worker` for `HTTP request failed` returns **zero hits over 7 days** — the error is not logged to stdout at all, only persisted as the attempt's `error_message` field.

At the same time, five adjacent failure modes are still invisible, under-rendered, or broken:

1. **Silent partial deploy drift.** `DeployerService.deploy()` applies a manifest (cluster generation bumps), then fails in a later step (e.g. `waitForServiceDependencies`, `getDeploymentStatus`, or a trailing `listNamespacedIngress`). `environment.current_release_id` remains the previous successful release and `last_failed_release_id`/`deploy_status` are not consistently updated on worker-driven pipeline failures, so `eve env show` can report an old release while the cluster is running the new, unhealthy one. Operators cannot tell from the CLI that the two are out of sync.
2. **App-level boot failures look like platform failures.** A crash-looping pod from a bad Flyway migration, a missing env var, or a config error presents to the project owner as a generic "HTTP request failed" or readiness timeout with no focused failure kind, previous-container excerpt, or next-step hint.
3. **Self-service log tailing exists but is not connected to the failure.** `eve env logs <project> <env> <service> --previous` and `eve env diagnose` already exist through the API, but deploy and pipeline failure output does not point users to the right service/pod/container, and `diagnose` does not fetch the previous-container excerpt inline.
4. **Custom-domain bindings are global, not env-scoped.** `bindToEnvironment` in `packages/db/src/queries/custom-domains.ts` does an unconditional `UPDATE` of `environment_id` whenever any env deploys with that hostname in its manifest. Every deploy of any env silently steals the hostname from whichever env last owned it. The rendered K8s Ingress then lands in the deploying env's namespace, and nginx admission rejects the request because another namespace already defines the same `host + path`. The only signal today is the generic `HTTP request failed` from Phase 1. Pierre's production still served traffic via its old ingress; staging could never deploy until the manifest was scoped per-env.
5. **Manifest resolution for pipeline runs ignores the ref's actual manifest.** `PipelineRunsService.getPipeline` and the job-based `PipelineExpanderService.expandPipeline` both resolve a pipeline's `manifest_hash` via `manifests.findLatestByProject(projectId)` at run-create time. Workspace auto-sync (`action-executor.autoSyncManifestFromWorkspace`) inserts a new manifest row mid-run, but by then the pipeline run already carries the old hash, so every step (including `deploy`) sees the old manifest. A project owner who pushes a manifest fix and immediately runs `eve env deploy --ref <new-sha>` deploys the new image with the **old** manifest. Users currently have to remember `eve project sync --ref <new-sha>` as an undocumented prerequisite.

The Limelee incident is a case of all five firing at once: the app had a real bug (`ON CONFLICT (id)` targeting the wrong unique constraint), the platform showed the operator nothing they could act on, its own reported state diverged from reality, a second platform bug (cross-env clobbering) kept the deploy from succeeding even after the app was fixed, and a third platform bug (stale `manifest_hash`) made the manifest workaround silently invisible until the user ran a separate `project sync`.

## Goals

- Every K8s API error surfaces `statusCode`, `reason`, `body.message`, and the operation + resource that triggered it.
- Every deploy failure writes a structured stack trace to both the attempt log and worker stdout — no silent swallowing.
- `eve env show` / `eve env diagnose` tell the full story when a deploy is unhealthy: pod phase, container state, last exit code, last events, and a capped/redacted previous-container excerpt for the failing service.
- The existing `eve env logs <project> <env> <service> [--previous]` route is improved and linked from deploy failures, with normal `envs:read` project-scoped auth and zero `kubectl` required.
- When `applyManifest` succeeds but a later step fails, the DB records both the last known-good release and the last applied failed release — never leaves silent drift.
- A `DeployFailure` taxonomy (`k8s_api_error`, `image_pull_error`, `app_crash_loop`, `readiness_timeout`, `dependency_timeout`, `manifest_invalid`, `ingress_conflict`) is thrown/persisted by the deployer and rendered inline by the CLI with an actionable next-step hint.
- **Custom domains are owned by exactly one environment at a time.** The first env to claim a hostname keeps it; subsequent deploys of other envs are skipped (with a logged warning pointing at the owning env) rather than silently clobbering. A user's unscoped `x-eve.ingress.domains` works for the env that deployed it first and does not break other envs.
- **A pipeline run's `manifest_hash` reflects the ref being deployed.** Pushing a manifest fix and running `eve env deploy --ref <sha>` picks up the new manifest without any extra sync step. If the ref's manifest cannot be resolved, the deploy fails fast with a clear message — never silently uses a stale hash.

## Non-Goals

- Building a full log aggregation / search backend (keep tailing the K8s API directly).
- Deploying a sidecar or agent into customer namespaces.
- Changing the build or release model — this plan is strictly about the deploy step and post-deploy visibility.
- Re-designing `eve job diagnose` — we extend the existing output blocks, not replace them.
- Replacing `@kubernetes/client-node` (its error shape is the root cause but the fix is a thin wrapper, not a SDK swap).

---

## Current Code Pointers

| Concern | File | Lines |
| --- | --- | --- |
| Deploy action entrypoint | `apps/worker/src/action-executor/action-executor.service.ts` | `handleDeploy` ~677; catch-all ~244–250 |
| Legacy pipeline deploy entrypoint | `apps/worker/src/pipeline-runner/pipeline-runner.service.ts` | `handleDeploy` ~274; catch-all ~178–193 |
| Raw K8s error leak | `apps/worker/src/deployer/k8s.service.ts` | `applyObject` 455–475; `applyManifest` 78–97; `getDeploymentStatus` 99–167; `listAliasIngresses` 183–202; `listCustomDomainIngresses` 204–223 |
| Deploy orchestration | `apps/worker/src/deployer/deployer.service.ts` | `deploy()` try/catch 365–424; `waitForServiceDependencies` 2227+ |
| Custom domain binding in deployer | `apps/worker/src/deployer/deployer.service.ts` | `for (const candidate of renderResult.customDomainIngresses)` 305–358; `garbageCollectCustomDomainIngresses` 1193+ |
| Custom domain binding in DB | `packages/db/src/queries/custom-domains.ts` | `claimOrUpdate` 77–91; `bindToEnvironment` 97–116 (unconditional clobber); `release` 154–161 |
| Custom domain HTTP/CLI surface | `apps/api/src/custom-domains/custom-domains.controller.ts`; `apps/api/src/custom-domains/custom-domains.service.ts`; `packages/cli/src/commands/domain.ts` | existing `eve domain list/status/verify/remove`; no transfer/unbind and no env-name owner display today |
| Manifest resolution for pipeline runs | `apps/api/src/pipelines/pipeline-runs.service.ts`; `apps/api/src/pipelines/pipeline-expander.service.ts` | both `PipelineRunsService.getPipeline` and `PipelineExpanderService.expandPipeline` use `manifests.findLatestByProject`; the job-based expander creates the authoritative `pipeline_runs.manifest_hash` |
| Manifest auto-sync (too late) | `apps/worker/src/action-executor/action-executor.service.ts` | `autoSyncManifestFromWorkspace` ~1762–1820 (records new hash, does not retro-apply to in-flight run) |
| Manifest queries | `packages/db/src/queries/manifests.ts` | `findLatestByProject`, `findByProjectAndHash` |
| CLI env deploy (where ref is resolved) | `packages/cli/src/commands/env.ts` | `deploy` subcommand resolves the git ref and currently sends a `manifest_hash`; direct deploy consumes it, pipeline deploy ignores it and uses latest server-side manifest |
| CLI project sync | `packages/cli/src/commands/project.ts` | `sync` — currently the user-facing way to fix stale `findLatestByProject` |
| Direct API deploy finalization | `apps/api/src/environments/environments.service.ts` | `finalizeReleasePointer` ~920; direct deploy ~636–681 |
| Existing env diagnostics API | `apps/api/src/environments/env-diagnostics.service.ts` | `diagnose` already returns deployments, pods, events; lacks failure taxonomy/log excerpts |
| Existing env logs API | `apps/api/src/environments/env-logs.service.ts` | `getServiceLogs`; route is `/projects/:id/envs/:name/services/:service/logs`; permission is `envs:read` |
| Env schemas | `packages/shared/src/schemas/environment.ts` | `EnvDiagnoseResponseSchema`, `EnvPodInfoSchema`, `EnvLogsResponseSchema` |
| Environment DB state | `packages/db/src/queries/environments.ts`; `packages/db/migrations/00080_add_env_deploy_status.sql`; `00063_add_last_failed_release_id.sql` | existing `deploy_status`, `last_failed_release_id`, `current_release_id` |
| CLI env commands | `packages/cli/src/commands/env.ts` | `show`, `diagnose`, existing `logs --previous --pod --container --all-pods` |
| CLI pipeline logs | `packages/cli/src/commands/pipeline.ts` | `handleLogs` (truncates deploy step errors today) |
| Attempt log writer | `apps/worker/src/action-executor/action-executor.service.ts` | `appendLog` |

### Review Corrections

- Do **not** add a second `eve env logs` command or a new `/projects/:id/envs/:name/logs` endpoint. Extend the existing route: `GET /projects/:id/envs/:name/services/:service/logs`.
- Do **not** use `projects:read` for logs. The existing controller gates logs and diagnostics with `envs:read`; keep that permission unless the access model changes deliberately.
- Do **not** redefine `current_release_id` casually. Today it is used as the "current/rollback base" release in API reset/rollback and job environment resolution. If implementation chooses to make it mean "last applied release", add a previous-known-good pointer first. The safer default in this plan is to preserve `current_release_id` as last successful/ready and add explicit failed-applied state.
- Worker uses `@kubernetes/client-node@0.22.3` while API uses `1.4.0`; error wrapping must handle both response shapes (`err.body`, `err.response.body`, `err.statusCode`, `err.response.statusCode`).
- The authoritative pipeline path is job-based. Updating only the legacy `pipeline-runs.service.ts` step-run code will not fix env deploys; Phase 6 must update `PipelineExpanderService.expandPipeline` and any dry-run/list/detail assumptions around job-based runs too.
- `eve domain` is **not** a new command namespace. It already exists with `list`, `status`, `verify`, and `remove`; Phase 5 should extend that namespace with `transfer` and `unbind`, and improve `list/status` to show the owning environment name, not only `environment_id`.
- `customDomains.claimOrUpdate` currently updates `service_name` before `bindToEnvironment` runs. Under first-bind-wins, that would still let a skipped staging deploy mutate production's row metadata. Phase 5 must make `service_name` updates owner-aware, not just make `bindToEnvironment` owner-aware.
- `garbageCollectCustomDomainIngresses` currently marks deleted ingress hostnames as `status='removed'`. That is wrong for explicit transfer/unbind flows where the local ingress should be deleted but the domain row should stay alive and may already belong to another env.

---

## Implementation Plan

### Phase 1 — Kill the generic K8s error (highest leverage, smallest change)

**Problem**: `applyObject`, `listNamespacedIngress`, `readNamespacedDeployment`, etc. all throw raw `@kubernetes/client-node` errors whose `.message` is the literal string `HTTP request failed`. Useful fields (`statusCode`, `body.message`, `body.reason`, `response.statusMessage`) are siblings that we never read.

#### Fix

1. Add `apps/worker/src/deployer/k8s-error.ts` exporting a `wrapK8sError(err, op, resource)` helper:
   - Reads both Kubernetes client error shapes: `err.statusCode`, `err.response?.statusCode`, `err.body?.message`, `err.response?.body?.message`, `err.body?.reason`, `err.response?.body?.reason`, `err.body?.details?.name`.
   - Also handles string/Buffer bodies and `err.response?.text`, because admission webhook failures often arrive as a plain serialized Kubernetes `Status` object rather than a parsed object.
   - Throws a new `K8sOperationError` with composed message: `K8s ${op} ${resource.kind}/${resource.name} failed (${statusCode} ${reason}): ${body.message}`.
   - Preserves original error as `cause` for stack trace.
   - Exposes `{ statusCode, reason, operation, resourceKind, resourceName, namespace, body }` as typed fields so callers (including `DeployerService`) can branch on them.
   - Includes a `isK8sNotFound(err)` helper so existing "404 means absent" logic remains explicit and does not get accidentally converted into hard failures.

2. Wrap every `objectApi`, `appsApi`, `coreApi`, `networkingApi`, `batchApi` call in worker `k8s.service.ts` — roughly 20 call sites. Pattern:
   ```ts
   try {
     return await this.objectApi!.replace(obj);
   } catch (err) {
     throw wrapK8sError(err, 'replace', {
       kind: obj.kind,
       name: obj.metadata.name,
       namespace: obj.metadata.namespace,
     });
   }
   ```
   Keep intentional soft-fail branches (`404` for "not found", `409` for "already exists") but wrap any unexpected K8s exception before it escapes.

3. Mirror the wrapper in API-owned K8s surfaces (`EnvLogsService`, `EnvDiagnosticsService`, and any system diagnostics paths touched by this work) so `eve env logs` and `eve env diagnose` do not reintroduce generic `HTTP request failed` messages from the API pod. API uses `@kubernetes/client-node@1.4.0` object-style calls and response objects where resources are often returned directly (`items`) rather than under `.body`; keep the wrapper compatible with that shape instead of copying worker positional-call assumptions.

4. In `action-executor.service.ts:244-250`, change the catch to also log to stdout with full stack:
   ```ts
   this.logger.error(
     `Action ${actionType} failed: ${message}`,
     error instanceof Error ? error.stack : undefined,
     { attempt_id: attemptId, project_id: projectId, action: actionType },
   );
   ```
   Keep the attempt-log append, but include `error_class`, `error_context`, and (when available) the `K8sOperationError` typed fields.

5. Apply the same stdout + structured log treatment to `pipeline-runner.service.ts` for the legacy runner path. The job-based pipeline path uses action jobs, but the legacy path is still present and has the same catch-and-persist-only failure pattern.

**Exit criteria**: a deploy that hits a K8s 422 on an invalid ingress produces a message like `K8s replace Ingress/limelee-vanity failed (422 Invalid): spec.rules[0].host: Invalid value ...`, and the same message + stack appears in `kubectl logs deploy/eve-worker`. `eve env diagnose` and `eve env logs` should surface the same structured body if their own K8s reads fail.

---

### Phase 2 — Surface pod-level failure in the deploy result

**Problem**: When `applyManifest` succeeds but pods crash-loop (Pierre's exact case), the deploy attempt has no visibility into pod state. The operator sees a generic failure with no mention of the container, exit code, or boot log.

#### Fix

1. Extend `DeployerService.deploy()` after `applyManifest` to always collect a "post-apply cluster snapshot", regardless of success/failure:
   - For each deployable service, fetch pod list via label selector (`eve.project_id=<projectId>,eve.env=<env>,eve.component=<service>`) within the namespace, not just `eve.component=<service>`.
   - For each pod: `phase`, `containerStatuses[].state` (running / waiting / terminated), `containerStatuses[].lastState.terminated` (reason, exitCode, finishedAt), `restartCount`.
   - Sort failing pods ahead of healthy pods (`CrashLoopBackOff` / image pull / not-ready, then highest restart count, then newest) so excerpts and CLI output point at the pod most likely to explain the failure.
   - Return the snapshot to the caller and append it as a `cluster_snapshot` execution log entry from the caller (`action-executor` or `pipeline-runner`), because `DeployerService` does not currently know the job attempt ID or pipeline step ID.

2. On deploy failure (either `applyManifest` throwing or readiness timeout), also enumerate K8s events in the namespace (last 50, sorted by lastTimestamp) and attach the `Warning`-severity ones to the attempt log.

3. Introduce a typed `DeployFailure` discriminated union and carry it on an error class instead of returning it as a success value:
   ```ts
   type DeployFailure =
     | { kind: 'k8s_api_error'; statusCode: number; resource: string; message: string }
     | { kind: 'manifest_invalid'; details: string }
     | { kind: 'image_pull_error'; service: string; pod: string; image: string; message: string }
     | { kind: 'app_crash_loop'; service: string; pod: string; container: string; exitCode: number; previousLogExcerpt: string[] }
     | { kind: 'readiness_timeout'; notReady: string[]; conditions: Array<{...}> }
     | { kind: 'dependency_timeout'; service: string; waitedOn: string[] };

   class DeployFailureError extends Error {
     readonly failure: DeployFailure;
     readonly snapshot?: ClusterSnapshot;
   }
   ```
   - `deployer.deploy()` and `waitForDeployReady()` throw `DeployFailureError` on classified failure.
   - `action-executor.execute` should return failure `output` when a deploy action throws `DeployFailureError`; the controller maps that to `HarnessResult.resultJson`, and the orchestrator persists it to `job_attempts.result_json`. `pipeline-runner.handleDeploy` should similarly write failure context to `pipeline_step_runs.output_json` before marking the step failed.
   - The human-readable error message still flows into `error_message`, but prefixed with the kind: `[app_crash_loop] staging-api exited 1: ...`.

4. Classify failures from inspection of the post-apply snapshot:
   - Any container with `waiting.reason == 'CrashLoopBackOff'` → `app_crash_loop`.
   - `ImagePullBackOff` / `ErrImagePull` → `image_pull_error`.
   - Readiness timeout without crash → `readiness_timeout`.
   - `waitForServiceDependencies` timeout → `dependency_timeout`.
   - Wrapped K8s validation errors (`422`, `400`) during apply → `manifest_invalid` when the body clearly points at an invalid manifest/resource; otherwise `k8s_api_error`.

5. Previous-container excerpts are useful, but they are persistent once written into attempt logs. Cap them to 20 lines, redact known project secret values and common token patterns, and store only the excerpt needed to diagnose boot failure. Use the pod/container selected by the classifier, not the first pod returned by the API. The full ephemeral log remains available through `eve env logs --previous`.

**Exit criteria**: A crash-looping app produces an attempt error like `[app_crash_loop] staging-api container api exited 1 (reason: Error). Previous log excerpt: <10 redacted lines of flyway stacktrace>` — inline, no kubectl needed, with the full log reachable via the existing `eve env logs ... --previous` command.

---

### Phase 3 — CLI visibility (make Phase 2 data accessible)

**Problem**: Phase 2 puts rich data in attempt/step logs, but today's CLI (`eve env show`, `eve pipeline logs`, `eve job diagnose`) doesn't render it. The only field shown in the incident path is `error_message`.

#### Fix

1. **`eve env diagnose <project> <env>`** — extend the existing command/API response to include:
   - Cluster snapshot from live K8s plus the latest deploy failure payload when available (pods, container states, restart counts, selected `DeployFailure.kind`).
   - Last 10 `Warning`-severity K8s events in the namespace. The API already returns events; filter/render Warning events prominently instead of burying them in the raw list.
   - State warning: if `last_applied_release_id` / `last_failed_release_id` points at a newer release than `current_release_id`, print a prominent warning: `State drift: last applied release <rel_B> is unhealthy; last ready release is <rel_A>.`
   - For each service not ready, print its container's previous-run last-20-lines using the existing logs service path, capped/redacted as in Phase 2. Pass the failing pod/container from the snapshot into the logs service so `diagnose` does not accidentally read previous logs from a healthy replica.
   - Extend `EnvDiagnoseResponseSchema` rather than bolting on untyped JSON, so `--json` callers can use the same fields.

2. **`eve env logs <project> <env> <service> [--previous] [--tail N]`** — improve the existing command:
   - Keep the existing endpoint: `GET /projects/:id/envs/:name/services/:service/logs`.
   - Keep existing filters (`--since`, `--tail`, `--grep`, `--pod`, `--container`, `--previous`, `--all-pods`) and `envs:read` auth.
   - Add `--follow` only if implemented as a proper streaming/SSE path; do not block the incident fix on follow mode because `--previous --tail` is enough for boot failures.
   - Improve API errors by returning the namespace, selector, pod/container, and wrapped K8s status body when log reads fail.

3. **`eve pipeline logs`** — when a deploy step fails, fetch the failing job's attempt output and inline any `cluster_snapshot` / `DeployFailure.kind` sections after the step header. Today the command reads `PipelineStepRunResponse` fields first; in job-based runs those "steps" are synthesized from jobs and have the job id as `step.id`, with `output_json`/`result_json` empty. Use that job id to call `/jobs/:id/attempts`, `/jobs/:id/result`, and `/jobs/:id/attempts/:attempt/logs`, or add an API-side pipeline log aggregator that does the same. The existing `/pipeline-runs/:runId/logs` endpoint only reads legacy step logs and will miss action-job deploy failures unless it is extended.

4. **`eve job diagnose`** — extend "Recent Logs" / latest attempt output rendering to display `cluster_snapshot` entries specially (tabular pod state, not raw JSON) and to print a one-line `Next step:` hint per `DeployFailure.kind`:
   | Kind | Hint |
   | --- | --- |
   | `k8s_api_error` | "Platform issue — share `<attempt_id>` with Eve support. Full body in attempt log." |
   | `manifest_invalid` | "Manifest rejected by K8s — run `eve manifest validate` or see inline details." |
   | `image_pull_error` | "Check `imagePullSecret` or the image digest. Run `eve env diagnose <proj> <env>`." |
   | `app_crash_loop` | "App is crashing on start. Run `eve env logs <proj> <env> <service> --previous`." |
   | `readiness_timeout` | "App came up but isn't ready. Check `eve env diagnose <proj> <env>` and liveness/readiness probes." |
   | `dependency_timeout` | "`depends_on` service didn't become healthy. Check `eve env logs <proj> <env> <dep-service>`." |

5. **`eve env show`** — render existing `deploy_status` and `last_failed_release_id` more prominently, then add any new Phase 4 fields. Today `Current Release` and `Last Failed` are printed but do not explain whether the cluster is currently running the failed applied release.

**Exit criteria**: For Pierre's exact scenario, `eve pipeline logs deploy <run-id>` should print:

```
Step: deploy (deploy)
Status: failed
Error: [app_crash_loop] staging-api container api exited 1 after 3s
Next step: App is crashing on start. Run `eve env logs proj_... staging api --previous`

Pod snapshot (eve-piexrre-limelee-staging):
  staging-api-58dbf9c44b-cljfg   CrashLoopBackOff   restarts=5   last exit=1 (Error)
  staging-web-6bbb5986d6-bgznw   Running            restarts=0

Last previous-container log for staging-api:
  Migration V10__seed_hanwell_hootie.sql failed
  ERROR: duplicate key value violates unique constraint "venues_google_place_id_key"
  ...
```

---

### Phase 4 — Close the silent-drift hole

**Problem**: `DeployerService.deploy()` applies the manifest to the cluster, then throws later. The manifest apply is not transactional; in the action-job path the env's `current_release_id` is only updated by `action-executor.handleDeploy` on full success (line ~722: `await this.envs.update(environment.id, { current_release_id: input.release_id })`). Result: cluster can run rel_B while DB says rel_A, and `deploy_status` / `last_failed_release_id` may not explain the applied-but-unhealthy state.

#### Fix

Use **record-applied-with-warning** as the default. Preserve `current_release_id` as the last known-good/ready release unless the implementation also introduces a separate previous-known-good pointer.

On partial failure:

- Leave `current_release_id` pointing at the last ready release.
- Set `last_failed_release_id = <rel_B>`.
- Set `deploy_status = 'failed'`.
- Set new `last_applied_release_id = <rel_B>` and `last_deploy_failure_json = { kind, service, pod, message, at, namespace }`.
- `eve env show` and `eve env diagnose` show that the cluster is running/attempted rel_B and that rel_A is only the last ready release.

On success:

- Set `current_release_id = <rel_B>`.
- Set `last_applied_release_id = <rel_B>`.
- Clear `last_failed_release_id`.
- Clear `last_deploy_failure_json`.
- Set `deploy_status = 'deployed'`.

Implementation steps:

1. Add a migration for:
   - `environments.last_applied_release_id TEXT`
   - `environments.last_deploy_failure_json JSONB`
2. Update `packages/db/src/queries/environments.ts`, `packages/shared/src/schemas/environment.ts`, `apps/api/src/environments/environments.service.ts`, and `packages/cli/src/commands/env.ts` to include/render those fields.
3. Refactor both action-job deploy (`action-executor.handleDeploy`) and legacy pipeline deploy (`pipeline-runner.handleDeploy`) so environment state is updated on failure paths too. On success, action-job deploy must set `deploy_status='deployed'`, clear `last_failed_release_id`, and write `last_applied_release_id`; today it only sets `current_release_id`.
4. Update the API deploy paths:
   - `deployViaPipeline` should mark the environment `deploy_status='deploying'` when the pipeline run is created; today the direct path does this but the pipeline path does not.
   - `deployDirect` / `finalizeReleasePointer` should record failure state when `deployRelease` throws before returning a `DeploymentStatus`, not only when `finalizeReleasePointer` receives a non-ready status.
   - `reset` and `rollback` should use the same state-recording helper so they do not preserve stale `last_deploy_failure_json`.
5. Emit an `env.deploy.state_recorded` event on both success and failure. Emit `env.deploy.drift_detected` only if later live-cluster inspection finds an applied release that differs from both `current_release_id` and `last_applied_release_id`.
6. Keep rollback-on-failure as a future option. It is not the default because rollback can fail independently and can erase the very evidence operators need for diagnosis.

**Exit criteria**: Pierre's failed deploy should leave `eve env show` saying:

```
Current Release:      rel_01kmp0wc... (last ready)
Last Applied Release: rel_01kpr868... (failed)
Deployment Status:   failed
Last Failure:        app_crash_loop on staging-api (2026-04-21T14:47:58Z)
  Run `eve env diagnose proj_... staging` for details.
```

— not the current silent `Current Release: rel_01kmp0wc...` (four-day-old release) with `1/2 ready`.

---

### Phase 5 — Env-scoped custom domains (fix the real Limelee blocker)

**Problem**: A custom domain today is a project-scoped row with a mutable `environment_id` that any deploy can rewrite. The deployer iterates `renderResult.customDomainIngresses` (built from every service's `x-eve.ingress.domains`) and calls `customDomains.bindToEnvironment(hostname, project.id, envId, ...)` unconditionally for each. The query is a plain `UPDATE ... WHERE hostname = ? AND project_id = ?` — no check on existing `environment_id`. So if production claimed `api.limelee.com` last week, a staging deploy this week rebinds the row to staging, renders an Ingress in the staging namespace with the same `host + path=/`, and nginx admission webhook rejects it with:

```
host "api.limelee.com" and path "/" is already defined in ingress
eve-piexrre-limelee-production/production-api-cd-api-limelee-com
```

From the user's side, this looked identical to the Phase 1 symptom (`HTTP request failed`) because the admission error is a 422 body that the unwrapped K8s client returns as bare text. The user cannot fix this without either (a) splitting domains per env in the manifest (the manual workaround we applied to Limelee) or (b) platform support for env ownership.

The invariant we want: **a custom domain is owned by exactly one environment at a time. Ownership is claimed on first successful bind and is not transferable without an explicit unbind.**

#### Fix

1. **Make custom-domain metadata owner-aware before binding.** `claimOrUpdate` currently runs before `bindToEnvironment` and updates `service_name` for any same-project row, even if another env owns it. Change it so same-project conflict updates are limited to unowned rows, or preserve `service_name` whenever `environment_id IS NOT NULL`; the owned-env redeploy path can update `service_name` in `bindToEnvironment` after proving ownership. Cover both `apps/api/src/projects/projects.service.ts:reconcileCustomDomains` and the deployer call site with tests, because both use `claimOrUpdate`.

2. **Change `bindToEnvironment` to first-bind-wins.** In `packages/db/src/queries/custom-domains.ts`:
   ```sql
   UPDATE custom_domains
   SET environment_id = ${environmentId},
       service_name   = ${serviceName},
       updated_at     = NOW()
   WHERE hostname   = ${normalized}
     AND project_id = ${projectId}
     AND status    != 'removed'
     AND (environment_id IS NULL OR environment_id = ${environmentId})
   RETURNING *
   ```
   - Returns the row if the caller already owns it (normal re-deploy) or if it was unowned.
   - Returns `null` if another env owns it. Callers treat `null` as "skip, don't render a new ingress".

3. **Deployer skips (does not fail) when ownership is held by a different env.** In `apps/worker/src/deployer/deployer.service.ts` around line 319, when `bindToEnvironment` returns `null`, look up the current owner via `findByHostname` plus the environments table so the message uses a name, not just an ID, and log:
   ```
   Custom domain api.limelee.com: owned by environment "production" — skipping in this env.
   To move the domain, run: eve domain transfer api.limelee.com --to staging
   ```
   Do **not** add the hostname to `desiredDomains` and do **not** add the ingress manifest.

4. **Scope custom-domain garbage collection to the current namespace, with ownership-aware status updates.** Today `garbageCollectCustomDomainIngresses(namespace, desiredDomains)` only inspects the current env's namespace and marks every deleted hostname `status='removed'`.
   - Never delete anything in sibling namespaces from this deployer path.
   - If the current namespace contains a stale custom-domain ingress for a hostname no longer desired by this env, it is safe to delete that local ingress. This is what makes `eve domain transfer <host> --to <envB>` followed by `eve env deploy envA` clean up env A.
   - Only set `status='removed'` when the DB row is still owned by the current env and the domain was removed from the manifest. If the row is unbound or owned by another env, delete the stale local ingress but leave the domain row/status alone.
   - On successful `register`/`bind`, optionally inspect sibling env namespaces for the same hostname and emit a `Warning` event if a stale ingress exists. Do not auto-delete it because it may still be serving live traffic.

5. **Extend existing CLI + API with explicit transfer and unbind.**
   - `POST /projects/:id/domains/:hostname/transfer { to_environment: "<env name or id>" }` → unbinds from current env, binds to target. Requires `projects:write`. Rejects if target env not in project. Return both previous and new environment ids/names plus next-step cleanup guidance.
   - `POST /projects/:id/domains/:hostname/unbind` → clears `environment_id` but keeps the row (so next deploy of any env can claim). Requires `projects:write`.
   - CLI: extend the existing `eve domain` namespace with `list [--env <name>]`, `transfer <hostname> --to <env>`, and `unbind <hostname>`. Keep existing `list/status/verify/remove` behavior, but add owner environment display to list/status.
   - The transfer/unbind operations only update DB state. They do **not** touch K8s Ingress resources in either namespace. Ingress cleanup is the job of the next deploy of the losing env (it sees the hostname is no longer in its `desiredDomains` and GC removes its local ingress).

6. **New `DeployFailure` kind: `ingress_conflict`.** If `applyManifest` still fails with a nginx `host + path` admission error after this change (e.g. a stale manual kubectl-created Ingress, or cross-project conflict), classify as `ingress_conflict` with the colliding ingress name and namespace from the admission message. Add to the Phase 3 hint table:
   | Kind | Hint |
   | --- | --- |
   | `ingress_conflict` | "Another ingress owns this host + path: `<ns>/<name>`. Run `eve domain list` to see who claims it; `eve domain transfer` to move ownership." |

7. **Manifest-schema guardrail (optional, after Phase 6 is stable).** At `eve project sync`/validation time, warn when the same `x-eve.ingress.domains` hostname appears in more than one environment's effective config (after env overrides are resolved). This is a lint, not an error — users may legitimately want to swap ownership across envs. Emit the lint through the existing sync/validate output.

8. **Backfill & migration.**
   - Do the K8s inspection as an operator script or one-shot admin job, not as a SQL migration. SQL migrations must not depend on cluster access.
   - For each `custom_domains` row, look at existing K8s Ingress resources across the project's namespaces labeled `eve.custom_domain=true` and `eve.domain_hostname=<hostname>`. If exactly one namespace owns the ingress, ensure the DB `environment_id` matches that namespace's env. If multiple namespaces have the same hostname's ingress, flag for manual review (don't auto-resolve — production vs staging is too consequential to guess).
   - Preserve existing behavior for rows currently bound to a valid env — just enforce invariance going forward.

**Exit criteria**:
- An `eve env deploy staging` whose manifest declares a domain currently owned by production logs `owned by environment "production" — skipping`, deploys the rest of the manifest successfully, and does not touch production's ingress. `eve env show production` continues to report the domain and the production ingress continues to serve traffic.
- `eve domain list` shows hostname → env bindings. `eve domain transfer limelee.com --to staging` moves DB ownership; the next `eve env deploy production` observes the hostname is not in its `desiredDomains` and GC removes the production ingress; the next `eve env deploy staging` creates the ingress in the staging namespace.
- Pierre's original manifest (with domains declared on base services and no env override) would have deployed cleanly the first time in whichever env deployed first.

---

### Phase 6 — Pipeline runs resolve manifest from the deploy ref

**Problem**: `pipeline-runs.service.ts` at the `getPipeline` helper calls `manifests.findLatestByProject(projectId)`, and the job-based path calls `PipelineExpanderService.expandPipeline`, which independently calls `findLatestByProject` again and creates the authoritative `pipeline_runs.manifest_hash`. That hash is inherited by every action step via `action-executor.resolveActionInput` (which reads `run?.manifest_hash`). The `action-executor.autoSyncManifestFromWorkspace` call happens inside an already-running job step, long after the pipeline run row was created — so the newly synced manifest becomes "latest" in the DB but the **in-flight run still carries the old hash**. All downstream action inputs (build, release, deploy) use the stale hash, and the deployer renders the stale manifest (including stale env overrides or missing domain blocks).

Concretely: push a manifest-only change, run `eve env deploy --ref <new-sha>`, and the deployer sees the **old** manifest. The CLI currently resolves the git ref and sends a `manifest_hash`, but the pipeline path does not use that hash; only direct deploy consumes it. The only reliable workaround today is to run `eve project sync --ref <new-sha>` first, which is undocumented and easy to miss.

#### Fix

Prefer **(a) resolve-on-create** as the default. It removes the hidden prerequisite and matches the user's mental model: "the ref I deploy is the code *and* the manifest I get."

1. **Resolve the ref's manifest server-side at pipeline-run creation.** In `apps/api/src/environments/environments.service.ts:deployViaPipeline` (and any other caller of `pipelineRunsService.createRun` that carries a git ref), before calling `createRun`:
   - Fetch the manifest content for the given ref. Reuse the same git-fetch path used by `prepareWorkspace` in the worker, or introduce a lightweight `manifests.resolveFromRef(projectId, gitSha)` service that:
     - Clones or `git cat-file` the manifest at the specified SHA using existing project credentials.
     - Computes the sha256 of the raw YAML.
     - Calls `manifests.findByProjectAndHash`; if missing, inserts a new row with `git_sha` set.
     - Returns the resolved `{ manifest_hash, manifest_yaml }`.
   - Pass the resolved manifest record into `createRun` explicitly (add an internal parameter; do not expose this as a general public override). `PipelineRunsService.getPipeline` must parse this manifest instead of falling back to `findLatestByProject`.
   - Pass the same resolved manifest record into `PipelineExpanderService.expandPipeline`. This is the path that currently writes `pipeline_runs.manifest_hash` for job-based runs, so missing this call leaves the bug intact.
   - Ensure dry-run and `--only` expansion use the same resolved manifest so validation, job graph creation, and the persisted run cannot disagree.
   - When no ref is provided (e.g. a pipeline triggered by an event without a git context), keep the current `findLatestByProject` behavior for backward compatibility.

2. **Make `autoSyncManifestFromWorkspace` defensive, not load-bearing.** Once Phase 6 (1) is in place, the worker's post-clone auto-sync is redundant for pipeline-driven deploys. Keep it for workflow-trigger freshness (its documented purpose), but:
   - If the just-synced workspace hash differs from the job's inherited `input.manifest_hash`, **fail the step** with `manifest_invalid`: "Resolved manifest for ref `<sha>` does not match pipeline run manifest `<hash>`." This catches races where the API resolved a stale manifest against a branch that was force-pushed mid-run, and surfaces drift rather than hiding it.

3. **Keep CLI responsibilities narrow and honest.** `eve env deploy --ref <sha>` already sends the ref to the API. With Phase 6 (1) in place, the API handles manifest resolution for pipeline deploys; the CLI should not silently substitute the latest server manifest for that path. Direct deploy can keep using the existing CLI-sent `manifest_hash` until direct deploy gets the same server resolver. Update human output so pipeline deploys display the `pipeline_run.run.manifest_hash` returned by the API instead of printing a preflight `Using manifest ...` line that may not be the manifest actually used.

4. **Fast-fail on unresolvable refs before creating a run.** If the ref cannot be fetched (auth failure, missing SHA, detached commit), the API returns `400` with the exact git error, not `500` with a stale hash and not a pending pipeline run that later fails. The `DeployFailure.kind = 'manifest_invalid'` already covers this; the fix here is just to route this class of error through it with a clear message.

5. **Backfill is unnecessary.** This is a server-side behavior change; historical pipeline runs keep their recorded `manifest_hash`. New runs pick up the new resolution path.

**Exit criteria**:
- Pushing a manifest-only change and running `eve env deploy staging --ref <new-sha>` deploys the new manifest without any `eve project sync` step. The pipeline run's `manifest_hash` matches the sha256 of `.eve/manifest.yaml` at `<new-sha>`.
- A ref whose manifest cannot be fetched produces a clear `400` from `eve env deploy` with the git error, not a run that succeeds-then-fails on stale data.
- The end-to-end Limelee sequence (push manifest fix + deploy) reproduces the success we had to force with `eve project sync` in the incident — without the manual sync step.

---

### Phase 7 — Docs & skill updates

1. `docs/system/deployment.md` — add "Diagnosing a failed deploy" section with the new CLI flow. Add a "Custom domain ownership" subsection covering first-bind-wins semantics and `eve domain transfer`/`unbind`.
2. `docs/system/builds.md` — link to the `DeployFailure` taxonomy (including new `ingress_conflict`).
3. `../eve-skillpacks/eve-work/eve-read-eve-docs/references/deploy-debug.md` — new "Deploy error classes" subsection; document existing `eve env logs --previous`, `eve env diagnose`, the `app_crash_loop` hint flow, and the `ingress_conflict` hint flow.
4. `../eve-skillpacks/eve-work/eve-read-eve-docs/references/manifest.md` — document that `x-eve.ingress.domains` claims are env-scoped and held by the first env to deploy; reference `eve domain transfer` for moves. Remove any suggestion that the same `domains` block applies to all envs — it does, but only one env at a time owns each hostname.
5. `../eve-skillpacks/eve-work/eve-read-eve-docs/references/cli.md` — update the existing `eve domain list/status/verify/remove` docs with owner-environment output and add `eve domain transfer` / `eve domain unbind`. Remove any workflow recipe that recommends `eve project sync` as a prerequisite to `eve env deploy --ref <sha>` (Phase 6 makes it unnecessary).
6. `eve-troubleshooting` skill — add a "Deploy succeeded applying but app crashes at boot" recipe pointing at `eve env logs --previous`. Add a "Deploy fails with ingress conflict" recipe pointing at `eve domain list` + `eve domain transfer`.
7. `eve-deploy-debugging` skill — update to reference `DeployFailure.kind` rendering, the drift warning, and the `ingress_conflict`/`manifest_invalid` hints.
8. API/OpenAPI docs — update `EnvDiagnoseResponseSchema`, `EnvironmentResponseSchema`, and `EnvLogsResponseSchema` examples so CLI users and agents know which structured fields are stable. Document new `POST /projects/:id/domains/:hostname/transfer` and `POST /projects/:id/domains/:hostname/unbind` routes.

---

## Sequencing & Sizing

| Phase | Blast radius | Rough size | Can ship independently? |
| --- | --- | --- | --- |
| 1. K8s error wrapper + stack logging | Low (internal wrapper; all behavior additive) | ~1 day | Yes — prerequisite for Phase 2 but useful alone |
| 2. Post-apply snapshot + `DeployFailure` taxonomy | Medium (new error type, new attempt/step log entries) | ~2 days | Yes — ships without CLI changes |
| 3. CLI surfacing (`env diagnose`, existing `env logs`, `pipeline logs`, `job diagnose` hints) | Medium (schema and rendering changes; no new logs endpoint required) | ~2 days | Yes — depends on Phase 2 for rich data |
| 4. Silent-drift fix (env state + migration) | Medium-high (DB migration, state write paths) | ~1–2 days | Yes, but should use Phase 2 failure payload if available |
| 5. Env-scoped custom domains (first-bind-wins + transfer/unbind) | Medium (query change, deployer branch, new CLI/API; cross-namespace behavior) | ~2 days | Yes, independent of 1–4. Benefits a lot from Phase 1 (wrapped admission errors) and Phase 2 (`ingress_conflict` classification). |
| 6. Resolve `manifest_hash` from deploy ref | Medium (API fetch-at-ref; new failure path) | ~1–2 days | Yes, independent of 1–5. Surfaces cleaner failures once Phase 1 is in. |
| 7. Docs/skillpacks | Low | ~half day | After 1–6 ship |

Suggested ship order: **1 → 5 → 6 → 2 → 4 → 3 → 7**. Phase 1 is the keystone error-wrapping change. Phases 5 and 6 are the two load-bearing behavior fixes that unblock real users today (they are why Pierre's deploy was stuck — not an observability issue). Phases 2 → 4 → 3 are the observability layer that makes future incidents self-serve. Phase 7 documents the new surface once the behavior is stable.

## Testing Strategy

- **Unit**: each K8s wrapper path in worker `k8s.service.ts` gets a test that simulates both client-node error shapes (`err.body` and `err.response.body`) and asserts the wrapped message/fields.
- **Unit**: `EnvLogsService` and `EnvDiagnosticsService` tests verify wrapped K8s failures include namespace/selector context and never return bare `HTTP request failed`.
- **Unit**: failure classifier tests cover `CrashLoopBackOff`, `ImagePullBackOff`, `ErrImagePull`, readiness timeout, dependency timeout, K8s validation errors, and nginx admission `host + path` conflicts (`ingress_conflict`).
- **Unit** (Phase 5): `bindToEnvironment` tests — table-driven for the 4 states `{unowned, owned-by-self, owned-by-other, removed}` × `{deploy, transfer, unbind}`. Assert no `UPDATE` ever moves `environment_id` silently.
- **Unit** (Phase 5): `claimOrUpdate` tests assert a same-project deploy for env B cannot mutate `service_name`, status, or ingress metadata for a domain owned by env A before `bindToEnvironment` proves ownership.
- **Unit** (Phase 5): `garbageCollectCustomDomainIngresses` tests assert local stale ingress deletion does not set `status='removed'` when the DB row is unbound or owned by a different env.
- **Unit** (Phase 6): `manifests.resolveFromRef` tests — known SHA returns existing row, new SHA inserts and returns, unreachable ref returns a typed error mapped to `manifest_invalid`. `pipelineRunsService.createRun` and `PipelineExpanderService.expandPipeline` tests assert the passed manifest record wins over `findLatestByProject` when provided.
- **Unit** (Phase 6): `eve env deploy --ref` CLI output test for pipeline-routed envs asserts it does not print a local/latest manifest hash as the manifest used unless that hash came back on `pipeline_run.run.manifest_hash`.
- **Integration** (`eh test integration`): fixture project whose manifest references an image that doesn't exist, assert the deploy attempt yields `DeployFailure.kind === 'image_pull_error'` with the right service, pod, and image strings.
- **Integration**: deploy a service that exits 1, assert `last_failed_release_id`, `last_applied_release_id`, `deploy_status='failed'`, and `last_deploy_failure_json.kind='app_crash_loop'` while `current_release_id` remains the last ready release.
- **Integration** (Phase 5): two envs in the same project each declare the same `x-eve.ingress.domains` hostname. Deploy env A first; then deploy env B and assert (i) env B's deploy succeeds, (ii) the custom_domain row is still bound to env A, (iii) env B's attempt log contains an `owned by environment "<A>"` skip entry, (iv) env A's ingress is untouched.
- **Integration** (Phase 5): `eve domain transfer <host> --to <envB>` followed by `eve env deploy envA` removes the A-side ingress; subsequent `eve env deploy envB` creates the B-side ingress. No overlap window where both are deployed.
- **Integration** (Phase 6): push a manifest-only commit on a branch and run `eve env deploy --ref <sha>` without `eve project sync`. Assert the pipeline run's `manifest_hash` matches sha256 of the manifest at `<sha>`, not `findLatestByProject`'s current value.
- **Integration** (Phase 6): create a pipeline whose latest synced manifest differs from the ref manifest, then assert job action inputs inherit the ref manifest hash from the pipeline run and that `autoSyncManifestFromWorkspace` fails loudly if the worker clone sees a different hash.
- **CLI** (Phase 3): `eve pipeline logs <pipeline> <run>` against a job-based deploy run fetches the deploy job attempt/result and renders `DeployFailure.kind` plus `cluster_snapshot`; it must not stop at empty legacy step logs.
- **Manual** (`tests/manual/`): new scenario `deploy-crash-loop.yml` — deploys a service whose entrypoint `exit 1`s; asserts `eve env diagnose` surfaces `app_crash_loop` with a non-empty redacted previous-container excerpt and a working `eve env logs ... --previous` hint.
- **Manual** (Phase 5): new scenario `deploy-cross-env-domain.yml` reproducing the Limelee setup — two envs claim same hostname, assert the behavior described above end-to-end through `eve domain list` and `eve domain transfer`.
- **Regression guard**: add a test that fails if catch blocks in `action-executor.service.ts` or `pipeline-runner.service.ts` omit `logger.error` with a stack for deploy failures. Add a second guard that greps `bindToEnvironment` usage in `deployer.service.ts` and asserts every call site handles the `null` (not-owned) branch.

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| `eve env logs` exposes secrets printed to stdout by the app | Existing surface already exists and is gated by `envs:read`; document that app logs may contain secrets. For persisted previous-log excerpts, cap length and redact known project secrets/token-like values. |
| Wrapping every K8s call is tedious and easy to miss one | Add a regex-based lint test that greps worker `k8s.service.ts` and API env K8s services for direct API calls not wrapped or explicitly marked as handled. |
| Post-apply snapshot adds latency to every deploy | Capped at 1 list + 1 events fetch per namespace — ~100ms. Acceptable. |
| Drift fix (Phase 4) may confuse "current release" semantics | Preserve `current_release_id` as last ready release in the first cut; add `last_applied_release_id` for the cluster-applied failed release. |
| API pod needs extra RBAC to tail pod logs for `eve env logs` | The endpoint already works through API K8s credentials; verify RBAC in staging/local and document in `docs/system/auth.md` only if permissions change. |
| Persisting previous-container excerpts increases retention of app logs | Store only redacted, capped excerpts on failure; rely on `eve env logs --previous` for full ephemeral logs. |
| Phase 5 first-bind-wins locks users out of their own domains | Provide explicit `eve domain transfer` and `eve domain unbind` from day one. The "lock" is only against silent clobbering, not against deliberate ownership moves. |
| Phase 5 still lets non-owner deploys mutate domain metadata via `claimOrUpdate` | Make `claimOrUpdate` owner-aware and move owner-scoped metadata changes into `bindToEnvironment`; test both project sync and deploy call sites. |
| Phase 5 GC removes the correct stale ingress but marks the live domain row `removed` | Split "delete local stale ingress" from "mark domain removed"; only set removed when the current env still owns the row and the manifest removed the hostname. |
| Phase 5 backfill could mis-assign ownership when two namespaces currently have the same hostname ingress | Don't auto-resolve — flag for manual review in the backfill migration output. Operators decide which env keeps it before enforcement kicks in. |
| Phase 5 breaks existing deploys that currently "work" only because the user manually split domains per env | Those deploys continue to work (the user's manifest already scopes domains). The change only affects cases where multiple envs reference the same domain, which today always fails at admission anyway. |
| Phase 6 fetch-at-ref adds a git round-trip to every pipeline-run creation | Cheap (~100–300ms) with existing auth/cache. If the project's repo is unreachable we fail fast; that's already broken territory for a deploy. |
| Phase 6 updates `PipelineRunsService` but misses the job-based expander | Treat `PipelineExpanderService.expandPipeline` as the authoritative write path and add a regression test that fails if it calls `findLatestByProject` when a resolved manifest was supplied. |
| Phase 6 manifest resolved at API may mismatch worker's clone if the branch is force-pushed mid-run | Covered by the Phase 6 (2) defensive check in `autoSyncManifestFromWorkspace`: worker fails with `manifest_invalid` when hashes differ, surfacing the race instead of hiding it. |

## Open Questions

- **Log retention**: `eve env logs --previous` reads from the kubelet's container log buffer, which is rotated. The plan persists a small redacted excerpt only. Do we need long-term app log retention? Out of scope here; file a follow-up if operators ask.
- **`current_release_id` semantics**: this plan preserves it as last ready release and adds `last_applied_release_id`. If product semantics should instead define it as "last applied", add `previous_successful_release_id` first and update rollback/job-resolution callers together.
- **Pipeline retry semantics**: if a deploy ends in `app_crash_loop`, should the pipeline retry? Currently it doesn't. Proposal: no auto-retry for `app_crash_loop` / `manifest_invalid` / `image_pull_error` / `ingress_conflict` (app-fault); do auto-retry for `k8s_api_error` (platform-fault). Decide during Phase 2.
- **Default env for custom domain binding**: when a user calls `POST /projects/:id/domains` without specifying an env, should the row stay unbound until a deploy, or should it default to the project's `production` env (if present)? Current plan keeps it unbound and lets first-deploy-wins. Revisit if users find this surprising.
- **Ingress cleanup when a domain is unbound**: should `eve domain unbind` immediately delete the losing env's K8s ingress, or wait for the next deploy of that env to GC it? This plan waits (conservative). Operators who need the ingress gone now can `eve env deploy <losing-env>` with the updated DB state.
- **Manifest resolution caching (Phase 6)**: if the API resolves the same `(project, git_sha)` pair repeatedly, should we cache `manifest_hash` on `releases` or a new `project_git_manifest` table? Probably yes at scale, but a single fetch per deploy is fine for now.

---

## Out of Scope (future)

- A reconciler that periodically diffs cluster state vs `environments.current_release_id` and auto-heals drift.
- A `Deployments` board in the dashboard surfacing `DeployFailure.kind` across all projects.
- Integrating K8s events into a long-lived event stream (today we fetch them on-demand).
- Cross-project domain sharing. Today `custom_domains` is project-scoped; a hostname is locked to one project. Cross-project ownership is a bigger product question and not needed for the current incident class.
- Automatic migration of live traffic when `eve domain transfer` runs (blue/green across namespaces). The current plan relies on the next deploy of each env to reconcile ingresses; true zero-downtime handoff needs a sequenced ingress rename or a cluster-wide rewrite and is deferred.

---

## Changelog

- **2026-04-21**: Review update: aligned Phase 5 with the existing `eve domain` CLI, added owner-aware `claimOrUpdate` and GC status safeguards, clarified that `PipelineExpanderService` is the authoritative job-based manifest-hash write path, and added CLI/log rendering guardrails for job-based pipeline deploys.
- **2026-04-21**: Added Phase 5 (env-scoped custom domains / first-bind-wins in `bindToEnvironment`, with `eve domain transfer`/`unbind` and new `ingress_conflict` failure kind) and Phase 6 (pipeline runs resolve `manifest_hash` from the deploy ref instead of `findLatestByProject`). Both phases came out of continued investigation of Pierre's Limelee staging deploy after the initial manifest-only workaround exposed two further platform bugs. Renumbered docs phase to 7. Expanded Problem Statement, Goals, Sequencing, Testing, Risks, and Open Questions accordingly.
- **2026-04-21**: Review update: corrected existing `eve env logs` / `eve env diagnose` surface, aligned auth/endpoint details with current code, changed drift fix to `last_applied_release_id` + `last_deploy_failure_json`, added API K8s wrapper scope, and added redaction/retention guardrails for previous-container excerpts.
- **2026-04-21**: Initial draft triggered by Limelee staging deploy incident (pipeline runs `prun_01kpr8613…` / `prun_01kpr7rvej…`).
