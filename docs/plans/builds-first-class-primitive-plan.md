# Builds as a First-Class Primitive Plan

> Status: Draft
> Last Updated: 2026-01-31
> Purpose: Make builds a first-class, observable, and reusable system primitive (specs, runs, artifacts) independent of pipelines or jobs.

## Problem Statement

Today, builds are effectively an implementation detail of pipeline actions:

- No dedicated Build entity to track inputs, outputs, retries, or provenance.
- Logs live inside job attempts, making build debugging indirect and brittle.
- Different backends (local buildx vs k8s kaniko) behave differently, causing drift.
- Releases depend on ad-hoc digest capture rather than a stable build artifact.
- Caching is incidental, not explicit or reusable across runs.

This makes builds hard to operate, hard to debug, and hard to evolve.

## Why This Has Been So Hard

- **Builds aren’t first-class**: logs and status live inside job attempts, so failures are opaque and hard to triage.
- **Two backends, two behaviors**: local Buildx and in-cluster Kaniko diverge on multi-stage behavior and caching.
- **Kaniko subprocess mode is broken for multi-stage**: `--force` triggers a filesystem snapshot cycle that drops toolchains
  (e.g., `pnpm` in `reference-app`). This is a known upstream issue, not a config bug.
- **Build context boundary**: worker workspaces live in a pod filesystem; build pods can’t access them without git clone or
  volume gymnastics.
- **Secrets + auth sprawl**: registry auth, git auth, and build secrets are scattered across action code paths.
- **Caching is incidental**: no shared cache policy means slow builds and inconsistent rebuild behavior.

## Goals

- Introduce **BuildSpec**, **BuildRun**, and **BuildArtifact** as first-class records.
- Provide stable build logs, statuses, and diagnostics via API + CLI.
- Make pipelines depend on **BuildRuns** instead of raw digest parsing.
- Support multiple backends through a clean interface (BuildKit primary, Kaniko fallback).
- Make caching and provenance explicit and reusable.
- Enable deterministic deployments via BuildArtifacts.

## Tech Choice (Recommendation)

**Primary backend: BuildKit (rootless)**  
**Fallback backend: Kaniko (K8s Job)**

Why BuildKit:
- Correct multi-stage semantics that match Docker/Buildx (no `--force` issues).
- Native registry cache export/import for repeatable, fast builds.
- Works rootless in Kubernetes; no Docker daemon needed.
- Same toolchain and flags as local buildx → less drift between local/staging.

Why keep Kaniko:
- Still valuable as a fallback in restricted clusters.
- Keeps a known-good path while BuildKit is stabilized.

Alternatives considered (not recommended as primary):
- **Buildah/Podman**: solid, but requires different build semantics and larger surface area to integrate.
- **Tekton/Kpack**: powerful, but heavy-weight and adds a new control plane we don’t need yet.

## Non-Goals

- Full CI replacement or complex build matrices (for now).
- Multi-registry routing per service (future).
- Full SBOM/provenance storage pipeline (start with pointers).
- Complex supply-chain policy enforcement (future).

## Core Concepts

### BuildSpec (Immutable input)
A BuildSpec defines **what to build**:

- `project_id`, `git_sha`, `manifest_hash`
- `services` (subset of manifest services)
- `build_args`, `target`, `platforms`
- `context`, `dockerfile` per service (resolved from manifest)
- `registry` config (host, namespace, auth keys)
- `cache` policy (registry cache, inline cache, or none)

### BuildRun (Execution instance)
A BuildRun defines **how and where** the BuildSpec was executed:

- `build_id`, `backend`, `status`, `started_at`, `completed_at`
- `runner_ref` (pod name / node / buildkit session)
- `logs_ref` (DB stream + optional object store)
- `error_message`

### BuildArtifact (Output)
A BuildArtifact represents **what was produced**:

- `service_name`, `image_ref`, `digest`, `platforms`
- `size_bytes`, `created_at`
- optional `sbom_ref`, `provenance_ref`

## Data Model (Proposed)

- `build_specs`
  - `id`, `project_id`, `git_sha`, `manifest_hash`, `created_by`
  - `services_json`, `inputs_json`
  - `registry_json`, `cache_json`
  - `created_at`

- `build_runs`
  - `id`, `build_id`, `status`, `backend`, `runner_ref`
  - `started_at`, `completed_at`, `error_message`, `logs_ref`

- `build_artifacts`
  - `id`, `build_id`, `service_name`, `image_ref`, `digest`
  - `platforms_json`, `size_bytes`, `sbom_ref`, `provenance_ref`
  - `created_at`

## API Surface

- `POST /projects/:id/builds` → create BuildSpec
- `GET /projects/:id/builds` → list BuildSpecs
- `GET /builds/:id` → BuildSpec
- `POST /builds/:id/runs` → start BuildRun
- `GET /builds/:id/runs` → list BuildRuns
- `GET /builds/:id/artifacts` → BuildArtifacts
- `GET /builds/:id/logs` → stream logs
- `POST /builds/:id/cancel` → cancel BuildRun

## CLI Surface

- `eve build create --project <id> --ref <sha> [--services <list>]`
- `eve build run <build_id>`
- `eve build logs <build_id> [--run <id>]`
- `eve build artifacts <build_id>`
- `eve build cancel <build_id>`

## Execution Architecture

### Scheduling Model

- BuildRuns are **scheduled by the existing orchestrator** (no new scheduler).
- Dispatch uses a build-runner execution path (worker mode or lightweight service).
- Use a **build-specific concurrency limiter** (e.g., `ORCH_BUILD_CONCURRENCY`) so builds
  don't starve jobs while still sharing the same scheduling backbone.

