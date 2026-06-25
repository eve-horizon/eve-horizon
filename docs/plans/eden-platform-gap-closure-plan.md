# Plan: Eden Platform Gap Closure

> Status: Draft
> Created: 2026-03-12
> Related: `docs/plans/eden-evolution.md`

## Problem

`docs/plans/eden-evolution.md` is implementable on current Eve Horizon, but a few platform gaps still force awkward app-specific glue:

1. `@eve-horizon/auth-react` exposes the authenticated user but not an org membership model or active-org switching helper.
2. Manifest workflows currently resolve only the first `agent` step into a job, so multi-stage agent flows still have to be hand-orchestrated inside one agent.
3. App API exposure for agents is currently strongest in the CLI (`eve job create --with-apis ...`), but that capability is not a first-class server/workflow primitive.

These are not Eden-only issues. They are reusable platform additions that would make Eden simpler to build and would improve the shape of future Eve apps.

## Goal

Add the smallest set of platform capabilities that lets Eden use native Eve flows instead of custom orchestration glue:

1. Org-aware auth primitives for browser apps.
2. Workflow-to-job-graph expansion for multi-step agent execution.
3. Server-side app API attachment that works the same way for direct jobs, workflows, and triggers.

## Non-Goals

- Rework Eve ingest, chat, events, or object-store primitives that already exist.
- Build Eden product features inside the platform repo.
- Introduce a separate workflow runtime when the existing jobs/dependencies model can carry the behavior.
- Expand auth scope beyond org-aware session ergonomics needed by Eve-compatible apps.

## Why Do This Before Eden App Work

If these gaps stay open, Eden can still ship, but the implementation will drift toward custom glue in the app layer:

- custom org selection/session plumbing in the frontend
- agent-side orchestration code standing in for a real workflow graph
- prompt-level API instructions duplicated between CLI and workflow entrypoints

That makes the Eden implementation harder to reason about and pushes reusable platform concerns into app code. The better sequencing is:

1. land the missing primitives in Eve Horizon
2. simplify `docs/plans/eden-evolution.md` to depend on those primitives
3. build Eden on top of the cleaner platform surface

## Current Gaps

| Gap | Current state | Eden impact | Recommended fix |
|---|---|---|---|
| Org-aware app auth | `@eve-horizon/auth-react` exposes `user`, `loading`, `error`, `config`, `loginWithSso`, `loginWithToken`, `logout`; no org membership list or `switchOrg()` helper | Eden UI has to stay artificially single-org or implement custom membership/session glue | Expose memberships and active-org helpers in the auth SDK |
| Multi-step workflows | Workflow invocation resolves the first workflow `agent` step into one job | Eden ingestion/alignment/review chains collapse into one agent or custom child-job logic | Expand workflow manifests into a job DAG using existing jobs/dependencies primitives |
| Agent app API parity | `--with-apis` is available on CLI job creation, but not as a shared server/workflow primitive | Workflow-triggered agents lose app API access parity unless prompts are manually patched | Move app API attachment into shared API/job creation paths and add workflow support |

## Gap 1: Org-Aware Auth SDK Primitives

### Current State

Today `@eve-horizon/auth-react` is good enough for "is the user logged in?" but not for "which org context should the app operate in?".

For Eden this forced the main plan to downgrade from an org switcher to a single active org per session. That is acceptable as a fallback, but it is a platform limitation, not a product decision.

### Proposed Change

Extend the React auth package so Eve-compatible apps can consume org membership context without rebuilding it locally.

Minimum useful shape:

```ts
type EveAuthOrg = {
  id: string;
  slug?: string;
  name?: string;
  role?: string;
};

type EveAuthContextValue = {
  user: EveAuthUser | null;
  orgs: EveAuthOrg[];
  activeOrg: EveAuthOrg | null;
  loading: boolean;
  error: string | null;
  loginWithSso: () => Promise<void>;
  loginWithToken: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  switchOrg?: (orgId: string) => Promise<void>;
};
```

### Design Notes

- Phase 1a should expose `orgs` and `activeOrg` even if `switchOrg()` is deferred.
- Membership data should come from the same trusted auth/session path the provider already uses; Eden should not need a second org-discovery API.
- If a true cross-org switch requires backend support, implement it as an explicit auth contract rather than app-local state pretending a token changed.

