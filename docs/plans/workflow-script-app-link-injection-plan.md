# Workflow Script App-Link Injection Plan

> **Status**: Proposed 2026-06-02; reviewed/updated 2026-06-02
> **Scope**: Platform (eve-horizon)
> **Tracking**: plan `eve-horizon-dakb`; implementation `eve-horizon-wvxq`
> **Source**: Downstream-app gap report (Observation Platform) — "Eve workflow `script:` child jobs do not receive `EVE_APP_LINK_*` env vars even when the consumed link declares `inject_into.jobs: true`"
> **Owner (PVS-side)**: Observation Platform · **Eve-horizon plan / PR**: this doc
> **Blocks**: Removing `LOAD_API_URL` / `LOAD_INGEST_API_URL` fallbacks from the Observation Platform `load-sandbox` workflow.
> **Related**:
> - `docs/plans/script-step-env-overrides-injection-plan.md` — shipped 2026-05-20; the *identical class of bug* for `env_overrides` (job row carries the value, script executor never reads it). This plan mirrors that fix for app-links.
> - `docs/plans/workflow-script-step-materialization-plan.md` — shipped `release-v0.1.284`; made workflow `script:` / `run:` steps materialize as script jobs.
> - `docs/plans/script-action-step-toolchains-plan.md` — shipped 2026-05-19; the toolchain half of script-step ↔ agent-step parity.
> - `docs/plans/local-app-link-mesh-plan.md` — `eve local mesh` wiring used to reproduce app-links on the local k3d stack.

## Problem

Observation Platform runs sandbox load suites as Eve workflow `script:` steps so the load generator runs in-cluster. The consumer manifest subscribes to its own `observation` and `observation-ingest` app-link exports with `inject_into.jobs: true`, and the load harness prefers `EVE_APP_LINK_*` URLs over fallback env vars. Today the fallback env vars are the *only* reason the workflow runs at all — which is exactly the tech debt the app-link contract is meant to retire.

Our own docs promise this works:

- `manifest.md` § Cross-Project App Links: `inject_into.jobs: true` injects the link's env vars into jobs.
- `jobs.md`: `eve job create --with-links alias1,alias2` requests explicit links.

In practice, **workflow `script:` child jobs never see the resolved link URLs or tokens.** They route to the worker's `ScriptExecutorService`, which builds the bash env from a small hard-coded set and never reads the resolved app-links that already sit on the job row.

### Reproduced on staging — 2026-06-02

Staging project `proj_example`:

- Earlier app-link-only roots failed: `obscore-f79ece05`, `obscore-78416f4c`.
- Invoked `load-sandbox` with `LOAD_API_URL=` and `LOAD_INGEST_API_URL=` (manifest fallbacks disabled). Root `obscore-e756c275` failed.
- Smoke child `obscore-e756c275.1`: `hints.resource_refs_count: 0`, `resource_refs: []`, only blank fallback env overrides.
- Child result: `baseUrl is required for remote load execution` — proving neither `EVE_APP_LINK_OBSERVATION_API_URL` nor `EVE_APP_LINK_OBSERVATION_INGEST_API_URL` reached the script runtime.

### Root cause (where the wiring breaks)

The intended data path is job creation -> persisted hints -> runtime env injection. The first leg exists, but it is currently env-sensitive, and the runtime leg is missing for scripts.

1. **Create-time path (direct jobs correct; workflow jobs missing):** `apps/api/src/jobs/jobs.service.ts:637-645` auto-injects `hints.app_links` from every subscription with `inject_into_jobs: true` when no explicit `app_links` hint is present. `:648` then calls `resolveAppApis`, which calls `resolveAppLinks` (`:357`) and persists `hints.resolved_app_links` (`:352`) for direct jobs. The workflow expander does **not** call `JobsService.create`; it writes root and step rows through `jobQueries.create`, so workflow jobs must resolve `inject_into.jobs` app links inside `WorkflowsService` before persisting root/child hints. `workflowHintsForExecution` (`:789-801`) strips `app_apis` / `resolved_app_apis` for script steps but deliberately leaves `app_links` intact.

2. **Wrong env scope (a real defect):** every workflow root and step child is created with `env_name: null` (`apps/api/src/workflows/workflows.service.ts:933,1101`), even when the workflow declares `env: sandbox`. `resolveAppLinks(projectId, aliases, envName)` is therefore called with `envName = null` (`jobs.service.ts:344,648`). For `environment: same` subscriptions this can either fail with `App link "<alias>" requires an env_name or fixed producer environment` or leave the child without `hints.resolved_app_links` on paths that avoided auto-injection. Even once we inject the vars, the URL/token must point at the workflow's target environment.

