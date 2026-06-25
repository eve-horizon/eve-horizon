# Kaniko K8s Job Builds: Fixing Multi-Stage Docker Builds in Eve Horizon

## Context

Eve Horizon's worker service is responsible for building Docker images from user projects. When running on Kubernetes (the staging and production environment), the worker uses [kaniko](https://github.com/GoogleContainerTools/kaniko) for in-cluster image builds, since the worker pods don't have access to a Docker daemon.

The original implementation copied the kaniko executor binary into the worker image at build time (via `COPY --from=kaniko /kaniko/executor /usr/local/bin/kaniko` in the worker Dockerfile) and invoked it as a subprocess:

```ts
execFile('/usr/local/bin/kaniko', ['--force', ...args])
```

The `--force` flag is mandatory when kaniko isn't running as the container's entrypoint. Without it, kaniko refuses to execute. This worked for simple, single-stage Dockerfiles, but broke badly for anything more complex.

## The Failure

The problem surfaced while building `reference-app`, a Node.js project that uses pnpm via corepack. Its Dockerfile follows a standard multi-stage pattern:

```dockerfile
FROM node:22-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@latest --activate

FROM base AS deps
COPY package.json ./
RUN pnpm install --frozen-lockfile  # <-- FAILS: pnpm: not found
```

The first stage installs pnpm via corepack, the second stage inherits from it and runs `pnpm install`. This is a completely ordinary Dockerfile pattern. It works with `docker build`, with `docker buildx`, and with kaniko when kaniko runs as the container entrypoint. But when kaniko runs as a subprocess with `--force`, the second stage can't find pnpm.

## The Long Road: v0.1.28 through v0.1.37

Fixing this consumed ten release iterations. Each version peeled back a layer of the problem, but the core issue kept surviving every attempted fix.

### Early iterations (v0.1.28 - v0.1.34)

The first several versions fought with environmental issues that masked the real problem:

- **`spawn git ENOENT`** -- The kaniko environment inside the worker pod didn't have git on its PATH. Kaniko's filesystem wipe removed tools the worker had installed.
- **`failed to get fileinfo for package.json`** -- Build context wasn't being passed correctly to kaniko. The workspace directory structure didn't match what kaniko expected.
- **Registry authentication failures** -- Docker config paths were wrong. Kaniko looks for credentials at `/kaniko/.docker/config.json`, but the worker was placing them elsewhere.
- **`--ignore-path` flags** -- Added to prevent kaniko from wiping directories the worker needed. Each flag fixed one thing and revealed another.

### v0.1.35: Diagnostics

Added detailed logging to the `prepareWorkspace` step. This confirmed that the git clone and workspace setup were working correctly -- the build context was intact when kaniko started. The git errors from earlier versions were gone. But `pnpm: not found` persisted.

### v0.1.36: Filesystem cleanup flags

Added `--ignore-path` flags to protect specific directories from kaniko's inter-stage filesystem wipe. COPY commands in the Dockerfile started succeeding (confirming the build context was fine), but pnpm still wasn't found in the second stage. The tool was being installed in stage 0 and vanishing by stage 1.

### v0.1.37: Build context preservation

Tried copying the entire build context into kaniko's working directory so it would survive the filesystem wipe between stages. This was a workaround attempt -- if the problem was the build context disappearing, pre-loading it should help. Same result: `pnpm: not found`.

## Root Cause

