# Self-Hosted Production Roadmap

> Status: Draft
> Last Updated: 2026-04-08
> Synthesizes: [`production-grade-customer-deployment-roadmap.md`](./production-grade-customer-deployment-roadmap.md) and [`self-hosted-production-execution-plan.md`](./self-hosted-production-execution-plan.md)
> Purpose: define the canonical roadmap to take Eve Horizon from assisted production to a production-grade platform that arbitrary companies can deploy, operate, upgrade, restore, and self-support without routine the platform operator involvement.

## Executive Summary

Eve Horizon already has the core primitives of a real platform:

- multi-service control plane (`api`, `orchestrator`, `worker`, `agent-runtime`, `gateway`, `sso`)
- auth, RBAC, pipelines, workflows, releases, and persistent environments
- Slack and GitHub event ingestion
- managed DB snapshots and restore substrate
- meaningful integration coverage and a broad manual scenario suite

What it does not yet have is a fully productized self-hosted operating model. The current experience is still centered on:

- the platform operator staging as the implied default control plane
- install and upgrade flows that assume operator knowledge
- operational guardrails that exist but are still optional or partially wired
- a few highly load-bearing hot paths with known incident history
- no first-class support bundle, operator kit, or customer-visible bug intake loop

The roadmap below combines the strategic framing of the customer deployment roadmap with the concrete workstreams from the execution plan. This should be the primary planning document for self-hosted production readiness.

## Where We Are Now

### What is already strong

- Core platform primitives are implemented, not aspirational: deploy, build, release, auth, env routing, job execution, and event ingestion exist today.
- There is already a real self-hosting baseline in the public `eve-horizon/eve-horizon-infra` template repo, not just a plan.
- The event spine, trigger router, external item mapping, and `create-pr` action provide a credible substrate for support automation.
- Sentinel, managed DB snapshots, and existing health and diagnose commands are the right starting point for operator tooling.

### Current self-hosted baseline

Today self-hosting already starts from `eve-horizon/eve-horizon-infra`, which provides:

- a public template repo with a real quick-start and deployment walkthrough
- a single committed `config/platform.yaml` for deployment shape and version pinning
- a gitignored `config/secrets.env` flow for cluster secrets
- `bin/eve-infra` as the day-to-day operator CLI for deploy, health, upgrade, logs, secrets, and DB tasks
- `scripts/setup.sh` for first-time cluster bootstrap
- GitHub workflows for deploy, health checks, and upgrade PR creation
- supported cloud and substrate combinations today:
  - AWS `k3s`
  - AWS `eks`
  - GCP `gke` + Cloud SQL + Cloud DNS

This materially changes the roadmap framing: Phase 1 is not "invent a self-hosting template." Phase 1 is "harden and productize the existing template, contract, and operator surfaces."

### What keeps this from self-serve production

#### 1. Distribution and install

- CLI and docs still default to `https://api.eve.example.com`.
- `eve init` and onboarding flows still assume the platform operator-owned defaults.
- the public infra template already supports local deploys, manual deploy workflow dispatch, and automated upgrade PRs, but release distribution still lacks a machine-readable contract
- source-repo release automation still mixes registry tags and optional downstream dispatch rather than a clean release manifest consumed by deployment repos
- supported deployment substrates exist, but the support policy, sizing guidance, and production recommendations across AWS `k3s`, AWS `eks`, and GCP are not yet explicit enough

#### 2. Day-2 operations and self-support

- there is no single `eve support doctor` command for whole-platform diagnosis inside the infra template or the source repo CLI
- there is no redacted support bundle flow
- sentinel and managed DB snapshots are behind opt-in flags rather than production defaults
- `notify` is still simulated instead of delivering to a real channel
- the infra template has API health checks and optional OTEL config, but not a first-class observability package with collector, dashboards, and alerts

#### 3. Reliability and hot-path hardening

- several services remain large and highly connected, especially deploy, orchestration, project resolution, invoke, and access paths
- known incident-class issues still exist in `docs/issues/`
- there is no dedicated customer conformance suite covering install, upgrade, rollback, backup, restore, and integration wiring

#### 4. Security and enterprise operability

- scoped integration credentials are incomplete
- external secret manager support is absent
- support bundle redaction and private incident handling need a defined product shape
- customer-ready auditability for support-triggered actions is not complete

