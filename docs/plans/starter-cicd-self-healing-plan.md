# Starter CI/CD + Self-Healing Automation Plan

> Status: Draft
> Last Updated: 2026-01-27
> Owner: Platform (Eve Horizon)
> Purpose: Implement event-driven CI/CD and remediation flows for the starter repo, with k8s-only log access and remediation concurrency limited to 1 per environment.

## Scope

- Trigger-driven pipelines/workflows from GitHub, system failure, and cron events.
- Cron scheduler emitting `cron.tick` events.
- k8s-only app log access API + CLI.
- Remediation workflows that **always open PRs** (no direct pushes to `main`).
- Concurrency control: **one remediation job per env**.

## Non-Goals

- Non-k8s log sources (cloud log providers) in this phase.
- Auto-merge of remediation PRs.
- Full workflow-skill system overhaul.

## Requirements

1) `github.push` on `main` triggers integration tests; success deploys staging.
2) Failed tests trigger remediation that opens a PR.
3) Hourly log audit on k8s logs; errors trigger remediation PR.
4) Remediation jobs are serialized **per env** (max 1 active per env).
5) Manifest-declared required secrets are validated on sync (or via explicit CLI), with actionable remediation guidance.
6) Auto-generate safe secrets when possible and provide CLI export for external webhook setup.

## Design Overview

### 1) Trigger-driven execution

- The event router should **create pipeline runs** and **workflow jobs** from manifest triggers.
- Sources:
  - `github.push` (webhook already normalized and stored).
  - `system.pipeline.failed` (already emitted by orchestrator).
  - `cron.tick` (new scheduler).

### 2) Workflow invocation enhancements

- Allow workflow definitions to specify `hints` (including `gates`) and propagate them into the created job.
- For remediation workflows, set `hints.gates` to `remediate:<project_id>:<env>`.
- Do **not** set `env_name` for remediation jobs unless we want to block all env work; instead pass env in workflow input.

### 3) Remediation gating (1 per env)

- Gate key: `remediate:<project_id>:<env_name>`.
- Orchestrator already supports `hints.gates` (see `environment-gating.md`).
- TTL should follow `hints.timeout_seconds` (default 30m) to avoid permanent locks.

### 4) k8s-only log access

- New API endpoint (k8s-only):
  - `GET /projects/{project_id}/envs/{env}/services/{service}/logs`
  - Query params: `since`, `tail`, `grep`, `level` (MVP: `since` + `tail` + `grep`).
- Implementation uses Kubernetes API to fetch pod logs by labels for the deployed service.
- If env is not k8s-backed, return 400 with a clear error.

### 5) CI/CD pipeline model

- Pipelines defined in `.eve/manifest.yaml` using v2 `steps`.
- `ci-cd-main` pipeline:
  - `integration-tests` (script step)
  - `deploy-staging` (deploy action)
- Trigger: `github.push` on `main`.

### 6) Remediation workflows

- `fix-ci-failure` triggered on `system.pipeline.failed` for `ci-cd-main`.
- `log-audit` triggered by `cron.tick` (hourly).
- Remediation jobs use git controls:
  - `git.branch=job/${job_id}`
  - `git.commit=auto`
  - `git.push=on_success`
  - `create-pr` action with `GITHUB_TOKEN`.

### 7) Secrets validation (sync-time + CLI)

- Allow manifest to declare required secrets, e.g.:
  - `x-eve.requires.secrets: [GITHUB_TOKEN, REGISTRY_TOKEN]`
  - Step-level overrides: `pipelines.*.steps[].requires.secrets`
- `eve project sync --validate-secrets` (or `--strict`) checks availability across scopes.
- Response includes missing secrets with remediation text (scope-aware):
  - Example: `eve secrets set GITHUB_TOKEN <token> --scope project --project proj_xxx`

### 8) Auto-generated secrets + safe export

- Support auto-generation for safe secrets (starting with `GITHUB_WEBHOOK_SECRET`) at project scope.
- Webhook verification should prefer **project-scoped** `GITHUB_WEBHOOK_SECRET` with org/system fallback for legacy setups.
- Provide a CLI command to emit **safe secrets** for external configuration:
  - `eve secrets export --project proj_xxx --keys GITHUB_WEBHOOK_SECRET`
  - Output includes key + value with warnings and optional JSON.
