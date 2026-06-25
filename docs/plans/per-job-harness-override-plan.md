# Per-Job Harness Profile & Env Overrides — Implementation Plan

> **Status**: Proposed
> **Date**: 2026-04-21
> **Spec**: [`docs/ideas/eve-platform-per-job-harness-override-spec.md`](../ideas/eve-platform-per-job-harness-override-spec.md)
> **Motivating consumer**: Eden (per-Eden-project brains: Claude/OpenAI/Gemini/self-hosted Qwen)
> **Tracking**: `eve-horizon-715w`
> **Related**: supersedes the earlier per-project profile sketch; shipped profile source is `x-eve.agents.profiles`

## 1. Problem Recap

Eve resolves `harness_profile: <name>` at dispatch time from `agent_config.x_eve_yaml`
(synced via `eve agents sync`). One project = one set of profiles. Eden hosts N
user-owned sub-projects inside a single Eve project and needs each to pick a
different brain (model, endpoint, BYOK credentials, reasoning effort) per request.

Today, mutating `eve/x-eve.yaml` + re-syncing per request is racy, slow, visible
on shared state, and impossible for chat-originated jobs. We need a first-class
per-invocation **inline profile override** plus **env overrides** with
`${secret.KEY}` interpolation, on every dispatch path.

## 2. Existing Landscape

| Area | File(s) | What's there today |
|------|---------|--------------------|
| Job DTOs | `packages/shared/src/schemas/job.ts:83` | `harness`, `harness_profile` (string), `harness_options` on `CreateJobRequest` / `UpdateJobRequest`. No `harness_profile_override`, no `env_overrides`. |
| Job storage | `packages/db/migrations/00022_add_job_harness_fields.sql` | `jobs.harness`, `jobs.harness_profile`, `jobs.harness_options JSONB`. No override or env_overrides columns. |
| Profile resolver (chat) | `apps/api/src/chat/chat.service.ts:1175` | `resolveHarnessProfile(projectId, profileName)` reads `agent_config.x_eve_yaml`, falls back to manifest. Called in 8 dispatch sites. |
| Profile resolver (workflow) | `apps/api/src/workflows/workflows.service.ts:558` | Inline resolution inside `resolveAgentConfig`. Duplicated logic. |
| Chat request schema | `packages/shared/src/schemas/agent-primitives.ts:125` | `ChatRouteRequestSchema` / `ChatDispatchRequestSchema` take `metadata` but **no `hints`**. Gateway controllers currently thread provider metadata through `metadata`; Phase 3 must add an explicit `hints` object and bridge old `metadata.hints` if gateway payloads already use it. |
| Env builder | `packages/shared/src/harnesses/env-builder.ts` | Allowlist-based sanitized env; adapter-provided keys merged in. Overrides must merge as adapter/env input only after key validation so they cannot shadow Eve-reserved vars. |
| Secret resolution | `packages/shared/src/invoke/workspace-secrets.ts` + `packages/shared/src/api-client/secret-client.ts` | `resolveSecrets()` resolves all effective project secrets via the internal API. Job-level interpolation should reuse the already-resolved secret list, not add per-key worker API round trips. |
| Routing log | `apps/orchestrator/src/loop/loop.service.ts:1887` | `appendLog(attempt.id, 'routing', { harness, harness_source, ... })`. Good hook point for `harness_profile_source` enum. |
| Harness introspection | `apps/api/src/harnesses/harnesses.controller.ts` | `GET /harnesses`, `GET /harnesses/{name}`. No validation endpoint. |
| Permissions | `packages/shared/src/permissions.ts`, `apps/api/src/auth/permissions.ts` | `packages/shared` is the canonical permission catalog; API role expansion imports it. No `jobs:harness_override` today. |
| Workflow schema | `packages/shared/src/schemas/pipeline.ts`, `packages/shared/src/schemas/manifest.ts:268` | Workflows reuse `PipelineStepSchema`; there is no `packages/shared/src/schemas/workflows.ts`. |
| Analytics | `apps/api/src/analytics/analytics.service.ts`, `packages/cli/src/commands/analytics.ts` | Current cost surface is `cost-by-agent`; there is no generic `eve analytics cost --group-by ...` command yet. |

Key insight: **profile resolution is duplicated** between chat and workflow services,
and the logic that eventually winds up on `jobs.harness` / `jobs.harness_options` is
a projection that discards the profile name, the source, and any env bundle. We will
push this resolution into a single shared module and extend it to support inline
overrides.

