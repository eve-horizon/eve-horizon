# Builds (First-Class Primitive)

> Status: Current
> Last Updated: 2026-01-31
> Purpose: Document BuildSpecs, BuildRuns, and BuildArtifacts as first-class primitives.

## Overview

Builds are now explicit system primitives, independent of pipelines and jobs.
They provide a stable record of what was built (spec), how it was built (run),
and what was produced (artifacts). Releases reference `build_id` and derive
image digests from artifacts for deterministic deploys.

## Core Concepts

### BuildSpec
Immutable input defining *what* to build.

Fields:
- `project_id`, `git_sha`, `manifest_hash`
- `services` (subset of manifest services)
- `inputs`, `registry`, `cache`

### BuildRun
Execution instance defining *how* and *where* a build ran.

Fields:
- `build_id`, `status`, `backend`
- `runner_ref`, `logs_ref`, `error_message`
- `started_at`, `completed_at`

### BuildArtifact
Output record defining *what* was produced.

Fields:
- `service_name`, `image_ref`, `digest`
- `platforms`, `size_bytes`
- `sbom_ref`, `provenance_ref` (reserved)

## API

```
POST /projects/{project_id}/builds        # create BuildSpec
GET  /projects/{project_id}/builds        # list BuildSpecs
GET  /builds/{build_id}                   # BuildSpec detail
POST /builds/{build_id}/runs              # create BuildRun
GET  /builds/{build_id}/runs              # list BuildRuns
GET  /builds/{build_id}/artifacts         # list BuildArtifacts
GET  /builds/{build_id}/logs              # stream BuildRun logs
POST /builds/{build_id}/cancel            # cancel latest or specified run
```

## CLI

```
eve build create --project <id> --ref <sha> --manifest-hash <hash> [--services <list>] [--repo-dir <path>]
eve build list [--project <id>]
eve build show <build_id>
eve build run <build_id>
eve build runs <build_id>
eve build logs <build_id> [--run <id>]
eve build artifacts <build_id>
eve build diagnose <build_id>
eve build cancel <build_id>
```

## Build Backends

- **Local:** Docker Buildx (default)
- **Kubernetes:** BuildKit (default)
- **Fallback:** Kaniko (only if BuildKit unavailable)

## Release Integration

- Release creation accepts `build_id`
- Image digests are derived from BuildArtifacts
- Deploys use digest-based image references for immutability

## Validation & Errors

- `manifest_hash` must match the synced manifest for the project ref
- Releases require a valid `build_id` that exists for the project
- Mismatches surface explicit errors; re-run build or re-sync the manifest

## Diagnostics

Use `eve build diagnose <build_id>` to pull spec, runs, artifacts, and recent logs
in one command.

## Observability

### Build Logs

```bash
eve build logs <build_id>              # Timestamped build output
eve build logs <build_id> --run <id>   # Specific run's logs
```

Each log line is prefixed with `[HH:MM:SS]` timestamps for easy correlation.

### Build Diagnosis

```bash
eve build diagnose <build_id>          # Full state: spec + runs + artifacts + logs
```

Shows:
- Build spec (git SHA, manifest hash, services)
- All runs with status, backend, timestamps
- Build artifacts (images, digests)
- Recent logs (last 50 entries)
- **Error classification** with actionable hints

### Error Codes

When builds fail, errors are classified automatically:

| Code | Label | Hint |
|------|-------|------|
| `auth_error` | Authentication Error | Check GITHUB_TOKEN via `eve secrets set` |
| `clone_error` | Git Clone Error | Verify repo URL and access |
| `build_error` | Build Error | Run `eve build diagnose <build_id>` for full output |
| `timeout_error` | Timeout Error | Check resources and timeouts |
| `resource_error` | Resource Error | Check disk space and memory |
| `registry_error` | Registry Error | Check registry credentials |

### BuildKit Output

Build failures include the last 30 lines of buildkit output and identify the failed Dockerfile stage:

```
Error: buildctl failed with exit code 1 at [build 3/5] RUN pnpm install
--- Last 12 lines ---
#8 [build 3/5] RUN pnpm install --frozen-lockfile
#8 ERROR: process "pnpm install --frozen-lockfile" did not complete successfully
...
```

### Pre-Build Visibility

Clone, checkout, and workspace preparation phases now produce observable log entries, visible through `eve build logs` and `eve job diagnose`.

## Related

- [pipelines.md](./pipelines.md)
- [container-registry.md](./container-registry.md)
