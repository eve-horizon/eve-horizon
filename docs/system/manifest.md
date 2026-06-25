# Eve Manifest (v2)

> Status: Current
> Last Updated: 2026-05-18
>
> This is the authoritative manifest specification. For migration context and future
> enhancements, see `docs/plans/manifest-v2-compose-plan.md`.

## Purpose

The Eve manifest (`.eve/manifest.yaml`) is the single source of truth for how a
project builds, deploys, and runs. The v2 format uses Docker Compose-style
service definitions with Eve-specific extensions under `x-eve`.

## Minimal Example

```yaml
schema: eve/compose/v2
project: my-project

registry:
  host: public.ecr.aws/w7c4v0w3
  namespace: eve-horizon
  auth:
    username_secret: REGISTRY_USERNAME
    token_secret: REGISTRY_PASSWORD

services:
  db:
    image: postgres:16
    ports: [5432]
    environment:
      POSTGRES_DB: app
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${secret.DB_PASSWORD}
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "app"]
      interval: 5s
      timeout: 3s
      retries: 5

  api:
    build:
      context: ./apps/api
    ports: [3000]
    environment:
      DATABASE_URL: postgres://app:${secret.DB_PASSWORD}@db:5432/app
    depends_on:
      db:
        condition: service_healthy
    x-eve:
      ingress:
        public: true
        port: 3000
        timeout: 300s
        max_body_size: 10m
      api_spec:
        type: openapi
        spec_url: /openapi.json

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

environments:
  test:
    pipeline: deploy-test
    overrides:
      services:
        api:
          environment:
            NODE_ENV: test

pipelines:
  deploy-test:
    steps:
      - name: migrate
        action: { type: job, service: migrate }
      - name: deploy
        depends_on: [migrate]
        action: { type: deploy }
```

## Top-Level Fields

| Field | Required | Description |
|-------|----------|-------------|
| `schema` | No | Manifest schema identifier (e.g., `eve/compose/v2`) |
| `project` | No | Human-friendly project slug (informational) |
| `registry` | No | Container registry configuration (`"eve"`, `"none"`, or object) |
| `services` | Yes | Compose-style services (buildable + dependencies) |
| `environments` | No | Environment definitions and overrides |
| `pipelines` | No | Deterministic pipelines (steps-based) |
| `workflows` | No | On-demand workflow definitions |
| `versioning` | No | Release/version policy (semver, tagging) |
| `x-eve` | No | Eve-specific top-level extensions (`x_eve` also supported) |

Note: Unknown fields are allowed for forward compatibility.

### Workflow References

For large workflows, keep the manifest small and reference repo-local workflow
files:

```yaml
workflows:
  acme-make-plan:
    $ref: .eve/workflows/acme-make-plan
```

The recommended convention is one directory per workflow:

```text
.eve/workflows/acme-make-plan/
  workflow.yaml
  prompts/
    plan.md
    review.md
```

When `$ref` points to a directory, the CLI loads `workflow.yaml` or
`workflow.yml` from that directory. `$ref` can also point directly at a YAML
file. References are expanded by `eve project sync` and `eve manifest validate`
before the manifest is sent to the API; direct API sync rejects unresolved
`$ref` values.

Inside workflow files, long agent prompts can live in Markdown files:

```yaml
steps:
  - name: plan
    agent:
      name: acme-planner
      prompt_file: prompts/plan.md
```

`prompt_file` is resolved relative to the workflow file directory, read
verbatim, and expanded into `agent.prompt` in the stored manifest.

### Top-Level `x-eve.defaults`

The `x-eve.defaults` block stores default job settings (env, harness, harness_profile,
harness_options, hints, git/workspace). It is
parsed and returned via the manifest sync API as `parsed_defaults`.