## 3. Design

### 3.1 Data Model Additions

Migration `00090_per_job_harness_overrides.sql`:

```sql
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS harness_profile_override JSONB,
  ADD COLUMN IF NOT EXISTS env_overrides JSONB,
  ADD COLUMN IF NOT EXISTS harness_profile_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS harness_profile_hash VARCHAR(64);

ALTER TABLE job_attempts
  ADD COLUMN IF NOT EXISTS harness_profile_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS harness_profile_hash VARCHAR(64);

-- Indexes: none (not a query path).
-- Constraints on both tables:
--   harness_profile_source IS NULL OR harness_profile_source IN
--   ('agent_default','string_ref','inline_override','workflow_template').
```

`harness_profile_override` stores the raw inline bundle exactly as provided
(`{harness, model, reasoning_effort, variant?, temperature?}`). `env_overrides`
stores env values with `${secret.KEY}` placeholders **intact** (R7.1). Profile
canonicalization and projection happen before dispatch/job insert; env secret
resolution happens in the shared invoke module at spawn time. The stable profile
hash is computed from the normalized inline bundle plus env override keys and
placeholder strings, never from resolved plaintext secret values.

Important implementation detail: direct job creation must still project the
effective profile into the existing `jobs.harness` and `jobs.harness_options`
columns before insert. The orchestrator currently ignores `jobs.harness_profile`
when constructing the invocation and only forwards `job.harness` /
`job.harness_options`, so merely storing `harness_profile_override` would be a
no-op.

### 3.2 Shared Module: `harness-profile-resolver`

New file: `packages/shared/src/harnesses/profile-resolver.ts`.

Extract the resolution logic currently split between `chat.service.ts:1175` and
`workflows.service.ts:558`. Signature:

```ts
type ResolvedProfile = {
  harness?: string;
  harness_options?: JobHarnessOptions;
  env_overrides?: Record<string, string>;
  profile_name?: string | null;
  profile_hash?: string | null;
  source: 'agent_default' | 'string_ref' | 'inline_override' | 'workflow_template';
  warnings: Array<{ code: string; message: string }>;
};

export async function resolveHarnessProfile(deps: {
  agentConfigs: AgentConfigReader;
  manifests: ManifestReader;
}, params: {
  projectId: string;
  agentDefault?: string | null;       // agent's declared harness_profile
  inlineOverride?: InlineProfileBundle;  // from job request
  stringRef?: string | null;          // harness_profile string override on request
  workflowTemplate?: InlineProfileBundle;  // from workflow step
  envOverrides?: Record<string, string>;
}): Promise<ResolvedProfile>;
```

Precedence (R6.3):

```
workflowTemplate ?? inlineOverride ?? stringRef ?? agentDefault
```

When both `stringRef` and `inlineOverride` are set, inline wins and we emit a
single warning log (`harness.profile.conflict`) — not an error.

For direct `POST /projects/{id}/jobs`, keep the existing `harness` +
`harness_options` body pair unchanged when no profile inputs are present. When
`harness_profile_override` is present it wins over both the string ref and legacy
explicit fields, with the same single conflict warning. This avoids a request
where the persisted debug fields and the effective runtime fields disagree.

### 3.3 Env Overrides — Interpolation Boundary

`env_overrides` values support `${secret.KEY}` references. Literal values are
allowed with a 4 KB total JSON size cap (Q1 open-question answered tentatively
"yes with cap").

Validation rules:
- Keys must match `^[A-Z_][A-Z0-9_]*$`.
- Reject reserved keys and prefixes: `EVE_*`, `PATH`, `HOME`, `SHELL`, `USER`,
  `TMPDIR`, `NODE_OPTIONS`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_HOME`.
- Values may contain literal text plus `${secret.KEY}` placeholders; reject
  other `${...}` expressions.
- Extracted secret keys are compared against the already-resolved effective
  secret map in the worker. Missing keys throw a typed
  `missing_secret_override` provisioning error before harness launch.

Interpolation flow (R7.2):

```
API (validates shape, stores placeholders intact)
  → Orchestrator (merges into invocation payload unchanged)
    → Shared invoke module (resolve at spawn time against resolved secrets)
      → env-builder (merge resolved values into adapterEnv after validation)
