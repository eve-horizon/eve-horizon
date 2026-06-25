# Manifest v2 (Compose-Plus) Core Implementation Plan

Status: Draft
Last Updated: 2026-01-26

## Principles

- CLI-first: every new capability is reachable via `eve` CLI and backed by API endpoints.
- Break/cleanup allowed: remove legacy manifest paths and dead code as we go.
- Opinionated versioning: one default path (conventional commits -> semver -> tag -> deploy by tag).
- Integration tests are the gate: do not advance phases until they pass.

Elegance with existing primitives:
- Reuse Release records as the canonical deploy unit; avoid new tag-only deploy paths.
- Keep worker action contracts stable (deploy requires `release_id`), add tag->release lookup only at API/runner boundary.
- Treat job services as first-class pipeline steps (same action executor, same logs/attempts).
- Use existing `worker_type` fields, but add real routing in orchestrator/worker (today it is only a hint).
- Preserve `defaults` under `x-eve.defaults` so job/env/harness hints keep working.

## Scope (Core)

In-scope:
- Manifest schema: `schema`, `project`, `registry`, `services`, `environments`,
  `pipelines`, `workflows`, `versioning`, `x-eve` (ingress, api_spec, role, defaults).
  Keep `domain` as a compatibility alias until ingress + API spec registration migrate.
- Services: `build` or `image`, `environment`, `ports`, `healthcheck`,
  `depends_on` (healthy).
- Environments: `deploy.ref` (branch|tag|sha), `auto`, `approval`,
  `overrides` (compose-like merge).
- Pipelines: `steps` with `action`, `script`, or `agent`.
- Job services for migrations/seeds (run via pipeline step).
- Env-specific worker pools (optional): worker services built/deployed with the
  app and selected via env config.

Out-of-scope (later fit):
- `clusters` and multi-cluster routing.
- Git-backed volumes and runner mounts.
- Advanced rollout strategies (blue/green, canary).

How deferred items fit later:
- `clusters` stays a top-level key; `environments.<env>.cluster` binds later.
- `volumes.x-eve.source.git` and `services.x-eve.runner_mounts` are reserved.
- `environments.workers` is core; future cluster routing will extend it.

## Schema Migration Reference

| Old (v1) | New (v2) | Migration Notes |
|----------|----------|-----------------|
| `components` | `services` | Rename; add `x-eve.role` for component/worker/job |
| `components[].port` | `services[].ports` | Single number → array of "host:container" strings |
| `components[].env` | `services[].environment` | Rename only |
| `components[].type` | `services[].x-eve.role` | `database` → role or external flag |
| `components[].external` | `services[].x-eve.external` | Move under x-eve namespace |
| `components[].migrations` | `services[]` with `x-eve.role: job` | Migrations become job services |
| `domain` | `services[].x-eve.ingress` | Per-service ingress config |
| `defaults` | `x-eve.defaults` | Move to x-eve namespace (top-level) |

## CLI Commands Affected

| Command | Phase | Change |
|---------|-------|--------|
| `eve env deploy` | 2, 3 | Support `--release-tag` input, resolve to release_id |
| `eve pipeline run` | 2 | Add `--only <step>` flag for single-step execution |
| `eve db migrate` | 4 | **Remove** — replaced by job services |
| `eve db schema/rls/sql` | — | Keep as-is (observability) |
| `eve api list/spec/call` | 5 | Read from `services[].x-eve.api_spec` |

## Beads + Branch Workflow

Feature branch: `feat/manifest-v2-compose` (or similar).

```bash
bd sync
bd create --title "Manifest v2 (compose-plus) core" --type epic --priority 1
# Create phase tasks and link to epic:
bd create --title "Phase 0: Kickoff + inventory" --type task
bd create --title "Phase 1: Schema + manifest sync" --type task
bd create --title "Phase 2a: Versioning + release records" --type task
bd create --title "Phase 2b: Step execution (action/script)" --type task
bd create --title "Phase 3: Services + deploy translation" --type task
bd create --title "Phase 4: Job services (migrations)" --type task
bd create --title "Phase 5: API specs + CLI observability" --type task
bd create --title "Phase 6: System docs + cleanup" --type task
bd create --title "Phase 7: Sister repo + e2e refresh" --type task
bd dep add <phase-0-id> <epic-id>
bd dep add <phase-1-id> <phase-0-id>
bd dep add <phase-2a-id> <phase-1-id>
bd dep add <phase-2b-id> <phase-1-id>
bd dep add <phase-3-id> <phase-2a-id>
bd dep add <phase-4-id> <phase-3-id>
# ...etc
```