#### 5. Customer bug intake and support automation

- the codebase has intake and remediation building blocks, but not the actual loop
- there is no public support repo, issue provider, triage workflow, or private-sensitive path
- automation stops short of reproducible bug -> guarded PR flow

## Production-Grade Release Definition

Eve Horizon should only be considered production-grade for arbitrary self-hosted customer deployments when all of the following are true:

1. A customer can instantiate a deployment from the public template repo, provide secrets and DNS, and complete bootstrap without touching the source repo.
2. Default CLI, docs, and onboarding paths are customer-owned, not the platform operator-staging-owned.
3. A customer can pin, upgrade, and roll back a supported release using a published release contract.
4. `eve support doctor --install` can verify control plane, data plane, auth, ingress, registry, runtime placement, and storage on a fresh deployment.
5. Backup, snapshot, and restore are defaulted, documented, and exercised as routine operations.
6. Notifications, alerts, and daily summaries are real integrations, not placeholders.
7. A customer operator or customer agent can generate a redacted support bundle and open a complete platform bug report without kubectl-first heroics.
8. Known incident-class issues are either fixed or covered by automated regression tests and manual scenarios.
9. Customer-visible support intake and private-sensitive handling both exist and feed a structured triage path.
10. Operator docs, runbooks, and agent skills are sufficient for self-support without direct founder intervention.

## Principles

- Productize what already exists instead of inventing parallel systems.
- Remove staging-centric defaults before adding higher-order automation.
- Make production guardrails default-on and diagnosable.
- Ship one-command diagnosis and one-command evidence capture before autonomous remediation.
- Build human docs and agent skills alongside each workstream, not afterward.
- Prefer public, low-friction support surfaces by default, with a private path for sensitive incidents.

## Roadmap At A Glance

| Phase | Goal | Primary workstreams | Exit signal |
| --- | --- | --- | --- |
| Phase 0 | Lock the product contract | topology matrix, release contract, responsibility split, go-live gate | customer-facing contract is explicit enough for infra automation |
| Phase 1 | Self-hosted packaging GA | WS-1, WS-2, WS-3 | the existing infra template is the hardened, customer-owned install and upgrade surface |
| Phase 2 | Day-2 ops and self-support GA | WS-4, WS-5, WS-6 | operator can diagnose, recover, and observe without custom heroics |
| Phase 3 | Reliability and hot-path hardening | WS-7 plus conformance and decomposition work | no incident-class gap remains without a fix or regression coverage |
| Phase 4 | Enterprise operability and security | WS-8 | customers have a credible secrets, audit, and sensitive-support story |
| Phase 5 | Customer bug intake and support automation | WS-9, WS-10 | customer-reported bugs can flow through triage and guarded remediation |
| Cross-cutting | Self-support docs and skills | WS-11, WS-12 | humans and agents can operate the platform from first-class guidance |

## Phase 0: Lock the Product Contract

**Goal:** define exactly what "customer-deployable Eve Horizon" means before optimizing anything around it.

### Deliverables

- supported topology matrix:
  - AWS `k3s` reference deployment
  - AWS `eks` managed-cluster deployment
  - GCP managed-cluster deployment
  - an explicit statement of which of those are support baselines versus experimental or advanced
- release contract:
  - semver policy
  - upgrade support window
  - infra template compatibility
  - migration compatibility
  - required environment keys
- customer/operator responsibility split
- production checklist and go-live gate

### Exit Criteria

- no customer-facing contract assumes the platform operator staging as the default path
- release compatibility is explicit enough that downstream deployment repos can automate against it
- operator-facing installation and upgrade documentation align with the contract

### Notes

- This phase is largely documentation and contract definition work, but it should land before deeper automation because it constrains every later workstream.
- The core output should be stable enough that `eve-ops` skills, bootstrap tooling, and conformance tests can target it.

## Phase 1: Self-Hosted Packaging GA

**Goal:** make the existing self-hosted template customer-owned, neutral, and deterministic.

### WS-1: Kill the staging defaults

**Outcome:** no customer-facing surface assumes `eve.example.com`.

Key changes:

- remove the hard-coded `DEFAULT_API_URL` fallback
- make resolution order explicit: `--api-url` -> `EVE_API_URL` -> profile -> fail with actionable setup guidance
- make `eve init` ask for an API URL with no staging default
- replace the platform operator-owned starter defaults with neutral, customer-facing defaults
- scrub staging URLs from user guides and examples
- add CI linting that blocks staging URLs outside staging-specific docs and plan docs

### WS-2: Release manifest and neutral deploy distribution

**Outcome:** `eve-horizon-infra` and downstream deployment repos consume a release contract instead of inferring upgrades from registry tags or relying on source-repo dispatch assumptions.

Key changes:

- publish a `release-manifest.json` for each `release-v*` tag containing:
  - platform version
  - git SHA
  - image digests
  - schema version
  - minimum infra template version
  - required env keys
  - breaking-change notes
- update the infra template's upgrade detection to consume the release manifest rather than scanning registry tags directly
- keep manual deploys and optional source-triggered deploys, but make the release manifest the canonical compatibility surface
- reduce source-repo deployment assumptions so downstream deploy repos do not depend on a hard-coded dispatch matrix
- document the contract in `docs/system/release-contract.md`

### WS-3: First-boot bootstrap and supported topologies

**Outcome:** the existing `eve-horizon-infra` install flow becomes a first-class, guided bootstrap path instead of a collection of partially manual steps.

Key changes:

- extend `bin/eve-infra` and `scripts/setup.sh` with a first-class bootstrap path rather than inventing a parallel installer
- wrap infra provisioning, kubeconfig generation, cluster bootstrap, release resolution, bootstrap auth, first admin, first org, and first smoke test into one guided flow
- formalize the currently shipped topology matrix:
  - AWS `k3s`
  - AWS `eks`
  - GCP
- add explicit sizing, failure-domain, and support-tier guidance for each topology
- decide whether an opinionated `ha-small` profile is a later packaging layer on top of `eks`/`gcp`, rather than a new baseline concept

### Phase 1 Exit Criteria

- a customer can stand up a deployment from docs plus template repo without editing source-repo CI
- a customer can pin and upgrade a release through the published contract
- install flow requires only expected human approvals for secrets and DNS

## Phase 2: Day-2 Ops and Self-Support GA

**Goal:** make normal operation, diagnosis, recovery, and evidence collection self-service.

### WS-4: `eve support doctor`, `eve support bundle`, `eve support report-bug`

**Outcome:** one command answers "what is broken"; one command captures the evidence; one command starts the support loop.

These should land first in the self-hosted operator surface, meaning `eve-horizon-infra` and `bin/eve-infra`, with any matching source-repo CLI support layered on later where it improves parity.

`eve support doctor` should aggregate at minimum:

- `eve system health`
- cluster health
- orchestrator loop lag
- sentinel last tick and degraded env count
- managed DB snapshot freshness
- runtime placement
- registry reachability
- ingress and TLS validity
- recent failed jobs
- deploy drift between release manifest and running images

`eve support bundle create` should produce a single redacted artifact containing:

- platform metadata and topology
- redacted cluster state
- doctor output
- recent failed jobs and diagnoses
- recent logs
- secret presence summary only
- environment config presence summary only

`eve support report-bug` should gather symptom, repro steps, severity, attach the bundle, and file through the intake flow from Phase 5.

### WS-5: Default-on guardrails and real notifications

**Outcome:** production deployments come with safety rails already enabled.

Key changes:

- make sentinel default-on for production mode
- make managed DB snapshot scheduling default-on for production mode
- introduce explicit `EVE_MODE=development|production`
- make `doctor` treat missing guardrails as `WARN` in development and `FAIL` in production
- replace simulated `notify` with a real notifier that resolves project and org-scoped delivery integrations

### WS-6: Observability presets

**Outcome:** a fresh deployment gets usable dashboards and alerts on day one.

Key changes:

- ship an OTEL collector component in the infra template
- provide canned dashboards for:
  - platform overview
  - cost and budget
  - reliability and placement
- promote planned observability items to shipped behavior:
  - `/internal/metrics` endpoints
  - correlation-aware log sampling
  - at least one log shipping preset
- add alert rules covering guardrails and platform health

### Phase 2 Exit Criteria

- an operator can answer "what is wrong?" and "what should I do next?" from supported tooling
- Slack or Gateway notifications and daily summaries work without custom operator wiring
- observability is available from template defaults rather than bespoke setup

