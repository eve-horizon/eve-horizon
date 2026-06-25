# Non-Agent Job Scoped Credentials Plan

> **Status**: Proposed
> **Created**: 2026-05-14
> **Origin**: External gap report — non-agent execution paths (`execution_type` of `script` and `action`) mint job tokens with hard-coded permission lists and do not propagate the persisted `jobs.token_scope`. Result: a pipeline that mixes agent steps and deterministic steps cannot apply the same least-privilege model end-to-end. Filers worked around it by wrapping deterministic work in an LLM harness just to receive a scoped Eve token.
> **Filed by**: `gap_reports/non-agent-jobs-declarative-credentials.md`

---

## The Problem

Agent jobs have a clean declarative path for scoped credentials:

1. `agents.yaml` declares `access.permissions: [...]`.
2. `apps/agent-runtime/src/invoke/invoke.service.ts:680` (`resolveAgentPermissions`) reads the named agent, merges with `DEFAULT_AGENT_PERMISSIONS`, and threads the list into `resolveInvocationJobToken`.
3. The orchestrator already attaches `__eve_job_scope` to the invocation envelope (`apps/orchestrator/src/loop/loop.service.ts:1954` via `resolveJobScope`).
4. `packages/shared/src/invoke/eve-credentials.ts:58` mints the JWT with both `permissions` and `scope`, then writes `~/.eve/credentials.json` inside the job-user HOME.

Non-agent execution paths skip every one of those rails:

- **Worker invoke (`apps/worker/src/invoke/invoke.service.ts:1927-1931`)** calls `writeEveCredentials(invocation, invocationToken, jobUserHome)` with **no permissions argument and no scope argument**. The mint falls back to `DEFAULT_AGENT_PERMISSIONS` and ignores `__eve_job_scope` unless the harness happens to be agent-shaped. For harness-driven jobs that the worker still owns (legacy / `execution_type='agent'` worker path) this asymmetry is invisible; for anything else it is wrong by default.
- **Script executor (`apps/worker/src/script-executor/script-executor.service.ts:18`)** owns a hard-coded `SCRIPT_JOB_PERMISSIONS` constant. The script command's `EVE_JOB_TOKEN` is minted from that fixed list. `jobs.token_scope` — already persisted on every script job by the workflow expander (`apps/api/src/workflows/workflows.service.ts:875`) — is **never read**. Effect: a workflow author can write `scope: { orgfs: { paths: ["..."] } }` on a `script:` step, the platform stores it on the row, and the executor silently drops it on the floor.
- **Action executor (`apps/worker/src/action-executor/action-executor.service.ts:986-1101`, `handleRun`)** shells out user commands via `bash -lc` with `process.env` plus `EVE_PROJECT_ID`. There is **no `EVE_JOB_TOKEN` and no `~/.eve/credentials.json`** for action jobs at all. Any `eve …` call from a `type: run` step is unauthenticated by construction.

The downstream effect: the only way to call the Eve CLI from a deterministic pipeline step with least privilege today is to put an LLM harness in front of it. That spends harness minutes on shell work, and it inverts the intent — agents should be the high-trust path, not the credential shim for scripts.

---

## 5 Whys Root Cause Analysis

### Why #1: Why do script/action jobs ignore `jobs.token_scope`?

The non-agent executors were written before `token_scope` existed on the job row. `script-executor.service.ts` mints its token with `mintJobToken(jobId, { permissions: SCRIPT_JOB_PERMISSIONS })` — no `scope` argument. `action-executor.service.ts` doesn't mint a token at all. The orchestrator's `resolveJobScope` plumbs the scope into the *invocation envelope* (`__eve_job_scope`) for agent-runtime consumption; the worker's script/action paths never touch the envelope, so the scope evaporates.

### Why #2: Why do scripts use a single hard-coded permission constant?

`SCRIPT_JOB_PERMISSIONS` was designed for one customer: a workflow that runs platform operations (migrations, env writes, releases). It hard-codes the union of permissions those operations need. New use cases — `orgfs:read` for staging, `cloud_fs:read` for fetching artefacts, `endpoints:write` for provisioning — have nowhere to land. Adding them to the constant grants them to *every* script job in the system. The contract is "fixed wide", not "per-job narrow".

### Why #3: Why do action jobs have no credential path at all?

