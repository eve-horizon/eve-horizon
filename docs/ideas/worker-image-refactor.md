# Worker Image Refactor: Base Contract + Variant Matrix

> **Idea / Draft**: Proposed refactor for Eve worker images and their build/publish flow.
> Status: Idea
> Last Updated: 2026-01-20

## Goal

Make worker images:
- **Deterministic** (run-as user, writable paths, stable caches).
- **Composable** (standard base + variant matrix + "full" image).
- **Fast to iterate** (rebuild only what changed, cache aggressively).
- **Obvious for downstream projects** (simple Dockerfile + CI template).

## Non-Goals

- Dynamic runtime installs in production (no network at job start).
- Complex plugin registry (optional later).
- Backward compatibility with legacy images (pre-deployment phase).

---

## Base Contract (Required for All Worker Images)

**Run-as user**
- All agent processes run as the same non-root user.
- Default: `uid=1000`, `gid=1000` (matches existing `node` user).
- Build can run as root; runtime must not.

**Required env**
```
EVE_RUN_AS_UID=1000
EVE_RUN_AS_GID=1000
EVE_HOME=/home/node
EVE_WORKSPACE_ROOT=/opt/eve/workspaces
EVE_CACHE_ROOT=/opt/eve/cache
EVE_STATE_ROOT=/opt/eve/state
EVE_TOOLCHAIN_ROOT=/opt/eve/toolchains
```

**Cache routing (no writes outside writable roots)**
```
XDG_CACHE_HOME=/opt/eve/cache
XDG_CONFIG_HOME=/home/node/.config
NPM_CONFIG_CACHE=/opt/eve/cache/npm
COREPACK_HOME=/opt/eve/cache/corepack
PNPM_HOME=/opt/eve/cache/pnpm
PIP_CACHE_DIR=/opt/eve/cache/pip
UV_CACHE_DIR=/opt/eve/cache/uv
CCACHE_DIR=/opt/eve/cache/ccache
```

**Writable paths (owned by run-as user)**
- `/opt/eve/workspaces`
- `/opt/eve/cache`
- `/opt/eve/state`
- `/opt/eve/toolchains`
- `$EVE_HOME/.config`, `$EVE_HOME/.cache`, `$EVE_HOME/.npm`, `$EVE_HOME/.local`

**Entrypoint preflight**
- Fail fast if any required directory is not writable.
- Ensure workspace root exists and is owned by the run-as user.
- Preserve existing credential bootstrap (Claude/Codex) and harness setup.

**K8s security context (runner pods)**
- Enforce `runAsUser`, `runAsGroup`, `fsGroup` for PVC write access.
- If the contract fails, the job fails immediately (no silent workarounds).

---

## Image Taxonomy

### 1) Base Runtime Image (canonical)
`eve-worker-base:<stack-version>`

Contents:
- Entry point + credential bootstrap.
- Eve worker runtime + CLIs (`eve-agent-cli`, `eve-worker`).
- Core harness tools (mclaude/zai/gemini/code/codex).
- Run-as user + cache routing + writable roots.

### 2) Variant Images (stack-specific)
`eve-worker-python:<stack-version>-py3.12`
`eve-worker-rust:<stack-version>-rust1.75`
`eve-worker-java:<stack-version>-jdk21`
`eve-worker-kotlin:<stack-version>-kotlin1.9-jdk21`

Contents:
- Base runtime + toolchain layer only.

### 3) Full Image (all normal stacks)
`eve-worker-full:<stack-version>`

Contents:
- Base runtime + python + rust + java + kotlin in a single image.

---

## Dockerfile Layout (Multi-Target)

Single Dockerfile with targets so CI and dev can build only what is needed.

```dockerfile
FROM eve-worker-base:stable AS base

FROM base AS python
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3.12 python3.12-venv \
  && rm -rf /var/lib/apt/lists/*
USER node

FROM base AS rust
USER root
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
RUN chown -R node:node /home/node/.cargo /home/node/.rustup
USER node

FROM base AS java
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-21-jdk \
  && rm -rf /var/lib/apt/lists/*
USER node

FROM base AS kotlin
USER root
# Install Kotlin compiler + Gradle (pinned versions)
USER node

FROM base AS full
USER root
# Install python + rust + java + kotlin here
USER node
```

Notes:
- Base image publishes the worker runtime and entrypoint.
- Variants should add only toolchains; no runtime duplication.
- Use BuildKit cache mounts for `apt` and `pnpm` to speed rebuilds.

---

## Runtime Selection (Worker Types + Runner Image)

- `hints.worker_type` selects the worker service (routing via `EVE_WORKER_URLS`).
- Each worker service sets its own `EVE_RUNNER_IMAGE`:
  - `default-worker` -> `eve-worker-full`
  - `python-worker` -> `eve-worker-python`
  - `rust-worker` -> `eve-worker-rust`

Example mapping:
```
EVE_WORKER_URLS=default-worker=http://worker-full:4811,python-worker=http://worker-python:4811
```

---

## CI Publish Plan

**Tag scheme**
- `:sha-<short>` for traceability.
- `:<stack-version>` for release consumers.
- Variants append toolchain version (e.g., `py3.12`).

**Matrix build**
- Build and push `base`, all variants, and `full`.
- Use `buildx` + registry cache to avoid rebuilding toolchain layers.
- Restrict workflow paths so orchestrator-only changes do not trigger worker builds.

Pseudo-matrix:
```
base
python   -> tag: py3.12
rust     -> tag: rust1.75
java     -> tag: jdk21
kotlin   -> tag: kotlin1.9-jdk21
full     -> tag: full
```

---

## Dev Cycle Optimizations

**Only rebuild the variant you are using**
- `eh worker-image build --variant python`
- `eh k8s-image build --worker-only --variant python`

**Cache everything**
- BuildKit cache mounts for apt/pnpm.
- Push cache to registry on CI, pull locally.
- Keep toolchain layers isolated so app changes only rebuild the top layer.

**Avoid rebuilding when not needed**
- Orchestrator-only changes should not rebuild worker images.
- Use Docker Compose dev target (`start:dev`) to avoid image rebuild for local work.

**Fast k8s refresh**
- Use `k3d image import` on the single updated image.
- Avoid full stack rebuild; restart only the worker deployment.

---

## Implementation Phases

1) **Base contract**
   - Update entrypoint to enforce writable paths and cache routing.
   - Add `securityContext` to runner pods and worker deployments.
   - Document contract.

2) **Variant matrix**
   - Refactor Dockerfile into targets.
   - Publish base + variants + full.
   - Wire worker types to variant images.

3) **Dev tooling**
   - Add `eh worker-image` commands for variant builds.
   - Update `k8s-image` helpers to support `--variant` and `--worker-only`.

---

## Open Questions

- Default worker image: `full` or `base`?
- Where to pin toolchain versions (Dockerfile vs manifest)?
- Should `toolchains` be a manifest field for validation?
- Do we want a registry of prebuilt variants for downstream projects?