Work hygiene:
- Update beads status as work starts/finishes; add comments per phase.
- Commit after each phase; keep commits small and named by phase.
- Before tests: `./bin/eh status`.

## Phase 0: Kickoff + Inventory

Goals:
- Freeze the opinionated core spec and map existing code paths.
- Set up tracking and branch hygiene.

Deliverables:
- This plan doc committed.
- Beads epic + phase tasks created.
- Inventory list of code areas to change (below).

Code areas to update:

| Area | Files | Phase |
|------|-------|-------|
| Manifest schema | `packages/shared/src/schemas/manifest.ts` | 1 |
| Release schema | `packages/shared/src/schemas/release.ts` | 2a |
| Pipeline schema | `packages/shared/src/schemas/pipeline.ts` | 1 |
| Manifest sync | `apps/api/src/projects/projects.service.ts` | 1 |
| Pipeline expander | `apps/api/src/pipelines/pipeline-expander.service.ts` | 2b |
| Deploy service | `apps/api/src/environments/environments.service.ts` | 2a, 3 |
| Deployer (worker) | `apps/worker/src/deployer/deployer.service.ts` | 3 |
| Orchestrator routing | `apps/orchestrator/src/` | 2b, 3 |
| CLI db commands | `packages/cli/src/commands/db.ts` | 4 |
| CLI pipeline commands | `packages/cli/src/commands/pipeline.ts` | 2b |

Integration tests that will need updates:
- `apps/api/test/integration/manifest.integration.test.ts`
- `apps/api/test/integration/pipelines-workflows.integration.test.ts`
- `apps/api/test/integration/environments.integration.test.ts`

Integration tests:
- `./bin/eh status`
- `./bin/eh test integration`

Exit criteria:
- Plan doc committed, beads epic created, integration tests clean.

## Phase 1: Schema + Manifest Sync

Goals:
- Replace legacy manifest schema with compose-plus core.
- Update manifest sync validation and parsing.

Note: Pipeline `steps[]` parsing with `action`, `script`, `agent` types **already exists**
in `PipelineExpanderService`. This phase focuses on schema validation, not execution.

Work:
- Update `packages/shared/src/schemas/manifest.ts`:
  - Add `ServiceSchema` with compose fields (`build`, `image`, `environment`, `ports`, `healthcheck`, `depends_on`)
  - Add `x-eve` extension schema (`role`, `ingress`, `api_spec`, `external`, `worker_type`)
  - Add `services: z.record(ServiceSchema)` to manifest
  - Keep `components` as deprecated alias (maps to services internally)
  - Move `defaults` to `x-eve.defaults` (top-level)
  - Keep `domain` accepted, map to first service with `x-eve.ingress.public: true`
- Update `packages/shared/src/schemas/pipeline.ts`:
  - Add `PipelineStepSchema` with proper validation (currently `z.record(z.unknown())`)
  - Validate `action`, `script`, or `agent` is present (one required)
  - Add `depends_on` array validation
- Update API manifest sync to validate new schema structure
- Add deprecation warnings for legacy fields in sync response

Compatibility layer:
- Internal code can call `getServicesFromManifest(manifest)` which returns services
  whether manifest uses `services` or legacy `components`
- This layer stays until Phase 3/5 complete

Integration tests:
- Update manifest integration tests to new schema
- Add validation tests for required keys and invalid shapes
- Test compatibility layer (components → services mapping)

Exit criteria:
- All integration tests pass.

## Phase 2a: Versioning + Release Records

Goals:
- Add version and tag fields to Release records
- Implement semver computation from conventional commits
- Support release_tag → release_id resolution

Opinionated versioning flow:
1. `release` action computes next semver from conventional commits since last tag
2. Persist release record with: git_sha + manifest_hash + **version** + **optional tag**
3. Optional git tag creation if git auth is available (not required for deploy)
4. `deploy` action targets `release_id` (or `release_tag` resolved to `release_id`)

Work:
- Add DB migration: `releases` table gets `version VARCHAR` and `tag VARCHAR` columns
- Update `packages/shared/src/schemas/release.ts`:
  - Add `version` and `tag` to `ReleaseResponseSchema`