### Implementation Outline

1. Extend auth-react types to include org membership data.
2. Update the provider to surface memberships and active org from the session payload.
3. If needed, add a narrow backend/session contract for active-org switching rather than forcing each app to invent one.
4. Document the intended single-org and multi-org usage patterns so app authors know when `switchOrg()` is real versus optional.

### Acceptance Criteria

- An Eve-compatible React app can render the user’s org memberships from the shared auth package.
- The active org is explicit in provider state instead of implicit in app code.
- If `switchOrg()` ships, it changes auth/session state through a documented platform contract.
- Eden can remove its "single active org because SDK cannot expose more" caveat from the plan.

## Gap 2: Workflow Expansion into Job Graphs

### Current State

Current workflow invocation behavior is too shallow for agent pipelines. A workflow can define multiple steps, but invocation still resolves only the first `agent` step into a job. That means the manifest shape suggests composition that the runtime does not actually provide.

For Eden, this is the biggest orchestration mismatch. The plan wants stages such as ingestion, extraction, synthesis, and review to be modeled as a workflow, but the platform currently requires those later stages to be re-created manually inside the first agent or in app-specific orchestration code.

### Proposed Change

Treat a workflow as a declarative job graph that compiles to ordinary Eve jobs and dependencies at invocation time.

Recommended scope:

- sequential agent steps
- explicit `depends_on`
- parent/child job relationships
- carry-over context between steps
- phase/status propagation from child jobs back to the workflow root

Do not build a separate workflow engine. Reuse the existing jobs model and expose the compiled graph via job tree APIs.

### Suggested Manifest Direction

Keep the current workflow authoring model but make step graph semantics real:

```yaml
workflows:
  ingestion-pipeline:
    steps:
      - name: ingest
        agent:
          name: ingestion
      - name: extract
        depends_on: [ingest]
        agent:
          name: extraction
      - name: synthesize
        depends_on: [extract]
        agent:
          name: synthesis
```

This is intentionally aligned to the current `PipelineStepSchema` (`name` + `depends_on`), which does not yet validate `id` on steps.

When we introduce `id`, add it behind a schema + coherence migration so examples can switch safely in one release.

### Implementation Outline

1. Define the supported workflow step subset that compiles into jobs.
2. Update `PipelineStepSchema` in `packages/shared/src/schemas/pipeline.ts` so step identity can be explicit and stable (`name` is current baseline; `id` can be added during migration).
3. Update workflow invocation to create a root workflow job plus child jobs for each step.
4. Materialize dependencies between child jobs using existing jobs/dependencies primitives.
5. Update `analyzeManifestCoherence` in `packages/shared/src/schemas/manifest.ts` to validate workflow dependency integrity:
   - each `depends_on` entry resolves to an existing step
   - duplicate step identifiers are rejected
   - cycle detection reports an error for cyclic dependencies
6. Carry forward context and structured outputs through documented step edges instead of prompt-only conventions.
7. Expose the compiled graph in existing job tree views and events.

### Acceptance Criteria

- Invoking a three-step workflow creates three step jobs plus an obvious root/container job.
- Downstream steps do not start until dependencies complete.
- Job tree inspection reflects the workflow graph without app-specific reconstruction.
- Eden can model its ingestion pipeline as a real workflow instead of "one entry agent that spawns the rest manually".

## Gap 3: Server-Side App API Attachment for Jobs and Workflows

### Current State

Eve already has a useful idea here: `eve job create --with-apis ...` can attach app API access guidance for an agent. The problem is that this is still mostly a CLI affordance. Workflow-created jobs do not get the same capability through a canonical shared path.

That forces Eden into one of two bad options:

- duplicate CLI helper text inside workflow prompts
- skip platform API attachment entirely and hand-roll app integration hints

### Proposed Change

Move app API attachment into the shared server-side job creation contract, then let the CLI and workflows use that same primitive.

Recommended shape:

- jobs API accepts a first-class `with_apis` field
- workflow definitions can declare `with_apis` at the workflow level and/or per step
- server resolves and injects the same helper metadata regardless of whether the job was created by CLI, workflow, or trigger

### Design Notes

