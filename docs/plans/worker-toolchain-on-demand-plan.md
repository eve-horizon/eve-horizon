# Worker Toolchain-on-Demand Plan

> **Status**: Implemented (2026-03-06, commit efb9e99)
> **Date**: 2026-03-06
> **Motivation**: Worker image is 2.6GB. Nodes with 20GB root volumes hit ephemeral-storage evictions during image pulls. Most agent jobs only need Node.js + harnesses (~800MB).
> **Scope**: Switch default worker to `base`, publish toolchain images, inject toolchains via init containers, add agent-level `toolchains` declarations

## Problem

The worker image ships every toolchain (Python, Rust, Java, Kotlin, ffmpeg, whisper.cpp) in a single 2.6GB `full` target. Both staging (`publish-images.yml`) and local k3d (`k8s-image.sh`) build `full` for every deploy. This causes:

1. **Disk pressure** — Kubernetes caches current + previous image versions. Two versions of a 2.6GB image consume 5.2GB on a 20GB node, leaving ~3GB for the OS, system images, and container writable layers. Kubelet GC thresholds can't keep up.
2. **Slow deploys** — 2.6GB pulls take ~45s even on fast connections. Most of that payload is unused by the job.
3. **All-or-nothing GC** — Kubelet can't reclaim individual toolchains. The entire 2.6GB blob either stays or goes.
4. **Wasted bandwidth** — A code review agent that only uses Claude Code still pulls Rust, Java, Kotlin, whisper models, and ffmpeg.

## Current Architecture

### Assumptions and Scope Boundaries
- Phase 1 and Phase 3 can be rolled out first as a low-risk baseline.
- Phases 2–6 should be implemented only after Phase 1 is validated in staging.
- Out of scope: full schema redesign of job/workflow models and non-worker runtime changes unless explicitly noted.
- `full` worker image availability is preserved for compatibility and can be selected via existing overrides.

### Dockerfile Multi-Target (Already Exists)

```
node-image → dependencies → build → runtime-setup → base
                                                       ├── media  (base + ffmpeg + whisper.cpp)
                                                       ├── python (base + python3 + pip + uv)
                                                       ├── rust   (base + rustup)
                                                       ├── java   (base + JDK 21)
                                                       ├── kotlin (java + kotlinc)
                                                       └── full   (media + python + rust + java + kotlin)
                                                            └── production (full + build metadata)
```

The multi-target structure is well-designed. The problem is that **only `full` is ever deployed**.

### Image Size Breakdown (Approximate)

| Target   | Size   | Contents                                                        |
|----------|--------|-----------------------------------------------------------------|
| `base`   | ~800MB | Node 22, git, gh, kubectl, kaniko, buildctl, harnesses (claude-code, codex, gemini-cli, cc-mirror, code, bd, skills) |
| `media`  | ~1.1GB | base + ffmpeg (~80MB) + whisper-cli (~5MB) + ggml-small.en model (~150MB) |
| `python` | ~900MB | base + python3, pip, venv, uv                                  |
| `rust`   | ~1.2GB | base + rustup, stable toolchain, rustfmt, clippy                |
| `java`   | ~1.1GB | base + Temurin JDK 21                                          |
| `kotlin` | ~1.2GB | java + kotlinc 2.0.21                                          |
| `full`   | ~2.6GB | Everything combined                                             |

`kotlin` remains a meaningful combination toolchain and should be explicitly handled in any matrix that publishes/uses toolchain images.

### Existing Routing Plumbing

The orchestrator already supports routing jobs to different worker images:

- `resolveWorkerImage()` in `apps/orchestrator/src/loop/loop.service.ts:2009` reads `hints.worker_type` from job, then checks `EVE_WORKER_URLS` mapping
- `EVE_WORKER_URLS` env var format: `worker-python=http://worker-python:4749,worker-media=http://worker-media:4749`
- `resolveWorkerUrl()` in `apps/orchestrator/src/worker/worker.client.ts:471` maps image names to worker URLs
- Runner pod manifests use `EVE_RUNNER_IMAGE` env var (`apps/worker/src/invoke/k8s-runner.ts:202`)

### Existing Toolchain Path Convention