- Update `apps/api/src/environments/environments.service.ts`:
  - `deploy()` accepts optional `release_tag` parameter
  - Add `resolveReleaseByTag(projectId, tag)` helper
  - Create release with version when going through release action
- Implement version computation:
  - Parse commits since last release tag
  - Apply conventional commit rules (feat → minor, fix → patch, BREAKING → major)
  - Store computed version in release record
- Update CLI `eve env deploy` to accept `--release-tag` flag

Integration tests:
- Release record creation with version field
- Tag → release_id resolution
- Deploy with release_tag parameter

Exit criteria:
- All integration tests pass.

## Phase 2b: Step Execution (Action/Script)

Goals:
- Define execution paths for `action` and `script` step types
- Wire output propagation between steps

Note: `PipelineExpanderService` already creates jobs with `execution_type` of
`action`, `script`, or `agent`. This phase implements the **execution** of action/script jobs.

Execution model:

| Step Type | Executor | Location |
|-----------|----------|----------|
| `agent` | Agent harness (mclaude/zai) | Worker |
| `action` | Action runner (build, deploy, release, job) | Orchestrator or Worker |
| `script` | Shell in runner pod | Worker |

Work:
- Define action execution in orchestrator:
  - Orchestrator recognizes `execution_type: 'action'` jobs
  - Built-in actions (`build`, `deploy`, `release`, `job`) execute inline or delegate
  - Custom actions route to worker
- Define script execution in worker:
  - Worker spawns shell in runner pod with job workspace
  - Streams stdout/stderr to job logs
  - Captures exit code as job result
- Wire output propagation:
  - `hints` object already carries `pipeline_run_id`, `step_name`, `git_sha`
  - Add `step_outputs` to pipeline_run record (JSON map of step_name → outputs)
  - Release step auto-injects `release_id` into outputs
  - Deploy step reads `release_id` from previous step outputs or explicit input
- Add CLI `eve pipeline run <name> --only <step>` for single-step execution

Integration tests:
- Action step execution (build → release → deploy flow)
- Script step execution with exit code handling
- Output propagation between steps

Exit criteria:
- All integration tests pass.

## Phase 3: Services + Deploy Translation

Goals:
- Translate compose-plus services into deployment manifests.
- Support env overrides and ingress mapping.
- Support env-specific worker pools deployed alongside services.

Override merge order (most specific wins):
1. Base: `services` section in manifest
2. Environment: `environments.<env>.overrides.services` (manifest)
3. Dynamic: `environments.overrides_json` (DB-stored, user-configurable)
4. Final: merged config used for deploy

Work:
- Update `apps/worker/src/deployer/deployer.service.ts`:
  - Read from `services` (via compatibility layer from Phase 1)
  - Implement compose-like deep merge for overrides
  - Derive ingress from `x-eve.ingress` (not top-level `domain`)
  - Map `ports` array to K8s container ports
  - Support `depends_on` health gating during deploy
- Update `apps/api/src/environments/environments.service.ts`:
  - Merge DB `overrides_json` on top of manifest overrides before sending to worker
  - Document merge order in code comments
- Update env-db resolver:
  - Identify DB services via `x-eve.role: database` or `x-eve.external.connection_url`
  - Read connection config from `services` not `components`
- Add worker pool support:
  - Parse `environments.<env>.workers[]` array
  - Mark one worker as `default: true` per env
  - Jobs without explicit `worker_type` route to default
  - Jobs with `worker_type` metadata route to matching pool
- Implement `worker_type` routing in orchestrator:
  - Currently `worker_type` is hint-only; make it real routing

Integration tests:
- Deploy translation tests (ports, env, ingress, overrides)
- Override merge order test (manifest → env → DB)
- Health gating tests for `depends_on: service_healthy`
- Worker pool routing tests (default + explicit `worker_type`)

Exit criteria:
- All integration tests pass.

## Phase 4: Job Services (Migrations, Seeds)

Goals:
- Migrations run as deterministic job services before deploy.
- Remove legacy migration fields and `eve db migrate` command.

Job service model:
- Services with `x-eve.role: job` are not deployed as long-running pods
- They run only when invoked via pipeline step or CLI
- Same execution model as other jobs (logs, attempts, status)

Work:
- Add `x-eve.role: job` recognition in deployer (skip deployment)
- Add pipeline `action: { type: job, service: <name> }` support in orchestrator:
  - Spawn job service container in target namespace
  - Mount volumes defined in service
  - Stream logs to job attempt
  - Block pipeline on failure