- Only allow export of **explicitly allowlisted** keys (never arbitrary secrets).

## Implementation Plan

### Phase 0 — Align docs + schemas (1–2 days)

- Reconcile `events.md`, `pipelines.md`, `workflows.md`, and `system-overview.md` to avoid contradictory statements about trigger execution.
- Document workflow `hints` propagation and remediation gate pattern.
- Document manifest secret requirements + validation behavior.

### Phase 1 — Trigger-driven pipeline/workflow creation (3–5 days)

- Orchestrator: when matching triggers, **create pipeline runs** (for pipelines) and **create jobs** (for workflows).
- Add trigger filter support for:
  - `github.push` with branch match.
  - `system.pipeline.failed` with pipeline name match.
- Integration tests:
  - Trigger -> pipeline run created -> jobs created.
  - Trigger -> workflow job created.

### Phase 2 — Cron scheduler (2–3 days)

- Add a simple scheduler in orchestrator (or a small cron service) that emits `cron.tick` events.
- Support manifest cron schedules (cron syntax) with idempotency keys.
- Integration tests for `cron.tick` -> workflow job creation.

### Phase 3 — k8s log API + CLI (3–5 days)

- API endpoint: fetch logs for `env + service` (k8s only).
- CLI command: `eve env logs <project> <env> <service> --since 1h --grep ERROR`.
- Tests: mock Kubernetes client or run against k3d in integration/e2e.

### Phase 4 — Remediation gating + PR-only policy (2–3 days)

- Workflow definitions accept `hints` and propagate `hints.gates`.
- Add remediation workflow templates using gates:
  - `remediate:<project_id>:<env>`
- Ensure remediation uses PR-only flow (`create-pr` action).

### Phase 5 — Starter validation flow (1–2 days)

- Confirm that starter repo pipelines + workflows run end-to-end against k8s stack.
- Add a small e2e scenario that triggers `github.push`, `system.pipeline.failed`, and `cron.tick`.

### Phase 6 — Secrets validation (2–3 days)

- Manifest schema: add `x-eve.requires.secrets` and step-level `requires.secrets`.
- API: add validation option on manifest sync (default warn-only, `--strict` fails).
- CLI: `eve secrets validate` and `eve project sync --validate-secrets`.
- Error model: return missing secrets + scope-ordered remediation hints.

### Phase 7 — Auto-generate + export safe secrets (2–3 days)

- Add allowlist for exportable secrets (start with `GITHUB_WEBHOOK_SECRET`).
- API: endpoint to generate (if missing) and return safe secrets at project scope.
- CLI: `eve secrets ensure --project proj_xxx --keys GITHUB_WEBHOOK_SECRET`.
- CLI: `eve secrets export --project proj_xxx --keys GITHUB_WEBHOOK_SECRET [--json]`.

## Acceptance Criteria

- A `github.push` event on `main` starts `ci-cd-main` and deploys staging on success.
- Failed integration tests trigger a remediation job that opens a PR (no direct push to `main`).
- Hourly `cron.tick` events create a log-audit job; errors lead to PRs.
- Only **one remediation job per env** can run at a time (gate enforced).
- Log audit uses k8s logs via the new API/CLI.
- `eve project sync --validate-secrets` reports missing secrets with remediation guidance.
- `eve secrets ensure` generates missing safe secrets and `eve secrets export` returns them for webhook setup.

## Risks / Mitigations

- **Log API permissions**: restrict to k8s-only; return 400 elsewhere.
- **Trigger storms**: enforce dedupe keys and rate limits on cron events.
- **Remediation loops**: add cooldown/backoff on repeated failures for the same env.

## Open Questions

- Should remediation jobs block deploys to the same env, or only serialize remediation?
- Should log audit run on `staging` only, or all persistent envs by default?

## Related Docs

- `docs/system/events.md`
- `docs/system/pipelines.md`
- `docs/system/workflows.md`
- `docs/system/environment-gating.md`
- `docs/ideas/starter-cicd-self-healing.md`