The Dockerfile already defines `EVE_TOOLCHAIN_ROOT=/opt/eve/toolchains` (line 115) and creates the directory (line 228). This path was designed for on-demand toolchain mounting.

## Design

### Key Insight: Init Containers as Toolchain Installers

Instead of baking all toolchains into the runner image, **mount them from pre-built toolchain images at pod creation time** using Kubernetes init containers.

```
Runner Pod
├── Init: tc-python   → copies /toolchain/* to /opt/eve/toolchains/python/
├── Init: tc-media    → copies /toolchain/* to /opt/eve/toolchains/media/
└── Container: runner → base image + PATH includes /opt/eve/toolchains/*/bin
    └── Volume: toolchains (emptyDir)
```

Init containers use small, single-purpose images. If the image is already on the node, the init container finishes in under a second (just a `cp`). If not, it pulls only the toolchain needed (50-300MB), not the entire fat image.

### Why This Beats Fat Images

| Concern              | Fat Image (`full`)          | Init Container + Base              |
|----------------------|-----------------------------|------------------------------------|
| Node disk pressure   | 2.6GB cached per version    | 800MB base + 200MB per toolchain   |
| Cold pull time       | ~45s for 2.6GB              | ~15s for base + ~5s per toolchain  |
| Warm start           | Same (image cached)         | Same (images cached)               |
| Toolchain update     | Rebuild + repull entire 2.6GB | Repull only the changed toolchain |
| Unused toolchains    | Always on disk              | Never on disk unless used          |
| GC behavior          | 2.6GB all-or-nothing        | Small images GC'd independently    |

## Phases

### Phase 1: Switch Default to `base` (Quick Win)

Ship `base` as the default worker image. Most jobs don't use toolchains — they run Claude Code, Codex, or Gemini against a code repo. The `full` image stays available as an opt-in variant.

#### 1a. Staging CI: Build `base` as default worker

**File**: `.github/workflows/publish-images.yml`

Change the worker matrix entry:

```yaml
# Before:
- service: worker
  dockerfile: apps/worker/Dockerfile
  target: full
  image: worker

# After:
- service: worker
  dockerfile: apps/worker/Dockerfile
  target: base
  image: worker
```

The `worker-images.yml` workflow already publishes variant images (`worker-base`, `worker-python`, `worker-rust`, `worker-java`, `worker-kotlin`, `worker-full`) to ECR. Those remain unchanged.

> **Pre-existing issues in `worker-images.yml`** (fix alongside Phase 1):
> - The `worker-base` matrix entry uses `target: runtime-base`, but the Dockerfile stage is named `base` (line 266: `FROM runtime-setup AS base`). This should be corrected to `target: base`.
> - The matrix is missing a `worker-media` entry for the `media` Dockerfile target. This gap becomes moot with the toolchain-on-demand approach but should be noted.

#### 1b. Local k3d: Default to `base`

**File**: `bin/eh-commands/k8s-image.sh`

Change the default variant:

```bash
# Before (line 83):
STACK_WORKER_VARIANT="${EVE_WORKER_VARIANT:-full}"

# After:
STACK_WORKER_VARIANT="${EVE_WORKER_VARIANT:-base}"
```

Users who need `full` locally can set `EVE_WORKER_VARIANT=full` or use `--variant full`.

#### 1c. Verify base image has all harnesses

Confirm the `base` target includes all harness binaries (claude-code, codex, gemini-cli, cc-mirror, code, bd, skills). These are installed in `runtime-setup` which `base` inherits from, so they should already be present.

```bash
# After building base:
docker run --rm eve-horizon/worker-base:local which mclaude claude codex gemini code bd
```

**Acceptance**: All harness binaries resolve. A basic agent job (no toolchains) runs to completion on the base image.

### Phase 2: Toolchain Images

Build small, single-purpose container images that contain just the toolchain binaries and libraries at a known path (`/toolchain/`). These are not worker images — they're "payload" images consumed by init containers.

#### 2a. Create toolchain Dockerfiles

**Directory**: `docker/toolchains/`

Each toolchain image installs into `/toolchain/` with `bin/`, `lib/`, `share/` subdirectories.

