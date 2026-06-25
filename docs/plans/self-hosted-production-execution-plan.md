# Self-Hosted Production Execution Plan

> **Status**: Draft
> **Last Updated**: 2026-04-08
> **Companion to**: [`production-grade-customer-deployment-roadmap.md`](./production-grade-customer-deployment-roadmap.md) (strategic) — this doc is the concrete execution plan.
> **Purpose**: translate the strategic "arbitrary companies can deploy and self-support Eve Horizon" goal into file-level, command-level, skill-level workstreams that an engineer or agent can execute without interpretation.

## Why This Doc Exists

The existing [production-grade-customer-deployment-roadmap](./production-grade-customer-deployment-roadmap.md) defines *what* self-hosted GA looks like. This doc defines *how we get there*, in executable chunks:

- exact file paths and lines to change
- exact CLI commands, artifacts, and workflows to add
- an explicit **operator skill pack** so agents running a customer's Eve can self-support without reading the platform source
- a concrete **public bug intake repo** design (repo name, templates, triage workflow, automation wiring)
- a sequenced backlog suitable for `bd create` breakdown

If you are planning work, read the strategic roadmap first. If you are *doing* work, start here.

---

## 1. Deep Analysis: Where We Actually Are

### 1.1 Shape of the codebase (graphify 2026-04-07 + manual audit)

- 6 services (`api`, `orchestrator`, `worker`, `agent-runtime`, `gateway`, `sso`) + 1 UI (`dashboard`)
- 45 CLI command modules in `packages/cli/src/commands/`
- 152 plan docs in `docs/plans/` (many stale; 14 were marked Shipped in the 2026-04-07 audit)
- 5 known incident-class bugs open in `docs/issues/`
- 33 manual test scenarios + 65 API integration specs

Graphify flags the same five god services the strategic roadmap calls out — these are the hot paths where any incident will land:

| Service | Lines | Edges | Risk |
| --- | --- | --- | --- |
| `apps/orchestrator/src/loop/loop.service.ts` | 3217 | 52 | job claim, routing, gate evaluation |
| `apps/worker/src/deployer/deployer.service.ts` | 3037 | 66 | k8s apply, ingress, PVC, secrets |
| `apps/worker/src/invoke/invoke.service.ts` | 2366 | — | pipeline/action/script execution |
| `apps/api/src/projects/projects.service.ts` | 1908 | 51 | project + manifest resolution |
| `apps/agent-runtime/src/invoke/invoke.service.ts` | 1634 | 44 | agent job execution (primary path) |

Decomposition of these files is a Phase 3 (Hardening) concern — not a gate for customer deployments, but load-bearing enough that we must ship **contract tests** before we consider them safe for unattended operation.

### 1.2 What blocks a cold-start customer deployment today

Concrete blockers an agent will hit trying to stand up Eve for a new customer, grouped by surface:

**CLI defaults to the platform operator staging.**
- `packages/cli/src/lib/context.ts:45` — `export const DEFAULT_API_URL = 'https://api.eve.example.com';`
- `packages/cli/src/lib/context.ts:152, 203` — every context resolution falls through to that constant.
- `docs/system/user-getting-started-guide.md:57,99,144` — recommends `eve profile create staging --api-url https://api.eve.example.com` to new users.
- `README.md:245,267-271` — showcases `eve.example.com` URLs as the canonical examples.
- `packages/cli/src/commands/init.ts` — starter template URL defaults to `https://github.com/eve-horizon/eve-horizon-starter`.

**Release CI assumes the platform operator's deployment instance.**
- `.github/workflows/publish-images.yml:162-207` — hard-coded `matrix.repo: example-org/deployment-instance` for deploy dispatch. Other customers either need a PR into this file or need their own fork.
- `continue-on-error: true` (line 210) silently swallows dispatch failures; customers cannot rely on the trigger.
- Registry is fixed at `public.ecr.aws/w7c4v0w3/eve-horizon` (line 13). This is a vendor-neutral namespace but it is the platform operator-owned.

**No release artifact or compatibility contract.**
- Nothing in this repo pins `{platform_version, schema_version, infra_template_version, worker_image_version}` as an atomic release bundle that downstream infra repos can consume.
- There is no published changelog of breaking infra changes.

**Operational guardrails are behind kill switches.**
- `apps/orchestrator/src/cron/env-health-watchdog.service.ts:107` — sentinel is a no-op unless `EVE_ENV_HEALTH_ENABLED=true`.
- `apps/orchestrator/src/cron/managed-db-snapshot-scheduler.service.ts:22` — snapshot scheduler is a no-op unless `EVE_MANAGED_DB_SNAPSHOT_SCHEDULER_ENABLED=true`.
- `docs/system/observability.md:59-62` — metrics dashboards, log shipping presets, and correlation-aware sampling are still listed as *Planned*.

