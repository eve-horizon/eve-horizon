# Pipeline Build + Registry Push Plan

> Status: Draft
> Last Updated: 2026-01-30
> Purpose: Implement real image builds + registry pushes so deploy pipelines publish images and deploy from digests.

## Problem Statement (Current Gaps)

- Build actions are stubs in both the job-based action executor and the legacy pipeline runner.
- Release creation in the job-based path does not persist image digests.
- Deploy attempts to pull images that were never built/pushed.
- Manual Scenario 05 (deploy flow) is blocked unless images are pre-pushed or `./bin/eh k8s-image push` is used.

## Goals

- Build actions produce real container images for services with `build` config.
- Images are pushed to the manifest registry and digests are recorded.
- Release records contain the correct `image_digests_json`.
- Deploy uses digests to pull immutable images.
- Works in both k8s and local/docker modes without manual image import.
- Manual Scenario 05 passes using the real pipeline build + release + deploy flow.

## Non-Goals

- Multi-registry per service or complex registry mirroring.
- Multi-arch builds, advanced caching, or build matrix support (later).
- Full CI/CD pipeline automation (this is only the build action inside Eve pipelines).

## Design Decisions (Refined)

- **Build backend**: Pluggable builder interface.
  - **Local/docker mode**: Docker Buildx on the host (fast, leverages local cache).
  - **k8s mode**: Kaniko job (no privileged Docker, works in k3d + real clusters).
- **Repository checkout**: Git clone at the requested `git_sha` into a workspace per build run.
- **Tagging**: Default tag `sha-<git_sha>` (shortened to 12 chars for Docker tag).
- **Digest source of truth**: Use pushed digest from builder output; tags are not stored.
- **Build scope**: Only services with `build` + `image`. Skip `x-eve.external` services.
- **Registry auth**: Required for push. Use manifest `registry.auth` secrets; fail-fast if missing.

## Implementation Plan (Phased)

### Phase 0: Finalize Interfaces + Shared Helpers

**Goal**: Establish interfaces and shared helpers to keep build logic consistent across paths.

**Tasks**
- Create `apps/worker/src/build/image-builder.interface.ts` defining:
  - `buildAll(params): Promise<Record<string, string>>` (service -> digest)
  - `buildService(params): Promise<string>` (digest)
- Add manifest parsing helpers (if missing) to collect buildable services:
  - `packages/shared/src/schemas/manifest.ts` (helper `getBuildableServices()` or similar)
- Add registry auth resolver (refactor from deployer):
  - Extract `resolveRegistryAuth()` from `apps/worker/src/deployer/deployer.service.ts`
  - Returns `{ host, username, token, dockerConfigJson }`

**Files likely touched**
- `apps/worker/src/build/`
- `apps/worker/src/deployer/deployer.service.ts`
- `packages/shared/src/schemas/manifest.ts`

### Phase 1: Local Builder (Docker Buildx)

**Goal**: Implement a Docker-based builder for non-k8s environments.

**Tasks**
- Add `apps/worker/src/build/docker-buildx-builder.ts`:
  - `docker buildx build --push`
  - Use `--metadata-file` to parse pushed digest.
  - Ensure `DOCKER_BUILDKIT=1`.
- Add a helper to build registry auth login:
  - Prefer `docker login` with username/token before build.
  - Use `docker config` fallback for non-interactive.

**Digest extraction**
- Prefer `--metadata-file` (Buildx) and parse `containerimage.digest`.
- Fallback to `docker buildx imagetools inspect <image:tag>` if metadata missing.

**Files likely touched**
- `apps/worker/src/build/docker-buildx-builder.ts`
- `apps/worker/src/build/image-builder.service.ts`

### Phase 2: k8s Builder (Kaniko Job)

**Goal**: Implement Kaniko-based builds in k8s with registry auth.

**Tasks**
- Add `apps/worker/src/build/kaniko-builder.ts`:
  - Create a build namespace if missing (e.g. `eve-build`).
  - Create a per-build job with:
    - `initContainer`: git clone at `git_sha` into `emptyDir`.
    - `kaniko`: build using `--context`, `--dockerfile`, `--destination`, `--digest-file`.
  - Mount registry auth secret as `/kaniko/.docker/config.json`.
  - Capture digest by reading `--digest-file` from the pod logs or file mount.