```

We reuse `workspace-secrets.ts::resolveSecrets` for the secret lookup. New helpers
`extractSecretRefs(raw)` and `interpolateEnvOverrides(raw, resolvedSecrets)` return
`{resolved, missing[]}`. If `missing` is non-empty, the attempt fails fast at the
same stage as today's `[resolveSecrets]` check, with `error_code =
missing_secret_override` and the offending keys listed. Never log resolved values.

### 3.4 DTO Changes

Put these schemas in `packages/shared/src/schemas/job.ts` and export them so chat,
workflows, validation, and CLI code share one shape.

`CreateJobRequest` (`packages/shared/src/schemas/job.ts`):

```ts
const InlineProfileBundleSchema = z.object({
  harness: z.string().min(1),
  model: z.string().optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  variant: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
}).strict();

const EnvOverridesSchema = z.record(
  z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  z.string().max(2048),
).refine(v => JSON.stringify(v).length <= 4096, 'env_overrides exceeds 4KB')
 .superRefine(rejectReservedEnvKeysAndUnknownExpressions);

// extend CreateJobRequestSchema:
  harness_profile_override: InlineProfileBundleSchema.optional(),
  env_overrides: EnvOverridesSchema.optional(),
```

Extend `UpdateJobRequestSchema` only if updating these fields on a ready job is a
deliberate feature. Safer Phase-1 default: make overrides create-only and reject
updates once an attempt exists, because changing runtime identity mid-queue is hard
to reason about.

`ChatRouteRequestSchema` and `ChatDispatchRequestSchema`: add a `hints` field that
accepts the same `harness_profile_override` + `env_overrides` keys plus existing
thread/app hints. For gateway compatibility, parse `metadata.hints` as a legacy
alias during Phase 3, but persist the normalized object as `hints`.

### 3.5 Validation Endpoint (R4)

New route `POST /projects/{id}/harness-profile/validate` in
`apps/api/src/harnesses/harnesses.controller.ts` (or a sibling controller in the
same module). Delegates to
`HarnessesService.validateInlineOverride({ projectId, userId, override, envOverrides })`:

1. Canonicalize `override.harness` with `resolveHarnessName`; reject unknown
   harness aliases at API time.
2. Use `HarnessesService.resolveEnv({ projectId, userId })` + `getHarnessAuthStatus`
   for the existing auth availability check.
3. Extract `${secret.KEY}` refs from `envOverrides`; validate them with
   `SecretsService.resolveForProject(projectId, userId)` and report
   `resolved | missing | wrong_scope` plus `resolved_at` scope metadata. Add a
   small service helper if needed; do not add a worker-side per-key `resolveMany`
   RPC.
4. Add a pure command-preview helper around `packages/eve-agent-cli`'s existing
   `adapter.buildCommand()` path. The CLI flag `--build-command-only` can use
   the helper, but API validation should not depend on shelling out to a binary
   that may not be present in the API image.
5. Response shape mirrors the spec §4 R4.2.

CLI: `eve harness validate --profile-file p.json --project proj_xxx` in
`packages/cli/src/commands/harness.ts`.

### 3.6 Receipts & Attribution (R5)

Orchestrator routing log (`loop.service.ts:1887`) already writes a structured
`routing` execution log. Extend payload:

```ts
{
  ...,
  harness_profile_name: job.harness_profile ?? null,
  harness_profile_source: 'inline_override' | ...,
  harness_profile_hash: hash(normalized_override), // no plaintext secrets
  effective_harness: selection.harness,
  effective_model: harness_options.model,
  effective_effort: harness_options.reasoning_effort,
}
```

The analytics grouping reads this from routing logs or a dedicated column on
`job_attempts`. Prefer the latter: add `job_attempts.harness_profile_source` +
`harness_profile_hash` columns in the same migration. Keeps analytics SQL simple.

Current code only has `GET /orgs/:org_id/analytics/cost-by-agent` and
`eve analytics cost-by-agent`. Phase 5 must add either:
- a general `GET /orgs/:org_id/analytics/cost?group_by=harness_profile` plus
  `eve analytics cost --group-by harness_profile`, or
- a narrower `cost-by-harness-profile` endpoint/CLI.

Also extend `packages/shared/src/pricing/receipt/receipt-v2.ts` and
`assemble-attempt-receipt.ts` so receipts carry `harness_profile_*` metadata, not
just lifecycle/routing logs.

### 3.7 Permission Model (R8)

Introduce `jobs:harness_override` in the canonical `packages/shared/src/permissions.ts`
catalog. Add it to API member/admin/owner role expansion wherever `jobs:write`
is granted by default. Orgs can omit it from custom roles via `.eve/access.yaml`.

Enforcement:
- `CreateJob` controller checks `jobs:harness_override` when
  `harness_profile_override` or `env_overrides` present.
- `CreateJob` controller also checks `secrets:read` when `env_overrides` contains
  any `${secret.KEY}` references.
- Chat dispatch checks the same permissions against the resolved Eve principal:
  direct `/projects/:id/chat/route` uses the authenticated user; gateway/internal
  dispatch uses `metadata.eve_user_id` when present and rejects override hints if
  no Eve principal can be resolved.
- `HarnessesService.validateInlineOverride` checks `secrets:read` at resolved
  scope per referenced secret.

## 4. Phases

The phasing matches the spec's migration plan, reordered slightly so every phase
ships behind a working verification scenario. Each phase below includes its own
manual-test extension.

### Phase 1 — Direct Job Creation (R1 + R6 + R7 + R8)

Covers Eden day-one needs: wizard, changeset apply, question evolution (all via
`POST /projects/{id}/jobs`).

**Code changes**:
1. Migration `00090_per_job_harness_overrides.sql`.
2. DTO: `CreateJobRequestSchema`, `JobResponseSchema`, DB `Job` interface, and
   `HarnessInvocation` type extensions. Keep `UpdateJobRequestSchema` unchanged
   unless create-only override semantics are explicitly relaxed.
3. `packages/db/src/queries/jobs.ts` insert/select/response mapping include new
   job columns; attempt creation/update include attribution columns.
4. New `packages/shared/src/harnesses/profile-resolver.ts`; refactor `chat.service.ts`
   and `workflows.service.ts` call sites to use it.
5. `packages/shared/src/invoke/workspace-secrets.ts`: add
   `extractSecretRefs()` / `interpolateEnvOverrides()` and merge into `adapterEnv`
   at spawn time in both runtimes.
6. `apps/worker/src/invoke/invoke.service.ts` + `apps/agent-runtime/src/invoke/invoke.service.ts`:
   read new fields from invocation payload, pass to shared resolver.
7. `apps/api/src/jobs/jobs.service.ts`: resolve/project overrides into
   `harness` / `harness_options` before job insert so direct jobs actually run
   with the requested profile.
8. `packages/shared/src/permissions.ts` + `apps/api/src/auth/permissions.ts`: add
   `jobs:harness_override`; update default role bindings.
9. `apps/api/src/jobs/jobs.controller.ts`: permission check when override fields
   present.
10. `eve job show <id> --json` exposes `harness_profile_override`,
   `env_overrides` (placeholders intact).
11. CLI: `eve job create --harness-override-file p.json --env-override KEY=VALUE`
    (repeatable). Thin wrapper over API body.
12. Receipts: extend routing log + new columns on `job_attempts`.
13. Tests: `profile-resolver.spec.ts`, `env-overrides.spec.ts`, job schema tests,
    jobs service create tests for projection and permissions, and worker/runtime
    invoke tests that prove both execution paths receive the resolved env.

**Shipping gate**: Phase-1 manual test scenario (below) passes; all existing
scenarios continue to pass (R6.1).

### Phase 2 — Validation Endpoint (R4)

Parallelizable with Phase 1; blocks wizard UX in consumer apps.

**Code changes**:
1. `POST /projects/{id}/harness-profile/validate` + `HarnessesService.validateInlineOverride`.
2. `packages/eve-agent-cli`: add a command-preview helper and
   `--build-command-only` flag that prints the would-be `execvp` argv without
   spawning.
3. CLI: `eve harness validate`.

### Phase 3 — Chat Hints Propagation (R2)

Unblocks Slack `@eve pm` and web chat panel with per-message brain selection.

**Code changes**:
1. `ChatRouteRequestSchema`: add `hints.harness_profile_override`,
   `hints.env_overrides`.
   Also update `ChatSimulateRequestSchema` and the simulate controller mapping.
2. `chat.service.ts`: replace 8 `resolveHarnessProfile(projectId, agent.harness_profile)`
   call sites with `sharedResolver.resolve({ projectId, agentDefault, inlineOverride: hints.harness_profile_override, envOverrides: hints.env_overrides })`.
3. Propagate overrides to team-dispatched child jobs (lead + member, all
   fanout/council/relay modes — `chat.service.ts` lines 544-650, 974-1070).
4. Write `harness_profile_override` and `env_overrides` to coordination thread
   metadata (`threads.metadata.harness_overrides`) so `eve thread messages` can
   surface it (R2.2).
5. Gateway-level: **no interpolation** — gateway passes the raw override through
   to the chat service (R2.4). Confirm no provider-specific leak paths.
6. Inbound error delivery: if secret missing, post error back to thread via
   existing `EveMessageRelay` path; mark job `delivery_failed` (R2.3).

### Phase 4 — Workflow Step Template Expressions (R3)

Unblocks `doc.ingest`, `changeset.accepted`, `question.answered` pipelines.

**Code changes**:
1. Workflow schema (`packages/shared/src/schemas/pipeline.ts`, consumed by
   `packages/shared/src/schemas/manifest.ts`): accept
   `workflow.inputs.<name>.from: event.payload.<path>` + `default`.
2. Step-level `harness_profile` accepts `${inputs.<key>}` template expressions.
3. Step-level `harness_profile_override` accepts inline bundle with per-field
   templates (e.g. `model: "${inputs.model}"`).
4. New `packages/shared/src/templates/expr.ts`: safe expression engine. Support
   only `${inputs.<key>}` and `${event.payload.<path>}` — no arbitrary JS, no
   function calls. Reject unknown variables at `eve agents sync` validation
   time (R3.4).
5. `workflows.service.ts`: evaluate templates against `{inputs, event}` at
   workflow start before child jobs are created. Fall back to agent default on
   unresolved with a warning log (R3.2), but reject malformed expressions during
   manifest/agent sync validation.

### Phase 5 — Receipts Attribution Polish (R5)

Extends Phase 1's foundational logging.

**Code changes**:
1. Add analytics API/CLI for harness-profile grouping. The query uses the new
   `job_attempts.harness_profile_source` + `harness_profile_hash` columns.
2. Existing `cost-by-agent` remains unchanged.
3. Analytics dashboard: surface `inline_override` rows as distinct from
   `agent_default`.

## 5. Verification Loop — Local K3d Stack

We will drive every phase through extensions to the manual test suite so each
lands with an executable pass/fail gate. Manual tests run against
`http://api.eve.lvh.me` after `./bin/eh k8s deploy`.