**Notify is simulated, not delivered.**
- `apps/worker/src/action-executor/action-executor.service.ts:1510` — `// Simulate notification - in real implementation, this would call notification service`.
- This means any remediation workflow that ends in "tell Slack" silently no-ops in a fresh customer install.

**No external secret manager support and no scoped integration credentials.**
- `EVE_GITHUB_TOKEN` is process-global; `create-pr` and any future `create-issue` action inherit it rather than reading scoped org/project credentials.
- Grep finds no Vault / AWS Secrets Manager / SSM / ExternalSecret integration in `packages/`, `apps/`, or `docs/`.

**No support bundle command.**
- Grep for `support.bundle|support_bundle|supportBundle` across `packages/cli/src/` and `apps/` returns zero results.
- There is no single command a customer can run to capture "what is wrong with my Eve" for a bug report.

**Known incident-class bugs still open.**
- `docs/issues/env-name-default-causes-global-job-serialization.md` — silently serialises every ad-hoc job on projects that set `x-eve.defaults.env`.
- `docs/issues/slack-file-download-gets-login-page-html.md`
- `docs/issues/agent-runtime-org-default-heartbeat-failure.md`
- `docs/issues/codex-harness-auth-401.md`
- `docs/issues/worker-git-auto-commit-not-executing.md`

### 1.3 What we already have that we should *not* re-invent

These substrates are real and we should build on them rather than ship new systems:

- **Infra template repo** `../deployment-instance` already exists with AWS Terraform, Kustomize overlays, `DEPLOYMENT.md`, `UPGRADE.md`, operator `bin/` scripts, and a `skills/` dir. This is the seed for the public template.
- **Sentinel watchdog** — disabled but functional. Daily summary cron at 08:00 UTC already scheduled. Circuit-breaker logic present.
- **Managed DB snapshot scheduler** — disabled but functional.
- **`eve job diagnose` / `eve env diagnose` / `eve system health`** — already the right shape for the "operator doctor" UX; need aggregation.
- **Event spine + trigger router + `external_item_map`** — enough to build the bug intake sync provider on.
- **`create-pr` action** — real, needs scoped credentials.
- **Developer skill pack** at `../eve-skillpacks/eve-se/` — 16 skills covering CLI-using developer flows. There is **no `eve-ops` pack for operators**.

---

## 2. What "Done" Looks Like (Gate Conditions)

A customer is considered to be on production-grade self-hosted Eve when **all of the following** are satisfied by a fresh agent starting from nothing but a repo URL and AWS credentials:

1. **Install**: agent can stand up a full Eve instance end-to-end from the public infra template without touching the eve-horizon source repo. Total human approvals limited to secrets and DNS.
2. **Smoke**: `eve support doctor --install` returns green across control plane, data plane, auth, registry, ingress, and storage.
3. **Upgrade**: customer can pin and move between releases using a published release manifest; rollback is a documented, tested path.
4. **Observability**: operator dashboards show job throughput, deploy failures, LLM cost, snapshot freshness, and runtime placement — without custom Grafana queries.
5. **Backup + restore**: managed DB snapshot scheduler runs on-default, daily, and a restore drill is scripted.
6. **Notifications**: `notify` action delivers to a real channel. Sentinel daily summary lands in the customer's Slack/Gateway integration.
7. **Secrets**: customer can bring their own secret manager or opt in to a managed secrets overlay; integration credentials are scoped, not process-global.
8. **Self-support**: customer operator (human or agent) can generate a support bundle and file a complete bug report against the public intake repo without touching kubectl.
9. **Bug loop closed**: public intake repo is live; triage agent classifies, requests evidence, and converts reproducible bugs into PRs against eve-horizon; notifications flow to Slack.
10. **No open incident-class issues** — `docs/issues/*.md` are either closed or covered by manual scenarios + integration tests with regression coverage.

These are the exit criteria. Each workstream below is calibrated to one or more of them.

---

## 3. Workstreams

Each workstream lists: **deliverables**, **acceptance criteria**, **key files**, **dependencies**, and **owner suggestion (agent persona)**. Phase numbers align with the strategic roadmap.

### WS-1 — Kill the staging defaults (Phase 1)

**Goal**: no customer-facing surface assumes `eve.example.com`.