```yaml
x-eve:
  defaults:
    env: staging
    harness: mclaude
    harness_profile: primary-orchestrator
    harness_options:
      model: opus-4.5
      reasoning_effort: high
    hints:
      permission_policy: auto_edit
      resource_class: job.c1
      max_cost:
        currency: usd
        amount: 5
      max_tokens: 200000
    git:
      ref_policy: auto
      branch: job/${job_id}
      create_branch: if_missing
      commit: manual
      push: never
    workspace:
      mode: job
```

`hints` can include budgeting and accounting fields such as `resource_class`,
`max_cost`, and `max_tokens`. These map to job scheduling hints and per-attempt
budget enforcement.

### Secret Requirements

Manifests may declare required secrets for validation during sync:

```yaml
x-eve:
  requires:
    secrets: [GITHUB_TOKEN, REGISTRY_TOKEN]

pipelines:
  ci-cd-main:
    steps:
      - name: integration-tests
        script:
          run: "pnpm test"
        requires:
          secrets: [DATABASE_URL]
```

Validation can be enforced via `eve project sync --validate-secrets` or
`--strict` to fail on missing secrets. Required keys map to secret names
and follow standard scope resolution rules.

Workflow `env_overrides` that reference `${secret.KEY}` are included in the
same required-secret validation. Both workflow-level defaults and step-level
overrides are scanned, so `eve manifest validate --validate-secrets` and
`eve project sync --validate-secrets` can report missing workflow runtime
secrets before an invocation creates jobs.

For pre-flight checks without syncing, use `eve manifest validate` to run
schema + secret validation against a local manifest or the latest synced
version.

### Cross-Project App Links

The top-level `x-eve.app_links` block lets a producer project grant another
project access to selected APIs, image-mode CLIs, and app events without sharing
long-lived secrets.

```yaml
x-eve:
  app_links:
    exports:
      apis:
        observation:
          service: api
          cli: obs
          scopes: [observations:read]
          consumers:
            - project: consumer
              scopes: [observations:read]
              envs: [staging]
      events:
        observation-feed:
          types: [app.observation.created]
          consumers:
            - project: consumer
    consumes:
      observation:
        project: producer
        api: observation
        environment: same
        scopes: [observations:read]
        events:
          feed: observation-feed
          types: [app.observation.created]
        inject_into:
          services: [api]
          jobs: true
```

Producer API exports must reference an existing service with `x-eve.api_spec`
or `x-eve.api_specs`. If `cli` is exported, the same service must declare a
matching `x-eve.cli` with `image`, because consumers do not have the producer
repo checked out. Consumer subscriptions are reconciled during
`eve project sync`; requested scopes and event types must be subsets of an
active producer grant.

Injected services and jobs receive `EVE_APP_LINK_<ALIAS>_API_URL`,
`EVE_APP_LINK_<ALIAS>_TOKEN`, `EVE_APP_LINK_<ALIAS>_SCOPES`,
`EVE_APP_LINK_<ALIAS>_PROJECT`, `EVE_APP_LINK_<ALIAS>_ENV`, and
`EVE_APP_LINK_<ALIAS>_CLI` when an exported CLI is available. See
`cross-project-app-links.md` for diagnostics and event fan-out behavior.

For local k3d cross-project work, use one shared environment name across every
project in the mesh. The convention is `environments.local`; `eve local mesh up`
fails fast when any project in the workspace does not declare the workspace env.
Consumer references must use the producer Eve project slug, which is also the
workspace project name.

### Platform Environment Variables

Eve automatically injects the following environment variables into all deployed services:

| Variable | Description |
|----------|-------------|
| `EVE_API_URL` | Internal cluster URL for server-to-server calls (e.g., `http://eve-api:4701`) |
| `EVE_PUBLIC_API_URL` | Public ingress URL for browser-facing apps (e.g., `https://api.eve.example.com`) |
| `EVE_PROJECT_ID` | The project ID (e.g., `proj_01abc123...`) |
| `EVE_ORG_ID` | The organization ID (e.g., `org_01xyz789...`) |
| `EVE_ENV_NAME` | The environment name (e.g., `staging`, `production`) |