## Phase 3: Reliability and Hot-Path Hardening

**Goal:** reduce hidden coupling and incident risk in the most connected services, and verify the product contract continuously.

### WS-7A: Close incident-class issues with regression coverage

Every issue in `docs/issues/` that is customer-impacting should end in one of two states:

- fixed with regression coverage
- still open, but covered by a failing or quarantined test plus an explicit owner and plan

Priority issues already identified include:

- env-name default causing global job serialization
- Slack file download returning login-page HTML
- agent-runtime org bootstrap and heartbeat failure
- Codex harness auth refresh failure
- worker git auto-commit failure

### WS-7B: Hot-path contract tests and targeted decomposition

The biggest and most connected services should not be refactored speculatively. They should first be pinned by contract tests, then decomposed only where behavior is stable enough to narrow safely.

Highest-risk paths:

- deploy path
- orchestration loop
- project and manifest resolution
- agent invoke path
- access and permission graph

Expected outputs:

- contract tests for deploy, event routing, auth, runtime placement, and project resolution
- smaller seams around high-risk services where tests already protect behavior
- fewer hidden couplings in production paths

### WS-7C: Customer conformance suites

Add dedicated self-hosted conformance coverage for:

- fresh install
- upgrade
- rollback
- backup and restore
- Slack and GitHub integration wiring
- production-hardening checks

These should live as customer-conformance suites, not as a loose collection of manual-only verification.

### Phase 3 Exit Criteria

- no known customer-impacting incident remains only as a markdown issue without either a fix or regression coverage
- install, upgrade, rollback, restore, and integration wiring have repeatable verification
- high-risk service changes are protected by contract tests rather than tribal knowledge

## Phase 4: Enterprise Operability and Security

**Goal:** satisfy the operating expectations of real customer environments.

### WS-8: Scoped credentials and external secrets

Key changes:

- replace process-global `EVE_GITHUB_TOKEN` dependencies with scoped credential resolution
- introduce explicit integration credential storage with audit fields
- add an External Secrets-based overlay for customer secret stores
- support at minimum AWS Secrets Manager and SSM Parameter Store
- document secret rotation as a runbook, not an improvisation
- define support-bundle redaction policy and support-triggered audit trails

### Phase 4 Exit Criteria

- outbound actions such as PR or issue creation work with scoped credentials and no global fallback requirement
- customer security teams have a credible answer for secrets management, rotation, audit, and sensitive-support handling

## Phase 5: Customer Bug Intake and Support Automation

**Goal:** turn customer-reported bugs into a structured, automatable loop with clear guardrails.

### WS-9: Public intake repo and triage automation

Default product shape:

- public repo: `eve-horizon/eve-horizon-support`
- private path for security-sensitive or tenant-sensitive evidence

Public repo should include:

- issue forms for platform bug, docs gap, feature request, and security redirect
- standard labels for area, severity, status, and type
- CODEOWNERS aligned to the platform triage team

Triage flow:

1. GitHub issue webhook enters Eve through the existing GitHub integration path.
2. Trigger routing opens a triage job.
3. Triage agent deduplicates, classifies severity and subsystem, requests missing evidence, or marks the issue ready for remediation.
4. Slack notification and issue comment are posted from the same workflow.
5. Sensitive incidents are routed to the private path and never mirrored publicly.

### WS-10: Guarded remediation automation

When an issue is reproducible and policy allows:

1. Spawn a remediation job against the platform repo.
2. Reproduce the issue from support bundle plus tests.
3. Make the smallest safe change.
4. Run targeted verification.
5. Open a PR with evidence, risk notes, and verification summary.
6. Notify Slack and link the issue to the PR.

Guardrails:

- no auto-merge
- no auto-deploy
- human approval required before landing
- bounded tool budget and escalation on weak reproduction

### Phase 5 Exit Criteria

- a customer agent can file a complete platform bug with evidence
- a triage agent can classify it, request more evidence, or route it
- reproducible bugs can become guarded PRs without a human hand-editing the intake path each time

## Cross-Cutting Deliverables

### WS-11: Operator skill pack

Extend the operator-facing skill layer that already exists in `eve-horizon-infra` and converge it with a first-class public `eve-ops` pack so customer-side agents can install, upgrade, diagnose, restore, and report bugs without reading the source repo.

