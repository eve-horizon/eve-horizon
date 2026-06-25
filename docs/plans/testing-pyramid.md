# Testing Pyramid Plan (K8s-First Runtime)

> **Plan (Historical)**: This plan may be partially or fully implemented.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

> Status: Plan
> Last Updated: 2026-01-18

This document defines the testing pyramid for Eve Horizon’s K8s-first runtime
and answers the open questions with concrete, opinionated choices. It aligns
with `docs/plans/runtime-k8s-final-design.md` and the pre‑MVP mandate to
simplify aggressively.

---

## Goals

1. **Unit tests** cover core logic for all services and shared packages.
2. **Integration tests** cover ~90% of system behavior using `pnpm dev` and
   a mock agent CLI with a real Postgres container.
3. Integration tests can **run inside an Eve job** in any K8s runtime
   (ephemeral or persistent), using **direct file access** to in‑repo example
   projects (no remote clone required when local access is available).
4. **Client-only E2E tests** exercise core happy paths against a real K8s stack
   using example Eve projects that live inside this repo, **preferably via
   direct file access**.
5. Example projects support **repo/branch/path overrides**, but **default to
   direct filesystem usage** for Tier 2/3/4 whenever possible.

---

## Testing Pyramid (Summary)

```
┌────────────────────────────────────────────────────────────┐
│ Tier 4: Client-only E2E (real K8s stack)                   │
│ - Uses example Eve projects (in this repo)                 │
│ - Real K8s stack (k3d/k3s/k8s)                              │
└────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────┐
│ Tier 3: Integration tests as Eve jobs (self-validation)    │
│ - Git-only repo clone                                      │
│ - Runs inside Eve job in any K8s runtime                   │
└────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────┐
│ Tier 2: Integration tests (local stack)                    │
│ - pnpm dev + stub harness + real postgres                  │
│ - The "90%" coverage tier                                  │
└────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────┐
│ Tier 1: Unit tests                                         │
│ - Isolated, fast, no infra                                 │
└────────────────────────────────────────────────────────────┘
```

---

## Tier 1: Unit Tests (Fast, Isolated)

**Purpose**: Verify pure logic, validators, and state transitions.

**Characteristics**:
- No DB, no network, no filesystem
- Target: <5ms per test
- Run in every PR

**Initial focus**:
- Job ID formatting and parsing
- Phase transition validation
- Gate acquisition / TTL logic
- Hook ordering logic

**Likely locations**:
- `apps/api/src/**/__tests__/*.test.ts`
- `apps/orchestrator/src/**/__tests__/*.test.ts`
- `apps/worker/src/**/__tests__/*.test.ts`
- `packages/shared/src/**/__tests__/*.test.ts`
- `packages/db/src/**/__tests__/*.test.ts`

**Command**:
```
pnpm test
```

---

## Tier 2: Integration Tests (Local Stack)

**Purpose**: Cover the majority of system behavior with real Postgres and stub
agent CLIs, without K8s.

**Current base**: `./bin/eh test e2e` (dev stack) with `eve_test` database.

**Characteristics**:
- Real Postgres container
- Stub harnesses (`tests/fixtures/bin/*`)
- Local services via `pnpm dev`

**Target**: 90% of functionality coverage.

**Command**:
```
./bin/eh test e2e
```

**Additions**:
- Use in‑repo example projects directly from the filesystem (no clone).
- Expand coverage around services provisioning, gates, workspace reuse, and
  hook execution order.

---

## Tier 3: Integration Tests as Eve Jobs (Dogfooding)

**Purpose**: Validate that Eve can run its own integration tests as a job in
any K8s runtime. This is the canonical self-validation loop.

**How it works**:
1. Eve job uses **direct file access** to the example projects in this repo
   when running in local/dev K8s (k3d) or other environments where the
   filesystem is available to the runner.
2. Job runs integration tests against those example projects.
3. Job status reflects test success/failure.

**Required repo contract**:
```
.eve/
  project.yaml  # legacy (deprecated)
  workflows/
    integration-test/
      SKILL.md
```

**Example workflow (concept)**:
```
name: eve-horizon__integration-test
description: Run Eve Horizon integration tests

Steps:
  1. pnpm install
  2. ./bin/eh test e2e --env dev
```

**Why this choice**:
- It exercises the real K8s execution path while reusing the same integration
  test suite as local dev.
- It keeps pre‑MVP simplicity: one test suite, two execution contexts.
- It avoids remote pushes for routine dev and self-validation loops.

---

## Tier 4: Client-Only E2E (Real K8s Stack)

**Purpose**: End-to-end happy-path flows against a real deployed K8s stack.

**Strategy**:
- Keep these tests “client-only”: they talk to the live API/worker and do not
  exec inside the cluster.
- Use example Eve projects stored in this repo for predictable scenarios.
- Prefer **direct filesystem access** to those example projects wherever the
  test runner has access to the repo checkout.

**Example projects (in-repo)**:
```
tests/fixtures/repos/
  e2e-project/       # basic job lifecycle
  e2e-hooks/         # hook execution order
  e2e-services/      # manifest services injection
  e2e-gates/         # gate acquisition + TTL
  e2e-workflows/     # workflow triggers
```