After extensive research and local diagnostic testing, the answer turned out to be a **well-known, long-standing kaniko bug** documented across multiple GitHub issues (#450, #2509, #1697, #2736, #2164, #2764).

When kaniko runs with `--force`, it performs a destructive filesystem round-trip between multi-stage build stages:

1. Execute all RUN commands in stage N
2. Snapshot the filesystem as a tar archive
3. **Delete the entire filesystem** (`Deleting filesystem...` appears in logs)
4. Restore from the tar archive
5. Begin stage N+1

The problem: this save-delete-restore cycle doesn't faithfully preserve everything. Symlinks, certain directory structures, and PATH-dependent tooling can be lost. In the `reference-app` case:

- `corepack prepare pnpm@latest --activate` creates pnpm at `/pnpm` (as directed by `PNPM_HOME`)
- After the tar round-trip, `/pnpm` doesn't exist
- The pnpm binary *does* exist at `/usr/local/lib/node_modules/corepack/shims/pnpm` (the corepack shim), and invoking it by full path works
- But the PATH-based resolution fails because the `/pnpm` directory is gone

Local diagnostic tests confirmed this: the directory simply doesn't survive the stage transition.

### Flags that don't help

Every documented workaround was tested:

| Flag combination | Result |
|---|---|
| `--use-new-run` | `pnpm: not found` |
| `--snapshot-mode=redo` | `pnpm: not found` |
| `--use-new-run` + `--snapshot-mode=redo` | `pnpm: not found` |
| `--single-snapshot` | `pnpm: not found` |
| Various `--ignore-path` combinations | `pnpm: not found` |

No flag combination fixes multi-stage builds when kaniko runs as a subprocess with `--force`. The bug is in the filesystem round-trip logic itself, and `--force` is the trigger.

## The Solution: K8s Job Builds (v0.1.38)

The canonical fix is to stop running kaniko as a subprocess entirely. Instead, run it as the container entrypoint in its own dedicated K8s pod, where `--force` is not needed.

### Architecture: Before and After

**Before** (subprocess, broken for multi-stage):

```
Worker Pod
  └── execFile('/usr/local/bin/kaniko', ['--force', ...])
```

**After** (K8s Job, no --force needed):

```
Worker Pod (orchestrates the build)
  └── Creates K8s Job:
        ├── Init Container: alpine/git:2.47.2
        │     └── Clones repo at exact SHA
        └── Main Container: gcr.io/kaniko-project/executor:v1.20.1
              └── Builds and pushes image (as entrypoint, no --force)
```

The worker no longer executes kaniko directly. It creates a K8s Job with two containers sharing an `emptyDir` volume:

1. An **init container** running `alpine/git` clones the project repository at the exact commit SHA into `/workspace`
2. The **main container** runs the kaniko executor as its entrypoint, building from `/workspace` and pushing to the registry

Because kaniko is the entrypoint of its own container, `--force` is not needed, and multi-stage builds work correctly.

### Why git clone instead of volume mounting?

The worker's local workspace lives inside the worker pod's filesystem. K8s Jobs run in separate pods -- they cannot access another pod's filesystem. The cleanest way to transfer the build context is to clone the repository directly. The authenticated git URL (with embedded credentials from the action executor's `injectGitAuth()`) is extracted from the workspace's `.git/config` and passed to the init container via a K8s Secret.

### Implementation

Four files were modified:

**1. `apps/worker/src/builder/kaniko-builder.ts`** (new file, complete rewrite)

The core of the change. `KanikoBuilder` now implements the K8s Job approach:

- Extracts the authenticated git remote URL from the workspace (via `git remote get-url origin`)
- Creates an ephemeral K8s Secret containing Docker registry auth (`config.json`) and the git clone URL
- Builds a K8s Job spec with:
  - Init container (`alpine/git:2.47.2`): runs `git clone --no-checkout "$GIT_URL" /workspace && cd /workspace && git checkout <sha>`
  - Main container (`gcr.io/kaniko-project/executor:v1.20.1`): runs with `--context`, `--dockerfile`, `--destination`, and OCI label args
  - Shared `emptyDir` volume for `/workspace`
  - Secret volume mounting Docker config at `/kaniko/.docker/config.json`
- Uses `K8sService.runJob()` to create the Job, poll for completion (10-minute timeout), and collect logs
- Parses the image digest (`sha256:...`) from kaniko's output
- Cleans up the ephemeral Secret in a `finally` block
- Detects namespace from the service account token file with fallback to `EVE_K8S_NAMESPACE`

**2. `apps/worker/src/deployer/k8s.service.ts`** (modified)

Added `createSecret()`, `deleteSecret()`, and `runJob()` methods. `createSecret` and `deleteSecret` follow the existing create-or-update pattern already established by `createConfigMap`/`deleteConfigMap`. `runJob` creates a namespaced Job, polls for completion, and returns the logs and exit code.