Deliverables:
- Remove `DEFAULT_API_URL` constant. Resolution order becomes: CLI `--api-url` flag → `EVE_API_URL` env → `.eve/profile.yaml` → explicit `eve profile create` (fail with actionable message if none set).
- `eve init` prompts for `api-url` with no default; in `--non-interactive` mode, fail without it.
- Replace `https://github.com/eve-horizon/eve-horizon-starter` default in `packages/cli/src/commands/init.ts` with a `--template` flag defaulting to `eve-horizon/eve-horizon-starter` (neutral org) and surfacing the prompt when not passed.
- Update `docs/system/user-getting-started-guide.md`, `README.md`, and every `docs/system/*.md` example to use placeholders (`https://api.eve.example.com`, `{org}-{project}`).
- Add a linter (simple grep in `scripts/lint-docs.sh`) that fails CI when `eve.example.com` appears outside `docs/deploy/staging.md` or `docs/plans/`.

Acceptance:
- `grep -r eve.example.com -- packages/cli docs/system README.md` returns nothing matching code or user guides.
- Running `eve system health` with no profile yields a clear bootstrap error that points to the install skill.

Key files: `packages/cli/src/lib/context.ts`, `packages/cli/src/commands/init.ts`, `packages/cli/src/commands/profile.ts`, `docs/system/user-getting-started-guide.md`, `README.md`, new `scripts/lint-docs.sh`.

Owner: `platform-cli` agent.

### WS-2 — Release manifest and neutral deploy dispatch (Phase 1)

**Goal**: downstream infra repos consume a release contract rather than source-CI dispatches.

Deliverables:
- Publish a **release manifest** artifact on every `release-v*` tag:
  ```
  release-manifest.json
  {
    "platform_version": "0.1.200",
    "git_sha": "...",
    "images": { "api": "...@sha256:...", "orchestrator": "...@sha256:...", ... },
    "schema_version": 42,
    "min_infra_template_version": "0.3.0",
    "required_env": ["EVE_DATABASE_URL", "EVE_JWT_PRIVATE_KEY", "..."],
    "breaking_changes": [],
    "notes_url": "https://github.com/eve-horizon/eve-horizon/releases/tag/release-v0.1.200"
  }
  ```
  Publish to GitHub Releases as `release-manifest.json` and also to a public S3/ECR-backed URL so non-GitHub deploys can poll it.
- Convert `.github/workflows/publish-images.yml` to a **publish-only** workflow. Remove hard-coded `matrix.repo: example-org/deployment-instance`.
- Add a new **pull-model** flow: the infra repo watches the release manifest URL and opens its own PR on a new version. Reference impl lives in `../deployment-instance/.github/workflows/check-upstream.yml`.
- Document the contract in `docs/system/release-contract.md`.

Acceptance:
- A fresh infra repo fork can detect and apply a new platform release without any change in eve-horizon CI.
- `docs/system/release-contract.md` defines semver policy, supported-window, and migration rules.

Key files: `.github/workflows/publish-images.yml`, new `.github/workflows/publish-release-manifest.yml`, new `docs/system/release-contract.md`, new `../deployment-instance/.github/workflows/check-upstream.yml`.

Owner: `platform-release` agent.

### WS-3 — First-boot bootstrap script + topology overlays (Phase 1)

**Goal**: a customer can go from empty repo to green smoke test with one command plus secrets.

Deliverables:
- New operator CLI: `eve ops bootstrap` (wraps `../deployment-instance/bin/*` into a single path):
  1. validate AWS creds
  2. apply Terraform (VPS + RDS + DNS)
  3. install k3s
  4. fetch release manifest, apply kustomize with image digests
  5. seed JWT keypair, bootstrap token, first admin, first org
  6. run `eve support doctor --install`
- Two supported topologies, each an overlay in `../deployment-instance/k8s/overlays/`:
  - `single-node` — reference single-node (already the current AWS overlay)
  - `ha-small` — 3-node k3s with RDS Multi-AZ, documented resource floor
- Topology matrix documented in `docs/deploy/topologies.md` with failure domains, sizing, and "when to graduate from single-node."

Acceptance:
- `eve ops bootstrap --topology single-node` on a clean AWS account produces a green `eve support doctor --install` within 20 minutes, with the only human steps being the DNS record and secret entry.

Key files: new `packages/cli/src/commands/ops.ts`, `../deployment-instance/bin/eh-bootstrap`, `../deployment-instance/k8s/overlays/ha-small/`, new `docs/deploy/topologies.md`.

Owner: `platform-installer` agent + infra repo maintainer.