### Build Executor Interface

```
interface BuildBackend {
  run(build: BuildSpec, run: BuildRun): Promise<BuildArtifacts>;
  cancel(runId: string): Promise<void>;
}
```

### Default Backend: BuildKit (In-Cluster for PaaS Builds)

- Run `buildkitd` as a **cluster service** for Eve-hosted app builds.
- `buildctl` invoked from a build-runner pod.
- Supports cache exports and deterministic behavior.
- Aligns with Docker build semantics (matches local buildx).
- **Multi-arch deferred** until BuildKit path is stable; start with single-platform builds.

### Local Dev Backend (Lightweight)

- Use **host BuildKit (docker buildx)** for local dev loops to keep k3d lightweight.
- Default local dev path: worker calls host buildx and pushes images (or uses k3d import).
- Provide a **fidelity mode** to run BuildKit **inside k3d** when validating PaaS behavior.

### Optional Fallback Backend: Kaniko Job (Only if BuildKit is blocked)

- Use only if BuildKit cannot run due to cluster security policy.
- Avoid defaulting to Kaniko to reduce backend drift.
- Keep the execution spec behind the `BuildBackend` interface.

### Build Runner

- New lightweight service or worker mode that only runs builds.
- Build pods are **ephemeral** and isolated (separate from worker actions).
- Build logs are streamed into `build_runs.logs_ref`.
  - **No `env_name`** on BuildRuns to avoid environment gates.
  - Optional explicit build gates for hot spots (e.g. `build:project:<project_id>`).

### K8s Resources (BuildKit)

**Add to `k8s/base` (for all clusters):**
- `buildkitd` **Deployment** + **Service** (ClusterIP)
- **PVC** for cache (default size e.g. 20Gi)
- **ServiceAccount/Role/RoleBinding** (if needed for pod-level access)

**Add to overlays:**
- `k8s/overlays/local`: optional enablement for fidelity mode (off by default).
- `k8s/overlays/staging` + `k8s/overlays/aws`: enabled by default.
- Configure resources, cache size, and pod security context per environment.

**Notes:**
- Build runner talks to `buildkitd` via service DNS (e.g. `buildkitd.eve.svc`).
- Registry auth is passed via build inputs (not hardcoded in BuildKit deployment).

## Pipeline Integration

- `build` action creates a BuildSpec + BuildRun and outputs `build_id`.
- `release` action references `build_id` (not raw digests).
- `deploy` action uses `release_id` (unchanged), but release now points to artifacts.

## Release Changes

- Release records should reference a `build_id` and use BuildArtifacts for image digests.
- `image_digests_json` becomes derived data and can be deprecated.

## Observability

- Build status and logs should be viewable independently of pipeline/job context.
- Add `eve build diagnose` (pulls build spec, backend, last logs, artifacts).

## Implementation Plan (Phased)

### Phase 0: Foundations (Schema + API)

- Add `build_specs`, `build_runs`, `build_artifacts` tables.
- Add API endpoints for create/list/get.
- Add CLI commands for create/list/show.

### Phase 1: Wire Build Actions → BuildSpec/Run

- Build action creates BuildSpec + BuildRun.
- BuildRun status updated as build progresses.
- Logs streamed to build logs endpoint.

### Phase 2: Backend Interface + Kaniko Adapter

- Implement `BuildBackend` interface.
- Wrap existing kaniko job logic as `KanikoBackend`.
- Return BuildArtifacts on success.
  - **Mark as optional** and only wire if BuildKit cannot be run in a target cluster.

### Phase 3: BuildKit Backend (Primary)

- Add `buildkitd` service + PVC to `k8s/base` (enabled in staging/aws overlays).
- Add an opt-in `k8s/overlays/local` patch for fidelity mode.
- Implement `BuildKitBackend` using `buildctl`.
- Add registry cache configuration.
  - Keep single-platform builds until multi-arch is proven.

### Phase 4: Release Integration

- Update release creation to consume BuildArtifacts.
- Pipeline release step requires `build_id` input.
- Deprecate direct digest injection via `image_digests_json`.

### Phase 5: Ops + Diagnostics

- Update `docs/system/container-registry.md` and `docs/system/pipelines.md`.
- Add `docs/system/builds.md` explaining BuildSpec/Run/Artifacts.
- Add `eve build diagnose` command.
- Add runbook for build backends and cache controls.

## Risks and Mitigations

- **Backend drift**: use BuildKit as default to align local and k8s behavior.
- **Secret leakage**: ensure build secrets are ephemeral and cleaned up.
- **Cache invalidation**: strict cache keys, opt-in policies.
- **Job vs Build confusion**: clearly separate BuildRuns from job attempts in UI/CLI.
- **Build starvation**: enforce build-specific concurrency caps separate from job dispatch.

## Acceptance Criteria

- Build specs and runs visible via API + CLI.
- A build can be run independently of pipelines.
- Releases reference build artifacts, not raw digest parsing.
- Deploys use artifacts and remain deterministic.
- Build logs available even when pipeline/job logs are not.

## Decisions (Resolved)

- **Scheduling**: BuildRuns are scheduled by the orchestrator (no new scheduler).
- **Multi-arch**: Defer until BuildKit is stable; launch with single-platform builds.
- **Gates/Priority**: Use the same priority system, but avoid env gates; add explicit
  build gates only when needed (project/registry throttling).