3. **Runtime (the definitive gap):** workflow `script:` jobs route to the worker's `ScriptExecutorService.execute()` (`apps/worker/src/script-executor/script-executor.controller.ts:37`), **not** the agent invoke path. `execute()` already loads the job and extracts `env_name` (`apps/worker/src/script-executor/script-executor.service.ts:150-175`), but `runScript()` (`:655-745`) assembles the bash env from `PATH`, `HOME`, `EVE_JOB_ID/PROJECT_ID/ATTEMPT_ID`, optional `EVE_API_URL` / `EVE_PUBLIC_API_URL` / `EVE_JOB_TOKEN` / `EVE_RUN_ID` / `EVE_ENV_NAME` / `EVE_ENV_NAMESPACE`, the toolchain overlay, and `applyEnvOverrides(...)`. There is **no read of `hints.resolved_app_links`, no `mintAppLinkToken`, and no `buildAppApiEnvVars`** anywhere in the script-executor.

The model to copy already lives in this repo. The worker's *agent* invoke path does exactly the right thing at `apps/worker/src/invoke/invoke.service.ts:1954-1974`:

```ts
const resolvedLinks = hintsRow[0]?.hints?.resolved_app_links as Array<{...}> | undefined;
const resolvedLinksWithTokens = [];
for (const link of resolvedLinks ?? []) {
  const token = await mintAppLinkToken({
    subscriptionId: link.subscription_id,
    consumerPrincipal: `job:${invocation.jobId}`,
    producerEnv: link.producer_env,
    ttlSeconds: 60 * 60,
  });
  resolvedLinksWithTokens.push({ ...link, origin: 'app_link', type: link.type ?? 'openapi', token: token?.access_token });
}
if (resolvedApis?.length || resolvedLinksWithTokens.length > 0) {
  Object.assign(adapterEnv, buildAppApiEnvVars([...]));
}
```

`mintAppLinkToken` (`packages/shared/src/api-client/auth-client.ts:148`) and `buildAppApiEnvVars` (`packages/shared/src/schemas/api-source.ts:126`) are both exported from `@eve/shared` and already imported in the worker. The script executor simply doesn't call them.

`buildAppApiEnvVars` emits exactly the var set the load harness wants (`api-source.ts:126-143`):

```
EVE_APP_LINK_<ALIAS>_API_URL
EVE_APP_LINK_<ALIAS>_TOKEN
EVE_APP_LINK_<ALIAS>_SCOPES
EVE_APP_LINK_<ALIAS>_PROJECT
EVE_APP_LINK_<ALIAS>_ENV
EVE_APP_LINK_<ALIAS>_CLI        # when the grant declares a CLI
```

So the asymmetry is mechanical: the resolved links sit on the job row, the helpers live in `@eve/shared`, the agent path already wires them — the script path doesn't.

### Workaround in use today

The `load-sandbox` workflow keeps `LOAD_API_URL` / `LOAD_INGEST_API_URL` manifest fallbacks so the script has *some* base URL. Costs:

- The app-link contract this repo exists to prove is never actually exercised by the load suite.
- Two copied URLs drift out of sync with the producer's real ingress, and must be hand-maintained per environment.
- The fallback masks the failure: a broken app-link looks like a working load run.

## Required behaviour

Workflow `script:` child jobs must receive app-link env vars for every subscription declared in `x-eve.app_links.consumes` with `inject_into.jobs: true` — with **no manifest change** from the consumer. At runtime the script environment must include at least:

```
EVE_APP_LINK_OBSERVATION_API_URL
EVE_APP_LINK_OBSERVATION_TOKEN
EVE_APP_LINK_OBSERVATION_SCOPES
EVE_APP_LINK_OBSERVATION_PROJECT
EVE_APP_LINK_OBSERVATION_ENV
EVE_APP_LINK_OBSERVATION_INGEST_API_URL
EVE_APP_LINK_OBSERVATION_INGEST_TOKEN
EVE_APP_LINK_OBSERVATION_INGEST_SCOPES
EVE_APP_LINK_OBSERVATION_INGEST_PROJECT
EVE_APP_LINK_OBSERVATION_INGEST_ENV
```

The existing consumer manifest is sufficient — no new field required:

