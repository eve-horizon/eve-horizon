# Worker Types

> Status: Current
> Last Updated: 2026-01-21
> Purpose: Document how to add and select worker types (e.g., Playwright).

## Overview

Eve Horizon supports multiple worker types. Each job can request a worker by name via
`hints.worker_type`, and the orchestrator routes the job to the correct worker using the
`EVE_WORKER_URLS` mapping.

Worker images are available in multiple variants with different toolchain combinations,
allowing jobs to use optimized images based on their language requirements.

## Worker Image Variants

Eve Horizon provides multiple pre-built worker images with different toolchain combinations.
All images are published to public ECR and versioned using git tags.

### Image Taxonomy

The following worker images are available:

| Image | ECR Path | Description |
|-------|-----------|-------------|
| **base** | `public.ecr.aws/w7c4v0w3/eve-horizon/worker-base:<version>` | Runtime without toolchains - Node.js, worker harness, and base utilities only |
| **python** | `public.ecr.aws/w7c4v0w3/eve-horizon/worker-python:<version>-py3.11` | Python 3.11, pip, uv package manager |
| **rust** | `public.ecr.aws/w7c4v0w3/eve-horizon/worker-rust:<version>-rust1.75` | Rust 1.75 via rustup, cargo |
| **java** | `public.ecr.aws/w7c4v0w3/eve-horizon/worker-java:<version>-jdk21` | OpenJDK 21 |
| **kotlin** | `public.ecr.aws/w7c4v0w3/eve-horizon/worker-kotlin:<version>-kotlin2.0-jdk21` | Kotlin 2.0 + OpenJDK 21 |
| **full** | `public.ecr.aws/w7c4v0w3/eve-horizon/worker-full:<version>` | All toolchains combined |

**Versioning**: Images are tagged with the stack version (e.g., `0.1.0`) and language-specific
suffixes for variant images. Tags follow the format `worker-images/vX.Y.Z` in git.

**Default image**: The `full` variant is used by default for local development. Override via
`EVE_WORKER_VARIANT` environment variable (e.g., `EVE_WORKER_VARIANT=base` for a slimmer image).

## Worker Type Routing

### How Jobs Get Routed to Workers

Jobs are routed to specific worker images based on the `hints.worker_type` field in job
creation requests. The orchestrator uses `EVE_WORKER_URLS` to map worker type names to
worker service URLs.

**Default routing configuration:**

```env
EVE_WORKER_URLS=default-worker=http://worker:4811,python-worker=http://worker-python:4811,rust-worker=http://worker-rust:4811
```

**Worker type to image mapping:**

| Worker Type | Routes To | Image Used |
|-------------|-----------|------------|
| `default-worker` | `worker` service | `eve-worker-base` (or per `EVE_WORKER_VARIANT`) |
| `python-worker` | `worker-python` service | `eve-worker-python` |
| `rust-worker` | `worker-rust` service | `eve-worker-rust` |
| `java-worker` | `worker-java` service | `eve-worker-java` |
| `kotlin-worker` | `worker-kotlin` service | `eve-worker-kotlin` |

**Job hint usage:**

- **Job field**: `hints.worker_type` (string) in job create requests.
- **Default**: If no `worker_type` is provided, the orchestrator uses `default-worker`
  (or falls back to `WORKER_URL`).
- **Example**: `eve job create --project proj_xxx --description "Run Python tests" --worker-type python-worker`

**Validation**: If a job specifies a worker type that is not in `EVE_WORKER_URLS`, the job
fails early with a clear error message.

## Environment Contract

All worker images enforce a deterministic environment contract to ensure consistent
behavior across local development, Kubernetes, and Docker Compose deployments.

### Required Environment Variables

These variables are baked into all worker images:

**User and ownership:**
- `EVE_RUN_AS_UID=1000` - User ID for running processes
- `EVE_RUN_AS_GID=1000` - Group ID for running processes