**`docker/toolchains/python/Dockerfile`**:
```dockerfile
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv curl \
    && python3 -m pip install --break-system-packages uv \
    && rm -rf /var/lib/apt/lists/*

# Copy only python binaries and their required shared libraries (use ldd to verify).
# Copying all of /usr/lib would produce a multi-GB image. Target only:
#   - python3 interpreter + stdlib
#   - pip, venv, uv binaries
#   - shared libraries identified by: ldd /usr/bin/python3
RUN mkdir -p /toolchain/bin /toolchain/lib /toolchain/share \
    && cp -a /usr/bin/python3 /toolchain/bin/ \
    && cp -a /usr/bin/uv /toolchain/bin/ \
    && cp -a /usr/bin/pip3 /toolchain/bin/ \
    && cp -a /usr/lib/python3* /toolchain/lib/ \
    && cp -a /usr/share/python3 /toolchain/share/ 2>/dev/null || true

FROM debian:bookworm-slim
COPY --from=build /toolchain /toolchain
```

> **Implementation note**: The Python toolchain Dockerfile above is a sketch. During implementation, use `ldd` to identify the exact shared libraries needed and copy only those. Copying `/usr/lib` wholesale would produce an image larger than the `full` worker.

**`docker/toolchains/media/Dockerfile`**:
```dockerfile
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg git cmake make g++ curl ca-certificates \
    && git clone --depth 1 --branch v1.8.1 https://github.com/ggml-org/whisper.cpp /tmp/whisper \
    && cd /tmp/whisper \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF \
    && cmake --build build -j$(nproc) --target whisper-cli \
    && mkdir -p /toolchain/bin /toolchain/models \
    && cp build/bin/whisper-cli /toolchain/bin/ \
    && curl -L -o /toolchain/models/ggml-small.en.bin \
       https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin \
    && cp /usr/bin/ffmpeg /toolchain/bin/ \
    && cp /usr/bin/ffprobe /toolchain/bin/

    # Copy only the shared libraries required by ffmpeg and whisper-cli (use ldd to verify)
RUN mkdir -p /toolchain/lib \
    && for bin in /toolchain/bin/ffmpeg /toolchain/bin/ffprobe /toolchain/bin/whisper-cli; do \
         ldd "$bin" 2>/dev/null | awk '/=>/ {print $3}' | xargs -I{} cp -n {} /toolchain/lib/ 2>/dev/null || true; \
       done

FROM debian:bookworm-slim
COPY --from=build /toolchain /toolchain
```

**`docker/toolchains/rust/Dockerfile`**:
```dockerfile
FROM rust:slim-bookworm AS build
RUN rustup component add rustfmt clippy \
    && rustup component remove rust-docs \
    && mkdir -p /toolchain \
    && cp -a /usr/local/cargo /toolchain/cargo \
    && cp -a /usr/local/rustup /toolchain/rustup

FROM debian:bookworm-slim
COPY --from=build /toolchain /toolchain
```

**`docker/toolchains/java/Dockerfile`**:
```dockerfile
FROM eclipse-temurin:21-jdk-jammy AS build
RUN mkdir -p /toolchain && cp -a /opt/java/openjdk /toolchain/jdk

FROM debian:bookworm-slim
COPY --from=build /toolchain /toolchain
```

**`docker/toolchains/kotlin/Dockerfile`**:
```dockerfile
FROM eclipse-temurin:21-jdk-jammy AS build
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip \
    && mkdir -p /toolchain && curl -sSL https://github.com/JetBrains/kotlin/releases/download/v2.0.21/kotlin-compiler-2.0.21.zip -o /tmp/kotlin.zip \
    && mkdir -p /tmp/kotlin && unzip -q /tmp/kotlin.zip -d /tmp/kotlin \
    && mkdir -p /toolchain/kotlin /toolchain/jdk \
    && cp -a /tmp/kotlin/kotlinc/bin /toolchain/kotlin/ \
    && cp -a /tmp/kotlin/kotlinc/lib /toolchain/kotlin/ \
    && cp -a /opt/java/openjdk/* /toolchain/jdk/ \
    && rm -rf /tmp/kotlin /tmp/kotlin.zip \
    && rm -rf /var/lib/apt/lists/*

FROM debian:bookworm-slim
COPY --from=build /toolchain /toolchain
```

