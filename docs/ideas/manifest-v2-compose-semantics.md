# Manifest v2: Docker Compose Semantics

> Note: This document references legacy `components`/`defaults` examples for historical context.
> Current implementations use `services` + `x-eve.*` and job-based migrations. See
> `docs/system/manifest.md` for the authoritative spec.

> Status: Proposal
> Last Updated: 2026-01-26

## Executive Summary

This proposal redesigns the Eve manifest format to align closely with **docker-compose semantics** while preserving Eve-specific primitives (buildable services with Dockerfile, custom workers, arbitrary services, multi-env, CI/CD). The goal is a configuration that any developer familiar with docker-compose can immediately understand, yet powerful enough for production deployments.

**Key insight**: Docker Compose has established an industry-standard vocabulary for container orchestration. Eve should speak this language, extending it only where necessary.

---

## Analysis of Current State

### Current Manifest Structure (.eve/manifest.yaml) [legacy]

```yaml
name: my-project
x-eve:
  defaults:
    env: test
    harness: docker
environments:
  test:
    x-eve:
      namespace: eve-test
services:
  api:
    image: eve-api
    ports:
      - "3000:3000"
    replicas: 1
```

### Current Problems

1. **Semantic Mismatch**: Fields like `type: service` and `db_ref` have no docker-compose equivalent, creating cognitive overhead
2. **Build/Image Confusion**: `image` can be either a base image OR a build output path, ambiguously
3. **Scattered Registry Config**: Registry auth lives at top-level, disconnected from images
4. **Pipelines/Workflows Divergence**: Two similar concepts with different syntax
5. **Environment Overrides**: Per-environment config is awkward (`overrides.replicas`)
6. **Missing Compose Primitives**: No `volumes`, `networks`, `profiles` equivalents
7. **No Cluster Targeting**: No way to scope environments to specific clusters (e.g., hardened prod cluster)
8. **No Env-Specific Externalization**: Services cannot switch between internal and external per environment

---

## Proposed Design: Compose-Native Eve

### Design Principles

1. **Compose-Compatible Where Possible**: Use exact docker-compose field names and semantics
2. **Eve Extensions Are Explicit**: Eve-specific fields prefixed with `x-eve-` or in a dedicated section
3. **Single Source of Truth**: One file describes build, deploy, AND runtime behavior
4. **Environment as Override Layer**: Environments are diff-layers on top of base config
5. **No Magic**: Every behavior is explicitly declared
6. **Multi-Cluster First**: Environments can target named clusters and optionally disable workers/jobs

### New Manifest Structure

```yaml
# ==============================================================================
# EVE MANIFEST v2
# Docker Compose semantics with Eve deployment extensions
# ==============================================================================

version: "3.8"  # Compose format version (informational)
name: my-project

# ==============================================================================
# SERVICES (Components)
# Follows docker-compose services syntax exactly
# ==============================================================================
services:
  db:
    image: postgres:16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: eve
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: app
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "eve"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s

  api:
    build:
      context: ./apps/api
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://eve:${DB_PASSWORD}@db:5432/app
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  web:
    build:
      context: ./apps/web
    ports:
      - "80:80"
    environment:
      API_URL: http://api:3000
    depends_on:
      - api

  worker:
    build:
      context: ./apps/worker
    # No ports - internal service
    environment:
      DATABASE_URL: postgres://eve:${DB_PASSWORD}@db:5432/app
      QUEUE_URL: redis://redis:6379
    depends_on:
      - db
      - redis
    # Eve extension: worker profile selection
    x-eve:
      worker_profile: python  # Uses Python worker variant

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

# ==============================================================================
# VOLUMES (Persistent Storage)
# Standard docker-compose volumes
# ==============================================================================
volumes:
  db-data:

# ==============================================================================
# X-EVE: Eve-Specific Extensions
# ==============================================================================
x-eve:
  # Registry configuration for image publishing
  registry:
    host: ghcr.io
    namespace: myorg
    auth:
      username: ${GHCR_USERNAME}
      token: ${GHCR_TOKEN}

  # Secret references (resolved at deploy time)
  secrets:
    DB_PASSWORD: ${secret.DB_PASSWORD}
    GHCR_USERNAME: ${secret.GHCR_USERNAME}
    GHCR_TOKEN: ${secret.GHCR_TOKEN}

  # Ingress/routing configuration
  ingress:
    domain: ${EVE_DEFAULT_DOMAIN}
    expose:
      - api
      - web

  # Cluster targets (named clusters known to Eve)
  clusters:
    shared:
      description: "Default dev/test cluster"
    prod:
      description: "Hardened production cluster"
      allow_workers: false
      allow_jobs: false

# ==============================================================================
# ENVIRONMENTS
# Layer overrides on top of base services config
# ==============================================================================
environments:
  test:
    # Sparse override - only what changes
    services:
      api:
        replicas: 1
        environment:
          NODE_ENV: test
      web:
        replicas: 1
    x-eve:
      namespace: eve-${PROJECT_SLUG}-test
      cluster: shared

  staging:
    services:
      api:
        replicas: 2
        environment:
          NODE_ENV: staging
      web:
        replicas: 2
    x-eve:
      cluster: shared
      namespace: eve-${PROJECT_SLUG}-staging
      ingress:
        domain: staging.myapp.com

  production:
    services:
      api:
        replicas: 3
        environment:
          NODE_ENV: production
      web:
        replicas: 3
    x-eve:
      namespace: myapp-prod
      ingress:
        domain: myapp.com
      approval: required  # Gated deployment

# ==============================================================================
# PIPELINES
# CI/CD workflows that build, test, and deploy
# ==============================================================================
pipelines:
  deploy-test:
    trigger:
      github:
        event: push
        branch: main
    steps:
      - name: build
        action: build

      - name: unit-tests
        script: pnpm test
        timeout: 1800

      - name: release
        action: release
        depends_on: [build, unit-tests]

      - name: deploy
        action: deploy
        depends_on: [release]
        target: test

      - name: smoke
        script: ./scripts/smoke-test.sh
        depends_on: [deploy]

  deploy-production:
    trigger:
      manual: true
    steps:
      - name: build
        action: build

      - name: release
        action: release
        depends_on: [build]

      - name: deploy
        action: deploy
        depends_on: [release]
        target: production
        approval: required

# ==============================================================================
# WORKFLOWS
# On-demand agent-driven processes
# ==============================================================================
workflows:
  smoke-check:
    db_access: read_only
    steps:
      - agent:
          prompt: "Run a quick smoke check on the deployed API"

  remediation:
    trigger:
      system:
        event: job.failed
    steps:
      - name: analyze
        agent:
          prompt: "Analyze failure and propose a fix"
      - name: create-pr
        action: create-pr
        depends_on: [analyze]
        dry_run: true
```

