# Worker Image Refactor Implementation Plan

> Plan (Proposed)
> Last Updated: 2026-01-21

## References

- `docs/ideas/worker-image-refactor.md` (source ideas)
- `apps/worker/Dockerfile` (current worker image)
- `docker/worker/entrypoint.sh` (credential bootstrap + preflight target)
- `apps/worker/src/invoke/k8s-runner.ts` (runner pod manifest)
- `k8s/base/worker-deployment.yaml` (worker service + EVE_RUNNER_IMAGE)
- `docs/system/worker-types.md` (routing model)

## Goals

- Deterministic worker images with enforced writable roots and cache routing.
- Multi-target Dockerfile for base + variants + full image.
- GHCR publish pipeline with traceable tags and release tags.
- Local dev tooling for fast variant builds and k3d import.
- Clear verification steps using `gh` CLI for every tag release.

## Non-goals

- Runtime toolchain installs during job execution.
- Compatibility with legacy worker images (pre-deployment phase).
- New registry or plugin system beyond GHCR publishing.

## Target State Summary

**Image taxonomy (GHCR):**
- `ghcr.io/eve-horizon/worker-base:<stack-version>`
- `ghcr.io/eve-horizon/worker-python:<stack-version>-py3.12`
- `ghcr.io/eve-horizon/worker-rust:<stack-version>-rust1.75`
- `ghcr.io/eve-horizon/worker-java:<stack-version>-jdk21`
- `ghcr.io/eve-horizon/worker-kotlin:<stack-version>-kotlin1.9-jdk21`
- `ghcr.io/eve-horizon/worker-full:<stack-version>`

**Default pool (global):**
- `default-worker` routes to `eve-worker-full` for all orgs by default.
- Variant workers (python/rust/java/kotlin) remain optional global pools.

**Worker pool modes:**
- a) Global shared workers (each required type).
- b) Org-scoped worker pools (each required type).
- c) Mixed: orgs default to global pool, opt into org pool via org setting.

**Org enforcement (optional):**
- Org can opt into org-scoped pools; hard-reject job hints that target global pools.
- Default global pool remains available for all orgs without opt-in.

**Required env (baked into image):**
- `EVE_RUN_AS_UID=1000`, `EVE_RUN_AS_GID=1000`
- `EVE_HOME=/home/node`
- `EVE_WORKSPACE_ROOT=/opt/eve/workspaces`
- `EVE_CACHE_ROOT=/opt/eve/cache`
- `EVE_STATE_ROOT=/opt/eve/state`
- `EVE_TOOLCHAIN_ROOT=/opt/eve/toolchains`

**Cache routing (baked into image):**
- `XDG_CACHE_HOME=/opt/eve/cache`
- `XDG_CONFIG_HOME=/home/node/.config`
- `NPM_CONFIG_CACHE=/opt/eve/cache/npm`
- `COREPACK_HOME=/opt/eve/cache/corepack`
- `PNPM_HOME=/opt/eve/cache/pnpm`
- `PIP_CACHE_DIR=/opt/eve/cache/pip`
- `UV_CACHE_DIR=/opt/eve/cache/uv`
- `CCACHE_DIR=/opt/eve/cache/ccache`

**Runtime behavior:**
- Entrypoint preflight fails fast if any required path is not writable.
- K8s runner pod `securityContext` enforces `runAsUser=1000`, `runAsGroup=1000`, `fsGroup=1000`.

## Implementation Plan

### Phase 0: Decisions and Versioning

- Use git tag versioning for GHCR tags:
  - `worker-images/vX.Y.Z` -> `stack-version=X.Y.Z`.
- Pin toolchain versions and record in the Dockerfile stage comments.
- Default worker image is `full` for k8s + docker global pools.

### Phase 1: Base Contract + Entrypoint Preflight

**Files:**
- `apps/worker/Dockerfile`
- `docker/worker/entrypoint.sh`
- `packages/shared/src/config/schema.ts`
- `apps/worker/src/invoke/k8s-runner.ts`

**Changes:**
- Set required env in the image (`EVE_*` and cache routing vars).
- Create required directories:
  - `/opt/eve/workspaces`, `/opt/eve/cache`, `/opt/eve/state`, `/opt/eve/toolchains`
  - `$EVE_HOME/.config`, `.cache`, `.npm`, `.local`, `.claude`, `.cc-mirror`, `.code`, `.codex`
- Entrypoint preflight:
  - Verify each required path is writable.
  - If `EVE_WORKSPACE_ROOT` is set, create it and verify ownership.
  - Map `EVE_WORKSPACE_ROOT` to existing `WORKSPACE_ROOT` config for compatibility.
  - Fail fast (non-zero exit) on any permission issue.