> **Note**: `kotlinc` requires a JDK at runtime (`kotlinc` invokes `java -jar ...`). The Kotlin toolchain image bundles its own JDK copy so it's self-contained. Its `env.sh` must set `JAVA_HOME=/opt/eve/toolchains/kotlin/jdk`. If both `java` and `kotlin` toolchains are mounted, `kotlin/env.sh` should take precedence (sourced after `java/env.sh` alphabetically).

#### 2b. CI workflow for toolchain images

**File**: `.github/workflows/toolchain-images.yml`

```yaml
name: Build Toolchain Images

on:
  push:
    tags: ['toolchain-images/v*']
    paths: ['docker/toolchains/**']
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        toolchain: [python, media, rust, java, kotlin]
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      # ECR login...
      - uses: docker/build-push-action@v5
        with:
          context: docker/toolchains/${{ matrix.toolchain }}
          push: true
          tags: ${{ env.ECR_REGISTRY }}/${{ env.ECR_NAMESPACE }}/toolchain-${{ matrix.toolchain }}:${{ steps.version.outputs.value }}
          platforms: linux/amd64,linux/arm64
```

Toolchain images are tagged independently from worker images. They change rarely (only when bumping Python version, Rust version, etc.).

#### 2c. Local k3d toolchain build support

**File**: `bin/eh-commands/k8s-image.sh`

Add a `--toolchains` flag or separate command to build and import toolchain images into k3d:

```bash
build_toolchain() {
  local name="$1"
  docker build -t "eve-horizon/toolchain-${name}:local" \
    -f "$REPO_ROOT/docker/toolchains/${name}/Dockerfile" \
    "$REPO_ROOT/docker/toolchains/${name}"
}
```

**Acceptance**: `docker images | grep toolchain` shows all five toolchain images. Confirm each payload is materially smaller than the full worker image and fits node cache budgets.

Import the built images into k3d when testing locally:

```bash
k3d image import \
  eve-horizon/toolchain-python:local \
  eve-horizon/toolchain-media:local \
  eve-horizon/toolchain-rust:local \
  eve-horizon/toolchain-java:local \
  eve-horizon/toolchain-kotlin:local
```

### Phase 3: Init Container Injection in Runner Pods

When the orchestrator creates a runner pod, inject init containers for each required toolchain.

#### 3a. Add `toolchains` to HarnessInvocation

**File**: `packages/shared/src/types/harness.ts`

```typescript
export interface HarnessInvocation {
  // ... existing fields ...
  toolchains?: string[];  // e.g. ['python', 'media']
}
```

#### 3b. Inject init containers in k8s-runner.ts

**File**: `apps/worker/src/invoke/k8s-runner.ts`

In `buildRunnerManifests()`, generate init containers from the `toolchains` array:

```typescript
const toolchains = invocation.toolchains ?? [];
const toolchainImagePrefix = process.env.EVE_TOOLCHAIN_IMAGE_PREFIX ?? 'eve-horizon/toolchain-';
const toolchainImageTag = process.env.EVE_TOOLCHAIN_IMAGE_TAG ?? 'local';

const initContainers = toolchains.map(tc => ({
  name: `tc-${tc}`,
  image: `${toolchainImagePrefix}${tc}:${toolchainImageTag}`,
  imagePullPolicy: 'IfNotPresent',
  command: ['sh', '-eux', '-c', `mkdir -p /opt/eve/toolchains/${tc} && cp -a /toolchain/. /opt/eve/toolchains/${tc}/`],
  volumeMounts: [{
    name: 'toolchains',
    mountPath: `/opt/eve/toolchains/${tc}`,
  }],
}));

// Extend PATH in runner container env
if (toolchains.length > 0) {
  const toolchainPaths = [...new Set(toolchains)].map(tc => `/opt/eve/toolchains/${tc}/bin`).join(':');
  envEntries.push({
    name: 'EVE_TOOLCHAIN_PATHS',
    value: toolchainPaths,
  });
}
```

Add toolchains volume to pod spec:

```typescript
volumes: [
  { name: 'workspace', persistentVolumeClaim: { claimName: pvcName } },
  { name: 'org-fs', persistentVolumeClaim: { claimName: 'eve-org-fs-org-default' } },
  ...(toolchains.length > 0 ? [{ name: 'toolchains', emptyDir: {} }] : []),
],
```

#### 3c. Entrypoint PATH extension

