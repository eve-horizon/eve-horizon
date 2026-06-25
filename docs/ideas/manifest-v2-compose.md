# Eve Config v2: Compose-Plus Manifest

> Status: Idea
> Last Updated: 2026-01-26

## Summary

Move to a Compose-like manifest that keeps runtime configuration familiar
(`services`, `volumes`, `environment`, `ports`, `depends_on`) while adding
Eve-specific primitives for environments, pipelines, workers, and releases.
One file stays the source of truth, and buildable services use Dockerfiles.
Supports env-specific external services and
named clusters for multi-cluster deployments.

## Goals

- Keep Docker Compose semantics for runtime config.
- Buildable services use Dockerfiles.
- Custom workers are first-class services with named worker types per env.
- Allow arbitrary services from any image with full config.
- Allow per-environment external services (e.g., RDS in prod).
- First-class filesystems per environment, including git-backed mounts.
- Branch pinning for auto-deploy per environment.
- Semver-based releases with optional git tagging.
- Support named clusters and deploy-only production clusters.
- Config is obvious and readable by inspection.

## Non-goals

- Backwards compatibility with the current manifest.
- Multi-file config or hidden defaults.

## Design principles

- Use Compose field names (`services`, `volumes`, `environment`, `ports`).
- Eve extensions live under `x-eve` to stay close to Compose.
- Environment overrides use Compose-style merge rules.

## Proposed file

Single file: `.eve/manifest.yaml`

Top-level keys:
- `schema`: `eve/compose/v1`
- `project`: project slug
- `registry`: image registry base
- `clusters`: named deploy targets and capabilities
- `services`: Compose services (buildable + dependencies)
- `volumes`: Compose volumes (extended for git-backed filesystems)
- `environments`: deploy targets + overrides
- `pipelines`: deterministic CI/CD
- `workflows`: optional agent workflows
- `versioning`: semver + tagging policy

## Service model (compose-plus)

Buildable service = any service with a `build` block. Services without `build` are
image-only dependencies. All services use standard Compose fields.

```yaml
services:
  api:
    build:
      context: ./apps/api
      dockerfile: ./apps/api/Dockerfile
    image: eve-api
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://app:secret@db:5432/app
    depends_on:
      db:
        condition: service_healthy
    x-eve:
      role: component
      ingress:
        public: true
        port: 3000
      api_spec:
        type: openapi
        spec_url: /openapi.json

  worker-gpu:
    build: ./apps/worker-gpu
    x-eve:
      role: worker
      worker_type: gpu
      queues: [default, gpu]

  db:
    image: postgres:16
    environment:
      POSTGRES_DB: app
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${secret.DB_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      timeout: 3s
      retries: 5
```

Notes:
- `ports` keeps Compose syntax; only container ports matter in K8s.
- `x-eve.role` is optional; implied by `build` or `worker` block.
- `x-eve.ingress` makes public routing explicit.

## API specs (file or URL)

`x-eve.api_spec` registers an API definition for a service. It can read from a
repo file or fetch a URL published by the running service.

```yaml
x-eve:
  api_spec:
    type: openapi
    spec_url: /openapi.json
    # or:
    # spec_path: ./apps/api/openapi.yaml
```

