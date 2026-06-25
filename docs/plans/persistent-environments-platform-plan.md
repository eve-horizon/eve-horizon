# Persistent Environments Platform - Design + Implementation Plan

> Status: Draft
> Last Updated: 2026-01-22
> Breaking changes are expected and encouraged. Delete or refactor any code that does not conform to this plan.
> Note: Migration flow and manifest structure are superseded by `docs/plans/manifest-v2-compose-plan.md`.
> Legacy note: examples may mention `components`, `defaults`, or `eve db migrate`.
> Current manifests use `services` + `x-eve.*` and job services for migrations.

## Source of Truth

- `docs/ideas/persistent-environments-platform.md`
- `docs/ideas/pipelines-vs-workflows.md`
- `docs/plans/event-driven-pipelines-platform-plan.md`

## Scope

- Manifest-driven persistent environments with deterministic pipelines as job graphs.
- Agent workflows remain skill-driven and run as jobs (request/response when invoked).
- Jobs default to `x-eve.defaults.env`.
- Event-driven triggers route into pipelines/workflows via normalized events.
- CLI-first usage for all operations.
- Phased delivery with integration tests and example repo validation per phase.
- No backward compatibility guarantees.

## Current State (Already Implemented)

- API sources + env DB endpoints in the API.
- `eve api` and `eve db` CLI commands.
- E2E coverage for API sources and env DB.
- Migrations run as job services defined in the manifest.
- Manifest service model schemas/docs + worker deployer dependency ordering.

## Cleanup Policy (Explicit)

When new design primitives land, remove old or redundant code immediately:
- Remove `.eve/services.yaml` parsing/provisioning in `apps/worker/src/invoke/invoke.service.ts` once manifest `services` is implemented.
- Remove tests and docs that assume `.eve/services.yaml` after the manifest replaces it.
- Delete any remnants that conflict with "pipelines are deterministic, workflows are skills."
- Prefer fewer files and fewer abstractions even if refactors are large.

## Existing Code Inventory (Keep vs Change)

**Keep (core primitives we build on)**
- Job lifecycle, phases, dependencies, and gates: `apps/api/src/jobs`, `apps/orchestrator/src/loop/loop.service.ts`, `packages/db/src/queries/jobs.ts`, `packages/db/migrations/00006_add_job_gates.sql`.
- Worker invocation + hooks + logs: `apps/worker/src/invoke/*`.
- Secrets and injection: `apps/api/src/secrets/*`, `packages/db/migrations/00004_add_secrets.sql`.
- CLI profile + auth plumbing (even if auth is disabled in phase 1): `packages/cli/src/*`.
- Auth verification module (HS256) to extend later: `apps/api/src/auth/*`.

**Replace or extend (new design touchpoints)**
- Project metadata flow: add manifest sync endpoints in `apps/api/src/projects/*` and new CLI command under `packages/cli/src/commands`.
- Add new DB tables and queries for manifest cache, environments, releases, pipelines, workflows, triggers, job tokens in `packages/db/migrations/*` and `packages/db/src/queries/*`.
- Job scheduling defaults: use `x-eve.defaults` in `apps/api/src/jobs/jobs.service.ts`.
- K8s deployer for environments: reuse kubectl helper patterns in `apps/worker/src/invoke/*`.
- Introduce env targeting fields on jobs (env name + execution mode).

**Delete or deprecate**
- `.eve/services.yaml` parsing/provisioning in `apps/worker/src/invoke/invoke.service.ts`.
- Docs and tests that hardcode `services.yaml` for job services.
- `eve k8s` command; replace with API-backed `eve system` subcommands for remote debugging.
- ~~`eve attempt` command; fold into `eve job` subcommands.~~ ✓ COMPLETED

## Phase Plan (Each Phase = New Feature Branch + Merge After Tests)

Each phase:
1) Create new branch `feat/<phase-topic>`.
2) Implement + update example repo (`../eve-horizon-fullstack-example`).
3) Run `./bin/eh test integration` and fix gaps.
4) Merge to `main` only after tests and example repo validation.

### Phase 1 - Persistent Environments + Manifest Sync + Local Auth Only

**Goals**
- End-to-end persistent envs (dev/staging/prod) driven by `.eve/manifest.yaml`.
- Jobs default to `x-eve.defaults.env`.
- Pipelines and workflows are defined in the manifest (execution lands in Phase 2/3).
- Local dev only auth (`EVE_AUTH_ENABLED=false`).