### WS-4 — `eve support doctor` and `eve support bundle` (Phase 2)

**Goal**: one command tells you if the platform is healthy; one command captures everything needed for a bug report.

Deliverables:
- `eve support doctor` — aggregates:
  - `eve system health`
  - cluster status (k3s/EKS probes via existing `cluster-health` service if present)
  - orchestrator loop lag (new metric exported via `/internal/metrics`)
  - sentinel last-tick timestamp + degraded env count
  - managed DB snapshot freshness
  - runtime placement: count of agent-runtime pods ready vs. expected
  - registry reachability
  - ingress + TLS validity
  - recent failed jobs (last 24h)
  - deploy drift (release manifest vs. running image digests)
  Each check emits a line with `PASS|WARN|FAIL` + remediation hint. Exit code reflects worst status.

- `eve support bundle create` — writes a single redacted tarball under `./eve-support-bundles/`:
  - `manifest.json` (platform_version, topology, timestamp, config hash)
  - `cluster-state.json` (kubectl `get` for eve namespace, redacted)
  - `doctor.json` (full `doctor` output)
  - `jobs.ndjson` (last N failed jobs + diagnoses)
  - `logs/` (last N minutes from each deployment, redacted)
  - `secrets-summary.json` (names and presence only — never values)
  - `env-config.json` (key presence only)
  Redaction uses a deny-list of keys matching `/token|secret|key|password|dsn/i`.

- `eve support report-bug` — interactive wrapper. Collects symptom, reproduction, severity; calls `bundle create`; opens the GitHub issue via WS-9.

Acceptance:
- `doctor` exits non-zero on any FAIL and prints an actionable next step.
- `bundle create` tarball contains no string matching the secrets deny-list pattern (verified by a bundled scanner step).
- `report-bug` can file a complete, triage-ready issue without operator hand-editing.

Key files: new `packages/cli/src/commands/support.ts`, new `apps/api/src/support/support.controller.ts`, new `apps/api/src/support/redactor.ts`, new `docs/system/support-toolkit.md`.

Owner: `platform-support` agent.

### WS-5 — Default-on operational guardrails (Phase 2)

**Goal**: guardrails that currently require opt-in env vars become default-on in production topologies.

Deliverables:
- Flip `env-health-watchdog.service.ts:107` gate to default-on when `EVE_MODE=production` (new env var) or topology overlay sets `sentinelEnabled: true`.
- Flip `managed-db-snapshot-scheduler.service.ts` gate the same way.
- New `EVE_MODE` env var accepted values: `development` | `production`. Topology kustomize overlays set this.
- `eve support doctor` flags sentinel-off and snapshot-scheduler-off as WARN in `development`, FAIL in `production`.
- Real `notify` action: replace `action-executor.service.ts:1498-1517` simulation with a `NotifierService` that resolves the project's notification integration (Slack/Gateway) and posts. Fall back to writing to `execution_logs` with a WARN if no integration is configured. Respect org/project scoping.

Acceptance:
- Fresh production-topology install has sentinel ticking, daily summary at 08:00 UTC, snapshots on schedule, and `notify` delivering to whichever Slack channel the integration points at — no operator config beyond the integration itself.
- Manual scenario `31-production-hardening.md` extended to verify all three in a single run.

Key files: `apps/orchestrator/src/cron/env-health-watchdog.service.ts`, `apps/orchestrator/src/cron/managed-db-snapshot-scheduler.service.ts`, `apps/worker/src/action-executor/action-executor.service.ts`, new `apps/worker/src/notifier/notifier.service.ts`, `tests/manual/scenarios/31-production-hardening.md`.

Owner: `platform-ops` agent.

### WS-6 — Observability presets (Phase 2)

**Goal**: operators get a dashboard on day one, not after a Grafana rabbit hole.

Deliverables:
- Ship an **OTEL collector** Kustomize component in the infra template that forwards logs, metrics, and traces to a configurable endpoint (Loki/Tempo/Mimir or CloudWatch/Datadog via exporter).
- Ship three canned **Grafana dashboards** as JSON under `../deployment-instance/observability/dashboards/`:
  1. `platform-overview.json` — job throughput, error rate, deploy success
  2. `cost-and-budget.json` — LLM cost, budget balance, top spenders
  3. `reliability.json` — sentinel state, runtime placement, snapshot freshness
- Promote three planned items from `docs/system/observability.md:59-62` to **implemented** with code:
  - service-level metrics: expose `/internal/metrics` Prom endpoint on API/orchestrator/worker/agent-runtime
  - correlation-aware log sampling (env-controlled rate)
  - at least one log shipping preset (start with CloudWatch exporter config)