- The CLI should become a thin client over the server capability, not the place where the feature meaning lives.
- The injected helper format should stay consistent across entrypoints so agent behavior is predictable.
- This should compose cleanly with workflow graph expansion: each workflow step can inherit or override the APIs it needs.

### Implementation Outline

1. Add `with_apis` to the server-side jobs creation contract.
2. Centralize app API helper generation in the API/service layer instead of CLI-only prompt mutation.
3. Add workflow support for `with_apis` inheritance and per-step overrides.
4. Update CLI job creation to call the shared path rather than owning special-case behavior.
5. Document the feature in agent app API access and workflow docs.

### Acceptance Criteria

- A direct API-created job and a CLI-created job can request the same app APIs with identical behavior.
- A workflow step can declare required app APIs without prompt duplication.
- Agent prompts/helper context are produced by one shared implementation path.
- Eden can use manifest-declared API access for agent stages instead of custom glue.

## Recommended Delivery Order

### Phase 1: Server-Side `with_apis`

This is the smallest change and immediately removes duplicated prompt logic. It also sets up the right primitive for workflow support.

### Phase 2: Workflow Job Graph Expansion

This is the highest-impact orchestration fix for Eden. Once this lands, the Eden plan can express its multi-agent pipeline directly in workflow/job terms.

### Phase 3: Auth SDK Org Awareness

This improves the app layer and removes an artificial UX limitation, but it is less central than the workflow/runtime gaps. If scope tightens, phases 1 and 2 are the must-have work before Eden implementation.

## Files Likely Touched

- `apps/api/src/workflows/workflows.service.ts`
- `packages/shared/src/schemas/pipeline.ts`
- `packages/shared/src/schemas/manifest.ts`
- `packages/shared/src/schemas/__tests__/manifest-build-helpers.spec.ts`
- `packages/cli/src/commands/job.ts`
- `packages/auth-react/src/provider.tsx`
- `packages/auth-react/src/types.ts`
- `docs/system/agent-app-api-access.md`
- `docs/system/workflows.md`
- `docs/system/auth-sdk.md` or equivalent auth SDK docs

### Cross-Repo Documentation Tasks

- `../eve-skillpacks`
  - Update workflow and app API reference skillpack docs to describe:
    - Manifest workflow step graphs (`depends_on`, duplicate/cycle rejection behavior)
    - `with_apis` at workflow and workflow-step level
    - Shared API-injection semantics across direct jobs and workflow steps
- `../../eve-horizon-docs`
  - Add/update public platform capability docs for:
    - Native workflow graph execution model
    - App API attachment being server-side/shared across job creation paths
    - Local k3d verification expectations for workflow graph and API parity

## Local k3d Verification Loop (Manual Scenario Style)

This is the repeatable gate for this plan. Run it after each implementation pass and before moving to Eden plan updates.

