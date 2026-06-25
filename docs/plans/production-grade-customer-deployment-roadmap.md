# Production-Grade Customer Deployment Roadmap

> Status: Draft
> Last Updated: 2026-04-08
> Purpose: define the roadmap to take Eve Horizon from an operator-led beta to a production-grade platform that arbitrary companies can deploy, operate, and self-support without coming back to the platform operator for routine help.

## Executive Summary

Eve Horizon is no longer a prototype. The platform already has strong foundations:

- multi-service control plane (`api`, `orchestrator`, `worker`, `agent-runtime`, `gateway`, `sso`)
- auth + RBAC
- pipelines, workflows, releases, and persistent environments
- Slack and GitHub webhook/event ingestion
- managed DB snapshots and restore
- strong API integration coverage and a broad manual test suite

However, the current shape is still best described as **assisted production**, not **self-serve production**.

The biggest gap is not one missing feature. It is that the shipped experience is still centered on:

- the platform operator staging as the default control plane
- operator knowledge living in docs, plans, and the founders' heads
- optional or partially wired operational guardrails
- a few extremely load-bearing services and known incident-class bugs

If we want arbitrary companies to stand up their own Eve Horizon deployment and run their own company systems on it, the release has to meet a higher bar:

1. **Installable without us**
2. **Operable without kubectl-first heroics**
3. **Upgradable and restorable without tribal knowledge**
4. **Debuggable by their humans and their agents**
5. **Connected to a real support intake loop that can turn bugs into triage, fixes, PRs, and notifications**

## Inputs Reviewed

- `graphify-out/GRAPH_REPORT.md` and `graphify-out/graph.json`
- `docs/system/deployment.md`
- `docs/deploy/aws.md`
- `docs/system/auth.md`
- `docs/system/integrations.md`
- `docs/system/events.md`
- `docs/system/observability.md`
- `docs/system/user-getting-started-guide.md`
- `tests/manual/README.md`
- `.github/workflows/publish-images.yml`
- `packages/cli/src/lib/context.ts`
- `packages/cli/src/commands/init.ts`
- `apps/worker/src/action-executor/action-executor.service.ts`
- `apps/orchestrator/src/cron/env-health-watchdog.service.ts`
- `apps/orchestrator/src/cron/managed-db-snapshot-scheduler.service.ts`
- `packages/db/src/sync/provider.ts`
- `packages/db/migrations/00001_initial_schema.sql`
- `docs/issues/*.md`

## Current Readiness Assessment

### What is already strong

- **Core platform primitives are real, not aspirational.** Deploy, build, release, env routing, auth, Slack/GitHub events, and job execution all exist in code and docs today.
- **There is meaningful test coverage.** The repo currently has 65 API integration test files and 33 manual scenarios, including deploy, Slack, web auth, dashboard, sentinel, and production-hardening scenarios.
- **There is already a self-hosting direction.** `docs/deploy/aws.md` and `docs/plans/client-deployment-and-infra-extraction-plan.md` describe a template-repo model instead of requiring source-repo access.
- **There is already a support-automation substrate.** The event spine, trigger router, `create-pr` action, Slack/Gateway delivery path, and external item sync schema are enough to build a real bug-intake loop on top.

### What keeps this from self-serve production today

- **The product still defaults to the platform operator staging.**
  - `packages/cli/src/lib/context.ts` hardcodes `DEFAULT_API_URL = 'https://api.eve.example.com'`.
  - `docs/system/user-getting-started-guide.md` and `README.md` repeatedly assume `api.eve.example.com`.
  - `packages/cli/src/commands/init.ts` defaults to `https://github.com/eve-horizon/eve-horizon-starter`.
- **Release and deployment distribution are still centrally wired.**
  - `.github/workflows/publish-images.yml` dispatches to a hard-coded repo matrix (`example-org/deployment-instance`).
  - There is no release manifest, compatibility matrix, or customer-visible upgrade channel contract in this repo.
- **Operational guardrails exist, but many are optional or incomplete.**
  - `apps/orchestrator/src/cron/env-health-watchdog.service.ts` is disabled unless `EVE_ENV_HEALTH_ENABLED=true`.
  - `apps/orchestrator/src/cron/managed-db-snapshot-scheduler.service.ts` is disabled unless `EVE_MANAGED_DB_SNAPSHOT_SCHEDULER_ENABLED=true`.
  - `docs/system/observability.md` still lists service-level metrics dashboards and log shipping presets as planned, not implemented.
- **Some automation surfaces are still placeholders.**
  - `apps/worker/src/action-executor/action-executor.service.ts` implements `notify`, but it is explicitly simulated rather than real delivery.
  - `create-pr` is real, but it depends on process-level `EVE_GITHUB_TOKEN`, not a scoped org/project credential model.