These allow your services to interact with the Eve platform without manual configuration.
Job runners also receive `EVE_ENV_NAMESPACE`, but service containers do not.
Services can override these values by defining them explicitly in their `environment` section.

**Which API URL to use:**
- `EVE_API_URL` — for backend/server-side calls from your container to the Eve API (internal cluster networking)
- `EVE_PUBLIC_API_URL` — for browser/client-side calls or any code running outside the cluster

**Example usage in your app:**

```javascript
// Server-side: call Eve API from your backend
const eveApiUrl = process.env.EVE_API_URL;

// Client-side: expose to browser for frontend API calls
const publicApiUrl = process.env.EVE_PUBLIC_API_URL;
```

---

### Top-Level `x-eve.agents`

Define per-project agent profiles and councils for orchestration:

```yaml
x-eve:
  agents:
    version: 1
    availability:
      drop_unavailable: true
    profiles:
      primary-orchestrator:
        - harness: mclaude
          model: opus-4.5
          reasoning_effort: high
      primary-reviewer:
        - harness: mclaude
          model: opus-4.5
          reasoning_effort: high
        - harness: codex
          model: gpt-5.2-codex
          reasoning_effort: x-high
      planning-council:
        - profile: primary-planner
        - harness: gemini
          model: gemini-3

### Top-Level `x-eve.packs` and `x-eve.install_agents`

AgentPacks let projects import agent, team, chat, and skills configuration
from external repositories. Packs are resolved by `eve agents sync` and locked
in `.eve/packs.lock.yaml`.

```yaml
x-eve:
  # Default agents to install skills for (defaults to [claude-code])
  install_agents: [claude-code, codex, gemini-cli]

  packs:
    # Local pack
    - source: ./skillpacks/my-pack

    # Remote pack (ref required for remote sources)
    - source: eve-horizon/eve-skillpacks
      ref: 0123456789abcdef0123456789abcdef01234567

    # Per-pack override (optional)
    - source: ./skillpacks/claude-only
      install_agents: [claude-code]
```

**Notes:**
- `source` may be a local path, `owner/repo`, `github:owner/repo`, or a git URL.
- `ref` is required for remote sources and must be a 40-character SHA.
- Packs can be full AgentPacks (with `eve/pack.yaml`) or skills-only packs.
- `eve packs status` shows lockfile state and drift; `eve packs resolve` previews
  resolution (delegates to `eve agents sync`).
```

This is consumed by orchestrators (via `eve agents config`) to select harness/model
combinations and run planning councils in parallel. The manifest sync API returns the
parsed policy as `parsed_agents`.

## Registry

```yaml
registry:
  host: public.ecr.aws/w7c4v0w3
  namespace: eve-horizon
  auth:
    username_secret: REGISTRY_USERNAME
    token_secret: REGISTRY_PASSWORD
```

Registry may also be specified as a string:

```yaml
registry: "eve"   # Use Eve-native registry (internal)
registry: "none"  # Opt out of registry auth and pull secrets
```

- `"eve"` uses the internal Eve registry and an API-issued JWT.
- `"none"` disables registry handling (assumes public images or external auth).

The deployer uses these secrets to create Kubernetes `imagePullSecrets` for
pulling private images. See `docs/system/container-registry.md` for setup.

## Managed Databases (`role: managed_db`)

Managed databases are declared as services with `x-eve.role: managed_db` and a
`x-eve.managed` config block. These services are **not** deployed to Kubernetes;
the orchestrator provisions tenants when you deploy an environment.

```yaml
services:
  db:
    x-eve:
      role: managed_db
      managed:
        class: db.p1
        engine: postgres
        engine_version: "16"
        extensions: [postgis, pgvector, pg_trgm]
```

