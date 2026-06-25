# Persistent Environments Platform

> **Idea / Draft**: Brainstorming document for a simple, elegant approach.
> Status: Idea
> Last Updated: 2026-01-19
> Note: Legacy `components`/`defaults` examples are superseded by `services` + `x-eve.*`.
> For the current spec, see `docs/system/manifest.md`.

## Goal

Add a minimal platform layer on top of the existing k8s runtime so Eve-compatible projects can:
- Run persistent dev/staging/production environments inside the Eve cluster
- Auto-scale each app component independently with ingress "just working"
- Use first-class versioning and rollbacks
- Trigger self-improving agent jobs from logs/cron with optional human gates
- Define CI/CD as human-readable workflows that run as Eve jobs
- Treat Postgres as a first-class resource with import/export and Git-managed data

Backward compatibility is not required; we can refactor freely.

---

## Principles (Keep It Simple)

1. Reuse existing primitives (jobs, repos, k8s) instead of adding a new control plane.
2. One manifest file under `.eve/` defines environments, pipelines, data, and `x-eve.defaults`.
3. Jobs target a persistent environment by default; ephemeral is opt-in.
4. Manifest sync + caching drives scheduling (worker/harness) without a full clone.
5. Deployments are k8s-native resources (Deployment/StatefulSet/Service/HPA/Ingress).
6. Every action is a job with auditable input/output and optional approvals.
7. Prefer a few explicit concepts over hidden automation.

---

## Model (Manifest + Jobs)

**Manifest (synced)**
- Single file at `.eve/manifest.yaml` defines services, environments, pipelines, triggers, databases, and `x-eve.defaults`.
- `eve project sync` pushes `manifest_hash` + `git_sha`; scheduler reads cached `x-eve.defaults` (worker/harness/env).
- If a job targets a ref that does not match the synced `git_sha`, Eve returns `sync_required`.

**Environments**
- Persistent envs are long-lived namespaces (dev/staging/production).
- Temporary envs are short-lived, TTL, optional pool + reset hook.
- Envs can define `overrides`; maps merge, arrays replace.

**Jobs**
- Default target is `x-eve.defaults.env`.
- `--ephemeral` runs in a job-scoped namespace with declared deps only.
- Jobs can target named environments; triggers are limited to persistent envs.

**Services**
- Deployment + Service + HPA (StatefulSet for stateful).

**Release**
- Points to `git_sha` + image digests + `manifest_hash`; envs point to a release.

**Pipeline**
- Named job graph; steps are jobs with optional approvals.

**Trigger**
- Event (logs, cron, webhooks) -> job or pipeline.

**Database**
- Postgres per env with import/export.
- Optional `services` for ephemeral jobs (redis, etc).

---

## Temporary Env Pooling (v1)

If a temporary env defines `pool`, Eve keeps warm slots to speed up PR flows.

**Pool lifecycle**
- Create `pool.size` slots on demand: `myapp-pr-pool-1`, `myapp-pr-pool-2`, ...
- `eve env create-temp pr --id 123` claims a free slot (waits or fails if none).
- Before handoff, run the reset hook to restore clean state.
- On release or TTL expiry, run reset again and mark the slot available.
- Failed resets quarantine the slot until manually cleared.

**Reset hook contract**
- `pool.reset.run` is an executable path in the repo.
- Runs as a job with env vars: `EVE_ENV_NAME`, `EVE_ENV_NAMESPACE`, `EVE_ENV_RESET=true`.
- Must be idempotent and restore data/state (often via `eve db restore`).

---

## Triggers + Integrations

Provider endpoints:
- GitHub: `POST ${EVE_API_URL}/integrations/github/events`
- Slack: `POST ${EVE_API_URL}/integrations/slack/events`

Deployments on AWS, k8s, or a VPS all use the same base URL:
- AWS: `https://api.eve.example.com/integrations/github/events`
- VPS: `https://eve.yourdomain.com/integrations/slack/events`

Signatures are verified using secrets referenced in the manifest.

**Normalized event shape**

```json
{
  "provider": "github",
  "type": "push",
  "repo": "org/myapp",
  "ref": { "sha": "abc123", "branch": "main" },
  "actor": { "id": "12345", "handle": "alice" }
}
```

**Rules**
- If `ref.sha` exists, use it unless overridden in the trigger.
- If no `ref.sha` exists, use the manifest default (branch or last synced `git_sha`).
- If the ref does not match the synced manifest, Eve returns `sync_required`.
- `trigger.env` overrides `x-eve.defaults.env` and must match a named persistent env.
- Trigger commands can interpolate event fields (e.g., `--ref ${event.ref.sha}`).

---

## Manifest Sketch

Legacy example below. Current manifests use v2 fields; see `docs/system/manifest.md`.

```yaml
# my-project/.eve/manifest.yaml (sketch)
name: myapp

x-eve:
  defaults:
    env: staging
    execution: persistent
    worker_type: standard
    worker_image: eve-runner:stable
    harness: mclaude
    harness_options:
      variant: fast

integrations:
  github:
    repo: org/myapp
    webhook_secret_ref: github_webhook_secret

services:
  web:
    image: ghcr.io/org/myapp-web
    ports:
      - "3000:3000"
  db:
    image: postgres:15
  cache:
    image: redis:7-alpine

environments:
  staging:
    type: persistent
    namespace: myapp-staging

pipelines:
  release:
    steps:
      - job: build
        run: "pnpm build"

triggers:
  github-main:
    source: github
    event: push
    branch: main
    env: staging
    on_trigger:
      job: "eve pipeline run release --env staging --ref ${event.ref.sha}"
```