Notes:
- `spec_url` can be relative (resolved against the service URL in that env) or absolute.
- `spec_url` is fetched during deploy/release for auto-registration of published specs.
- `spec_path` is read from the repo for deterministic, versioned specs (currently **local file:// repos only**).
- Registered APIs surface in the CLI under `eve api` commands (e.g., `eve api list`,
  `eve api spec <name>`, `eve api call <name> ...`).

## External services (per-environment)

Services can be internal in some envs and external in others (RDS in prod).
Use `x-eve.external` + `x-eve.connection_url` in env overrides to skip
deployment and supply a connection URL.

```yaml
services:
  db:
    image: postgres:16

  api:
    build: ./apps/api
    environment:
      DATABASE_URL: postgres://app:${secret.DB_PASSWORD}@db:5432/app

environments:
  production:
    overrides:
      services:
        db:
          x-eve:
            external: true
            connection_url: ${secret.PROD_DATABASE_URL}
```

Note: `service.<name>.url` interpolation is not implemented yet. For now,
use explicit internal hostnames (e.g., `db:5432`) or inject URLs via secrets.

## Workers (custom runner types)

Workers are normal services marked with `x-eve.role: worker`. Environments
select which worker types run and how they scale.

```yaml
environments:
  staging:
    workers:
      - type: default
        service: worker
        replicas: 2
      - type: gpu
        service: worker-gpu
        replicas: 1
```

Notes:
- If `environments.<env>.workers` is omitted, Eve uses the cluster default
  worker pool with `worker_type: default`.
- Custom workers are opt-in; they only run when listed.

## One-off jobs (migrations, seeds, smoke tests)

Define a job service (container + command) and run it from the pipeline. This
keeps migrations in the manifest, uses existing tools like Flyway, and
guarantees ordering. These are standard Eve Jobs (deterministic), not agent
workflow jobs; `role: job` just marks a service as runnable.

```yaml
services:
  api:
    build: ./apps/api
    environment:
      DATABASE_URL: postgres://app:${secret.DB_PASSWORD}@db:5432/app
    depends_on:
      db:
        condition: service_healthy
    x-eve:
      ingress: { public: true, port: 3000 }

  migrate:
    image: flyway/flyway:10
    command: -url=jdbc:postgresql://db:5432/app -user=app -password=${secret.DB_PASSWORD} -locations=filesystem:/migrations migrate
    volumes:
      - ./db/migrations:/migrations:ro
    depends_on:
      db:
        condition: service_healthy
    x-eve:
      role: job

  db:
    image: postgres:16
    environment:
      POSTGRES_DB: app
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${secret.DB_PASSWORD}

pipelines:
  deploy:
    steps:
      - name: migrate
        action: { type: job, service: migrate }
      - name: deploy
        depends_on: [migrate]
        action: { type: deploy }

environments:
  staging:
    pipeline: deploy
```

Ordering model (pipeline vs service readiness):

```text
Service readiness (depends_on):
  db healthy -> migrate job can start
  db healthy -> api pods can start

Pipeline ordering (step depends_on):
  migrate step -> deploy step -> api rollout

Net effect:
  db healthy
      |
      v
  run migrations (job) --success--> deploy -> api pods start
                         --fail----> deploy blocked
```

Notes:
- Job services are not deployed; they run only when invoked by a pipeline step
  or CLI.
- The same pattern works for seeds, backfills, smoke tests, and data repairs.
- The deploy step (which rolls out `api`) starts only after `migrate` completes,
  so new API pods do not start until migrations finish.
- The migration tool is just a container; swap Flyway for `migrate-mongo`,
  `mongosh` scripts, or any other DB-specific tooling.

## Filesystems (compose volumes + git)

Use Compose `volumes` plus an Eve source extension to support git-backed
filesystems. Services mount them using standard Compose `volumes` syntax.

```yaml
volumes:
  db-data: {}

  content:
    x-eve:
      source:
        git:
          repo: https://github.com/acme/content
          ref: main
          path: /
```

```yaml
services:
  web:
    build: ./apps/web
    volumes:
      - content:/app/content:ro
```

Environment-specific git refs override the volume source:

```yaml
environments:
  staging:
    overrides:
      volumes:
        content:
          x-eve:
            source:
              git:
                ref: staging
```

## Git-backed volumes in agent jobs

Goal: agents can read/write a git-backed filesystem, commit changes, and still
run inside the normal job sandbox.

How it ties together:
- Jobs route to a worker type (per-env default or job hint).
- Worker prepares the job workspace: clone project repo + hydrate git volumes.
- Git-backed volumes are mounted inside the workspace so sandbox rules allow
  read/write.
- Harness runs with `cwd` set to the project repo; skills load from
  `.agents/skills` in that repo as usual.

```yaml
services:
  worker-content:
    build: ./apps/worker
    x-eve:
      role: worker
      worker_type: content
      runner_mounts:
        - volume: content
          target: mounts/content
          read_only: false

volumes:
  content:
    x-eve:
      source:
        git:
          repo: https://github.com/acme/content
          ref: main
          auth:
            token_secret: CONTENT_GIT_TOKEN
          writeback:
            enabled: true
            branch: env/${ENV_NAME}

environments:
  staging:
    workers:
      - type: content
        service: worker-content
        replicas: 1
        default: true
```

Workspace layout (per job attempt):

```text
workspace/
  repo/                    # project repo (skills live here)
  mounts/
    content/               # git-backed volume clone (rw)
```

Execution flow:

```text
job (env=staging) -> worker_type=content
  -> workspace setup (clone repo + hydrate volume)
  -> harness start (cwd=workspace/repo, sandbox=workspace)
  -> agent can edit/commit in workspace/mounts/content
```

Notes:
- `runner_mounts` is a worker-only mount list (applied to runner pods), not the
  worker service container itself.
- If `writeback.enabled` is true, the mounted repo is a normal git clone with
  credentials; the agent can `git commit` + `git push` as part of the job.
- If you want read-only behavior, set `read_only: true` and omit `writeback`.

## Environments (branch pinning + overrides)

Environment blocks bind deploy behavior and allow Compose-style overrides.

```yaml
environments:
  staging:
    pipeline: deploy
    cluster: shared
    deploy:
      ref:
        branch: staging
      auto: true
    overrides:
      services:
        api:
          deploy:
            replicas: 2

  production:
    pipeline: deploy
    cluster: prod
    deploy:
      ref:
        tag: v1.2.3
      auto: false
    approval: required
```

`overrides` merges like Compose overrides:
- objects deep-merge
- lists replace by default (same as Compose override files)

`deploy.ref` supports `branch`, `tag`, or `sha`. Branches are convenient for
dev/staging; production usually pins a tag or SHA from the release step.

## Clusters (multi-cluster aware)

Clusters are named deploy targets. Environments select a cluster by name.
Capabilities gate what can run in that cluster.

```yaml
clusters:
  shared:
    type: k8s
    context: k3d-eve-local
    capabilities:
      deploy: true
      jobs: true
      workers: true

  prod:
    type: k8s
    context: eve-prod
    capabilities:
      deploy: true
      jobs: true
      workers: false
```

```yaml
environments:
  production:
    cluster: prod
    pipeline: deploy
```

Deploy actions target the env cluster. `jobs` controls deterministic pipeline
jobs (migrations, smoke tests), while `workers` gates agent workflows. A
deploy-only cluster is optional (set `jobs:false`, `workers:false`), but if
you want on-cluster migrations or self-healing checks in prod, keep
`jobs:true`.

## Auto-deploy triggers

If `deploy.auto: true` and `deploy.ref.branch` is set, Eve creates an implicit
trigger on `push` to that branch. If `deploy.ref.tag` is set, Eve triggers on
tag creation. Explicit `triggers` blocks remain optional for non-branch
events.

## Rollouts (blue/green + auto rollback)

```yaml
environments:
  production:
    deploy:
      ref: { tag: v1.2.3 }
      auto: false
      rollout:
        strategy: blue_green
        healthcheck:
          path: /healthz
          timeout_seconds: 60
        bake_seconds: 120
        rollback: auto
```

Notes:
- Blue/green keeps the old release serving until the new one passes health
  checks (or a smoke-test job) and traffic is switched.
- On failure or timeout, Eve keeps traffic on the old release and marks the
  deploy failed.

## Pipelines + workflows

Keep the existing deterministic pipeline model; pipeline steps use `action`,
`script`, or `agent`. Workflows remain optional and agent-run.

```yaml
pipelines:
  deploy:
    steps:
      - name: build
        action: { type: build }
      - name: release
        depends_on: [build]
        action: { type: release }
      - name: deploy
        depends_on: [release]
        action: { type: deploy }
```

## Versioning (semver + tagging)

```yaml
versioning:
  scheme: semver
  source: conventional_commits   # or manual, git_tag, file
  tag:
    enabled: true
    format: "v{version}"
  files:
    - package.json
    - apps/web/package.json
```

`versioning` feeds the release action:
- computes a version for each release
- optionally creates a git tag during the pipeline

## Versioning flow example

Typical flow with `source: conventional_commits`:
1. Release step computes the next version from commits since the last tag.
2. Images are tagged with that version.
3. Optional git tag is created (e.g., `v1.4.0`).
4. Deploy step targets that release (by version or tag).

Other options:
- `manual`: version provided at release/deploy time.
- `git_tag`: deploy already-tagged commits.
- `file`: read version from repo files (e.g., `package.json`).

## Full example (condensed)

```yaml
schema: eve/compose/v1
project: acme-app

registry:
  host: ghcr.io
  namespace: acme

clusters:
  shared:
    type: k8s
    context: k3d-eve-local
    capabilities: { deploy: true, jobs: true, workers: true }
  prod:
    type: k8s
    context: eve-prod
    capabilities: { deploy: true, jobs: true, workers: false }

services:
  api:
    build: ./apps/api
    ports: ["3000:3000"]
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://app:${secret.DB_PASSWORD}@db:5432/app
    depends_on:
      db:
        condition: service_healthy
    x-eve:
      ingress: { public: true, port: 3000 }
      api_spec: { type: openapi, spec_url: /openapi.json }

  web:
    build: ./apps/web
    ports: ["8080:80"]
    volumes:
      - content:/app/content:ro
    x-eve:
      ingress: { public: true, port: 80 }

  worker:
    build: ./apps/worker
    x-eve:
      role: worker
      worker_type: default

  migrate:
    image: flyway/flyway:10
    command: -url=jdbc:postgresql://db:5432/app -user=app -password=${secret.DB_PASSWORD} -locations=filesystem:/migrations migrate
    volumes:
      - ./db/migrations:/migrations:ro
    depends_on:
      db:
        condition: service_healthy
    x-eve:
      role: job

  db:
    image: postgres:16
    environment:
      POSTGRES_DB: app
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${secret.DB_PASSWORD}
    volumes:
      - db-data:/var/lib/postgresql/data

volumes:
  db-data: {}
  content:
    x-eve:
      source:
        git:
          repo: https://github.com/acme/content
          ref: main
          path: /

environments:
  staging:
    pipeline: deploy
    cluster: shared
    deploy:
      ref: { branch: staging }
      auto: true
    workers:
      - type: default
        service: worker
        replicas: 2
    overrides:
      services:
        api:
          deploy:
            replicas: 2

  production:
    pipeline: deploy
    cluster: prod
    deploy:
      ref: { tag: v1.2.3 }
      auto: false
      rollout:
        strategy: blue_green
        rollback: auto
    approval: required
    overrides:
      services:
        db:
          x-eve:
            external:
              connection_url: ${secret.PROD_DATABASE_URL}

pipelines:
  deploy:
    steps:
      - name: build
        action: { type: build }
      - name: release
        depends_on: [build]
        action: { type: release }
      - name: migrate
        depends_on: [release]
        action: { type: job, service: migrate }
      - name: deploy
        depends_on: [migrate]
        action: { type: deploy }

versioning:
  scheme: semver
  source: conventional_commits
  tag:
    enabled: true
    format: "v{version}"
```

## Refactor plan (no backward compat)

1. Spec: finalize schema and merge rules; update `docs/system/manifest.md`.
2. Parser: update manifest schema and validation to compose-plus fields.
3. Runtime: update deployer to read `services`, `volumes`, `x-eve`, and external services.
4. Clusters: add named cluster config + capability gating; target deploys by env.
5. CI/CD: wire `versioning` into release action; add git tagging option.
6. Examples: update templates and example repo to new manifest.
7. Cleanup: remove legacy parsing, tests, and docs.

## Additional high-value additions

- `x-eve.routes` for explicit host/path mapping per service.
- `x-eve.secrets` to declare required secrets and validate on sync.
- `profiles` or `groups` to toggle optional services cleanly.