- Ensure job cleanup (TTL) to avoid resource leaks.

**Files likely touched**
- `apps/worker/src/build/kaniko-builder.ts`
- `apps/worker/src/k8s/` (if new helpers are required)

### Phase 3: Wire Build Actions (Job-Based)

**Goal**: Replace build stubs with real build execution in the job-based action path.

**Tasks**
- Update `apps/worker/src/action-executor/action-executor.service.ts`:
  - Replace `handleBuild` stub with real builder calls.
  - Support optional `components` filtering.
  - Log per-service build status + digest output.
- Update action input handling:
  - Add `tag` field (optional) and `build_mode` (optional override).
- Extend `resolveActionInput()`:
  - For `release` action, include `image_digests` from dependency outputs.
- Update `handleRelease()` to store `image_digests_json`.

**Files likely touched**
- `apps/worker/src/action-executor/action-executor.service.ts`
- `packages/shared/src/schemas/pipeline.ts` (if adding new build inputs)

### Phase 4: Legacy Runner Strategy

**Preferred**: Route all pipelines to job-based execution (deprecate legacy runner).

**Tasks**
- Update `apps/api/src/pipelines/pipeline-runs.service.ts` to always call `createRunAsJobs`.
- Update `docs/system/pipelines.md` to remove legacy runner reference.
- Ensure legacy endpoints still function but internally use jobs.

**Fallback** (if deprecation is risky):
- Update `apps/worker/src/pipeline-runner/pipeline-runner.service.ts`:
  - Replace `handleBuild` stub with `ImageBuilderService`.
  - Keep behavior aligned with job-based path.

### Phase 5: Example Repo + Manual Scenario

**Goal**: Make Scenario 05 reliable with real builds.

**Tasks**
- Ensure `eve-horizon-fullstack-example` has:
  - `registry` config + `services.*.build + image` configured.
  - Valid GHCR image names.
- Update `tests/manual/scenarios/05-deploy-flow.md`:
  - Explicit secrets: `GHCR_USERNAME`, `GHCR_TOKEN`, `GITHUB_TOKEN`.
  - Mention build step should show digests.

### Phase 6: Tests + Docs

**Tests**
- Unit: buildable services resolver.
- Integration: mock builder returns digests; release stores `image_digests_json`.
- Pipeline: deploy uses digests and succeeds in k8s (manual for now).

**Docs**
- `docs/system/container-registry.md` (remove “planned” status for build).
- `docs/system/pipelines.md` (clarify build action outputs).
- `docs/system/deployment.md` (note digest-based deploy).

## Backend Choice Rationale

- **Kaniko** is the safest for k8s because it avoids privileged Docker and is well-supported in cluster builds.
- **Buildx** is fastest for local dev and leverages existing Docker caches.
- Pluggable interface keeps both paths consistent and testable.

## File-Level Task Breakdown (Initial Pass)

- `apps/worker/src/build/` (new):
  - `image-builder.interface.ts`
  - `image-builder.service.ts`
  - `docker-buildx-builder.ts`
  - `kaniko-builder.ts`
- `apps/worker/src/action-executor/action-executor.service.ts`
  - Replace `handleBuild`, wire `ImageBuilderService`.
  - Persist `image_digests_json` in release.
- `apps/worker/src/pipeline-runner/pipeline-runner.service.ts` (if fallback path used)
- `apps/worker/src/deployer/deployer.service.ts`
  - Extract registry auth helper.
- `packages/shared/src/schemas/manifest.ts`
  - `getBuildableServices()` helper.
- `docs/system/container-registry.md`, `docs/system/pipelines.md`, `tests/manual/scenarios/05-deploy-flow.md`

## Rollout Plan

1) Land Phase 0–3 and test job-based pipelines in k3d.
2) Update manual scenario docs + example repo.
3) Remove legacy runner or keep fallback with deprecation note.
4) Add integration tests and update docs.

## Acceptance Criteria (Refined)

- Build action produces real digests for all buildable services.
- Release record stores non-empty `image_digests_json`.
- Deploy uses digests (image refs contain `@sha256:`).
- Scenario 05 passes end-to-end without manual `k8s-image push`.