- Add alert rule file `observability/alerts.yaml` covering the guardrails in WS-5.

Acceptance:
- Fresh bootstrap with `--observability=aws` produces a working Grafana with the three dashboards populated from real data within 15 minutes.
- `eve support doctor` reports "observability: PASS" when dashboards are reachable and the collector is up.

Key files: `apps/*/src/metrics/`, new `../deployment-instance/k8s/components/otel/`, new `../deployment-instance/observability/`, `docs/system/observability.md`.

Owner: `platform-observability` agent.

### WS-7 — Known-incident closure with regression coverage (Phase 3)

**Goal**: nothing left sitting in `docs/issues/` without a fix or a test.

Deliverables (one PR per issue; each PR **must** land an integration or manual test that would have caught the bug):

| Issue | Fix approach | Regression test |
| --- | --- | --- |
| `env-name-default-causes-global-job-serialization.md` | `jobs.service.ts:467-470` — apply `defaults.env` only when `data.run_id \|\| data.action_type` is set. Document `env_name=null` semantics. | new scenario: create 3 ad-hoc agent jobs with `x-eve.defaults.env` set, assert all run concurrently. |
| `slack-file-download-gets-login-page-html.md` | account-specific provider resolution in gateway; validate content-type before treating as file. | manual scenario `08-chat-gateway-slack.md` extended to download a file from a private channel and assert bytes. |
| `agent-runtime-org-default-heartbeat-failure.md` | bootstrap path reconciles `org_default` heartbeat once per agent-runtime boot. | new integration test simulating first-boot heartbeat with an empty state. |
| `codex-harness-auth-401.md` | codex token refresh path. | harness-level mocked OAuth refresh in unit tests. |
| `worker-git-auto-commit-not-executing.md` | worker git-auto-commit path. | manual scenario extension. |

Acceptance:
- All five issue files marked **Resolved** with a commit hash and a test pointer.
- `pnpm test` and the matching manual scenarios pass.

Owner: `platform-incident-closer` agent.

### WS-8 — Scoped credentials and external secrets (Phase 4)

**Goal**: remove process-global tokens; support real customer secret stores.

Deliverables:
- Replace `EVE_GITHUB_TOKEN` dependency in `action-executor.service.ts` with a new `GithubCredentialResolver` that reads a scoped credential from `project_secrets` → `org_secrets` → fallback.
- Introduce an `integration_credentials` table keyed by `(org_id, provider, scope)` with audit fields.
- Add an **External Secrets overlay** to the infra template using the upstream External Secrets Operator; support AWS Secrets Manager and SSM Parameter Store at minimum. Document the mapping from Eve secret names to external paths.
- Document key rotation runbook in `docs/runbooks/secret-rotation.md`.

Acceptance:
- `create-pr` and the new `create-issue` action both work with a scoped project credential and no `EVE_GITHUB_TOKEN` env var set.
- Manual scenario verifies rotation: change the upstream secret, assert Eve picks up the new value on next reconcile tick without a restart.

Owner: `platform-security` agent.

### WS-9 — Public bug intake repo and triage automation (Phase 5)

This is the customer-visible support loop. See §5 for the full design.

Deliverables:
- New public repo `eve-horizon/eve-horizon-support` with issue forms, triage labels, and a CODEOWNERS file pointing at the triage agent team.
- GitHub Issues sync provider implementing `packages/db/src/sync/provider.ts`'s interface.
- Triage workflow wired via the existing trigger router:
  - `github.issue.opened` → `triage-platform-bug` agent job
  - agent enriches with `external_item_map`, classifies severity and subsystem, requests missing evidence, or routes to remediation
- `eve support report-bug` in WS-4 files against this repo.
- Internal mirror for sensitive issues: private repo or Eve project with a policy gate.

Acceptance:
- Filing a bug via `eve support report-bug` produces a GitHub issue with a filled-in template, a triage comment within 5 minutes, and a Slack notification to the `#eve-platform-triage` channel.
- Sensitive bugs never mirror to the public repo.

Owner: `platform-support` + `triage-agent`.

### WS-10 — Remediation automation (Phase 5, step B)

**Goal**: reproducible bugs become PRs against eve-horizon without a human hand-editing intake.

Deliverables:
- On label `area/*` + `severity/≤2` + `status/reproduced`, spawn a `remediation` agent job against the eve-horizon repo with:
  - support bundle as input context
  - failing scenario as the test harness
  - PR opening scoped credential from WS-8