**File**: `docker/worker/entrypoint.sh`

At the top of the entrypoint, prepend toolchain paths to `PATH`:

```bash
# Extend PATH with any mounted toolchains
if [ -n "${EVE_TOOLCHAIN_PATHS:-}" ]; then
  export PATH="${EVE_TOOLCHAIN_PATHS}:${PATH}"
fi
```

This ensures toolchain binaries are discoverable by both the worker process and any harness/agent it spawns.

#### 3d. Toolchain-specific env vars

Some toolchains need more than just `PATH`. Add a convention where each toolchain image includes a `/toolchain/env.sh` file that the entrypoint sources:

```bash
# In entrypoint.sh
for tc_dir in /opt/eve/toolchains/*/; do
  if [ -f "${tc_dir}env.sh" ]; then
    . "${tc_dir}env.sh"
  fi
done
```

Example `env.sh` for Java:
```bash
export JAVA_HOME=/opt/eve/toolchains/java/jdk
export PATH="${JAVA_HOME}/bin:${PATH}"
```

Example `env.sh` for Rust:
```bash
export RUSTUP_HOME=/opt/eve/toolchains/rust/rustup
export CARGO_HOME=/opt/eve/toolchains/rust/cargo
export PATH="${CARGO_HOME}/bin:${PATH}"
```

**Acceptance**: A runner pod with `toolchains: ['python']` starts with `python3` available. A runner pod with no toolchains starts with only base tools. Both complete their jobs successfully.

### Phase 4: Agent-Level Toolchain Declarations

Let agents declare which toolchains they need. The orchestrator resolves these at job creation time and passes them through to the runner pod.

#### 4a. Schema: Add `toolchains` to agent config

**File**: `packages/shared/src/schemas/agent-config.ts`

```typescript
const AgentEntrySchema = z.object({
  // ... existing fields ...
  toolchains: z.array(z.enum(['python', 'media', 'rust', 'java', 'kotlin'])).optional(),  // e.g. ['python', 'media']
}).passthrough();
```

#### 4b. Agent YAML usage

```yaml
# eve/agents.yaml
version: 1
agents:
  doc-processor:
    name: Document Processor
    skill: process-documents
    harness_profile: claude-sonnet
    toolchains: [media]            # needs ffmpeg + whisper

  code-reviewer:
    name: Code Reviewer
    skill: review-code
    harness_profile: claude-opus
    # no toolchains — runs on base image

  data-analyst:
    name: Data Analyst
    skill: analyze-data
    harness_profile: claude-sonnet
    toolchains: [python]           # needs python + uv

  full-stack:
    name: Full Stack Dev
    skill: full-stack-dev
    harness_profile: claude-opus
    toolchains: [python, rust, java]  # multi-toolchain
```

#### 4c. Resolve toolchains from agent config

Agent config resolution for workflow-triggered jobs already lives in `apps/api/src/workflows/workflows.service.ts` (the `resolveStepAgent()` method, line ~255). Extend this to extract and return `toolchains`:

**File**: `apps/api/src/workflows/workflows.service.ts`

```typescript
// In resolveStepAgent(), after resolving the agent:
const stepToolchains = firstStep?.toolchains as string[] | undefined;
const agentToolchains = agentConfig?.toolchains as string[] | undefined;
const toolchains = stepToolchains ?? agentToolchains ?? [];

return {
  // ... existing fields ...
  toolchains,
};
```

The orchestrator (`apps/orchestrator/src/loop/loop.service.ts`) then passes the resolved toolchains through to the `HarnessInvocation` when creating the job.

Toolchain precedence must be deterministic:
- workflow step `toolchains` should override agent defaults when present.
- otherwise use `agent.toolchains ?? []`.
- schema validation should reject unknown toolchain names early.

#### 4d. Workflow-level toolchain override

Workflows can also specify toolchains, overriding the agent default:

```yaml
# eve/workflows.yaml
version: 1
workflows:
  process-document:
    trigger:
      system.event: doc.ingest
    steps:
      - name: process
        agent: doc-processor
        toolchains: [media, python]  # override: needs both for this workflow
```

**Acceptance**: An agent with `toolchains: [media]` creates runner pods with a media init container. An agent with no toolchains creates runner pods with no init containers. The workflow `toolchains` override is respected when present.