Notes:
- `class` controls the managed DB tier (`db.p1`, `db.p2`, `db.p3`).
- Provisioning happens on first deploy for an environment.
- Use `eve db status --env <name>` to view provisioning state.
- Other services may reference managed values with `${managed.<service>.<field>}`
  placeholders (resolved at deploy time when available).
- `extensions` is optional and supports plain tenant-local extensions:
  `postgis`, `pgvector`, `pg_trgm`, `btree_gist`, `hstore`, and `citext`.
- The manifest name `pgvector` maps to the PostgreSQL extension `vector`.
- Eve installs declared extensions as the backing instance admin during
  provisioning or in-place reconcile, before app migration jobs run.
- Removing an extension from the manifest does not drop it from an existing DB.
  Extension removal is sticky in v1 to avoid data loss.
- `pg_cron` is provider-gated. It is rejected unless the platform has enabled
  `EVE_MANAGED_DB_ENABLED_PRELOAD_EXTENSIONS=pg_cron` and the backing Postgres
  instance has `shared_preload_libraries=pg_cron`.
- `pg_cron` is installed in the instance admin database (`postgres`) following
  the AWS RDS model; tenant-database job targeting is a platform-admin
  operation.
- `timescaledb` is still a non-declarable preload candidate on AWS RDS.

---

## Project Bootstrap

Bootstrap creates a project + environments in a single API call:

```bash
eve project bootstrap --name my-app --repo-url https://github.com/org/repo \
  --environments staging,production
```

API: `POST /projects/bootstrap` with body:
- `org_id`, `name`, `repo_url`, `branch` (required)
- `slug`, `description`, `template`, `packs`, `environments` (optional)

Idempotent — re-calling with the same name returns the existing project.

---

## Services (Compose-Style)

Services follow Docker Compose conventions (`image`, `build`, `environment`,
`ports`, `depends_on`, `healthcheck`). Eve adds extensions under `x-eve`.

```yaml
services:
  api:
    build:
      context: ./apps/api
    ports: [3000]
    environment:
      NODE_ENV: production
    depends_on:
      db:
        condition: service_healthy
    x-eve:
      ingress:
        public: true
        port: 3000
```

### Service Fields

| Field | Description |
|-------|-------------|
| `image` | Base image (no tag required) |
| `build` | Build context + optional `dockerfile` |
| `environment` | Env var map |
| `ports` | Container ports (Compose-style entries allowed) |
| `depends_on` | Dependency ordering with health conditions |
| `healthcheck` | Docker-style health checks |
| `x-eve` | Eve extensions (see below) |

### Eve Extensions (`x-eve` / `x_eve`)

| Field | Description |
|-------|-------------|
| `role` | `component` (default), `worker`, `job`, or `managed_db` |
| `ingress` | Public HTTP routing: `{ public: true|false, port: number, alias?: string, domains?: string[], timeout?: string, max_body_size?: string }` |
| `tcp_ingress` | Public L4 TCP listeners for raw protocols |
| `api_spec` | Single API spec registration |
| `api_specs` | Multiple API specs |
| `external` | If `true`, service is not deployed (external dependency) |
| `connection_url` | Connection string for external services |
| `worker_type` | Worker pool type for worker services |
| `files` | Mount repo files into container |
| `storage` | Persistent volume configuration |
| `managed` | Managed DB config (requires `role: managed_db`) |
| `audit_log_table` | Optional table used by `eve env diagnose --request` |
| `request_id_column` | Optional request ID column for `audit_log_table` (default `request_id`) |

Notes:
- If a service exposes ports and a domain is configured, Eve creates public
  ingress by default. Set `x-eve.ingress.public: false` to disable.
- `x-eve.ingress.timeout` tunes nginx-ingress request/response timeout for all
  HTTP ingress objects for the service (default host, alias, and custom
  domains). Use lowercase duration strings such as `30s`, `5m`, or `30m`.
  Platform default is `EVE_DEFAULT_INGRESS_TIMEOUT=300s`; valid range is
  `1s`-`30m`. Longer batch work should run as an Eve job.