- Guardrails:
  - no auto-merge
  - no auto-deploy
  - human approval gate required before merge
  - bounded tool budget per remediation attempt
- Slack notification on PR open with issue link, verification summary, and review owner.

Acceptance:
- At least 3 seed bugs (e.g. the 5 in `docs/issues/`) can be resolved this way end-to-end in dry-run mode.

Owner: `remediation-agent` (built on top of existing agent runtime).

### WS-11 — Operator skill pack (`eve-skillpacks/eve-ops/`) — **NEW**

**Goal**: agents operating a customer's Eve have a skill pack covering install, upgrade, incident response, and bug reporting — so the customer does not need us.

This is the skills deliverable the user asked for. It sits alongside `eve-se/` (developer) and `eve-work/` (job execution) packs in `../eve-skillpacks/`.

Proposed skills (one SKILL.md each):

| Skill | Purpose | References |
| --- | --- | --- |
| `eve-ops-index` | Load first. Route operator questions. | Index of all ops skills. |
| `eve-install` | Stand up a new self-hosted Eve from the public infra template. | WS-3 bootstrap, topologies, secrets. |
| `eve-upgrade` | Move between supported releases using the release manifest. | WS-2 release contract. |
| `eve-backup-restore` | Snapshot, verify, and restore managed DB and org-fs. | WS-5 scheduler defaults. |
| `eve-incident-response` | Ladder from symptom to remediation. | `eve support doctor`, `eve job diagnose`, `eve env diagnose`. |
| `eve-observability-setup` | Install OTEL collector and dashboards. | WS-6. |
| `eve-security-hardening` | Secrets, TLS, RBAC, rotation. | WS-8. |
| `eve-report-bug` | Produce a complete bug report with evidence. | WS-4 `support bundle`, WS-9 intake repo. |
| `eve-self-host-topologies` | Pick and operate the right topology. | WS-3 overlays. |
| `eve-release-watch` | Poll release manifest, decide upgrade cadence. | WS-2. |

Each skill:
- lists **triggers** (`when to use`)
- cites **exact CLI commands** and **file paths** the operator should touch
- provides **validation steps** (e.g. "run `eve support doctor`, verify green")
- links to the relevant runbook under `docs/runbooks/`

Acceptance:
- An agent with only these skills (no access to eve-horizon source) can install Eve on a fresh AWS account and resolve a seeded incident without escalation.

Owner: `skills-author` agent with the `eve-docs-upkeep` + `eve-skill-distillation` skills.

### WS-12 — Operator manual + runbook library

**Goal**: a single human-readable operator manual, not 150 plans.

Deliverables:
- New top-level directory `docs/operator/` with:
  - `installation.md` — the human version of `eve-install`
  - `upgrade.md` — human version of `eve-upgrade`
  - `topologies.md` — moved from WS-3 into this tree
  - `security.md`
  - `backup-restore.md`
  - `observability.md` (move content out of `docs/system/` for operator-facing concerns)
- New `docs/runbooks/`:
  - `bad-deploy.md`
  - `managed-db-restore.md`
  - `auth-bootstrap-failure.md`
  - `slack-integration-broken.md`
  - `agent-runtime-placement-failure.md`
  - `secret-rotation.md`
  - `rollback-platform-release.md`
- Each runbook has: symptom, detection (what doctor says), diagnosis steps, safe fix, verification, escalation.

Acceptance:
- `docs/operator/` and `docs/runbooks/` are the *only* things a new operator needs to read; everything else is reference.
- Each runbook is exercised at least once via a manual scenario.

Owner: `docs-agent` with `eve-docs-upkeep`.

---

## 4. Sequencing

Execution order (dependencies flow top-down):

```
Phase 1 (unblocks customer deployments)
├── WS-1  Kill staging defaults          ──┐
├── WS-2  Release manifest + dispatch    ──┤
└── WS-3  Bootstrap + topologies         ──┘   → WS-4, WS-11-install

Phase 2 (self-support)
├── WS-4  Doctor + bundle + report-bug   ──┐
├── WS-5  Guardrails default-on          ──┤
└── WS-6  Observability presets          ──┘   → WS-11 skills, WS-12 runbooks

Phase 3 (hardening)
└── WS-7  Close incident-class issues

Phase 4 (enterprise ops, parallelisable with 3)
└── WS-8  Scoped creds + external secrets

Phase 5 (bug loop, depends on WS-4 + WS-8)
├── WS-9  Public intake repo + triage
└── WS-10 Remediation automation

Cross-cutting (start early, keep current)
├── WS-11 Operator skill pack
└── WS-12 Operator manual + runbooks
```