**DB**
- Add `project_manifests` (project_id, manifest_yaml, manifest_hash, git_sha, branch, parsed_defaults).
- Add `environments` (project_id, name, type, namespace, db_ref, overrides_json, current_release_id).
- Add `releases` (project_id, git_sha, manifest_hash, image_digests_json, created_by).
- Add `jobs.env_name` and `jobs.execution_mode`.

**API**
- `POST /projects/:id/manifest` for CLI sync.
- `GET /projects/:id/envs` + `GET /projects/:id/envs/:name`.
- `POST /projects/:id/envs/:name/deploy` (sets release pointer + applies manifests).
- `GET /projects/:id/pipelines` + `GET /projects/:id/pipelines/:name`.
- `GET /projects/:id/workflows` + `GET /projects/:id/workflows/:name`.
- Jobs service: fill default env/worker/harness from cached manifest.
- Add remote debugging endpoints for `eve system logs|pods|events` (API-backed, no kubectl).

**Worker / Orchestrator**
- Use `x-eve.defaults` when scheduling jobs.
- Add env gating with job_gates (e.g., `env:<project_id>:<env>`).
- Build a minimal k8s deployer that renders deployments/services/ingress from manifest `services` and `x-eve.ingress`.

**CLI**
- Add `eve project sync` to push manifest + git sha.
- Add `eve env list|show|deploy`.
- Add `eve pipeline list|show` (read-only in Phase 1).
- Add `eve workflow list|show` (read-only in Phase 1).
- Add `--env <name>` on `eve job create` (default from manifest).
- Replace `eve k8s` with `eve system` subcommands for remote debugging.
- ~~Remove `eve attempt` in favor of `eve job attempts` and `eve job logs`.~~ ✓ COMPLETED

**Proposed `eve system` subcommands (remote admin)**
- `eve system status` (API/orchestrator/worker health)
- `eve system logs <service>` (api/orchestrator/worker/postgres)
- `eve system pods` (list pods with status)
- `eve system events` (recent cluster events)
- `eve system config` (deployment config summary)
- Require admin RBAC for all `system` commands (system or org-level admin only).

**RBAC enforcement**
- API guard checks a required `admin_scope` on all `/system/*` endpoints.
- `org_admin`: may access system data scoped to org projects only (logs/pods/events filtered by org label).
- `system_admin`: full cluster visibility across all orgs and system namespaces.
- CLI does not gate; API is the enforcement point.

**K8s labeling for org scoping**
- Required labels on all Eve resources: `eve.org_id`, `eve.project_id`, `eve.env`, `eve.component`.
- Job-scoped resources also include: `eve.job_id`, `eve.attempt_id`.
- `eve system` endpoints filter by `eve.org_id` for org admins.

**Example repo**
- Add `.eve/manifest.yaml` with `test`, `staging`, `production` envs.
- Add pipeline and workflow definitions in manifest (execution in later phases).
- Update README with `eve project sync` and `eve env deploy staging`.
- Use simple smoke tests (curl health endpoints) to validate envs.

**Tests**
- Integration tests for manifest sync and env deploy.
- Integration tests for pipeline/workflow list/show (no run).
- E2E smoke test using the example repo and staging env.

**Cleanup**
- Remove any legacy env/workflow docs that conflict with this model.
- Remove `packages/cli/src/commands/k8s.ts` and related help text after system endpoints exist.

### Phase 2 - Deterministic Pipelines (Job Graphs)

**Goals**
- Pipeline runs expand into job graphs of deterministic action/script jobs.
- No separate pipeline runner; orchestration uses existing job scheduling.
- Request/response mode for pipelines (`wait=true`) via run + job status.

**DB / API**
- Store runs (`runs` with `kind=pipeline`) and link jobs via `jobs.run_id`.
- Add `jobs.pipeline_step_id`, `jobs.execution_type`, and action/script payload fields.
- `POST /projects/:id/pipelines/:name/run` and `?wait=true`.

**Execution**
- API expands pipelines to jobs with dependencies at run creation.
- Worker executes `execution_type=action|script` jobs directly.
- Env policy gates apply to deploy steps; approval handled at deploy boundary.

**CLI**
- `eve pipeline run <name> --ref <sha> --env <env>`.

**Example repo**
- Add pipelines for deploy-test/staging/prod using `eve-default-deploy`.

**Tests**
- Integration tests for run creation, job graph ordering, wait mode, and approvals.

### Phase 3 - Agent Workflows (Skills)

**Goals**
- Workflow skills (OpenSkills) run as agent jobs.
- Workflows can call pipelines for deterministic actions.
- Optional request/response workflow endpoints with JSON schema validation.