- `x-eve.ingress.max_body_size` tunes nginx-ingress request body size. Use
  lowercase byte strings such as `512k`, `10m`, or `1g`. Platform default is
  `EVE_DEFAULT_INGRESS_MAX_BODY_SIZE=10m`; valid range is `1k`-`1g`.
  Larger uploads should use signed URLs or object storage.
- Ingress timeout/body-size translation is nginx-only in this phase. Traefik or
  unknown ingress classes keep existing routing behavior and skip L7 tuning.
  `eve env diagnose <project> <env>` includes an `HTTP Ingress` section and
  `.http_ingress[]` JSON rows showing requested and effective values.
- `x-eve.role: job` marks a service runnable as a one-off job (migrations, seeds).
- `x-eve.role: managed_db` marks a service as a platform-provisioned database
  and removes it from K8s deployment rendering.
- `audit_log_table` is only queried when request-level diagnostics are run. The
  table name may be schema-qualified; rows are returned verbatim and failures are
  reported as warnings in the diagnose response.

### TCP Ingress

Use `x-eve.tcp_ingress` when an app needs public raw TCP listeners instead of
HTTP routing, for example device trackers or protocol gateways. The service
must still declare every listener port in top-level `ports`.

```yaml
services:
  device-edge:
    image: ghcr.io/acme/device-edge:latest
    ports: [33400, 33500]
    x-eve:
      tcp_ingress:
        hostname: trackers
        allow_cidrs:
          - 0.0.0.0/0
        listeners:
          - name: a1-gt06
            port: 33400
          - name: mictrack-mt700
            port: 33500
```

Fields:

| Field | Description |
|-------|-------------|
| `listeners` | Required list of 1-20 listeners. Names must be lowercase alphanumeric with hyphens and become `EVE_TCP_LISTENER_<NAME>_*` env vars. |
| `listeners[].port` | Public and target TCP port. It must be declared in service `ports` and must not use the Kubernetes NodePort range `30000-32767`. |
| `hostname` | Optional platform alias under `EVE_TCP_INGRESS_HOSTED_ZONE` or `EVE_DEFAULT_DOMAIN`. If omitted, Eve advertises a generated service-scoped hostname. |
| `allow_cidrs` | Optional source CIDR allowlist rendered as `loadBalancerSourceRanges`. |

The platform renders one `Service` of type `LoadBalancer` per service with
`tcp_ingress`, labelled `eve.tcp_ingress=true`. The provider is selected by
`EVE_TCP_INGRESS_PROVIDER`:

| Provider | Behavior |
|----------|----------|
| `none` | Validate the manifest, but render no public TCP service or env vars. |
| `klipper` | Local k3d/k3s LoadBalancer provider. |
| `aws-nlb` | Internet-facing AWS Network Load Balancer; requires the AWS Load Balancer Controller. |

The app container receives:

| Env var | Example |
|---------|---------|
| `EVE_TCP_PUBLIC_HOST` | `trackers.eve.example.com` |
| `EVE_TCP_LISTENER_A1_GT06_PORT` | `33400` |
| `EVE_TCP_LISTENER_A1_GT06_HOST` | `trackers.eve.example.com` |

TCP aliases use the same global claim table and reserved-name rules as HTTP
ingress aliases. A manifest cannot declare the same alias for HTTP and TCP.
Removing a `tcp_ingress` block garbage-collects the stale LoadBalancer service
on the next deploy.

Diagnostics:

```bash
eve env diagnose <project> <env>                       # shows TCP Ingress rows
eve env diagnose <project> <env> --json | jq '.tcp_ingress'
eve tcp-ingress test <project> <env> --listener a1-gt06
```

For local k3d, expose raw TCP ports when the cluster is created:

```bash
./bin/eh k8s start --tcp-ports 33400,33500 --recreate
```

### API Specs