- Keep credential bootstrap (Claude/Codex) and `cc-mirror` variant install.

### Phase 2: Multi-Target Worker Dockerfile

**Files:**
- `apps/worker/Dockerfile`

**Changes:**
- Restructure Dockerfile to provide targets:
  - `runtime-base` (worker runtime + harness tools + entrypoint)
  - `python`, `rust`, `java`, `kotlin` (toolchain-only layers)
  - `full` (all toolchains)
  - `production` (alias of `full`)
- Add BuildKit cache mounts for `apt` and `pnpm`.
- Isolate toolchain installs to avoid rebuilding base on code changes.
- Ensure all targets retain the base contract env and entrypoint.

### Phase 3: Runner Pod Security Context + Env Alignment

**Files:**
- `apps/worker/src/invoke/k8s-runner.ts`
- `k8s/base/worker-deployment.yaml`
- `k8s/base/worker-rbac.yaml` (if needed for new SA usage)

**Changes:**
- Add `securityContext` to runner pod spec:
  - `runAsUser=1000`, `runAsGroup=1000`, `fsGroup=1000`
  - `fsGroupChangePolicy=OnRootMismatch`
- Ensure runner pod mounts workspace at `/opt/eve/workspaces` and aligns `EVE_WORKSPACE_ROOT`.
- Add `EVE_RUN_AS_UID`, `EVE_RUN_AS_GID`, `EVE_WORKSPACE_ROOT` to env entries if not baked in.
- Validate that worker deployments set `EVE_RUNNER_IMAGE` explicitly and default to `full` or `base`.

### Phase 4: Worker Type Routing for Variants

**Files:**
- `k8s/base/worker-deployment.yaml`
- `k8s/base/worker-service.yaml`
- `docker/compose/docker-compose.yml`
- `apps/orchestrator/src/worker/worker.service.ts` (only if routing changes are needed)
- `docs/system/worker-types.md`

**Changes:**
- Define worker services per variant (e.g., `worker-full`, `worker-python`).
- Map `default-worker` to `worker-full` in `EVE_WORKER_URLS`.
- Set each worker service `EVE_RUNNER_IMAGE` to its matching variant image.
- Update `EVE_WORKER_URLS` in orchestrator deployment for routing by `hints.worker_type`.
- For Docker Compose, add optional variant worker services for local testing.

### Phase 5: Org Worker Pooling (Multi-tenant Sandboxing)

**Files:**
- `packages/db/migrations/00012_add_org_worker_pool.sql` (new)
- `packages/db/src/queries/orgs.ts`
- `packages/shared/src/schemas/org.ts`
- `apps/api/src/orgs/orgs.service.ts`
- `apps/api/src/jobs/jobs.service.ts`
- `apps/orchestrator/src/loop/loop.service.ts`
- `apps/orchestrator/src/worker/worker.service.ts`
- `apps/worker/src/invoke/invoke.service.ts`
- `k8s/base/worker-deployment.yaml`
- `k8s/base/worker-rbac.yaml`
- `k8s/base/namespace.yaml`
- `docs/system/worker-types.md`

**Changes:**
- Data model:
  - Add `worker_pool` to `orgs` (nullable), values: `global` or `org`.
  - Default: `global` (shared pools) when unset.
- API + CLI:
  - Expose `worker_pool` on org create/update and response schemas.
  - Add CLI flag: `eve org update --worker-pool <global|org>`.
- Orchestrator enforcement:
  - Resolve effective pool per job (lookup org via project).
  - Worker type selection:
    - `global`: use `job.hints.worker_type` or `default-worker`.
    - `org`: map to org-scoped worker type name (naming scheme below).
  - If job hints target global workers while `worker_pool=org`, reject the job with a clear error.
- Worker-side guard (defense-in-depth):
  - Add env `EVE_ALLOWED_ORG_IDS` (comma-separated).
  - On invoke, resolve project -> org and fail immediately if not allowed.
- K8s worker pools:
  - Create per-org worker deployments + services for required types.
  - Naming scheme (proposal): `org-<org_id>-<type>` where `<type>` is `default-worker`, `python-worker`, etc.
  - Prefer per-tenant namespaces for strong isolation:
    - Namespace: `eve-org-<org_id>`.
    - Worker runs in that namespace with scoped RBAC.
    - `EVE_K8S_NAMESPACE` set to that namespace so runner pods stay isolated.
  - Default global pool remains in `eve` namespace for orgs with `worker_pool=global`.

### Phase 6: CI Publish to GHCR (GitHub Actions)

**Files:**
- `.github/workflows/worker-images.yml` (new)

**Workflow outline:**
- Trigger:
  - `push` tags: `worker-images/v*`
  - `workflow_dispatch` (manual)