```yaml
x-eve:
  app_links:
    consumes:
      observation:
        project: obscore
        api: observation
        environment: same
        scopes: [observations:read, observations:write]
        inject_into:
          jobs: true
      observation-ingest:
        project: obscore
        api: observation-ingest
        environment: same
        scopes: [observations:write]
        inject_into:
          jobs: true
workflows:
  load-sandbox:
    env: sandbox
    steps:
      - name: smoke
        script:
          run: node scripts/load/run-suite.mjs --suite sandbox-smoke --environment sandbox --archive
```

This must hold for every path that materializes a workflow script job: `eve workflow invoke`, cron-triggered workflow runs, and dependent (multi-step) workflow script steps.

## Design

Three small changes, mostly mirroring code that already exists for the agent path. **No new app-link manifest grammar.** The explicit `with_links` workflow/step field floated in the gap report is intentionally a non-goal (see below) — auto-injection via `inject_into.jobs: true` is enough, but workflow jobs need their own `WorkflowsService` resolution because they are persisted through `jobQueries.create`, not `JobsService.create`. Typing the existing workflow-level `env` field is part of the fix, but it is not a new consumer app-link opt-in.

### Phase 1 — Declare and carry the workflow `env` onto workflow jobs

Fix the `env_name: null` defect so app-link resolution mints the token/URL for the correct producer env.

- In `packages/shared/src/schemas/workflow.ts`, add `env: z.string().min(1).optional()` to `WorkflowDefinitionSchema`. Today `env` survives only because the schema is `.passthrough()`, which leaves the implementation relying on an untyped extra field.
- In `apps/api/src/workflows/workflows.service.ts`, resolve the workflow-level `env` once near the rest of the shared invocation context (e.g. `const workflowEnvName = typeof workflow.definition.env === 'string' ? workflow.definition.env : null`) and pass it as `env_name` instead of the hard-coded `null` on both the root/container job (`:933`) and each step child (`:1101`).
- The root job does not execute, but it still carries workflow hints and app-link metadata for audit/propagation. Scope the root consistently with the children.
- Also pass `workflowEnvName` into the workflow service's same-project `with_apis` resolution (`this.resolveAppApis(projectId, stepDescription, stepApis, workflowEnvName)`) so workflow agent steps keep env-scoped API behavior aligned with direct jobs. This is adjacent to the app-link bug; script app-links use the workflow-local resolver added below.
- Add workflow-local app-link resolution in `WorkflowsService` so subscriptions with `inject_into.jobs: true` are discovered/resolved before root and step rows are created. Supplying the real env name makes `environment: same` subscriptions resolve the producer env correctly.
- Guard: workflows with no `env` keep `env_name: null` (unchanged behaviour). Confirm no existing test asserts `env_name === null` on a workflow child with an `env` declared; update any that do — this was a latent bug, not a contract.

> Note: for fixed-environment app-link subscriptions, Phase 2 can make vars appear even if `env_name` remains null. For `environment: same`, Phase 1 is required for correct producer-env resolution and may be required for job creation to succeed at all.

### Phase 2 — Inject `EVE_APP_LINK_*` in the script executor

Make `ScriptExecutorService` honor `hints.resolved_app_links`, mirroring `apps/worker/src/invoke/invoke.service.ts:1954-1974`.

- In `apps/worker/src/script-executor/script-executor.service.ts`, import `buildAppApiEnvVars`, `mintAppLinkToken`, and the relevant `AppApiInfo` type from `@eve/shared`. `execute()` already loads the job (`:150-169`); read `job.hints.resolved_app_links` there. If the `jobs.findById` projection ever lacks `hints`, extend that query rather than adding a separate ad hoc DB read.
- For each resolved link, call `mintAppLinkToken({ subscriptionId: link.subscription_id, consumerPrincipal: \`job:${jobId}\`, consumerEnv: envName ?? null, producerEnv: link.producer_env ?? null, ttlSeconds: 60*60 })`.
- Treat a null token result or missing `access_token` as a script-step failure with a clear message naming the alias/subscription, not as a silent non-fatal warning. The agent path currently catches this setup as non-fatal because the prompt still contains URL instructions; scripts have no equivalent fallback and should fail fast when a required link token cannot be minted.
- Build the env map with `buildAppApiEnvVars([...resolvedLinksWithTokens])` and thread it into the `runScript(...)` context (new `appLinkEnv?: Record<string,string>` field on the context object at `:658-674`).
- In `runScript()` merge `appLinkEnv` into `env` after toolchain provisioning and **before** `applyEnvOverrides(...)` (`:721`), so an explicit author `env_overrides` key can still override a link var if they truly need to. Token minting is async — keep it inside the existing `try` so a mint failure surfaces as a normal step failure with a clear message, not a crash.
- Reserved-key safety: `EVE_APP_LINK_*` are not in the reserved set; no strip needed. Do **not** log token values — log only the injected key names (mirror the `Applied env_overrides:` status log at `:730-734`).