```bash
set -euo pipefail
export EVE_API_URL=http://api.eve.lvh.me
export VERIFICATION_LOOPS="${VERIFICATION_LOOPS:-2}"

# 0) Ensure local stack is healthy
./bin/eh status
./bin/eh k8s start
./bin/eh k8s deploy
./bin/eh k8s deploy  # rerun after local image changes

# 1) Build a local fixture repo for workflow+API checks
FIXTURE_DIR=/tmp/eden-gap-fixture
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR/.eve"

cat >"$FIXTURE_DIR/.eve/manifest.graph-valid.yaml" <<'EOF'
services:
  api:
    image: nginx:alpine
workflows:
  gap-closure-smoke:
    with_apis:
      - coordinator
    steps:
      - name: ingest
        agent:
          name: mclaude
        with_apis:
          - coordinator
      - name: extract
        depends_on: [ingest]
        agent:
          name: codex
        with_apis:
          - analytics
      - name: review
        depends_on: [extract]
        agent:
          name: mclaude
EOF

cat >"$FIXTURE_DIR/.eve/manifest.graph-cycle.yaml" <<'EOF'
services:
  api:
    image: nginx:alpine
workflows:
  gap-closure-smoke:
    steps:
      - name: ingest
        depends_on: [review]
        agent:
          name: mclaude
      - name: extract
        depends_on: [ingest]
        agent:
          name: codex
      - name: review
        depends_on: [extract]
        agent:
          name: mclaude
EOF

cat >"$FIXTURE_DIR/.eve/manifest.workflow-duplicate.yaml" <<'EOF'
services:
  api:
    image: nginx:alpine
workflows:
  gap-closure-smoke:
    steps:
      - name: ingest
        agent:
          name: mclaude
      - name: ingest
        depends_on: [ingest]
        agent:
          name: codex
EOF

cp "$FIXTURE_DIR/.eve/manifest.graph-valid.yaml" "$FIXTURE_DIR/.eve/manifest.yaml"
cd "$FIXTURE_DIR"
git init
git add .eve/manifest.yaml .eve/manifest.graph-valid.yaml .eve/manifest.graph-cycle.yaml .eve/manifest.workflow-duplicate.yaml
git commit -m "temp: workflow coherence fixture"
git branch -M main

export ORG_ID=org_manualtestorg
export PROJECT_ID="$(
  eve org ensure "Manual Test Org" --slug manualtest --json \
    | jq -r '.id'
)"
export PROJECT_ID="$(
  eve project ensure \
    --org "$ORG_ID" \
    --name "Eden Gap Loop" \
    --slug edengaploop \
    --repo-url "file://$FIXTURE_DIR" \
    --branch main \
    --force \
    --json \
  | jq -r '.id'
)"

for i in $(seq 1 "$VERIFICATION_LOOPS"); do
  echo "=== Verification loop $i / $VERIFICATION_LOOPS ==="

  # 2) Schema/coherence preflight (negative + positive checks)
  eve manifest validate --project "$PROJECT_ID" --path "$FIXTURE_DIR/.eve/manifest.workflow-duplicate.yaml" --json
  eve manifest validate --project "$PROJECT_ID" --path "$FIXTURE_DIR/.eve/manifest.graph-cycle.yaml" --json
  eve manifest validate --project "$PROJECT_ID" --path "$FIXTURE_DIR/.eve/manifest.graph-valid.yaml" --json

  # 3) Sync the valid manifest and verify workflow graph expansion
  cp "$FIXTURE_DIR/.eve/manifest.graph-valid.yaml" "$FIXTURE_DIR/.eve/manifest.yaml"
  eve project sync --project "$PROJECT_ID" --dir "$FIXTURE_DIR" --validate-secrets

  WORKFLOW_JOB_ID="$(eve workflow run "$PROJECT_ID" gap-closure-smoke --input '{"run_id":"'"$i"'"}' --json | jq -r '.job_id // .id // .data.id')"
  eve job show "$WORKFLOW_JOB_ID" --json
  eve job tree "$WORKFLOW_JOB_ID"
  echo "$WORKFLOW_JOB_ID" > /tmp/eden-gap-workflow-job-id

  # Inspect step dependency wiring (expect ingest -> extract -> review).
  for step_id in $(eve job show "$WORKFLOW_JOB_ID" --json | jq -r '.children[]?.id'); do
    echo "--- Dependencies for $step_id ---"
    eve job dep list "$step_id"
  done

  # 4) Parity check: CLI vs workflow path for app API hints
  DIRECT_JOB_ID="$(eve job create \
    --project "$PROJECT_ID" \
    --description "direct with-apis parity check" \
    --agent mclaude \
    --with-apis coordinator,analytics \
    --json \
  | jq -r '.id // .job.id')"
  eve job show "$DIRECT_JOB_ID" --json

  for step_id in $(eve job show "$WORKFLOW_JOB_ID" --json | jq -r '.children[]?.id'); do
    echo "--- API injection for $step_id ---"
    eve job show "$step_id" --json
  done
done
```

Pass criteria per loop:
- `manifest validate` rejects duplicate names and cycles, and accepts the valid graph.
- `eve project sync` with valid manifest succeeds.
- Workflow invocation creates one root job plus three step jobs.
- `eve job dep list` reflects declared edges exactly as `ingest -> extract -> review`.
- `eve job show` output for direct `--with-apis` and workflow step jobs contains the same app API injection behavior.

## Success Criteria

This plan is successful when `docs/plans/eden-evolution.md` can be simplified to say:

- org-aware app auth uses first-class auth SDK primitives
- ingestion/review pipelines are declared as real Eve workflows
- agent app API access is declared once and works the same for jobs and workflows

At that point Eden becomes a normal Eve-native application instead of a project that has to paper over missing platform seams.
