# PR Preview Environments (Auto-Deploy)

> Plan (Proposed)
> Last Updated: 2026-01-29

## Context

We want PR environments so reviewers can test the dashboard app (see
`docs/plans/system-dashboard-app-plan.md`) on a real deployment. The top-level
epic job should enter final review with a working preview URL and a concrete
login command (CLI token flow). We are not doing Playwright in v1.

## Goals

- Auto-deploy every PR commit to a preview environment.
- Provide a stable, shareable URL in the final review summary.
- Capture PR metadata on the environment (number, branch, SHA, URL).
- Clean up preview environments when PRs close.
- Keep this generic so any repo can opt in.

## Non-goals

- Playwright or full browser automation.
- Full browser auth flow (device code, WebAuthn).
- Complex multi-tenant preview management across many orgs.

## Decisions (Locked)

- Use explicit `env-ensure` before deploy (no auto-create on deploy).
- No TTL cleanup; remove preview envs on PR close or manual delete only.
- Project-level secrets only (no env-level secret overrides in v1).
- Preview URL exposed in step `result_json`, pipeline run output, and root job result.

## Proposed Default: Per-PR Environments

Use one environment per PR to avoid collisions and enable parallel review.

- Environment name: `pr-<number>` (example: `pr-123`)
- Environment type: `persistent`
- Labels (stored on env record):
  - `pr_number`, `pr_branch`, `pr_sha`, `pr_url`, `base_branch`, `repo`
- Ingress URL: `{service}.{project}-{env}.{domain}`

## Fallback: Shared Test Environment (Optional)

If per-PR envs are not available, allow a shared `test` env for a single PR at
a time. This is a last resort because PRs overwrite each other.

## Trigger + Pipeline Flow

### Events

GitHub webhook normalization already exists (`github.pull_request`). We should
route PR events into pipeline runs.

Required PR actions:
- `opened`, `synchronize`, `reopened` -> deploy
- `closed` -> cleanup

### Pipeline Inputs (from event payload)

The event router should pass the following inputs into the pipeline run:

```json
{
  "pr_number": 123,
  "pr_branch": "feat/dashboard",
  "pr_sha": "abc123",
  "pr_url": "https://github.com/org/repo/pull/123",
  "base_branch": "main",
  "repo": "org/repo",
  "env_name": "pr-123"
}
```

### Pipeline Steps (deploy)

1. ensure-env (new action, required)
2. build
3. release
4. deploy (target env = `env_name`)
5. smoke (optional script: curl root or health endpoint)

### Pipeline Steps (cleanup)

1. delete-env (new action)

### Concurrency + Deduping

- Use a dedupe key of `pr-<number>` so a new commit cancels or supersedes
  an in-flight deploy for the same PR.
- Environment gating already prevents parallel deploys to the same env.

## Manifest Sketch

```yaml
pipelines:
  deploy-pr:
    trigger:
      github:
        event: pull_request
        action: [opened, synchronize, reopened]
        base_branch: main
    steps:
      - name: ensure-env
        action:
          type: env-ensure
          input: { env_name: "${inputs.env_name}", kind: "preview" }
      - name: build
        action: { type: build }
      - name: release
        depends_on: [build]
        action: { type: release }
      - name: deploy
        depends_on: [release]
        action:
          type: deploy
          input: { env_name: "${inputs.env_name}" }
      - name: smoke
        depends_on: [deploy]
        script:
          run: "curl -fsS ${PIPELINE_OUTPUT.preview_url}/health"

  cleanup-pr:
    trigger:
      github:
        event: pull_request
        action: closed
        base_branch: main
    steps:
      - name: delete-env
        action:
          type: env-delete
          input: { env_name: "${inputs.env_name}" }
```

Notes:
- `env-ensure` and `env-delete` are new actions.
- `inputs.*` mapping is illustrative; we need exact templating rules.

## Reviewer Login Flow

We need a concrete CLI command that produces a token for the dashboard UI.
Options:

Primary choice:
- Add `eve auth token --print` (short-lived access token).

Deferred:
- `eve auth status --json --include-token`.
- CLI -> UI one-time token exchange endpoint.

The pipeline (or epic job summary) should include:

```
Preview URL: https://web.dashboard-pr-123.<domain>
Auth command: eve auth token --print
```

## Required Platform Changes

1. Trigger filters for `pull_request` actions (opened, synchronize, reopened, closed).
2. Event router passes PR metadata into pipeline inputs.
3. Deploy step accepts `env_name` input (dynamic env per PR).
4. Action support for `env-ensure` and `env-delete` (or auto-create on deploy).
5. Pipeline output aggregates `preview_url` (and env metadata) from step results.
   The root job result should also include the pipeline output payload.
6. CLI token helper for UI login.
7. CLI `eve env delete <name>` (admin-only) for manual cleanup.

## Implementation Plan (Phased)

### Phase 0: Spec + Baseline

- Document trigger schema for PR actions.
- Confirm how pipeline inputs map to event payloads.
- Decide env naming rule and metadata fields.

### Phase 1: Trigger + Inputs

- Add PR action filters in trigger matcher.
- Map PR payload -> pipeline inputs (number, branch, sha, url).
- Add dedupe key for PR runs.

### Phase 2: Env Lifecycle Actions

- Implement `env-ensure` action (create if missing, update labels).
- Implement `env-delete` action (remove env + associated releases).
- Add `env_name` input support to `deploy`.
- Add CLI `eve env delete <name>` wrapper for manual cleanup.

### Phase 3: Preview URL Output

- Compute preview URL from env + ingress rules.
- Store in deploy step `result_json`, aggregate in pipeline run output, and
  copy to the root job result.
- Surface preview URL in job summary and CLI (`eve pipeline show-run` and
  `eve job result`).

### Phase 4: CLI Token Helper

- Add `eve auth token --print` or equivalent.
- Update docs to show reviewer login steps.

### Phase 5: Docs + Runbook

- Update `docs/system/pipelines.md` with PR trigger examples.
- Update dashboard plan with preview env flow.

## Testing Plan (No Playwright)

- Unit: trigger filters, env name derivation, dedupe logic.
- Integration: simulate PR webhook -> pipeline run -> env created -> deploy.
- Manual: open preview URL and log in with CLI token.
- Cleanup: PR close triggers env deletion; manual `eve env delete pr-123` works.

## Open Questions

- (None. All v1 questions resolved.)

## Success Criteria

- PR open/sync auto deploys to `pr-<number>`.
- Preview URL is visible in the pipeline run and epic review summary.
- Reviewers can log in using a single CLI command.
- PR close deletes the preview env and releases.