Action jobs were modelled as built-in platform operations (`build`, `release`, `deploy`, `env-ensure`, `notify`, `create-pr`) that the worker performs *on behalf of* the project — they call platform APIs from inside `ActionExecutorService` using the worker's own internal credentials. The `type: run` shape (arbitrary bash with a workspace) was added later, on the same scaffolding, without revisiting credential delivery for user code.

### Why #4: Why isn't the credential injection centralised so all three paths look identical?

`packages/shared/src/invoke/eve-credentials.ts` is parameterised correctly — it already accepts `permissions` and `scope`. But the three call sites use it (or don't) ad hoc:

| Caller | Permissions arg | Scope arg | Credential file | `EVE_JOB_TOKEN` env |
| --- | --- | --- | --- | --- |
| `agent-runtime/invoke.service.ts` | resolved from `access.permissions` | from invocation (`__eve_job_scope`) | yes (job-user HOME) | yes |
| `worker/invoke.service.ts` | omitted → defaults | omitted | yes | yes |
| `worker/script-executor.service.ts` | `SCRIPT_JOB_PERMISSIONS` constant | omitted | **no** (only `EVE_JOB_TOKEN`) | yes |
| `worker/action-executor.service.ts` (`handleRun`) | none | none | **no** | **no** |

There's no shared "make a job-shaped runtime environment" helper. Each path open-codes a different subset.

### Why #5: Why hasn't this been caught by tests?

No manual scenario or integration test exercises a non-agent pipeline step that calls the Eve CLI with a scope that should be enforced. The closest scenario (`24-project-secret-scope-regression.md`) is about *secret* scoping at deploy time, not *token* scoping at job runtime. The eval surface for "script step's `EVE_JOB_TOKEN` honours `jobs.token_scope`" simply does not exist.

---

## Root Cause Summary

Four compounding gaps:

1. **No job-row permission declaration for non-agent steps.** `agents.yaml` carries `access.permissions` for agents; nothing carries equivalent declarations for `script:` or `action:` steps in `manifest.yaml` workflows/pipelines.
2. **Hard-coded permission constants instead of resolved per-job lists** in `script-executor.service.ts`.
3. **`jobs.token_scope` ignored** by both script and action executors despite being persisted by the workflow expander.
4. **No credential injection at all** for `action: { type: run }` jobs.

The fix is symmetry: a non-agent step should be able to say "I need `orgfs:read` and `cloud_fs:read`, narrowed to these paths" in the same declarative shape an agent uses, the platform stores those on the job row, every executor reads them, and the same `writeEveCredentials` helper writes the same credential file with the same `EVE_JOB_TOKEN` env regardless of execution type.

---

## Goals & Non-Goals

### Goals

- A pipeline/workflow step author can declare per-step `permissions: [...]` and `scope: { ... }` for `script:` and `action:` steps with the same ergonomics as agent step `scope:`.
- Script and action jobs persist that permission list on the job row alongside the existing `token_scope`.
- `script-executor.service.ts` mints `EVE_JOB_TOKEN` using the persisted permissions and scope; `SCRIPT_JOB_PERMISSIONS` survives only as the backwards-compatible default for steps that don't declare anything.
- `action-executor.service.ts handleRun` writes `~/.eve/credentials.json` and exports `EVE_JOB_TOKEN` exactly like the script path.
- `eve job show <id> --verbose` and `eve job diagnose <id>` surface the resolved permissions + scope, redacted as needed.
- Manual scenario(s) and an integration test prove that an over-broad request from inside a scoped script step is denied by the API, both locally and on staging.

### Non-Goals

- Reworking the auth-guard scope model itself — `AccessBindingScope` already supports orgfs paths, cloud_fs, envdb, etc. We are wiring it through more code paths, not redesigning it.
- Per-action-type permission templates (e.g., "every `type: build` step gets `builds:write`"). Action executors call APIs as the *worker*, not as the job; only the `type: run` shape is in scope here for token injection. Other action types continue to use the worker's internal auth.
- Revisiting the agent step path — `access.permissions` already works on agents and stays unchanged.
- Migrating existing pipelines. Default behaviour preserves today's `SCRIPT_JOB_PERMISSIONS`; opt-in via the new manifest field.

---

## Proposed Changes

### 1. Add `token_permissions` to the job row

**Files:**
- `packages/db/migrations/00XXX_job_token_permissions.sql` (new)
- `packages/db/src/types/job.ts`
- `packages/shared/src/schemas/job.ts`
- `apps/api/src/jobs/jobs.service.ts` (`CreateJobRequest` / `create` / `findById` / `toJobResponse`)

**Migration:**

```sql
ALTER TABLE jobs
  ADD COLUMN token_permissions text[] NULL;
COMMENT ON COLUMN jobs.token_permissions IS
  'Per-job permission grants for EVE_JOB_TOKEN minting. NULL = use defaults by execution_type.';
```

`text[]` (not jsonb) because the values are flat and validated against `ALL_PERMISSIONS`. Nullable — `NULL` means "fall back to the execution-type default" (preserves today's behaviour).

**Validation:** `JobsService.create` calls `validateTokenPermissions(perms)` which checks every entry against `PERMISSION_SET` from `packages/shared/src/permissions.ts` and rejects unknown values with `400 Bad Request`. Mirrors the existing `assertActorCanUseScope` flow for `token_scope`.

**API DTO additions:**
- `CreateJobRequest.token_permissions?: string[] | null`
- `JobResponse.token_permissions: string[] | null`

### 2. Manifest schema: per-step `permissions`

**File:** `packages/shared/src/schemas/pipeline.ts`

```ts
export const PipelineStepSchema = z.object({
  // … existing fields …
  scope: AccessBindingScopeSchema.optional(),
  permissions: z.array(z.string().min(1)).optional(),   // NEW
}).refine(/* … */);

export const PipelineDefinitionSchema = z.object({
  // … existing fields …
  scope: AccessBindingScopeSchema.optional(),
  permissions: z.array(z.string().min(1)).optional(),   // NEW (workflow-level default)
}).passthrough();
```

Workflows reuse the same pipeline step schema (`apps/api/src/workflows/workflows.service.ts` already calls `PipelineStepSchema` indirectly via the workflow definition validator), so no separate workflow schema change is needed beyond exposing the merged value.

**Merge semantics (mirrors `token_scope` precedence):**

1. Invocation override (`POST /workflows/:name/invoke { permissions: [...] }`) — admin actors only.
2. Step-level `permissions` (innermost wins).
3. Workflow/pipeline-level `permissions`.
4. Execution-type default (`SCRIPT_JOB_PERMISSIONS` for `script`, `RUN_ACTION_JOB_PERMISSIONS` for `action: { type: run }`, `DEFAULT_AGENT_PERMISSIONS` for `agent` — unchanged).

### 3. Workflow / pipeline expanders persist `token_permissions`

**Files:**
- `apps/api/src/workflows/workflows.service.ts` (root + step job creates)
- `apps/api/src/pipelines/pipeline-expander.service.ts` (`expand` + retry path)

Both expanders already compute `stepJobTokenScope` via `parseTokenScope` + `mergeStepTokenScope` + `assertActorCanUseScope`. Add a parallel `stepJobTokenPermissions` chain:

```ts
const stepTokenPermissions = parseTokenPermissions(step.permissions, /* path */);
const stepJobTokenPermissions = mergeStepTokenPermissions(
  workflowTokenPermissions,
  stepTokenPermissions,
  invocationTokenPermissions,
);
await assertActorCanGrantPermissions(orgId, projectId, userId, stepJobTokenPermissions);
```

`assertActorCanGrantPermissions` rejects any permission the *invoking actor* does not themselves hold — actors can narrow, not escalate. Reuses the same membership/role lookups as `assertActorCanUseScope`.

### 4. New defaults catalogue

**File:** `packages/shared/src/permissions.ts`

Move the `SCRIPT_JOB_PERMISSIONS` constant out of `script-executor.service.ts` into the shared module and add a sibling for action-`run`:

```ts
export const DEFAULT_SCRIPT_JOB_PERMISSIONS: readonly Permission[] = [
  'jobs:read', 'jobs:write',
  'projects:read',
  'envs:read', 'envs:write',
  'envdb:read', 'envdb:write',
  'releases:read', 'builds:read', 'pipelines:read',
  'secrets:read',
];

export const DEFAULT_ACTION_RUN_JOB_PERMISSIONS: readonly Permission[] = [
  'jobs:read', 'jobs:write',
  'projects:read',
  'envs:read',
  'secrets:read',
];
```

Two defaults, not one: `script:` steps in pipelines have historically been platform-operations (migrations, env writes, releases), so the legacy default stays broad. `action: { type: run }` is "arbitrary user shell command" and gets a much narrower read-only default. Workflow authors widen via explicit `permissions:`.

Also fix a stale label: the current `SCRIPT_JOB_PERMISSIONS` includes `'environments:read'` / `'environments:write'`, which are **not** valid permissions (`ALL_PERMISSIONS` uses `envs:*`). Net effect today: silently ignored. The new shared constants use the correct names.

### 5. Resolve permissions + scope at dispatch time, not at creation time

**File:** `apps/orchestrator/src/loop/loop.service.ts` (around `resolveJobScope` / invocation construction)

The orchestrator already attaches `__eve_job_scope` to the invocation envelope for agent-routed jobs. Add a parallel `__eve_job_permissions` and ensure both are read by every executor:

```ts
if (job.token_scope) invocationData.__eve_job_scope = tokenScope;
if (job.token_permissions) invocationData.__eve_job_permissions = job.token_permissions;
```

Define the helper once in `packages/shared/src/invoke/eve-credentials.ts`:

```ts
export function getInvocationJobPermissions(
  invocation: HarnessInvocation,
): string[] | undefined { /* parse + validate */ }
```

And extend `writeEveCredentials` callers to prefer `invocation.data.__eve_job_permissions` over the executor's hard-coded list.

### 6. Script executor: read job-row permissions + scope

**File:** `apps/worker/src/script-executor/script-executor.service.ts`

```ts
// Before mintJobToken:
const job = await this.jobs.findById(jobId);
const permissions =
  job?.token_permissions ??
  DEFAULT_SCRIPT_JOB_PERMISSIONS;
const scope = job?.token_scope ?? undefined;

const tokenResult = await mintJobToken(jobId, { permissions, scope });
```

Also write the credentials file (not only the env var) so `eve` CLI invocations from inside the script can use the standard credential resolution path — matches the agent-runtime layout.

### 7. Action executor (`handleRun`): inject credentials

**File:** `apps/worker/src/action-executor/action-executor.service.ts`

`handleRun` currently shells out `bash -lc command` with `cwd: workspace, env: { ...process.env, EVE_PROJECT_ID }`. Three changes:

- Mint a job token using `job.token_permissions ?? DEFAULT_ACTION_RUN_JOB_PERMISSIONS` and `job.token_scope`.
- Write `~/.eve/credentials.json` into a workspace-local HOME (mirrors `createJobUserHome` from worker invoke).
- Sanitise the env: don't leak the worker's `EVE_INTERNAL_API_KEY` or `process.env.HOME` into the user command. Replace with the same `buildSanitizedHarnessEnv`-style allowlist used by the agent path.

The handler signature stays the same; the workspace cleanup already runs in a `finally` block.

### 8. CLI surfacing

**Files:**
- `packages/cli/src/commands/job/show.ts`
- `packages/cli/src/commands/job/diagnose.ts`

Both already render `token_scope` when `--verbose` / `--json`. Add `token_permissions` adjacent. `diagnose` adds a hint when a step's permissions are obviously misaligned with its scope (e.g., declares `scope.orgfs.paths` but no `orgfs:read` in permissions).

### 9. Reference docs

**Files:**
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/pipelines-workflows.md` (step shape, `permissions:` and `scope:` examples for non-agent steps)
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/jobs.md` (new `token_permissions` field on the job row)
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/secrets-auth.md` (least-privilege defaults catalogue)

Sync obligation per `CLAUDE.md`'s skillpacks-sync rule. Without these, agents writing manifests will keep open-coding workarounds.

---

## Out of Scope (Adjacent, Not Solved Here)

- **Per-action-type permission templates** (e.g., infer `releases:write` from `type: release`). Built-in actions don't need a job token because they don't run user code — they call platform APIs as the worker itself. We deliberately keep that path internal.
- **Pre-flight permission checks on the API side** ("this manifest declares `endpoints:write` but actor doesn't hold it") — covered for runtime via `assertActorCanGrantPermissions`, but a manifest-sync linter would be a follow-up.
- **Token-permission audit log entries.** Today the auth guard logs allow/deny on each request; surfacing "this denial happened because the job's `token_permissions` didn't include X" in the diagnose path is a follow-up once the basics work.

---

## Eval Loop Against Staging

The eval loop is the part that makes this real. Without it, "scope is honoured" is a code-review claim, not a tested guarantee. We add scenarios that work identically against local k3d and staging, plus a CI gate.

### Eval Goals

1. **Positive control:** a `script:` step declaring `permissions: ['orgfs:read']` + `scope: { orgfs: { paths: ['/allowed/**'] } }` can read `/allowed/foo.txt` and gets `200`.
2. **Negative control — path scope:** the same step trying to read `/forbidden/foo.txt` gets `403`, and the executor doesn't crash on the denial.
3. **Negative control — missing permission:** a step declaring only `permissions: ['jobs:read']` trying to call `eve orgfs read /allowed/foo.txt` gets `403`.
4. **Action `type: run` parity:** all of the above repeated with an `action: { type: run, command: 'eve …' }` step.
5. **Back-compat:** a `script:` step with no `permissions:` and no `scope:` continues to behave identically to today (uses `DEFAULT_SCRIPT_JOB_PERMISSIONS`, no scope narrowing).
6. **Cross-environment parity:** the same scenario script passes against `http://api.eve.lvh.me` and `https://api.eve.example.com`.

### Scenario File

**Path:** `tests/manual/scenarios/32-non-agent-scoped-credentials.md`

**Shape (sketch — final wording follows the existing scenario template):**

```bash
# Prereqs: EVE_API_URL set, manual-test-org provisioned (scenario 01 style)
export RUN_ID=$(date +%s)
export PROJECT_NAME="scope-test-${RUN_ID}"
export PROJECT_SLUG="sct${RUN_ID}"
eve project ensure --org $ORG_ID --name "$PROJECT_NAME" --slug "$PROJECT_SLUG" \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example --branch main --json
# (Bind PROJECT_ID, sync manifest)

# Seed orgfs with allowed/forbidden fixtures
eve orgfs upload --org $ORG_ID /allowed/ok.txt   --file <(echo ok)
eve orgfs upload --org $ORG_ID /forbidden/no.txt --file <(echo no)

# Invoke a workflow that declares per-step permissions + scope
eve workflow invoke scope-test-positive --project $PROJECT_ID --json
eve workflow invoke scope-test-negative-path --project $PROJECT_ID --json
eve workflow invoke scope-test-negative-perm --project $PROJECT_ID --json

# Assertions: positive returns 0, negatives return non-zero with a 403 in logs
```

The fixture workflow definitions live alongside the scenario in `tests/manual/scenarios/fixtures/non-agent-scope/`:

```yaml
# manifest.yaml fragment
workflows:
  scope-test-positive:
    steps:
      - name: read-allowed
        script:
          command: eve orgfs read /allowed/ok.txt
        permissions: [orgfs:read]
        scope:
          orgfs: { paths: ["/allowed/**"] }

  scope-test-negative-path:
    steps:
      - name: read-forbidden
        script:
          command: eve orgfs read /forbidden/no.txt
        permissions: [orgfs:read]
        scope:
          orgfs: { paths: ["/allowed/**"] }   # narrower than the request

  scope-test-negative-perm:
    steps:
      - name: read-without-perm
        script:
          command: eve orgfs read /allowed/ok.txt
        permissions: [jobs:read]              # missing orgfs:read
```

Repeat each in `action: { type: run, command: '…' }` form so action-path parity is covered.

### Eval Loop Mechanics

A single script — `tests/manual/scenarios/32-non-agent-scoped-credentials.sh` — drives the scenario non-interactively and emits JSONL results:

```jsonl
{"case": "positive-script-orgfs",          "expected": "success", "actual": "success", "pass": true}
{"case": "negative-path-script-orgfs",     "expected": "denied",  "actual": "denied",  "pass": true}
{"case": "negative-perm-script-orgfs",     "expected": "denied",  "actual": "denied",  "pass": true}
{"case": "positive-action-run-orgfs",      "expected": "success", "actual": "success", "pass": true}
{"case": "negative-path-action-run-orgfs", "expected": "denied",  "actual": "denied",  "pass": true}
{"case": "negative-perm-action-run-orgfs", "expected": "denied",  "actual": "denied",  "pass": true}
{"case": "backcompat-script-no-decl",      "expected": "success", "actual": "success", "pass": true}
```

The script accepts `--env=local|staging` and switches `EVE_API_URL` + admin email + SSH key accordingly. Pass/fail summary at exit code level so it can be wrapped by `eve job` for fully automated runs.

### Run Cadence

| When | Where | How |
| --- | --- | --- |
| Each PR touching `script-executor`, `action-executor`, or `mintJobToken` | Local k3d | Reviewer runs `./tests/manual/scenarios/32-…sh --env=local`. |
| Pre-release (`release-v*` tag candidate) | Staging | Owner of staging runs `--env=staging` and pastes the JSONL block into the PR. |
| Nightly | Staging | A `cron` workflow (`apps/api/src/workflows/cron/*`) invokes the same fixture project. Failures emit `system.scenario.failed` events. |

The nightly cron is the eval loop: a regression that lands silently still fires the scenario the next morning, surfaces as a failed workflow on staging, and pages the staging owner.

### What "Done" Looks Like

- All seven cases pass on local k3d.
- All seven cases pass on staging (`api.eve.example.com`) after deploying the change via the normal `release-v*` flow.
- Nightly cron has run green on staging for 3 consecutive days before the feature is considered shipped.
- `eve job show <id> --verbose` on each scenario job shows the resolved `token_permissions` and `token_scope` matching the manifest declaration.

---

## Migration / Rollout Plan

Pre-deployment phase per `CLAUDE.md` rule 6 — no users, no backwards-compat shims. Even so, the change is *additive*:

1. Ship the migration. `token_permissions` column added; all existing rows are `NULL` and behave as before.
2. Ship the executor changes. `NULL` permissions fall back to defaults, so existing pipelines are unaffected.
3. Ship the manifest schema changes. Authors can now opt in by declaring `permissions:` / `scope:` on `script:` / `action:` steps.
4. Ship the scenarios + cron. Nightly eval starts running.
5. Sync skillpack docs in the same PR (per `CLAUDE.md` sync obligation).
6. Update the gap report to reference this plan and mark `non-agent-jobs-declarative-credentials.md` as addressed.

Rollback is just reverting the migration (`token_permissions` is unused by older code).

---

## Beads Issues to File

When this plan is approved, file one bead per top-level section so the work can flow through `bd ready`:

| Title | Type | Priority | Notes |
| --- | --- | --- | --- |
| Add `token_permissions` column + DTO + validation | task | P2 | Section 1; blocks 6 and 7 |
| Add `permissions:` to pipeline/workflow step schema | task | P2 | Section 2 |
| Persist `token_permissions` in workflow + pipeline expanders | task | P2 | Sections 3, depends on 1+2 |
| Move script/action defaults into `permissions.ts` | task | P3 | Section 4 |
| Plumb `__eve_job_permissions` through orchestrator + invocation | task | P2 | Section 5, depends on 1 |
| Script executor: read job-row permissions + scope + write credentials.json | feature | P2 | Section 6, depends on 5 |
| Action executor: inject scoped credentials in `handleRun` | feature | P2 | Section 7, depends on 5 |
| CLI: surface `token_permissions` in `job show --verbose` and `job diagnose` | task | P3 | Section 8 |
| Sync skillpack reference docs (`pipelines-workflows.md`, `jobs.md`, `secrets-auth.md`) | task | P2 | Section 9 |
| Write scenario 32 + fixtures + driver script | task | P2 | Eval loop |
| Wire nightly cron workflow on staging that runs scenario 32 | task | P2 | Eval loop, depends on previous |

`bd dep add` to chain blockers per the dependency notes.

---

## Open Questions

1. **Default for `action: { type: run }` — `jobs:read` only, or include `secrets:read`?** Today's `handleRun` env-injection path doesn't surface secrets. Including `secrets:read` is convenient for shell scripts that need to call other services; excluding it follows least-privilege. Recommendation: exclude; authors opt in.
2. **Should `permissions:` validation happen at manifest-sync time or only at job-create time?** Sync-time gives faster feedback but means the linter needs the permission catalogue; create-time keeps the validator authoritative. Recommendation: both — sync-time warning, create-time hard reject.
3. **Do we want a `token_permissions` invocation override (`POST /workflows/:name/invoke { permissions: [...] }`)?** Useful for one-off ops runs; risky as a footgun. Recommendation: yes, but gated to admin actors and logged in the audit trail, mirroring `scope:` override behaviour.