- Implement in worker action executor:
  - `JobActionExecutor` handles `action.type === 'job'`
  - Looks up service definition from manifest
  - Creates K8s Job resource, monitors completion
  - Returns success/failure to orchestrator
- Remove legacy migration support:
  - Drop `components[].migrations` schema support
  - Drop `depends_on.migrations` flag
  - **Remove `eve db migrate` CLI command** (replaced by job services)
  - Keep `eve db schema|rls|sql` for observability
- Update documentation:
  - Migration workflow: define job service → add to pipeline → runs automatically
  - Manual migration: `eve pipeline run deploy --only migrate --env staging`

New migration workflow:
```yaml
services:
  migrate:
    image: flyway/flyway:10
    command: ["-url=${service.db.url}", "migrate"]
    volumes:
      - ./db/migrations:/migrations:ro
    x-eve:
      role: job

pipelines:
  deploy:
    steps:
      - name: migrate
        action: { type: job, service: migrate }
      - name: deploy
        depends_on: [migrate]
        action: { type: deploy }
```

Integration tests:
- Job service runs after DB is healthy
- Pipeline blocks when job service fails
- Job service logs stream correctly
- `eve pipeline run --only migrate` works

Exit criteria:
- All integration tests pass.

## Phase 5: API Specs + CLI Observability

Goals:
- Auto-register API specs from `services[].x-eve.api_spec` on deploy.
- Keep CLI-first debugging paths intact.

Work:
- Update `registerComponentApiSpecs()` in environments service:
  - Read from `services` (via compatibility layer)
  - Use `x-eve.api_spec` not top-level `api_spec`
  - Resolve relative URLs against service ingress URL
- Support both `spec_url` (runtime fetch) and `spec_path` (repo file) modes
  - `spec_path` is limited to local `file://` repos for now
- Ensure `eve api list/spec/call` flows work with new structure
- Remove `components`/`domain` compatibility layer (all consumers migrated)

Integration tests:
- API spec registration with relative URL
- API spec registration from repo file path
- CLI `eve api list` returns expected data

Exit criteria:
- All integration tests pass.

## Phase 5.5: Self-Healing / Self-Improvement (Optional)

Prerequisites: Phases 2-4 complete (robust event emission and job execution).

Goals:
- Automatically react to failed deploys or error spikes by running an agent job that proposes fixes.
- Produce a PR for human review, never auto-merge.

Design (aligns with existing primitives):
- Trigger: `system.job.failed`, `system.pipeline.failed`, and deploy error logs.
- Action: create a pipeline run with a `job` step that invokes an agent harness.
- Inputs: job diagnostics + recent logs + manifest + release metadata.
- Output: patch + tests + PR via existing `create-pr` action.

Work:
- Add a system trigger preset that maps failure events to a remediation workflow.
- Add a remediation pipeline template (`diagnose -> propose -> create-pr`).
- Gate via org/project settings (opt-in), rate limits, and sandboxed repo access.
- Extend `create-pr` action to attach diagnostics and remediation summary.

Integration tests:
- Simulated failed deploy emits event and creates remediation job.
- Remediation job produces PR with expected summary/labels.

## Phase 6: System Docs + Cleanup

Goals:
- Add full manifest spec doc with examples for every section.
- Remove legacy docs and code paths.

Work:
- Write new system doc: `docs/system/manifest-v2.md`.
- Update `docs/system/README.md` and CLI docs where needed.
- Delete or archive legacy manifest docs.
- Remove compatibility layers:
  - `components` → `services` mapping
  - `domain` → `x-eve.ingress` mapping
  - Legacy `defaults` location
- Remove deprecated CLI command: `eve db migrate`

Integration tests:
- `./bin/eh status`
- `./bin/eh test integration`

Exit criteria:
- Docs complete, legacy removed, integration tests clean.

## Phase 7: Sister Repo + E2E Refresh (Later)

Goals:
- Update example repo and e2e tests for new manifest spec.

Work:
- Update `../eve-horizon-fullstack-example/.eve/manifest.yaml` to v2 schema
- Convert any `components` to `services`
- Add job service for migrations if applicable
- Update `tests/e2e` and `tests/e2e/README.md`
- Run e2e against k8s stack when ready

Exit criteria:
- E2E tests updated and passing (when scheduled).