- Permissions:
  - `contents: read`
  - `packages: write`
- Steps:
  1. Checkout
  2. `docker/setup-buildx-action`
  3. `docker/login-action` to `ghcr.io` (use `GITHUB_TOKEN`)
  4. Matrix build for targets: `runtime-base`, `python`, `rust`, `java`, `kotlin`, `full`
  5. Tag scheme:
     - `sha-<short>` for traceability
     - `<stack-version>` (from tag)
     - `:<stack-version>-<variant>` for variants
  6. Build cache:
     - `cache-from: type=registry,ref=ghcr.io/eve-horizon/worker-cache:<target>`
     - `cache-to: type=registry,ref=ghcr.io/eve-horizon/worker-cache:<target>,mode=max`

**Stack version extraction (example):**
- Tag name: `worker-images/v1.2.3`
- `stack-version`: `1.2.3`

### Phase 7: Dev Tooling Updates

**Files:**
- `bin/eh-commands/worker-image.sh` (new)
- `bin/eh-commands/k8s-image.sh`
- `bin/eh` (command registration)

**Changes:**
- Add `eh worker-image build --variant <name>` to build a single target.
- Add `eh worker-image import --variant <name>` to k3d import.
- Extend `eh k8s-image` with:
  - `--worker-only`
  - `--variant <name>`
- Keep default behavior unchanged (`build` still builds api/orchestrator/worker).

### Phase 8: Documentation Updates

**Files:**
- `docs/system/harness-execution.md`
- `docs/system/worker-types.md`
- `docs/system/cli-tools-and-credentials.md`
- `docs/system/deployment.md`

**Changes:**
- Document base contract, env defaults, and cache routing.
- Record new worker image taxonomy and variant mapping.
- Update deployment notes for GHCR images and tag usage.

## Release + Verification with `gh` CLI

**Tag and publish:**
```bash
git tag worker-images/v1.2.3
git push origin worker-images/v1.2.3
```

**Watch the workflow:**
```bash
gh run list --workflow worker-images.yml --limit 1
gh run watch <run-id> --exit-status
```

**Verify GHCR tags per image:**
```bash
# Base image
gh api /orgs/eve-horizon/packages/container/worker-base/versions --paginate \
  --jq '.[] | .metadata.container.tags[]' | rg '^1.2.3$'

# Variant image (example: python)
gh api /orgs/eve-horizon/packages/container/worker-python/versions --paginate \
  --jq '.[] | .metadata.container.tags[]' | rg '^1.2.3-py3.12$'

# Full image
gh api /orgs/eve-horizon/packages/container/worker-full/versions --paginate \
  --jq '.[] | .metadata.container.tags[]' | rg '^1.2.3$'
```

**Verify sha tag exists:**
```bash
gh api /orgs/eve-horizon/packages/container/worker-base/versions --paginate \
  --jq '.[] | .metadata.container.tags[]' | rg '^sha-[0-9a-f]+$'
```

## Testing and Validation

- Local build:
  - `eh worker-image build --variant python`
  - `eh k8s-image import --variant python`
- K8s:
  - `./bin/eh k8s deploy`
  - Run `./bin/eh test integration` (default runtime)
  - Ensure runner pod fails fast on permission errors.
- Docker Compose:
  - `./bin/eh start docker`
  - Create a job with `--worker-type python-worker` and verify routing.
- Enforcement:
  - Set `worker_pool=org` on an org.
  - Create a job with a conflicting `--worker-type` and verify rejection.
  - Ensure worker guard blocks invocations outside allowed org list.

## File Checklist

- [ ] `apps/worker/Dockerfile` (multi-target + contract env)
- [ ] `docker/worker/entrypoint.sh` (preflight + env alignment)
- [ ] `apps/worker/src/invoke/k8s-runner.ts` (securityContext + env)
- [ ] `k8s/base/worker-deployment.yaml` (variant mapping)
- [ ] `docker/compose/docker-compose.yml` (variant workers)
- [ ] `packages/db/migrations/00012_add_org_worker_pool.sql` (new)
- [ ] `packages/shared/src/schemas/org.ts` (worker_pool)
- [ ] `apps/api/src/orgs/*` (worker_pool fields)
- [ ] `apps/api/src/jobs/jobs.service.ts` (pool enforcement logic)
- [ ] `apps/orchestrator/src/loop/loop.service.ts` (worker type resolution)
- [ ] `apps/worker/src/invoke/invoke.service.ts` (allowed org guard)
- [ ] `bin/eh-commands/worker-image.sh` (new)
- [ ] `bin/eh-commands/k8s-image.sh` (variant flags)
- [ ] `.github/workflows/worker-images.yml` (GHCR publish)
- [ ] `docs/system/*` (contract + deployment docs)