**Why in-repo**:
- Simplest pre‑MVP path (no external repo management)
- Versioned alongside test code
- Enables path override to target subprojects

---

## Decisions (Open Questions Answered)

### 1. Private Git Repo Authentication (K8s runtime)

**Decision**: Use SSH deploy keys stored in K8s Secrets **only as a fallback**
when direct filesystem access is not available.

**Why**:
- Direct filesystem access is the preferred pre‑MVP path (fast, no pushes).
- SSH deploy keys are the simplest, least‑privileged fallback for non‑local
  K8s runtimes where local FS access is impossible.

**Fallback flow**:
```
1) Generate keypair (one-time):
   ssh-keygen -t ed25519 -C "eve-horizon-ci" -f ./eve_horizon_deploy_key

2) Add public key to repo as a deploy key (read-only).

3) Create K8s secret:
   kubectl create secret generic eve-git-ssh \
     --from-file=ssh-privatekey=./eve_horizon_deploy_key

4) Worker mounts secret into runner pod at /root/.ssh/id_ed25519
   and sets GIT_SSH_COMMAND="ssh -i /root/.ssh/id_ed25519 -o StrictHostKeyChecking=no".

5) Job uses git+ssh repo URL:
   git@github.com:eve-horizon/eve-horizon.git
```

**Notes**:
- Use `StrictHostKeyChecking=no` initially for simplicity; replace with known_hosts
  pinning when security hardening starts.

---

### 2. Test Database in K8s Jobs

**Decision**: Use **ephemeral Postgres via `.eve/manifest.yaml` services** for job-level
tests.

**Why**:
- Ensures test isolation per job
- Avoids coupling tests to cluster-wide Postgres state
- Matches the repo contract model (manifest services)

**Flow**:
```
.eve/manifest.yaml
services:
  - name: test-db
    image: postgres:16-alpine
    env:
      POSTGRES_USER: eve
      POSTGRES_PASSWORD: eve
      POSTGRES_DB: eve_test
    ready: pg_isready
    provides:
      DATABASE_URL: postgres://eve:eve@$HOST:$PORT/eve_test
```

---

### 3. Harness Authentication in CI / K8s

**Decision**: K8s Secret with environment variables injected into job runner.

**Why**:
- Standard K8s pattern
- Avoids direct `.env` distribution in repo
- Works for multiple providers

**Flow**:
```
kubectl create secret generic eve-runtime-secrets \
  --from-literal=ANTHROPIC_API_KEY=... \
  --from-literal=EVE_SECRETS_MASTER_KEY=... \
  --from-literal=EVE_INTERNAL_API_KEY=...

# project.yaml (legacy)
environments:
  staging:
    vars_from_secret: eve-runtime-secrets
```

---

### 4. Filesystem Mode for Tier 2/3/4

**Decision**: **Default to filesystem mode** wherever possible (local stack and
local k3d). Only use git clone when the runtime cannot access the repo files.

**Why**:
- Removes the need to push to remote during iteration
- Makes example projects the single source of truth across Tier 2/3/4
- Keeps the plan consistent with “examples in repo” as the canonical fixtures

**Flow (preferred)**:
```
EVE_E2E_LOCAL_FS=1 ./bin/eh test e2e --env stack

# Runner mounts hostPath (k3d) and uses local path directly
# No clone required
```

**Guardrails**:
- Allow filesystem mode only when the runner can see the repo (local dev)
- When not available, fall back to git clone with SSH deploy key

---

### 5. Example Projects: In-repo vs External

**Decision**: Keep example projects in-repo for now.

**Why**:
- Simplest pre‑MVP path
- Versioned alongside tests
- Enables repo/branch/path overrides without extra repos

---

## Repo/Branch/Path Overrides (E2E)

**Environment Variables**:
```
EVE_E2E_EXAMPLE_REPO_URL=https://github.com/eve-horizon/eve-horizon-fullstack-example
EVE_E2E_EXAMPLE_REPO_BRANCH=main
EVE_E2E_REPO_PATH=tests/fixtures/repos/e2e-project
```

**Flow**:
1. If filesystem mode is enabled and the repo exists locally, the runner uses
   the local checkout directly.
2. Otherwise, the runner clones `EVE_E2E_EXAMPLE_REPO_URL` + `EVE_E2E_EXAMPLE_REPO_BRANCH`.
3. Runner changes into `EVE_E2E_REPO_PATH` before invoking tests.
4. Example project is treated as the root of the Eve repo contract.

---

## Implementation Steps (High-Level)

1. Add unit test suites for core logic across services and shared packages.
2. Expand local integration tests to cover services, gates, hooks, and reuse.
3. Add `.eve/manifest.yaml` + integration-test workflow for self-validation tests.
4. Create example projects under `tests/fixtures/repos/`.
5. Add repo/branch/path overrides to e2e runner.
6. Add local filesystem mode for k3d only.

---

## Validation Checklist

- Unit tests pass in CI and locally.
- `./bin/eh test e2e` passes with stub harness and real Postgres.
- Integration tests run as an Eve job in a K8s runtime using private git repo.
- Client-only E2E passes against deployed K8s stack using in-repo example projects.
- Local filesystem mode works in k3d and is rejected elsewhere.