---

## Key Design Decisions

### 1. Services Instead of Components

**Legacy (deprecated):** `components` blocks are replaced by `services`.

**After:**
```yaml
services:
  api:
    build:
      context: ./apps/api
```

**Rationale**: `services` is the docker-compose term. Everyone knows it.

### 2. Build Is Always Explicit

Every service that Eve builds MUST have a `build` block:

```yaml
services:
  api:
    build:
      context: ./apps/api
      dockerfile: Dockerfile  # Optional, defaults to Dockerfile
```

Services with only `image` are **external dependencies** (postgres, redis, etc.) and are NOT built by Eve:

```yaml
services:
  db:
    image: postgres:16  # External image, not built
```

**No ambiguity**: If you see `build`, Eve builds it. If you only see `image`, it's pulled.

### 3. x-eve Extensions Are Namespaced

Docker-compose allows `x-*` extensions. We use `x-eve` for Eve-specific config:

```yaml
services:
  worker:
    x-eve:
      worker_profile: python  # Eve-specific: which worker variant

x-eve:
  registry:
    host: ghcr.io
  ingress:
    domain: myapp.com
```

This means the manifest is **valid docker-compose** (for local dev) while containing deployment metadata.

### 4. Environments as Sparse Overrides

Environments don't repeat the full service definition. They only specify **what changes**:

```yaml
services:
  api:
    replicas: 1  # Base default
    environment:
      NODE_ENV: development

environments:
  production:
    services:
      api:
        replicas: 3  # Override
        environment:
          NODE_ENV: production  # Override
```

**Merge strategy**: Deep merge with environment values taking precedence.

### 5. Pipelines Use Simple Step Syntax

```yaml
pipelines:
  deploy:
    steps:
      - name: build
        action: build

      - name: test
        script: pnpm test

      - name: deploy
        action: deploy
        depends_on: [build, test]
```

Three step types:
- `action`: Built-in Eve action (build, release, deploy, create-pr)
- `script`: Shell command
- `agent`: AI agent task

### 6. Healthcheck → K8s Probes (Automatic)

Docker-compose healthchecks are **automatically converted** to K8s readiness/liveness probes:

```yaml
services:
  api:
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 10s
      timeout: 5s
```

This already works in the current system. The new manifest just makes the syntax cleaner.

---

## Migration Path

Since there's **no backwards compatibility requirement**, migration is straightforward:

### Step 1: Rename and Restructure

| Old | New |
|-----|-----|
| `project:` | `name:` |
| `components:` | `services:` |
| `registry:` | `x-eve.registry:` |
| `defaults:` | `x-eve.defaults:` |

### Step 2: Normalize Build/Image

Legacy `components` examples are omitted here; see `docs/plans/manifest-v2-compose-plan.md` for the explicit mapping.

```yaml
services:
  api:
    build:
      context: ./apps/api
    # image is computed: ghcr.io/org/api from registry + name
```