Critical path to "a new customer can install and run Eve self-hosted" is **WS-1 → WS-2 → WS-3 → WS-4 → WS-11 (install skill)**. Everything else layers quality, reliability, and the support loop on top.

---

## 5. Public Bug Intake Repo: Concrete Design

This is the core of the customer-support loop. The strategic roadmap recommends a public repo plus a private path; this section specifies the exact shape.

### 5.1 Repo

- **Name**: `eve-horizon/eve-horizon-support` (public)
- **Purpose**: platform bugs, docs gaps, feature requests, upgrade questions. **Not** for customer-tenant data, security-sensitive incidents, or proprietary prompts.
- **Not**: the eve-horizon source repo. Keep the source repo's issue tracker for internal engineering work.

### 5.2 Issue forms (`.github/ISSUE_TEMPLATE/`)

Four forms:

1. **Platform bug** — required fields:
   - platform version (auto-filled by `report-bug`)
   - topology (`single-node` / `ha-small` / `other`)
   - affected subsystem dropdown (`api`, `orchestrator`, `worker`, `agent-runtime`, `gateway`, `sso`, `cli`, `deploy`, `auth`, `billing`)
   - symptom
   - reproduction steps
   - support bundle URL (generated by `support bundle create`)
   - severity (`sev-1` … `sev-4`)
   - confirm "no secrets or tenant data in the bundle" checkbox
2. **Docs gap** — pointer to the doc, what was wrong, what was expected.
3. **Feature request** — use case, desired UX, current workaround.
4. **Security report** — **redirect** form: points the user to the private disclosure path. Never accept security details in public.

### 5.3 Labels

- `area/*` — mirrors the subsystem dropdown
- `severity/1..4`
- `status/triage`, `status/needs-evidence`, `status/reproduced`, `status/in-remediation`, `status/awaiting-release`
- `type/bug`, `type/docs`, `type/feature`

### 5.4 Intake → triage

1. `github.issue.opened` webhook hits `apps/api/src/integrations/github.controller.ts`.
2. Trigger router matches the event and opens a job in the `eve-platform-triage` project.
3. Triage agent (built on existing agent runtime) does:
   - dedupe: search `external_item_map` + GitHub search for similar title/body
   - classify severity and area using the form fields
   - if support bundle missing or URL unreachable → label `status/needs-evidence`, post comment asking for it
   - else → label `status/reproduced` if a known scenario matches, else `status/triage`
   - post a triage summary comment
   - notify `#eve-platform-triage` via `notify` action (WS-5 must be real for this to work)
4. Private incidents (security or tenant-sensitive) follow a parallel path into a private project. Policy gate blocks mirroring to public.

### 5.5 Intake → remediation (WS-10)

When an issue has `status/reproduced` + `severity/1|2` + `area/*`, remediation agent:
1. clones eve-horizon on a branch
2. writes a failing test that reproduces the bug (from the bundle)
3. makes the smallest safe change
4. runs targeted verification
5. opens a PR against `main` with issue link, verification output, and risk notes
6. posts PR link on the issue and Slack

Never auto-merge. Never auto-deploy.

### 5.6 SLA the customer can see

Publish in `README.md` of the intake repo:

- sev-1: first response ≤ 2h (triage comment from agent), human ack ≤ 1 business day
- sev-2: first response ≤ 8h, human ack ≤ 2 business days
- sev-3/4: first response ≤ 2 business days

These are agent-met for first response; humans gate the rest.

### 5.7 Private path

- Repo: `eve-horizon/eve-horizon-support-private` (or an Eve project with access bound to `eve-platform-support` team)
- Used for: customer tenant data, security disclosures, prompts, stack traces with internal paths
- Entry point: `eve support report-bug --private` routes here with end-to-end encrypted bundle upload
- Never mirrored publicly. Summaries in the public repo are redacted and manually posted.

### 5.8 Why this works

- It reuses substrates we already have: trigger router, `external_item_map`, GitHub webhook ingestion, `create-pr`, agent runtime.
- It does not require a new service.
- It gives customers a URL they can share with their own engineering organisation.
- It unblocks the "we are not required to hold their hand" requirement: agents on the customer side can produce bundles and file issues; agents on our side can classify and fix.

---

## 6. Documentation & Skills: Self-Support Without Hand-Holding

The user requirement is that customers can self-support without our direct involvement. That translates to three concrete artefacts:

### 6.1 `docs/operator/` — the single human entry point