## Proposed Architecture (High Level)

```
Pipeline Build Step
  -> ImageBuilderService (worker)
      -> Resolve manifest + registry auth
      -> Build + push per service
      -> Capture digest per image
  -> Step output: image_digests
Release Step
  -> Persist image_digests_json on release
Deploy Step
  -> Render manifest with image digests
  -> Kubernetes pulls immutable digests
```

## Workstreams

### 1) Shared Build Engine (Worker)

**Deliverables**
- `ImageBuilderService` (or similar) in `apps/worker/` used by both action executor and pipeline runner.
- Build backend interface with `buildAll(...) -> Record<service, digest>`.
- Registry auth helper (refactor from deployer) that:
  - Resolves `registry.auth.username_secret` / `token_secret`.
  - Produces a Docker config JSON (for build + push).
- Workspace preparation helper (reuse pipeline runner logic) to checkout repo at `git_sha`.

**Notes**
- Build step should parse the manifest for services with `build` and `image`.
- Allow explicit `components` list in action input to limit builds.
- Record per-service build metadata in logs (context, dockerfile, tag).
- Fail fast on any build error (no silent skips).

### 2) Build Backend Implementation

**Local (Docker Buildx)**
- Use `docker buildx build --push --tag <image:tag>`.
- Capture digest:
  - Prefer `--iidfile` + `docker buildx imagetools inspect` for registry digest.
  - Or use `--metadata-file` to parse the pushed digest.

**k8s (Kaniko Job)**
- Create a build job per service in a dedicated namespace (e.g., `eve-build`).
- Init container clones the repo at `git_sha` into an `emptyDir` volume.
- Kaniko container builds using `--context` and `--dockerfile`.
- Use `--digest-file` to capture the digest.
- Mount registry auth secret as `/kaniko/.docker/config.json`.
- Pull git auth (GITHUB_TOKEN) from secrets for private repos.

### 3) Pipeline Integration (Job-Based)

**Action Executor**
- Replace `handleBuild` stub with `ImageBuilderService`.
- Extend `ActionInput` to accept `components` and optional `tag`.
- Ensure build output is returned as `{ image_digests: { service: digest } }`.

**Release Action**
- Extend `resolveActionInput` to pull `image_digests` from:
  - Pipeline run inputs
  - Step outputs of dependencies
- Update `handleRelease` to persist `image_digests_json`.

### 4) Legacy Pipeline Runner Compatibility

Option A (Preferred): Route all action-only pipelines to job-based execution.
- Update `PipelineRunsService` to always use the expander (job graph), even for action-only pipelines.
- Update docs and CLI notes to remove the legacy runner reference.

Option B (Fallback): Update legacy runner build step to reuse `ImageBuilderService`.
- Replace `handleBuild` no-op in `pipeline-runner.service.ts`.
- Keep legacy runs functional until fully deprecated.

### 5) Example Repo + Manual Test Flow

- Ensure `eve-horizon-fullstack-example` manifest includes valid `build` + `image`.
- Add or update GH Actions in the example repo (optional) to push images for smoke testing.
- Update `tests/manual/scenarios/05-deploy-flow.md`:
  - Explicitly require GHCR secrets.
  - Verify build step in pipeline run logs.

### 6) Tests + Docs

**Tests**
- Unit tests for manifest build parsing and registry auth resolution.
- Integration test for build action (mock builder in CI to avoid real pushes).
- Pipeline integration test to assert `image_digests_json` is populated on release.

**Docs**
- Update `docs/system/container-registry.md` to reflect implemented build path.
- Update `docs/system/pipelines.md` to clarify build action behavior and backend.

## Definition of Done

- Build action creates images and pushes to registry for all buildable services.
- Build step outputs include real digests.
- Release stores `image_digests_json` populated from build outputs.
- Deploy uses digests and succeeds without manual image import.
- Manual Scenario 05 passes end-to-end in k8s with real pipeline build.

## Risks / Open Questions

- Build backend choice: Kaniko vs BuildKit (performance vs complexity).
- Private repo clone strategy inside k8s build jobs.
- Digest extraction reliability across registries.
- Should action-only pipelines always use job-based execution (preferred) or keep legacy runner?