- **Operational complexity is concentrated in a few god services.**
  - Graphify’s 2026-04-07 report identifies `DeployerService`, `OrgFsSyncService`, `LoopService`, `ProjectsService`, `InvokeService`, and `AccessService` as the most connected nodes.
  - Those files are large: `DeployerService` ~3037 lines, `LoopService` ~3217 lines, `ProjectsService` ~1908 lines, `InvokeService` ~1634 lines.
- **Known incident-class bugs still exist or were only recently fixed.**
  - `docs/issues/env-name-default-causes-global-job-serialization.md`
  - `docs/issues/slack-file-download-gets-login-page-html.md`
  - `docs/issues/agent-runtime-org-default-heartbeat-failure.md`
- **I found no evidence of external secret-manager integration** in the docs/code search for Vault, AWS Secrets Manager, SSM, SOPS, or ExternalSecret. That is an inference from the search result set, not a documented product guarantee.

## Gap Inventory

### 1. Distribution and Installation Gaps

To support arbitrary customer deployments, we need a clear productized distribution contract, not a staging-centered developer workflow.

Missing or weak today:

- customer-facing install flow that does not default to the platform operator staging
- versioned release artifact that a customer infra repo can consume deterministically
- documented supported topologies:
  - single-node reference deployment
  - recommended HA production topology
  - resource sizing and failure domains
- compatibility policy for:
  - platform version
  - worker image version
  - infra template version
  - database migration version
- first-class bootstrap flow for:
  - domain
  - TLS
  - email
  - auth keys
  - first admin
  - first org
  - smoke tests

### 2. Day-2 Operations and Self-Support Gaps

A customer should be able to answer "what is broken?" and "what do I do next?" without us.

Missing or weak today:

- support bundle / diagnostics bundle command for the whole platform
- one-command operator health pack:
  - system health
  - env health
  - recent failures
  - deploy drift
  - snapshot/backup status
  - runtime pod health
  - config sanity
- metrics dashboards and shipping presets
- default alert routing and real notifications
- upgrade check / upgrade apply workflow
- recovery runbooks for:
  - bad deploy
  - auth bootstrap failure
  - managed DB restore
  - Slack/GitHub integration breakage
  - agent-runtime placement failure
- a completed operator dashboard experience

The platform already has useful pieces:

- `eve job diagnose`
- `eve env diagnose`
- `eve system health/status/logs`
- sentinel watchdog
- managed DB snapshots and restore

But these are not yet assembled into a polished self-support product.

### 3. Reliability and Hardening Gaps

Before GA, the load-bearing paths need to be simpler, better-tested, and less surprising.

Highest-risk areas:

- deploy path (`DeployerService`)
- orchestration loop (`LoopService`)
- project/manifest resolution (`ProjectsService`)
- agent invoke path (`InvokeService`)
- access and permission graph (`AccessService`)

What this implies:

- we need targeted decomposition of the biggest god services
- we need golden-path tests around deploy, event routing, auth, and runtime placement
- we need regression coverage for incident-class bugs already discovered in customer-like environments
- we need fewer "optional" production controls and more sane defaults

### 4. Security and Enterprise Operability Gaps

Production customers will expect a stronger operating model than "set env vars and keep them safe."

Missing or weak today:

- external secret manager support
- clearer secret rotation workflows for customer-owned deployments
- scoped GitHub credentials for:
  - issue creation
  - PR creation
  - webhook management
- private support path for sensitive incidents
- customer-ready support bundle redaction and PII handling
- formal separation between platform-admin controls and tenant-admin controls where needed

### 5. Customer Bug Intake Gaps

We have pieces of the loop, but not the loop itself.

What exists today:

- inbound GitHub webhook normalization (`apps/api/src/integrations/github.controller.ts`)
- Slack/Gateway delivery
- event router and trigger matching
- `create-pr` action
- provider-agnostic external item sync interfaces (`packages/db/src/sync/provider.ts`)
- external mapping table (`external_item_map` in `packages/db/migrations/00001_initial_schema.sql`)

What is missing:

- GitHub Issues provider implementation
- issue intake schema/templates/forms
- support bundle generation and attachment flow
- private incident intake path
- triage automation for duplicates, severity, and area ownership
- PR automation guardrails and approval workflow
- Slack notification path that is not a placeholder

## Production-Grade Release Definition

We should not call Eve Horizon "production-grade for arbitrary customer deployments" until all of the following are true:

1. A new customer can instantiate a deployment repo from a public template, provision infrastructure, bootstrap the first admin, and pass smoke checks without direct the platform operator help.
2. All default CLI/docs/install flows are customer-owned, not the platform operator-staging-owned.
3. A customer can upgrade one supported release to the next with a documented rollback path.
4. A customer can create, verify, and restore managed DB backups as an audited routine, not an emergency improvisation.
5. A customer agent can produce a support bundle and open a platform bug report with enough structured context for automated triage.
6. Platform notifications, alerts, and issue triage are real integrations, not simulated placeholders.
7. Known incident-class bugs in runtime placement, env gating, Slack file handling, and similar hot paths are closed or covered by automated regression tests.

## Roadmap

### Phase 0: Lock the Product Contract

**Goal:** define exactly what "customer-deployable Eve Horizon" means.

Deliverables:

- supported topology matrix:
  - reference single-node deployment
  - recommended HA production deployment
- release contract:
  - semver policy
  - upgrade support window
  - infra template compatibility
  - migration compatibility
- customer/operator responsibility split
- production checklist and go-live gate

Exit criteria:

- no user-facing docs rely on the platform operator staging as the default path
- the release contract is explicit enough that customer infra repos can automate against it

### Phase 1: Self-Hosted Packaging GA

**Goal:** make customer-owned install and upgrade the default story.

Deliverables:

- replace staging-centric CLI/doc defaults
- public, versioned infra template with documented instantiation flow
- release manifest artifact per platform release:
  - image digests
  - schema version
  - required config keys
  - worker image compatibility
- bootstrap workflow for:
  - auth keys
  - bootstrap token
  - first admin
  - first org
  - first smoke test
- customer-owned deploy update mechanism
  - not a hard-coded downstream repo list in source CI

Suggested concrete changes:

- remove `DEFAULT_API_URL` hardcoding to the platform operator staging
- make `eve init` and onboarding skills parameterize platform URL and deployment owner
- replace source-repo `repository_dispatch` assumptions with a release artifact that deployment repos pull

Exit criteria:

- a customer can stand up a deployment from docs plus template repo
- a customer can pin and upgrade a release without editing source-repo CI

### Phase 2: Day-2 Ops and Self-Support GA

**Goal:** make normal operation and first-line support self-service.

Deliverables:

- `eve support doctor` or equivalent platform-wide diagnostics command
- `eve support bundle create` or equivalent redacted support bundle
- default sentinel enablement profile for production deployments
- default managed DB snapshot scheduler profile for production-capable classes
- real `notify` action backed by Slack/Gateway or a direct provider abstraction
- operator runbooks:
  - bad deploy
  - runtime placement failure
  - webhook/auth breakage
  - restore from snapshot
  - key rotation
- customer-ready observability presets:
  - OTEL collector
  - log shipping
  - metrics dashboards
  - alert thresholds

Exit criteria:

- a customer operator can answer "what is wrong?" and "what should I do next?" from supported tooling
- Slack notifications and daily summaries work without custom operator wiring

### Phase 3: Reliability and Hot-Path Hardening

**Goal:** reduce hidden coupling and incident risk in the most connected services.

Deliverables:

- fix or regression-test known incidents from `docs/issues/`
- decompose and narrow the highest-risk god services
- add install/upgrade/restore/incident validation suites
- add customer-deployment conformance tests:
  - fresh install
  - upgrade
  - rollback
  - backup + restore
  - Slack/GitHub integration wiring

Priorities:

- env gating semantics for ad-hoc jobs
- account-specific Slack provider resolution and file validation
- agent-runtime org bootstrap/heartbeat behavior
- deploy/orchestrator/invoke path decomposition and contract tests

Exit criteria:

- no known customer-impacting incident remains only documented in `docs/issues/` without either a fix or a regression test
- customer deployment verification is automated, not manual-only

### Phase 4: Enterprise Operability and Security

**Goal:** satisfy the operational expectations of real customer environments.

Deliverables:

- external secret manager support
- scoped credentials for PR/issue creation and outbound integrations
- support bundle redaction policies
- audit trails for support-triggered actions
- secure/private incident intake path

Exit criteria:

- customer security teams have a credible answer for secrets management, audit, and sensitive-incident handling

### Phase 5: Customer Bug Intake and Support Automation

**Goal:** turn customer-reported platform bugs into a structured, automatable flow.

Deliverables:

- public bug intake surface
- private incident intake surface
- GitHub Issues provider built on the existing sync abstraction
- triage workflow:
  - duplicate detection
  - severity
  - subsystem owner
  - missing-data requests
- remediation workflow:
  - reproduce
  - patch
  - test
  - open PR
  - notify Slack