### 5.1 New Scenario: `34-per-job-harness-override.md`

Goal: end-to-end verification of R1, R6, R7, R8 on the local stack.

Shape (abbreviated; full file will live at `tests/manual/scenarios/34-per-job-harness-override.md`):

```
Phase A — Baseline (R6.1): existing scenario 02 still green after deploy.
Phase B — Inline override, single request:
  1. Create test project with x-eve.yaml defining profile "planner" (claude, sonnet).
  2. eve agents sync.
  3. POST /projects/{id}/jobs with:
       harness_profile_override: { harness: "zai", model: "glm-4.6" }
  4. Assert: job record has override persisted; routing log shows
     harness_profile_source=inline_override; harness=zai; receipt captures
     harness_profile_hash.
  5. eve job follow — harness executes with zai, not planner's claude.
Phase C — Env overrides with secret interpolation (R7):
  1. Set project secret EDEN_TEST_BASE_URL = "https://test.provider.example".
  2. Create job with env_overrides: { ANTHROPIC_BASE_URL: "${secret.EDEN_TEST_BASE_URL}" }.
  3. Assert: GET /jobs/{id} returns placeholder verbatim (R7.3).
  4. Assert: no plaintext secret value appears in job, attempt, receipt, or
     execution logs. Unit/integration tests cover the resolved env merge directly;
     the manual test should not ask an agent to inspect env vars.
Phase D — Missing-secret fail-fast (R7.4):
  1. Create job referencing ${secret.DOES_NOT_EXIST}.
  2. Assert: attempt fails with error_code=missing_secret_override, remediation
     hint naming the key.
Phase E — Permission gate (R8.3):
  1. Create a custom role without jobs:harness_override; bind a service
     principal; attempt to create a job with override → expect 403 with
     permission name in error body.
Phase F — Precedence rule (R6.3):
  1. Job body includes both harness_profile: "planner" and
     harness_profile_override: { harness: "zai" }. Expect: inline wins;
     single warning log "harness.profile.conflict".
```