See WS-12. Must be the thing we link to from every "how do I …" customer question. Kept short; anything operator-facing stops landing in `docs/plans/` or `docs/system/`.

### 6.2 `docs/runbooks/` — one page per incident class

Each runbook has the same structure (enforced by a template at `docs/runbooks/_template.md`):

```
# <Incident name>

## Symptom
## Detection (what `eve support doctor` says)
## Diagnosis
## Safe fix
## Verification
## Escalation (when to file a support bug)
```

Every runbook must end with a pointer to the intake repo template for "I followed the runbook and it didn't work."

### 6.3 `eve-skillpacks/eve-ops/` — the agent entry point

See WS-11. This is the delta that lets customer agents operate Eve without reading source code.

The three artefacts reinforce each other:
- Humans read `docs/operator/` and follow `docs/runbooks/`.
- Agents load `eve-ops-index` and drill into the right skill, which links back to the runbooks.
- Both paths end in the same place: `eve support doctor`, `eve support bundle`, `eve support report-bug`.

---

## 7. Test Strategy for the Execution Plan

We need three things that are not well-covered today:

1. **Customer conformance suite** — runs on every `release-v*` tag. Brings up a clean single-node topology in a throwaway AWS account (or k3d facsimile), runs `eve ops bootstrap`, runs the full `eve support doctor`, runs three manual scenarios (smoke, deploy, chat). Fails the release if any step fails.
2. **Upgrade suite** — given two release manifests, install the old one, install a seed dataset, run the upgrade, assert data integrity and app availability.
3. **Restore drill** — schedule a snapshot, corrupt the DB deliberately, restore, verify.

Both live under `tests/conformance/` (new) with their own harness; not in `tests/integration/` or `tests/manual/`.

---

## 8. Open Questions (decide before starting)

1. **Registry hosting** — do we keep `public.ecr.aws/w7c4v0w3` as the long-term neutral namespace, or move to a vendor-independent registry under the `eve-horizon` GitHub org? Affects WS-2 release manifest image references.
2. **Private incident intake** — private GitHub repo vs. Eve project. The latter is more "eat your own dogfood" but adds a dependency on the very platform that may be broken when a customer is filing a bug. Lean GitHub-private for bootstrap safety.
3. **Topology overlays scope** — do we commit to `ha-small` now or defer to Phase 6? My recommendation: ship single-node at GA, document ha-small as experimental, stabilise later.
4. **`EVE_MODE=production` vs. per-feature flags** — I recommend a single mode flag plus per-feature overrides, so operators can diagnose "why is X disabled."
5. **Remediation agent blast radius** — how many autonomous turns before asking a human? Default proposal: 20 tool calls OR 1 file write to source, whichever first.

---

## 9. What to Land First (Week 1 Pull Requests)

Smallest useful slice that makes customer deployments real:

1. WS-1.a — remove `DEFAULT_API_URL` hardcoded staging URL; replace with explicit resolution + doc lint. (one PR)
2. WS-1.b — update `user-getting-started-guide.md` and `README.md` to use placeholders. (one PR)
3. WS-2.a — ship `publish-release-manifest.yml` alongside existing image publish. (one PR, purely additive)
4. WS-4.a — skeleton `eve support doctor` command that just aggregates existing `eve system health` + `eve job list` + sentinel state. Cheap and immediately useful. (one PR)
5. WS-11.a — `eve-ops-index` + `eve-install` skill stubs pointing at the existing infra template `DEPLOYMENT.md`. (one PR in `eve-skillpacks`)

Total: ~5 small PRs. None of them block each other. Every one of them is visible on day one.

---

## 10. Bottom Line

The platform is close. The missing work is **productisation, not invention**: we have sentinel, snapshots, deploy, auth, events, agents, and a template infra repo already. What is missing is the contract — default-off → default-on, staging-centric → customer-centric, "ask us on Slack" → "file an issue, agent picks it up."

Execute in this order and customers get a credible self-hosted Eve:

1. Kill staging defaults (WS-1)
2. Publish the release contract (WS-2)
3. Make bootstrap one command (WS-3)
4. Ship the doctor + bundle + report-bug triad (WS-4)
5. Default-on guardrails (WS-5) + observability presets (WS-6)
6. Close known incidents (WS-7)
7. Ship the public intake repo with triage (WS-9)
8. Add remediation automation (WS-10) once WS-4 + WS-8 are in place

The operator skill pack (WS-11) and runbook library (WS-12) are built *alongside* each workstream — not after. Skills without code are vapour; code without skills is a product only we can operate.