- approval gate before merge/deploy

Exit criteria:

- a customer agent can file a complete bug report with evidence
- a platform triage agent can classify it and either request more data or route it into remediation
- reproducible bugs can become PRs without a human hand-editing the intake every time

## Recommendation: Use a Public GitHub Intake Repo, But Not Only That

### Recommendation

Use a **public GitHub issue intake repo** as the default customer-visible bug-report surface, but pair it with a **private incident path** for sensitive cases.

### Why a public repo is the right default

- lowest-friction interface for arbitrary companies and their agents
- native issue forms, labels, templates, discussions, duplicates, and search
- easy webhook trigger point into Eve automation
- public paper trail for product bugs, docs gaps, and feature requests
- no requirement that the customer has direct access to our internal trackers

### Why a public repo is not enough

Customer bug reports may include:

- proprietary prompts
- stack traces with internal paths
- deployment topology details
- support bundles
- screenshots or logs with sensitive data

That means we need a second path:

- **public repo** for generic platform bugs and reproducible product defects
- **private support path** for tenant-specific incidents, security issues, and sensitive evidence

### Recommended repo structure

- `eve-horizon-support` (public): issue forms, docs gaps, product bugs, feature requests
- internal/private engineering repo or Eve project: implementation work, internal notes, sensitive incidents

Do not force customers into our source repo issue tracker until the source/distribution model is deliberately public and support-ready.

## Recommended Bug-Report Automation Architecture

### Intake

Customer human or customer agent runs:

1. `eve support doctor`
2. `eve support bundle create`
3. `eve support report-bug`

`report-bug` should capture:

- platform version / release tag
- infra template version
- deployment topology
- failing subsystem
- exact symptom
- reproduction steps
- severity / urgency
- sanitized support bundle link

### Transport

- For public-safe bugs:
  - create GitHub issue in the public support repo
- For sensitive bugs:
  - create a private support case in an internal Eve project or private repo

### Triage Automation

Trigger on GitHub issue opened/edited/labeled:

1. ingest issue via webhook
2. mirror to Eve job using a GitHub Issues sync provider
3. triage agent:
   - detect duplicate
   - classify severity
   - identify subsystem
   - request missing evidence
   - decide public vs private handling
4. post triage summary back to GitHub
5. notify internal Slack

### Remediation Automation

When the issue is reproducible and policy allows:

1. spawn remediation job against the platform repo
2. reproduce using support bundle + tests
3. make the smallest safe change
4. run targeted verification
5. open PR
6. notify Slack with:
   - issue link
   - PR link
   - verification summary

### Guardrails

- no auto-merge
- no auto-deploy to customer environments
- private issues never mirrored publicly
- agent must request more data instead of guessing when reproduction is weak
- policy gate for security-sensitive or data-sensitive issues

## Implementation Notes for the Bug Intake Loop

The codebase already has useful building blocks:

- `packages/db/src/sync/provider.ts` gives us a provider abstraction for external issue trackers
- `external_item_map` already exists for job ↔ external item mapping
- GitHub webhook ingestion already exists
- the event router already creates work from events
- `create-pr` already exists

The missing work is mostly productization:

- implement a GitHub Issues provider
- add an issue-creation action or service
- move `create-pr` and future issue actions off process-global `EVE_GITHUB_TOKEN` and onto scoped credentials
- replace placeholder `notify` delivery with a real notifier
- add support bundle generation and redaction

## Recommended Execution Order

If we want the fastest path to a credible production-grade release, do the work in this order:

1. **Phase 0 + Phase 1 first**
   - remove staging defaults
   - ship the real self-host/install/upgrade contract
2. **Phase 2 second**
   - self-support tooling and real notifications
3. **Phase 3 third**
   - close incident-class bugs and harden hot paths
4. **Phase 5 in two steps**
   - Step A: public/private intake + triage + Slack
   - Step B: remediation-to-PR automation
5. **Phase 4 in parallel where security pressure demands it**

Do **not** start with full autonomous bug fixing. The platform first needs a reliable install story, self-support tooling, and scoped integration credentials. Otherwise we will automate around missing product surfaces instead of fixing them.

## Bottom Line

The platform is close to being a serious customer-operated system, but it is not yet a drop-in product for arbitrary companies.

The shortest path to that goal is:

1. productize the deployment and upgrade contract
2. make day-2 ops self-serve
3. harden the hot paths and close known incidents
4. add a public/private bug intake loop
5. then automate triage-to-PR on top of those stable foundations

That sequence gives customers real autonomy while also creating the right substrate for agents to report bugs against the platform and for Eve to help fix itself responsibly.