### Step 3: Move Eve Extensions to x-eve

Legacy `components` + `domain` examples are omitted here; see `docs/plans/manifest-v2-compose-plan.md` for the explicit mapping.

```yaml
services:
  api:
    ports:
      - "3000:3000"
x-eve:
  ingress:
    domain: myapp.com
```

---

## Implementation Plan

### Phase 1: Schema Definition (2-3 days)
- Define new Zod schemas in `packages/shared/src/schemas/manifest-v2.ts`
- Create manifest parser that validates against new schema
- Add schema documentation

### Phase 2: Parser Migration (3-4 days)
- Update `DeployerService.renderManifest()` to use new schema
- Update `PipelineExpanderService` for new pipeline syntax
- Update API manifest sync endpoint

### Phase 3: Test Migration (2 days)
- Update all test fixtures to new format
- Update E2E tests

### Phase 4: Documentation (1-2 days)
- Update `docs/system/manifest.md` with new format
- Update skill `eve-manifest-authoring`
- Add migration guide

### Files to Change

| File | Change |
|------|--------|
| `packages/shared/src/schemas/manifest.ts` | Replace with v2 schema |
| `apps/worker/src/deployer/deployer.service.ts` | Update manifest parsing |
| `apps/api/src/pipelines/pipeline-expander.service.ts` | Update pipeline parsing |
| `docs/system/manifest.md` | Rewrite for v2 |
| `.eve/manifest.yaml` (dogfood) | Migrate to v2 |
| `tests/fixtures/**/*.yaml` | Migrate all fixtures |

---

## Example: Complete Real-World Manifest

```yaml
version: "3.8"
name: fullstack-example

services:
  db:
    image: postgres:16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: app
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "app"]
      interval: 5s
      retries: 5

  api:
    build:
      context: ./apps/api
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgres://app:${DB_PASSWORD}@db:5432/app
      JWT_SECRET: ${JWT_SECRET}
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]

  web:
    build:
      context: ./apps/web
    ports:
      - "80:80"
    environment:
      API_URL: http://api:3000
    depends_on:
      - api

volumes:
  db-data:

x-eve:
  registry:
    host: ghcr.io
    namespace: example
    auth:
      username: ${GHCR_USERNAME}
      token: ${GHCR_TOKEN}

  secrets:
    DB_PASSWORD: ${secret.DB_PASSWORD}
    JWT_SECRET: ${secret.JWT_SECRET}
    RDS_URL: ${secret.RDS_URL}
    GHCR_USERNAME: ${secret.GHCR_USERNAME}
    GHCR_TOKEN: ${secret.GHCR_TOKEN}

  ingress:
    domain: lvh.me
    expose: [api, web]

  clusters:
    prod:
      # Hardened prod cluster that only deploys runtime services
      allow_workers: false
      allow_jobs: false

environments:
  test:
    x-eve:
      namespace: eve-fstack-test

  production:
    services:
      db:
        # Use external RDS in prod; overrides base service
        x-eve:
          external: true
          connection_url: ${secret.RDS_URL}
      api:
        replicas: 3
        environment:
          DATABASE_URL: ${secret.RDS_URL}
          NODE_ENV: production
      web:
        replicas: 3
    x-eve:
      cluster: prod
      namespace: fstack-prod
      ingress:
        domain: fstack.example.com
      approval: required

pipelines:
  deploy-test:
    trigger:
      github:
        event: push
        branch: main
    steps:
      - name: build
        action: build
      - name: test
        script: pnpm test
      - name: release
        action: release
        depends_on: [build, test]
      - name: deploy
        action: deploy
        depends_on: [release]
        target: test

workflows:
  nightly-audit:
    db_access: read_only
    steps:
      - agent:
          prompt: "Audit error logs and summarize anomalies"
```

---

## Benefits

1. **Familiar Syntax**: Any developer who knows docker-compose can read/write Eve manifests
2. **Local Dev Parity**: The manifest is valid docker-compose for local development
3. **Clear Boundaries**: `services` = standard compose, `x-eve` = deployment extensions
4. **No Ambiguity**: Build vs image, environment overrides, all explicit
5. **Extensible**: `x-eve` namespace allows future features without breaking compose compatibility
6. **Simpler Code**: Parser can leverage existing compose parsing libraries

---

## Open Questions

1. **Should we support compose `profiles`?** Could map to Eve environment variants.
2. **Networks section?** K8s networking differs significantly. May skip or stub.
3. **Compose file references?** `extends` and file includes could simplify multi-env setups.
4. **Secrets management?** Current `${secret.X}` syntax vs compose `secrets` section.

---

## Related Documents

- [Current Manifest Spec](../system/manifest.md)
- [Docker Compose Specification](https://docs.docker.com/compose/compose-file/)
- [Pipelines vs Workflows](./pipelines-vs-workflows.md)