```yaml
services:
  api:
    build:
      context: ./apps/api
    x-eve:
      api_spec:
        type: openapi
        spec_url: /openapi.json
        # spec_path is only supported for local file:// repos
        # spec_path: ./apps/api/openapi.yaml
```

Notes:
- `spec_url` may be relative (resolved against the service URL) or absolute.
- `spec_path` is local-only (`file://` repo URLs).

### Files Mount

```yaml
services:
  api:
    x-eve:
      files:
        - source: ./config/app.conf
          target: /etc/app/app.conf
```

### Persistent Storage

```yaml
services:
  api:
    x-eve:
      storage:
        mount_path: /data
        size: 10Gi
        access_mode: ReadWriteOnce
        storage_class: standard
```

### Health Checks

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
  interval: 10s
  timeout: 5s
  retries: 3
  start_period: 10s
```

### Dependencies

```yaml
depends_on:
  db:
    condition: service_healthy
```

Supported conditions:
- `service_started` / `started`
- `service_healthy` / `healthy`

---

## Environments

Environments link pipelines to deploy targets and provide overrides.

```yaml
environments:
  staging:
    pipeline: deploy
    pipeline_inputs:
      smoke_test: true
      timeout: 1800
    approval: required
    overrides:
      services:
        api:
          environment:
            NODE_ENV: staging
    workers:
      - type: default
        service: worker
        replicas: 2
```

| Field | Description |
|-------|-------------|
| `pipeline` | Pipeline to run for this environment (when set, `eve env deploy` becomes a pipeline alias) |
| `pipeline_inputs` | Default inputs to pass to the pipeline run (merged with CLI `--inputs`, CLI wins) |
| `approval` | `required` to gate deploy/job steps |
| `overrides.services` | Compose-style service overrides |
| `workers` | Worker pool selection for this environment |

### Environment Pipeline Behavior

When `pipeline` is configured for an environment, `eve env deploy <env> --ref <sha>` triggers a pipeline run instead of performing a direct deployment. This enables:

- Consistent build/test/deploy workflows across environments
- Promotion patterns where staging/production reuse releases from test
- Environment-specific pipeline inputs and approval gates

To bypass the pipeline and perform a direct deployment, use `--direct`:

```bash
eve env deploy staging --ref 0123456789abcdef0123456789abcdef01234567 --direct
```

### Promotion Example

```yaml
environments:
  test:
    pipeline: deploy-test
  staging:
    pipeline: deploy
    pipeline_inputs:
      smoke_test: true
  production:
    pipeline: deploy
    approval: required
```

Deploy flow:

```bash
# Build + test + release in test
eve env deploy test --ref 0123456789abcdef0123456789abcdef01234567

# Promote to staging (reuse release)
eve release resolve v1.2.3  # Get release_id from test
eve env deploy staging --ref 0123456789abcdef0123456789abcdef01234567 --inputs '{"release_id":"rel_xxx"}'

# Promote to production (approval required)
eve env deploy production --ref 0123456789abcdef0123456789abcdef01234567 --inputs '{"release_id":"rel_xxx"}'
```

---

## Pipelines (v2 steps)

Pipelines define ordered steps that expand into job graphs.

```yaml
pipelines:
  deploy:
    toolchains: [python]
    steps:
      - name: build
        action: { type: build }
      - name: unit-tests
        toolchains: [python]
        script:
          run: "pnpm test"
          timeout: 1800
      - name: release
        depends_on: [build, unit-tests]
        action: { type: release }
      - name: deploy
        depends_on: [release]
        action: { type: deploy }