---

## K8s Mapping (No Custom Control Plane)

- Environment -> namespace (`myapp-staging`, `myapp-prod`).
- Service -> Deployment + Service + HPA (StatefulSet for stateful).
- Ingress from `x-eve.ingress.domain` (e.g., `web.staging.myapp.eve.local`).
- Ephemeral jobs run in a job-scoped namespace and only provision declared deps (services + job services).

---

## CLI Model (Runtime + Admin)

- `eve` is the CLI-first interface for users and agents.
- Admin debugging lives under `eve system` (logs, pods, events, status).
- System commands are API-backed and work remotely; no `eve k8s`.
- `eh` remains a local dev/ops helper for this repo only.

---

## Releases + Pipelines

**Release record**
- `release_id`, `git_sha`, image digests, `manifest_hash`.
- Deploying sets `env.current_release = release_id`; rollback is a pointer change.

**Pipelines**
- Pipelines are job graphs; steps are jobs with explicit inputs and optional gates.
- No separate workflow engine; same audit trail and policy surface.

---

## Self-Improving Loop

- Trigger fires (logs, cron, webhook) -> analysis job with context.
- Job can open a PR or run a pipeline; production is gated.
- Everything remains a job for auditability.

---

## Example: Fullstack Repo (Test/Staging/Production)

Minimal manifest for a repo like `eve-horizon-fullstack-example` (NestJS API + Vite web):

```yaml
# .eve/manifest.yaml (excerpt)
name: eve-horizon-fullstack-example

x-eve:
  defaults:
    env: staging
    execution: persistent
    harness: mclaude
    harness_options:
      variant: fast
  ingress:
    domain: fullstack.eve.local

environments:
  test:
    type: persistent
    namespace: ehx-test
  staging:
    type: persistent
    namespace: ehx-staging
  production:
    type: persistent
    namespace: ehx-prod
    approval: required

pipelines:
  cd-main:
    description: "main -> test -> staging -> release -> prod"
    steps:
      - job: deploy-test
        env: test
        run: "eve env deploy test --ref ${event.ref.sha}"
      - job: integration-tests
        env: test
        run: "curl -fsS https://api.test.fullstack.eve.local/health && curl -fsS https://api.test.fullstack.eve.local/todos"
      - job: deploy-staging
        env: staging
        run: "eve env deploy staging --ref ${event.ref.sha}"
      - job: e2e-tests
        env: staging
        run: "curl -fsS https://api.staging.fullstack.eve.local/health && curl -fsS https://web.staging.fullstack.eve.local/"
      - job: release
        run: "eve release create --ref ${event.ref.sha}"
      - job: review
        requires_approval: true
      - job: deploy
        env: production
        run: "eve env deploy production --ref ${event.ref.sha}"

triggers:
  main-merge:
    source: github
    event: push
    branch: main
    on_trigger:
      job: "eve pipeline run cd-main --ref ${event.ref.sha}"

  heal-staging:
    source: logs
    env: staging
    query: 'level=error AND service=api'
    window: 5m
    threshold: 20
    on_trigger:
      job: "eve job create --env staging --description 'Self-heal: analyze staging errors, propose fix, open PR'"

  heal-production:
    source: logs
    env: production
    query: 'level=error AND service=api'
    window: 5m
    threshold: 20
    on_trigger:
      job: "eve job create --env production --description 'Self-heal: analyze prod errors, propose fix, open PR'"
```

Notes:
- Integration tests are read-only and idempotent because `test` uses a persistent database.
- The self-heal jobs open PRs; production rollout still requires the approval gate.

---

## Auth Model (First-Class CLI)

**Modes**
- Local dev: `EVE_AUTH_ENABLED=false` or `EVE_AUTH_MODE=dev`.
- Supabase (VPS): HS256 JWT via `SUPABASE_JWT_SECRET`.
- OIDC (cloud): RS256 JWT via `EVE_AUTH_ISSUER` + `EVE_AUTH_JWKS_URL`.

**CLI**
- `eve auth login` obtains a JWT and stores it in the CLI profile.
- Requests use `Authorization: Bearer <token>`; refresh is handled when supported.

**Job tokens (RBAC)**
- API issues a short-lived job token scoped to `job_id`, `project_id`, `env`, and actions.
- Worker injects `EVE_JOB_TOKEN`; agents call the API with it and inherit RBAC.

**Service actors**
- Webhooks authenticate via provider signatures.
- API maps them to a service account (project-scoped) with explicit permissions.

---

## Postgres as First Class

Each `database` entry becomes:
- A StatefulSet (or managed external connection)
- A Service and Secret
- Optional backup job

**Import/Export**
- `eve db export --env staging --db main --to data/staging.sql`
- `eve db import --env dev --db main --from data/staging.sql`

**Git-managed data**
- Store seed data or snapshots in `data/` (small and intentional)
- Use Git LFS if snapshots grow large
- Treat data bundles as part of the release pipeline when needed

---

## Minimal CLI Surface

```bash
eve job create --project proj_myapp --description "Investigate X"
eve job create --project proj_myapp --ephemeral
eve env create-temp pr --id 123 --from staging --ttl 48h
eve job create --project proj_myapp --env pr-123
eve env deploy staging --release rel_xxx
eve release create --ref main
eve pipeline run release --ref main
eve db export --env dev --db main --to data/dev.sql
```

---

## Why This Is Simple

- One manifest file per repo, no CRDs required.
- Manifest sync cache keeps project DB minimal.
- Same job system for CI/CD, agents, and approvals.
- Jobs default to persistent envs; ephemeral is explicit.
- k8s-native resources for scaling and ingress.