Near-term rule:

- treat the infra template's repo-local skills as the starting point
- add or upstream missing install, upgrade, backup, incident-response, and report-bug workflows there first
- then decide what belongs in shared public skillpacks versus template-local operational guidance

Minimum skills:

- `eve-ops-index`
- `eve-install`
- `eve-upgrade`
- `eve-backup-restore`
- `eve-incident-response`
- `eve-observability-setup`
- `eve-security-hardening`
- `eve-report-bug`
- `eve-self-host-topologies`
- `eve-release-watch`

Each skill should include:

- when to use it
- exact CLI commands
- required inputs and secrets
- validation steps
- links to the matching human runbook

### WS-12: Operator manual and runbook library

Treat the existing template docs as the seed operator manual, then promote them into a cleaner operator documentation set instead of starting from zero.

Starting point that already exists:

- `README.md`
- `DEPLOYMENT.md`
- `UPGRADE.md`
- repo-local operational skills in `skills/`

Target operator docs:

- `docs/operator/installation.md`
- `docs/operator/upgrade.md`
- `docs/operator/topologies.md`
- `docs/operator/security.md`
- `docs/operator/backup-restore.md`
- `docs/operator/observability.md`

And incident runbooks:

- `docs/runbooks/bad-deploy.md`
- `docs/runbooks/managed-db-restore.md`
- `docs/runbooks/auth-bootstrap-failure.md`
- `docs/runbooks/slack-integration-broken.md`
- `docs/runbooks/agent-runtime-placement-failure.md`
- `docs/runbooks/secret-rotation.md`
- `docs/runbooks/rollback-platform-release.md`

Each runbook should follow the same shape:

1. symptom
2. detection
3. diagnosis
4. safe fix
5. verification
6. escalation

### Cross-Cutting Rule

WS-11 and WS-12 should start in Phase 1 and evolve with every later phase. Skills without code are not enough; code without operator docs and skills is not yet a self-support product.

## Recommended Execution Order

The fastest path to a credible self-hosted production release is:

1. Phase 0 contract definition
2. Phase 1 packaging GA
3. Phase 2 self-support tooling
4. Phase 3 incident closure and conformance
5. Phase 5 in two steps:
   - intake and triage first
   - remediation automation second
6. Phase 4 in parallel where security requirements force earlier work

Critical path to "customer can install and operate Eve without us":

1. WS-1 kill staging defaults
2. WS-2 publish the release contract
3. WS-3 harden `eve-horizon-infra` bootstrap into a first-class product path
4. WS-4 ship doctor, bundle, and report-bug in the operator surface
5. WS-11 extend the existing infra-template skills into a credible operator pack

## First Useful Slice

The smallest visible slice that changes the story quickly is:

1. remove hard-coded staging URL defaults and add a doc lint
2. rewrite onboarding examples to use neutral placeholders
3. publish a release manifest alongside release artifacts and point the template upgrade flow at it
4. land a first `eve support doctor` skeleton in `bin/eve-infra` that aggregates existing health signals
5. extend the existing infra-template skills with install and incident-response guidance instead of starting a parallel skill surface

These can land as small, largely independent PRs and immediately move the platform from "founder-operated" toward "customer-operated."

## Open Questions

1. Should the long-term neutral registry remain `public.ecr.aws/w7c4v0w3`, or move under an `eve-horizon`-owned namespace?
2. Should the support baseline be AWS `k3s` first, or do we declare AWS `eks` and GCP as equally supported production baselines from day one?
3. Should the private incident path be a private GitHub repo, an Eve project, or both?
4. Should production guardrails be controlled primarily by `EVE_MODE=production` plus overrides, or by independent feature flags with a stricter profile layer?
5. What should be the default blast radius and stop conditions for remediation automation?

## Bottom Line

The missing work is mostly productization, not invention. Eve already has the core platform surfaces needed for self-hosted production. The roadmap is to turn them into a coherent product:

1. remove staging assumptions
2. publish a real release and install contract
3. make day-2 ops self-service
4. harden the hot paths and close known incidents
5. add a public-plus-private support loop
6. then automate triage and remediation on top of those stable foundations

If this sequence lands cleanly, Eve becomes something arbitrary companies can deploy and run as their own platform, not just something the platform operator can operate for them.