```

Step types:
- **action**: built-in actions (`build`, `release`, `deploy`, `run`, `job`, `create-pr`)
- **script**: shell command executed by the worker (`run` or `command` + `timeout`)
- **agent**: AI agent job (`prompt`, optional config)
- **run**: shorthand for `script.run`

`toolchains` can be declared at pipeline root or step level. Valid values are
`python`, `media`, `rust`, `java`, and `kotlin`. Script, shorthand `run`,
agent, and `action: { type: run }` steps resolve `step.toolchains >
pipeline.toolchains > []`; non-run actions cannot declare step-level
toolchains, and `action.toolchains` is rejected.

---

## Workflows

Workflows are manifest-defined job DAGs. The platform reads step definitions,
dependency edges, `db_access`, `with_apis`, git controls, and resource ref
policies when invoking a workflow. Workflow and step `env_overrides` are
validated with the same schema as job-level overrides. Workflow and step
`scope` blocks narrow the step job token and org filesystem mount. Each step
must define exactly one execution kind: `agent`, `script`, or top-level `run`.
`script` and `run` workflow steps materialize as worker-executed script jobs;
workflow `action` steps are reserved for future support and are rejected at
invoke time.

Workflow `toolchains` can be declared at workflow root or step level. Script and
shorthand `run` steps resolve `step.toolchains > workflow.toolchains > []`.
Agent steps resolve `step.toolchains > agent config toolchains >
workflow.toolchains > []`. Resolved toolchains are stored in
`jobs.hints.toolchains`, provisioned before execution, and visible in
`runtime_meta.toolchains` through `eve job show --verbose` / `eve job diagnose`.

```yaml
workflows:
  create-design:
    db_access: read_only
    toolchains: [python]
    resource_refs: inherit
    env_overrides:
      WEB_SEARCH_API_KEY: ${secret.WEB_SEARCH_API_KEY}
    scope:
      orgfs:
        allow_prefixes: [/groups/projects/proj-a/**]
    steps:
      - name: prepare
        toolchains: [python]
        script:
          run: eve job list --json
          timeout_seconds: 60
      - name: read-sources
        depends_on: [prepare]
        agent:
          name: designer
      - name: publish
        depends_on: [read-sources]
        resource_refs: none
        env_overrides:
          PUBLISH_API_KEY: ${secret.PUBLISH_API_KEY}
        scope:
          cloud_fs:
            allow_mount_ids: [mount_a]
        agent:
          name: publisher
```

`resource_refs` controls invocation resource access:

| Value | Description |
|-------|-------------|
| `inherit` / `all` | Pass all invocation refs to the step (default) |
| `none` | Pass no invocation refs |
| string array | Pass only refs whose `name`, `label`, `mount_path`, `uri`, or `metadata.name` matches |
| `{ mode: selected, include: [...] }` | Object form for selected refs |

Set `resource_refs` at workflow level for a default and override it per step
when a later step should not receive raw uploaded or linked resources.

`env_overrides` can be declared at workflow level, step level, or supplied at
invoke time with `eve workflow run|invoke --env-override KEY=VALUE`. The
effective step job value is merged by key with this precedence:

1. Invocation request overrides.
2. Step-level workflow YAML overrides.
3. Workflow-level YAML defaults.

Values may be literals or `${secret.KEY}` placeholders. Other `${...}`
expressions are rejected, reserved platform variables such as `EVE_*`, `PATH`,
and `HOME` cannot be overridden, and the merged object must fit the job
`env_overrides` size limit. The root workflow job remains metadata-only;
executable step jobs persist the merged `env_overrides`, and the existing
worker/agent-runtime secret interpolation injects resolved values only inside
the harness process.

`scope` can be declared at workflow level, step level, or supplied in the
workflow invoke API body. The effective step-job `token_scope` is the
intersection of those layers, so invocation scope may narrow but not widen the
manifest. Supported axes are `orgfs`, `orgdocs`, `envdb`, and `cloud_fs`.
Request-supplied `scope` requires `jobs:harness_override`. There is no CLI
`--scope-*` flag yet; use manifest workflow/step `scope` or the API body.

---

## Versioning

The `versioning` block describes semver/tagging policy for release creation.
See `docs/ideas/manifest-v2-compose.md` for evolving proposals.