### Phase 3 — Tests

- **Unit (`packages/shared`)**: `buildAppApiEnvVars` already has one app-link case; add a case asserting two app_link entries (`observation`, `observation-ingest`) produce all ten expected vars with the alias-uppercasing rule (`observation-ingest` -> `OBSERVATION_INGEST`). Also add a workflow schema case in `packages/shared/src/schemas/__tests__/workflow.spec.ts` proving `WorkflowDefinitionSchema` accepts and preserves `env: sandbox`.
- **Unit (worker)**: extend `apps/worker/src/script-executor/script-executor.toolchains.spec.ts` style harness — add `mintAppLinkToken` to the existing `@eve/shared` mock, construct a job with `hints.resolved_app_links`, assert the launched script sees `EVE_APP_LINK_OBSERVATION_API_URL` / `_TOKEN`, assert `consumerEnv` is passed to `mintAppLinkToken`, assert an `env_overrides` key with the same name wins, and assert a null token result fails before bash runs.
- **Unit (api)**: add coverage in `apps/api/src/workflows/workflows.service.spec.ts` asserting a workflow with `env: sandbox` creates the root and step children with `env_name: 'sandbox'` (Phase 1 regression guard), while a workflow without `env` still persists `env_name: null`.
- **Integration (`./bin/eh test integration`)**: workflow with one `script:` step that prints only app-link key names plus non-secret URL/env values, and redacts token values itself. Assert the API-created job carries `hints.resolved_app_links` and the script log shows both link API URLs plus `_TOKEN=<redacted:true>` markers.

## Acceptance criteria

1. Invoking `load-sandbox` with `LOAD_API_URL=` and `LOAD_INGEST_API_URL=` succeeds on the `smoke` step.
2. `eve job show <workflow-script-child> --json` records app-link link metadata (`hints.resolved_app_links` populated) instead of an empty set.
3. The script runtime reads `EVE_APP_LINK_OBSERVATION_API_URL` and `EVE_APP_LINK_OBSERVATION_INGEST_API_URL` (and their `_TOKEN`) with **no** manifest fallback env vars.
4. The same behaviour holds for cron-triggered workflow runs, manual `eve workflow invoke`, and dependent (multi-step) workflow script steps.
5. Token values never appear in job logs; platform status logs include only injected key names, and verification scripts redact token values before printing.

## Verification on local k3d

The contract must be proven on the local k3d stack before tagging, using `eve local mesh` to stand up a producer + consumer app-link without staging.

```bash
# 0. Stack up (owner only)
./bin/eh status
./bin/eh k8s start && ./bin/eh k8s deploy
export EVE_API_URL=http://api.eve.lvh.me
eve system health --json        # {"status":"ok"}

# 1. Producer project that EXPORTS an app api ("observation"-style), deployed to env `sandbox`.
#    Consumer project that CONSUMES it with inject_into.jobs: true and a `load-sandbox`
#    workflow whose single script step prints EVE_APP_LINK_* keys and URL/env values,
#    but prints _TOKEN=<redacted:true|false> instead of token values (fixtures under tests/manual).
eve local mesh init applink-smoke --org org_manualtestorg --env local
eve local mesh add producer --path <producer-checkout>
eve local mesh add consumer --path <consumer-checkout>
eve local mesh up               # syncs manifests, mints grants/subscriptions

# 2. Invoke the workflow with manifest fallbacks blanked, exactly like the staging repro.
eve workflow invoke load-sandbox --project <consumer_proj_id> \
  --env-override LOAD_API_URL= --env-override LOAD_INGEST_API_URL=

# 3. Inspect the script child.
ROOT=<root-job-id>
eve job show ${ROOT}.1 --json | jq '.hints.resolved_app_links'   # non-empty (AC #2)
eve job logs ${ROOT}.1 | grep EVE_APP_LINK_OBSERVATION            # API URLs + token-present markers
eve job result ${ROOT}.1                                          # step succeeds (AC #1, #3)
```