Each phase lists explicit `eve ...` commands and `jq` assertions, following
the pattern of scenarios 02, 09, and 27 (which set the style for structured
harness assertions).

### 5.2 Extension to Scenario 04 (Events API)

Add a phase to `tests/manual/scenarios/04-events-api.md` for R3: event-triggered
workflow runs with `inputs.harness_profile` pulled from event payload. Verifies
that a `doc.ingest` event carrying `harness_profile: "qwen-local"` produces a
workflow job with the overridden profile, and that omitting the payload field
falls back to the default.

### 5.3 Extension to Scenario 08 (Chat Gateway)

Add a phase to `tests/manual/scenarios/08-chat-gateway-slack.md` for R2:
simulated inbound Slack payload with
`hints.harness_profile_override: { harness: "gemini", model: "gemini-2.5-pro" }`.
Verifies:
- Lead job honors override.
- Fanout/relay child jobs inherit override (R2.1).
- Coordination thread metadata carries the override (R2.2).

### 5.4 Validation endpoint scenario

Extend scenario 01 (smoke) with a `POST /projects/{id}/harness-profile/validate`
call that exercises R4.1 (no inference traffic), R4.2 (missing-secret status),
and the `eve harness validate` CLI. Keep it inside smoke because it should be
fast (<1s) and relies on no external inference.