**DB / API**
- `POST /projects/:id/workflows/:name/run` (creates workflow job).
- `POST /projects/:id/workflows/:name/invoke?wait=true` (request/response).
- Optional endpoint aliasing from SKILL frontmatter (`endpoint.path`).
- Optional `workflow_runs` table for external tracking.

**Execution**
- Workflow jobs use the existing job lifecycle (`issue_type=workflow`).
- Worker loads SKILL.md and passes inputs via env.
- API validates `request.schema.json` and `response.schema.json` when provided.

**CLI**
- `eve workflow run <name> --ref <sha> --env <env>`.
- `eve workflow invoke <name> --json <payload>` (request/response).

**Example repo**
- Add workflow skills with clear agent instructions (eve-prefixed standard skills).

**Tests**
- Integration tests for workflow run creation and execution.

### Phase 4 - Events + Triggers (Logs + Cron + Webhooks)

**Goals**
- Normalized event ingestion with manifest-based trigger matching.
- Unified triggers in manifest.
- Provider-specific webhook endpoints (GitHub/Slack).

**API**
- `POST /projects/:id/events` (manual + app events).
- `POST /integrations/github/events` and `/integrations/slack/events`.
- Trigger matcher reads cached manifest triggers and creates runs/jobs.

**System**
- Cron runner emits `cron.tick` events (simple internal scheduler).
- Log-based trigger hooks (start with polling or log queries via API).

**Example repo**
- Add triggers for `main` push -> pipeline.
- Add log trigger for self-heal (staging/prod).

**Tests**
- Integration tests for webhook handling and trigger matching.

### Phase 5 - Env DB Provisioning + Authed Access (Remaining)

**Goals**
- `databases` section in manifest provisions Postgres per env.
- Preserve user context and enforce RLS in app/API access.
- No snapshotting yet; focus on reliable provisioning and safe access.

**Worker / Runtime**
- Create Postgres StatefulSet + Service for each env.
- Inject DB connection secrets into env jobs.
 - Enforce `db.write` gating for write access (workflow-declared only).

**CLI**
- `eve db status --env <env>`.
- Job-based migration service optional (if migrations exist).
 - `eve db sql --write` only when job token includes `db.write`.

**Example repo**
- Add database definition and verify API uses env DB.
 - Add a workflow that exercises RLS-protected API calls.

**Tests**
- Integration test: env DB is reachable and persistent across jobs.
 - Integration tests for RLS-safe SQL and `db.write` gating.

### Phase 6 - Ephemeral Jobs (Job-Scoped Deps)

**Goals**
- `--ephemeral` job runs in job namespace with `databases` + `services`.
- Replace `.eve/services.yaml` with manifest `services`.

**Worker**
- Remove `.eve/services.yaml` parsing in `apps/worker/src/invoke/invoke.service.ts`.
- Provision manifest `services` for ephemeral jobs only.

**CLI**
- `eve job create --ephemeral` (already planned).

**Tests**
- Integration test ensures ephemeral services provision and teardown.

**Cleanup**
- Remove any references to `.eve/services.yaml` in docs/tests.

### Phase 7 - Temporary Environments (PR + Pooling)

**Goals**
- Temporary envs with TTL, optional pool, and reset hook.
- Named temp envs can be claimed and released.

**API/Worker**
- `eve env create-temp <name> --id <id>`.
- Pool lifecycle + reset hook execution.

**Example repo**
- Add `pr` env definition with pool and reset hook.

**Tests**
- Integration tests for temp env claim, reset, release, and TTL cleanup.

### Phase 8 - DB Snapshotting

**Goals**
- Add snapshot import/export.
- Enable temp env resets via snapshot restore.

**API/Worker**
- `eve db snapshot create|restore`.
- Snapshot metadata stored per env.

**Tests**
- Restore snapshot in temp env and validate data reset.

### Phase 8 - VPS / Cloud Auth

**Goals**
- Supabase auth for VPS.
- OIDC auth for cloud SSO.

**API**
- Support RS256 JWT verification via issuer + JWKS.
- Job token issuance for RBAC propagation.

**CLI**
- Device flow login for OIDC.
- Refresh token support when available.

**Tests**
- Integration tests for auth-required endpoints and job token scoping.

## Example Repo and Testing Loop (Always On)

Each phase must:
- Update `../eve-horizon-fullstack-example` to use the new manifest and commands.
- Run `./bin/eh test integration` and fix failures.
- Add or extend integration tests to lock in behavior.

## Success Criteria (End State)

- Manifest-driven persistent envs are the default runtime.
- Pipelines and triggers are first-class and fully audited as jobs.
- Jobs inherit RBAC and can safely act on envs.
- Example repo demonstrates the full flow and stays green in integration tests.