**3. `apps/worker/src/deployer/deployer.module.ts`** (modified)

Exported `K8sService` so it can be injected across NestJS module boundaries. The `BuilderModule` needs access to `K8sService`, which lives in the `DeployerModule`.

**4. `apps/worker/src/builder/builder.module.ts`** (modified)

Added `DeployerModule` to imports so NestJS dependency injection can resolve `K8sService` when constructing `KanikoBuilder`. The runtime selection logic (`EVE_RUNTIME === 'k8s'` or `KUBERNETES_SERVICE_HOST` present) determines whether `KanikoBuilder` or `DockerBuildxBuilder` is used.

### Key Design Decisions

- **Ephemeral secrets with guaranteed cleanup.** Registry credentials and git auth tokens are stored in per-build K8s Secrets, created before the Job and deleted in a `finally` block after completion. This minimizes credential exposure window and avoids leaving sensitive data in the cluster.

- **No changes to user Dockerfiles.** The fix is entirely server-side. Any multi-stage Dockerfile pattern -- including pnpm/corepack, multi-stage Go builds, Python poetry installs, or anything else -- should work correctly because kaniko runs as designed (as the entrypoint).

- **Job-level TTL for automatic cleanup.** The Job spec includes `ttlSecondsAfterFinished: 300`, so completed Jobs are garbage-collected by Kubernetes after 5 minutes even if the worker doesn't clean them up.

- **`backoffLimit: 0`** on the Job spec. Build failures should surface immediately rather than being silently retried. If the Dockerfile is broken, retrying won't help.

## Current Status

- v0.1.38 has been committed and tagged as `release-v0.1.38`
- CI pipeline builds all three images (api, orchestrator, worker) and deploys to staging
- The staging overlay patches have been reset to `:staging` image tags for CI's sed-based tag substitution
- Next verification step: trigger a `reference-app` build on staging to confirm multi-stage Docker builds succeed with the K8s Job approach
- The worker's staging security context still runs as root (from debugging iterations) and can be reverted once the fix is confirmed, since the worker no longer executes kaniko directly

## Risks and Operational Considerations

### RBAC

The worker's K8s service account must have permissions to create and delete Jobs and Secrets in its namespace. If the cluster's RBAC policies are too restrictive, Job creation will fail at runtime. The required verbs are `create`, `get`, `list`, `delete` on `batch/v1/jobs` and `v1/secrets`.

### Cluster Resources

Each kaniko build now runs as a separate pod consuming its own CPU and memory allocation. For production, the Job spec should include explicit `resources.requests` and `resources.limits` to prevent builds from starving other workloads. Concurrent builds will each spawn their own pod.

### Network Access

The kaniko pod needs outbound network access to two external services:
- The container registry (GHCR at `ghcr.io`) for pushing built images
- The git remote (GitHub at `github.com`) for cloning the repository

If the cluster has `NetworkPolicy` resources restricting egress, the kaniko pods (labeled `eve.horizon/component: kaniko-build`) may need explicit allow rules.

### Orphaned Secrets on Worker Crash

If the worker process crashes after creating the build Secret but before the `finally` cleanup runs, the Secret will persist in the cluster. The Job itself is handled by `ttlSecondsAfterFinished`, but Secrets have no such built-in TTL. A label-based cleanup mechanism (e.g., a CronJob that deletes Secrets labeled `eve.horizon/component: kaniko-build` older than a threshold) would provide defense in depth.

## Lessons Learned

1. **Kaniko's `--force` flag is fundamentally incompatible with reliable multi-stage builds.** This is not an edge case or a configuration issue -- it's a structural limitation of how kaniko handles filesystem snapshots in subprocess mode. The upstream issues have been open for years with no fix.

2. **When you're fighting a tool's design, change the approach, not the flags.** Ten versions of flag combinations couldn't fix what was a fundamental architectural mismatch. The K8s Job approach works *with* kaniko's design rather than against it.

3. **The first five errors you see may not be the real problem.** Git missing, build context issues, and registry auth failures all had to be fixed, but they were masking the deeper multi-stage snapshot bug. Each fix was necessary but insufficient.