### 5.5 Rebuild-and-test loop

Standard local workflow:

```bash
./bin/eh status
./bin/eh k8s deploy                              # ~60-90s full rebuild
eve secrets import --org org_manualtestorg --file ./manual-tests.secrets
eve secrets set EDEN_TEST_BASE_URL "https://test.provider.example" --org org_manualtestorg

# Run in parallel when isolated, sequential when touching the same project:
eve system health --json
# "Run manual scenarios 01, 34 in parallel, and 04, 08 after."
```

After each phase lands, iterate `deploy → run → fix → redeploy` until scenario
34 plus unchanged 01–33 all pass. Do not ship a phase until the relevant
scenario is green on a fresh `./bin/eh k8s deploy`.

## 6. Open Questions (From Spec §8)

- **Q1** (literal env values): ship with 4 KB cap. Revisit if abuse observed.
- **Q2** (`variant` in inline override): **yes**, same shape as `harness_options.variant`.
  Adds trivial field; no extra resolution complexity.
- **Q3** (`permission_policy` in inline override): **no** — keep permission
  policy sourced from the agent default. Different concerns; avoid scope creep.
- **Q4** (rate-limiting override volume): ship without; add only if metrics
  show worker secret-resolver cost trending up.

## 7. Risks

- **Secret leak via env_overrides key names**: an attacker who can create jobs
  could use `env_overrides: { SECRET_LEAK: "${secret.SOMETHING}" }` to exfiltrate
  via the harness subprocess env, which is readable by the agent. Mitigation:
  `env_overrides` is privileged input from `jobs:harness_override` callers,
  requires `secrets:read` for secret refs, and rejects reserved env keys/prefixes
  so callers cannot shadow Eve runtime credentials or control paths.
- **Profile resolution drift**: extracting the shared resolver changes 10+ call
  sites. Risk of subtle behavior change in fallback path. Mitigation: golden
  tests in `packages/shared/src/harnesses/__tests__/profile-resolver.spec.ts`
  matching current behavior exactly before the refactor.
- **Gateway injection surface**: any caller who can post to `/chat/route` could
  set harness overrides. Mitigation: gateway continues to authenticate callers,
  and the chat dispatch path checks `jobs:harness_override` on the resolved
  principal just like direct job creation does.
- **Workflow template expansion misuse**: a permissive expression engine is a
  template-injection CVE waiting to happen. Mitigation: Phase-4 engine supports
  **only** `${inputs.<key>}` and `${event.payload.<path>}` with static path
  validation at sync time.

## 8. Rollout Plan

1. **Phase 1 + Phase 2 + Phase 5 (partial)** in one release. Scenario 34
   required green. CLI v0.2.x bump.
2. **Phase 3** next release. Scenario 08 extension required green. Coordinate
   with gateway deploy; gateway behavior is pass-through only, while the API
   normalizes and validates hints.
3. **Phase 4** when template engine is stabilized. Scenario 04 extension
   required green. `eve agents sync --validate` must reject unknown templates.
4. **Phase 5 polish** alongside Phase 3 — analytics groupings are deployed
   once routing-log payload is stable.

## 9. Non-Goals (Restated)

- No managed model catalog; BYOK is unchanged.
- No UI for picking profiles; consuming apps own the wizard.
- No changes to how `x-eve.agents.profiles` works as the default source.
- No Eve-managed inference proxy.

---

Ship Phase 1 and Eden delivers per-Eden-project brains through a wizard radio
button, zero shared-state races, clean cost attribution, and a path to
air-gapped Qwen-on-Mac-Mini endpoints as first-class options.
