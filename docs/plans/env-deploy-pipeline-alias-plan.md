# Env Deploy + Promotion Flow Plan

> Plan (Proposed)  
> Last Updated: 2026-01-28  
> Owner: TBD

## Summary

Make `eve env deploy` run the environment’s configured pipeline (if present), require an explicit `--ref`, and make promotion from **test → staging → prod** obvious via a release lookup command + pipeline inputs. This preserves determinism and eliminates confusion between direct deploy and pipeline runs.

## Goals

- `eve env deploy <env> --ref <sha>` runs the env’s configured pipeline.
- CLI requires explicit `--ref` (no implicit HEAD).
- Provide a **release lookup CLI** to promote the same build across envs.
- Support env-specific `pipeline_inputs` in manifest (merge with CLI inputs).
- Make the test → release → deploy promotion flow obvious in docs and examples.

## Non-goals

- Redesigning pipeline/action execution.
- Removing the ability to do direct deploys entirely (keep escape hatch).
- Full automation of “promotion gates” beyond existing approvals.

## Current Behavior (as of 2026-01-28)

- `eve env deploy` bypasses pipelines and deploys directly.
- `eve pipeline run` is a separate path with different semantics.
- Docs/examples imply `env deploy` is a pipeline alias, but it isn’t.

## Target UX

### Standard Promotion Flow (obvious)

```bash
# 1) Build + test + release in test
eve env deploy test --ref <sha>

# 2) Resolve release tag → ref/release_id
eve release resolve v1.2.3 --project <id>

# 3) Promote same release to staging (no rebuild)
eve env deploy staging --ref <sha> --inputs '{"release_id":"rel_xxx"}'

# 4) Promote same release to production (approval gate)
eve env deploy production --ref <sha> --inputs '{"release_id":"rel_xxx"}'
```

### Manifest Pattern (single deploy pipeline reused)

```yaml
environments:
  test: { pipeline: deploy-test }
  staging: { pipeline: deploy }
  production:
    pipeline: deploy
    approval: required
```

## Proposed Behavior

1. **Default**: `env deploy` resolves `environments.<env>.pipeline` and triggers a pipeline run.
2. **Explicit ref**: CLI requires `--ref` for `env deploy`.
3. **Inputs**: allow `environments.<env>.pipeline_inputs` merged with `--inputs` (CLI wins).
4. **Escape hatch**: `env deploy --direct` uses the existing direct deploy endpoint.
5. **Release promotion**: use `eve release resolve <tag>` to provide `release_id` + `git_sha`.

## API Changes (Primary)

### 1) Env Deploy → Pipeline
**Target:** `apps/api/src/environments/environments.service.ts`

- Load latest manifest and read `environments.<env>.pipeline`.
- If present, call `PipelineRunsService.createRun` with:
  - `ref` (git SHA)
  - `env` (env name)
  - `inputs` (merged from manifest + request)
- If absent or `direct=true`, fall back to existing deploy flow.

### 2) Release Lookup
Add a release lookup endpoint:

```
GET /projects/:id/releases?tag=v1.2.3
```

Returns `{ release_id, git_sha, manifest_hash, tag, version }`.

## CLI Changes (Required)

### 1) `env deploy`
**Target:** `packages/cli/src/commands/env.ts`

- Require `--ref`.
- Add `--direct` flag to bypass pipelines.
- Add `--inputs` to pass JSON inputs.
- Remove or deprecate `--release-tag` (use `release resolve` instead).

### 2) `release resolve`
**New CLI command**:

```
eve release resolve <tag> [--project <id>]
```

Outputs:
- `release_id`
- `git_sha`
- `manifest_hash`
- `tag`, `version` (for human context)

## Pipeline Inputs (Manifest + Run)

Add to manifest schema:

```yaml
environments:
  staging:
    pipeline: deploy
    pipeline_inputs:
      release_id: rel_xxx
      smoke_test: false
```

Merge rules:
- `manifest pipeline_inputs` + `CLI --inputs`
- CLI inputs override manifest keys.

## Worker Changes (Promotion Support)

**Target:** `apps/worker/src/action-executor/action-executor.service.ts`

- When executing a deploy action, allow `release_id` to come from:
  1. step outputs (existing)
  2. pipeline run inputs (new)
  3. action config (explicit override)

This enables staging/prod deploys to reuse a test release without rebuilding.

## Documentation Updates (core repo)

- `README.md`: show explicit `--ref` and promotion flow.
- `docs/system/pipelines.md`: note `env deploy` is a pipeline alias.
- `docs/system/manifest.md`: add `pipeline_inputs` field and reuse guidance.
- `docs/system/job-cli.md`: update related examples if needed.

## Sister Repo Updates

### eve-horizon-fullstack-example
- Update `README.md` + `AGENTS.md` with explicit `--ref` and promotion flow.
- Ensure manifest uses a reusable deploy pipeline.

### eve-horizon-starter
- Update `README.md` + `AGENTS.md` with explicit `--ref`.
- Add/confirm manifest env → pipeline mapping and reuse pattern.

## Testing

- Integration tests:
  - `env deploy` creates pipeline run if env has `pipeline`.
  - `env deploy --direct` uses direct deploy endpoint.
  - `release resolve` returns tag → release_id + ref.
  - `deploy` action can use `release_id` from run inputs.
- Update e2e tests/examples that assumed direct deploy.

## Open Questions (Remaining)

1. **Deprecation path for `--release-tag`**  
   **Decision:** Hard removal from `env deploy`.

2. **Exact API shape for release lookup**  
   **Decision:** `GET /projects/:id/releases/by-tag/:tag` (single resource, 404 if missing).

3. **Where to store release_id after test**  
   **Decision:** No output file. Use existing pipeline step outputs and print a “next steps”
   hint in CLI when `--wait` is used (JSON output already includes step outputs).