### Phase 5: Agent Runtime Toolchain Support

The agent runtime (warm pods) uses a StatefulSet, not ephemeral pods. Toolchains need different handling here.

#### 5a. Init containers on StatefulSet pods

Add init containers to the agent-runtime StatefulSet spec based on the org's agent configurations. When the agent runtime starts (or restarts), it evaluates which toolchains are needed by the agents it serves and mounts them.

**File**: `k8s/base/agent-runtime-deployment.yaml` (note: file is named `deployment.yaml` but contains a StatefulSet spec)

This requires the agent runtime to declare its toolchain requirements at deploy time, not per-request. The simplest approach: the deploy/sync process reads all agent configs for the org and unions their `toolchains` arrays.

#### 5b. Alternative: Runtime install on first use

A simpler alternative for warm pods: the agent runtime installs toolchains on first use. The entrypoint checks `/opt/eve/toolchains/{name}` — if missing, it pulls and extracts the toolchain image.

This is slower on first use but requires no StatefulSet spec changes. Suitable for the agent runtime where pods are long-lived and the cost is amortized.

**Acceptance**: Agent runtime pods have access to toolchains needed by their configured agents. First-use latency is under 30 seconds for any single toolchain.

### Phase 6 (Optimization): Persistent Toolchain Cache via Node-Local PVC

For nodes that run many jobs needing the same toolchains, use a node-local PersistentVolume that persists toolchains across pod restarts.

#### 6a. Node-local PVC for toolchain cache

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: eve-toolchain-cache-<node>
spec:
  capacity:
    storage: 5Gi
  accessModes: [ReadWriteOnce]
  hostPath:
    path: /var/eve/toolchain-cache
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values: [<node-name>]
```

#### 6b. Init container check-before-copy

Modify init container command to skip copy if toolchain already exists on the PVC:

```bash
#!/bin/sh
if [ -f "/opt/eve/toolchains/$TC_NAME/.installed" ]; then
  echo "Toolchain $TC_NAME already cached on node"
  exit 0
fi
cp -a /toolchain/. "/opt/eve/toolchains/$TC_NAME/"
touch "/opt/eve/toolchains/$TC_NAME/.installed"
```

#### 6c. Runner pod manifest: PVC instead of emptyDir

```typescript
// In k8s-runner.ts, when node-local cache is available
volumes: [
  ...(toolchains.length > 0 ? [{
    name: 'toolchains',
    persistentVolumeClaim: { claimName: `eve-toolchain-cache` },
  }] : []),
],
```

#### 6d. Cache invalidation

Toolchain images are versioned. The `.installed` marker file includes the image version:

```bash
echo "$TC_IMAGE_TAG" > "/opt/eve/toolchains/$TC_NAME/.installed"
```

Init container compares versions and re-copies if changed:

```bash
CACHED_VERSION=$(cat "/opt/eve/toolchains/$TC_NAME/.installed" 2>/dev/null || echo "")
if [ "$CACHED_VERSION" = "$TC_IMAGE_TAG" ]; then
  echo "Toolchain $TC_NAME@$TC_IMAGE_TAG cached"
  exit 0