**Directory structure:**
- `EVE_HOME=/home/node` - Home directory for the node user
- `EVE_WORKSPACE_ROOT=/opt/eve/workspaces` - Root for all workspace mounts
- `EVE_CACHE_ROOT=/opt/eve/cache` - Root for all cache directories
- `EVE_STATE_ROOT=/opt/eve/state` - Root for persistent state
- `EVE_TOOLCHAIN_ROOT=/opt/eve/toolchains` - Root for installed toolchains

### Cache Routing Variables

These variables redirect tool-specific caches to the shared cache root:

**General:**
- `XDG_CACHE_HOME=/opt/eve/cache` - XDG base directory for caches
- `XDG_CONFIG_HOME=/home/node/.config` - XDG base directory for configs

**JavaScript/Node.js:**
- `NPM_CONFIG_CACHE=/opt/eve/cache/npm` - npm package cache
- `COREPACK_HOME=/opt/eve/cache/corepack` - Corepack cache
- `PNPM_HOME=/opt/eve/cache/pnpm` - pnpm global store

**Python:**
- `PIP_CACHE_DIR=/opt/eve/cache/pip` - pip package cache
- `UV_CACHE_DIR=/opt/eve/cache/uv` - uv package manager cache

**C/C++:**
- `CCACHE_DIR=/opt/eve/cache/ccache` - ccache compiler cache

### Runtime Behavior

**Entrypoint preflight:**
- Verifies all required paths (`EVE_WORKSPACE_ROOT`, `EVE_CACHE_ROOT`, etc.) are writable
- Fails fast with a non-zero exit code if any permission check fails
- Reports AI credential availability. Codex auth may use configured auth files; Claude setup-token credentials are materialized per attempt under `EVE_JOB_USER_HOME`, not globally.

**Per-step toolchain cache:**
- Manifest `toolchains` on workflow/pipeline script steps and pipeline
  `action: { type: run }` steps are resolved to `jobs.hints.toolchains`.
- The worker script/action-run executors materialize each requested toolchain
  into `EVE_TOOLCHAIN_ROOT` with `crane export` from
  `${EVE_TOOLCHAIN_IMAGE_PREFIX}<name>:${EVE_TOOLCHAIN_IMAGE_TAG}`.
- The installed toolchain `env.sh` is sourced for the launched bash process, so
  `PATH`, `JAVA_HOME`, `CARGO_HOME`, `PYTHONPATH`, `LD_LIBRARY_PATH`, and other
  exported values apply only to that step.
- On local k3d, `eh k8s-image push-toolchains` imports toolchain images into
  k3d and publishes them to `eve-registry.eve.svc.cluster.local:5000` for
  worker-side `crane export`.

**Script/action-run execution:**
- Worker script jobs and pipeline `action: { type: run }` jobs are accepted via
  short HTTP requests, then executed in the worker background.
- The worker emits `runner.started`, `runner.completed`, and `runner.failed`
  events; the orchestrator polls those events rather than holding the submit
  request open for the full command duration.
- Bash stdout/stderr are streamed into `execution_logs` while the command is
  running. The worker keeps bounded output tails for the final result payload
  and emits one truncation warning per stream after `EVE_SCRIPT_OUTPUT_CAP_BYTES`
  is reached.
- Script jobs enforce `script_timeout_seconds`; action-run jobs enforce
  `action.timeout_seconds` / `action.timeout`, then `hints.timeout_seconds`,
  then the platform default.

**Kubernetes security context:**
Runner pods are created with the following security context to enforce the user/group contract:

```yaml
securityContext:
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
  fsGroupChangePolicy: OnRootMismatch
```

This ensures volume mounts have correct ownership and all processes run as the `node` user.

## Add a New Worker Type