Then prove path coverage (AC #4):

- **Cron**: attach a `cron.tick` trigger to `load-sandbox`, let it fire (or `eve event emit cron.tick`), and repeat the child inspection.
- **Dependent steps**: add a second `script:` step depending on `smoke`; confirm it also receives the vars.

Pass bar: every script child shows populated `hints.resolved_app_links`, both `_API_URL` vars and redacted `_TOKEN=<redacted:true>` markers in the script env, and a green step result — with `LOAD_API_URL` / `LOAD_INGEST_API_URL` empty. Capture job IDs and the redacted app-link env log line in the PR.

### Completion evidence (2026-06-02)

- Full build: `pnpm build` passed.
- Full unit suite: `pnpm test` passed.
- Focused gates passed:
  - `pnpm --filter @eve/shared exec vitest run src/schemas/__tests__/workflow.spec.ts src/schemas/__tests__/app-api-instruction-block.spec.ts`
  - `pnpm --filter @eve/api exec vitest run src/workflows/workflows.service.spec.ts`
  - `pnpm --filter @eve/worker test -- src/script-executor/script-executor.toolchains.spec.ts`
  - `./bin/eh test integration --target test/integration/pipelines-workflows.integration.test.ts`
- Full integration gate: `./bin/eh test integration` passed with 60 files passed, 6 skipped, 203 tests passed.
- Local k3d app-link mesh:
  - `./bin/eh k8s deploy` completed and `eve system health --json` returned `status=ok`.
  - `eve local mesh up --workspace lmesh-workflow-links` synced/deployed producer `proj_example` and consumer `proj_example`.
  - Manual invoke root `cons-dd382bb6` completed; script children `cons-dd382bb6.1` and `cons-dd382bb6.2` were `done`, `env_name=local`, and carried resolved `observation` plus `observation-ingest` app links.
  - Event/cron root `cons-0f5d309d` from event `evt_01kt41rqj0eh5veddtde151m3m` completed; children `cons-0f5d309d.1` and `cons-0f5d309d.2` were `done` with the same resolved links.
  - Script logs showed injected key names only plus redacted markers such as `EVE_APP_LINK_OBSERVATION_TOKEN=<redacted:true>` and never printed token values.

## Non-goals

- No change to the app-level load harness semantics.
- No new app-link manifest grammar. The explicit `with_links:` workflow/step field from the gap report is **not** added — auto-injection via `inject_into.jobs: true` already carries resolved links onto the job row, so adding a parallel opt-in field would be redundant surface area. Revisit only if a future case needs a script step to consume a link the project did *not* mark `inject_into.jobs: true`. The workflow-level `env` field already exists in manifests; this plan only makes it explicit in the shared schema and carries it into job rows.
- No exposure of producer **database** credentials to workflow jobs — only the link's HTTP base URL + scoped short-lived token.
- No new long-lived secret or copied-URL mechanism. Tokens are minted per-job with a 1h TTL, identical to the agent path.

## Docs to update on ship (eve-skillpacks sync obligation)

- `references/pipelines-workflows.md` § Multi-Step Workflow Expansion — note that workflow `script:` steps receive `EVE_APP_LINK_*` for `inject_into.jobs: true` subscriptions, and that the workflow `env:` now scopes the child job's env for link resolution.
- `references/pipelines-workflows.md` § Workflow schema — list the existing workflow-level `env:` field if it is not already documented there.
- `references/manifest.md` § Cross-Project App Links — clarify `inject_into.jobs: true` covers workflow script steps, not just agent jobs.
- `references/jobs.md` — script-job env now includes resolved app-link vars.

## See Also

- `[[plans/2026-06-01-load-testing-and-optimisation/05-optimisation-rollout]]`
- `[[plans/2026-05-20-observation-platform-skeleton/06-evals-and-load-verification]]`
- `[[decisions/0005-core-and-satellite-eve-projects]]`
- `core/.eve/manifest.yaml`
- `.agents/skills/eve-read-eve-docs/references/manifest.md` § Cross-Project App Links
- `.agents/skills/eve-read-eve-docs/references/pipelines-workflows.md` § Multi-Step Workflow Expansion
- Code anchors: `apps/api/src/jobs/jobs.service.ts:637-650`, `apps/api/src/workflows/workflows.service.ts:789-801,1101`, `apps/worker/src/invoke/invoke.service.ts:1954-1974`, `apps/worker/src/script-executor/script-executor.service.ts:655-745`, `packages/shared/src/schemas/api-source.ts:126-143`, `packages/shared/src/api-client/auth-client.ts:148`