fi
rm -rf "/opt/eve/toolchains/$TC_NAME"
cp -a /toolchain/. "/opt/eve/toolchains/$TC_NAME/"
echo "$TC_IMAGE_TAG" > "/opt/eve/toolchains/$TC_NAME/.installed"
```

**Performance impact**:
- First job on a node: init container copies toolchain (~2-5s per toolchain)
- Subsequent jobs on same node: init container exits in <100ms (version match)
- Toolchain version bump: one re-copy per node, then cached again

**Acceptance**: Second job on the same node with the same toolchains starts with zero init container copy overhead. Toolchain version bumps trigger a single re-copy.

## File Change Summary

| Phase | File | Change |
|-------|------|--------|
| 1a | `.github/workflows/publish-images.yml` | Worker target: `full` → `base` |
| 1b | `bin/eh-commands/k8s-image.sh` | Default variant: `full` → `base` |
| 2a | `docker/toolchains/python/Dockerfile` | New: Python toolchain image |
| 2a | `docker/toolchains/media/Dockerfile` | New: Media toolchain image |
| 2a | `docker/toolchains/rust/Dockerfile` | New: Rust toolchain image |
| 2a | `docker/toolchains/java/Dockerfile` | New: Java toolchain image |
| 2a | `docker/toolchains/kotlin/Dockerfile` | New: Kotlin toolchain image |
| 2b | `.github/workflows/toolchain-images.yml` | New: CI for toolchain images |
| 2c | `bin/eh-commands/k8s-image.sh` | Add toolchain build/import support |
| 3a | `packages/shared/src/types/harness.ts` | Add `toolchains` to `HarnessInvocation` |
| 3b | `apps/worker/src/invoke/k8s-runner.ts` | Inject init containers from `toolchains` |
| 3c | `docker/worker/entrypoint.sh` | PATH extension from `EVE_TOOLCHAIN_PATHS` |
| 3d | `docker/toolchains/*/env.sh` | Per-toolchain env var files |
| 4a | `packages/shared/src/schemas/agent-config.ts` | Add `toolchains` to `AgentEntrySchema` |
| 4b | Agent YAML files | Declare `toolchains` per agent |
| 4c | `apps/api/src/workflows/workflows.service.ts` | Resolve `toolchains` from agent config + workflow step |
| 4d | `packages/shared/src/schemas/workflow.ts` | Add `toolchains` to workflow step schema |
| 5  | `k8s/base/agent-runtime-deployment.yaml` | Toolchain init containers or runtime install |
| 6  | `apps/worker/src/invoke/k8s-runner.ts` | PVC-based toolchain volume, check-before-copy |

## Validation Checklist

- [ ] Confirm base is default in `.github/workflows/publish-images.yml` while `worker-full` remains published.
- [ ] Confirm local `k8s-image.sh` default switches to `base` but still supports `EVE_WORKER_VARIANT=full`.
- [ ] Validate each toolchain image can be consumed by init-container `cp` flow as documented.
- [ ] Add unit/integration coverage for `toolchains` resolution precedence.
- [ ] Add at least one manual scenario per class:
  - job with no toolchains (base path only),
  - job with `[python]`,
  - workflow override with `[media, python]`.
- [ ] Add one staging rollout and verify `eve-orchestrator` no longer keeps all `full` pulls in cache by default.
- [ ] Verify agent/runtime startup behavior does not regress for agents without toolchains.

## Risks

| Risk | Mitigation |
|------|------------|
| Toolchain images missing shared libraries | Use `ldd` during build to verify all deps are bundled. Test each toolchain in a `FROM scratch` container before shipping. |
| Init container image pull adds latency | Toolchain images are small (50-300MB). First pull on a node takes 5-10s. Subsequent pods use cache. Phase 6 PVC eliminates even that. |
| PATH conflicts between toolchains | Each toolchain has its own `/opt/eve/toolchains/{name}/bin` prefix. No shared namespace. |
| Agent runtime (warm pods) complexity | Start with runtime-install approach (Phase 5b). Only move to init containers if latency matters. |
| Existing `full` users broken | `full` image stays published and available. `EVE_WORKER_VARIANT=full` restores old behavior. |
| Toolchain env.sh sourcing order | Source in alphabetical order. Document that toolchains should not conflict. |
| Kotlin requires JDK at runtime | Kotlin toolchain image bundles its own JDK copy. If both `java` and `kotlin` are mounted, `JAVA_HOME` from `kotlin/env.sh` wins (alphabetical). |

## Backwards Compatibility

- `full` image remains available as `worker-full` in ECR and via `--variant full` locally
- `EVE_WORKER_VARIANT=full` overrides the new default for users who need everything
- Agents without `toolchains` field continue to work (no init containers, no change)
- The `worker-images.yml` CI workflow already publishes all variant images — no changes needed

## Future Considerations

| Enhancement | When |
|-------------|------|
| GPU toolchain image (CUDA + whisper GPU build) | When GPU nodes are available |
| Toolchain composition in manifest (`x-eve.toolchains`) | When projects want org-wide defaults |
| Dynamic toolchain install via agent request | When agents need to install arbitrary packages at runtime |
| Toolchain marketplace (community-contributed images) | When third-party agent ecosystem exists |
| OCI artifact storage for toolchains (instead of container images) | When init container approach proves too heavy |