1) **Add a worker service (K8s default)**
   - Duplicate the worker deployment and service in `k8s/base/worker.yaml`.
   - Give it a new name (e.g., `worker-playwright`) and a unique service port.
   - If you need a different base image, set it via env (e.g., `WORKER_BASE_IMAGE=mcr.microsoft.com/playwright:latest`).
   - Apply updates through `k8s/overlays/local` for local testing.

   **Quick dev loop (Docker Compose)**
   - Duplicate the `worker` service in `docker/compose/docker-compose.yml`.
   - Give it a new name (e.g., `worker-playwright`) and a unique port.

2) **Update routing map**
   - In the `orchestrator` service, update `EVE_WORKER_URLS` to include the new worker.

3) **Create a job targeting the worker**
   - Example:
     `eve job create --project proj_xxx --description "Run UI checks" --worker-type playwright-worker`

## Building Worker Images Locally

Worker images can be built locally for development and testing purposes. The build system
supports building individual variants or all variants at once.

### Build a Single Variant

To build a specific worker image variant:

```bash
# Build the Python variant
eh worker-image build --variant python

# Build the Rust variant
eh worker-image build --variant rust

# Build the full variant (all toolchains)
eh worker-image build --variant full

# Build the base variant (no toolchains)
eh worker-image build --variant base
```

### Customizing AI Harnesses

By default, all AI harnesses are installed (Claude Code, Codex, Gemini, Code, etc.). For smaller
images, you can disable specific harnesses using build arguments:

```bash
# Build with only Claude Code (saves ~800MB)
eh worker-image build --variant full -- \
  --build-arg INSTALL_CODEX=false \
  --build-arg INSTALL_GEMINI=false \
  --build-arg INSTALL_CODE=false

# Build with Claude + Codex only
eh worker-image build --variant full -- \
  --build-arg INSTALL_GEMINI=false \
  --build-arg INSTALL_CODE=false
```

**Available harness flags** (all default to `true`):

| Flag | Package | Size |
|------|---------|------|
| `INSTALL_GEMINI` | `@google/gemini-cli` | ~440MB |
| `INSTALL_CODEX` | `@openai/codex` | ~355MB |
| `INSTALL_MIRROR` | `cc-mirror` | ~92MB |
| `INSTALL_CODE` | `@just-every/code` | ~88MB |
| `INSTALL_CLAUDE` | `@anthropic-ai/claude-code` | ~84MB |
| `INSTALL_BD` | `@beads/bd` | ~31MB |
| `INSTALL_SKILLS` | `skills` | ~4MB |

### Push Images to k3d (Local Kubernetes)

After building, import images into your local k3d cluster:

```bash
# Push only worker images (all variants)
eh k8s-image push --worker-only

# Push a specific worker variant
eh k8s-image push --worker-only --variant full

# Push all stack images including worker variants
eh k8s-image push
```

### Multi-Target Dockerfile

The worker Dockerfile uses BuildKit multi-stage builds to provide multiple targets:

- `runtime-base` - Worker runtime, harness tools, and entrypoint (no toolchains)
- `python` - Adds Python 3.11, pip, uv
- `rust` - Adds Rust via rustup
- `java` - Adds OpenJDK 21
- `kotlin` - Adds Kotlin 2.0 + OpenJDK 21
- `full` - Combines all toolchain layers
- `production` - Alias for `full` (used in deployments)

All targets inherit the base environment contract and entrypoint behavior.

## Notes

- All worker services must mount the same workspace and skill pack volumes.
- If a job specifies a worker that is not in `EVE_WORKER_URLS`, the job fails early.
- Docker Compose and k8s worker services use port 4811 by default.
- Worker images are published to ECR on git tag push (`worker-images/v*` pattern).
- Each variant is built independently to optimize build caching and image size.

## Validation Checklist

1) Start stack with default worker only:
   - `./bin/eh k8s start` (default runtime)
   - Optional quick dev loop: `./bin/eh start docker`
   - Create a job without `worker_type` and ensure it runs on the default worker.

2) Start stack with a secondary worker enabled:
   - Create a job with `--worker-type playwright-worker`.
   - Confirm the orchestrator routes to the correct worker URL.
