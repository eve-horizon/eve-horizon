# Self-Service Deploy Recovery for Eve-Compatible Apps

> Status: Superseded by `docs/plans/deploy-recovery-and-db-reset-plan.md`
> Last Updated: 2026-02-15
>
> Incident context (local k3d, February 15, 2026):
> - Existing project pipeline migrate failed with Prisma `P3018` (`relation "projects" already exists`)
> - Direct deploy left new pods in `ImagePullBackOff` (`eve-registry.../evepm/api:latest` not found), old release remained live
> - Fresh project pipeline: clone auth initially failed, build/release later passed, migrate failed on managed DB provisioning TLS
> - Manual scenario M01 hit `404` on `/api/v1/projects` because old API contract stayed active

## The Problem

Eve-compatible app teams can trigger deploys, but when deploys fail part-way they
cannot reliably recover on their own. Today, rollback/cleanup capabilities are
incomplete at the CLI/API layer even though some lower-level primitives exist.

Result: teams get stuck between "new release failed" and "old release still
serving", with no deterministic self-service path to:

1. roll back quickly,
2. clear broken environments safely, and
3. retry from known-good state.

## Goals

1. App teams can recover a failed deploy without platform operator intervention.
2. Recovery commands are explicit, auditable, and idempotent.
3. Environment state in DB matches what is actually running in k8s.
4. Local k3d behavior matches the same recovery semantics expected in staging.

## Current State and Gaps

### What already exists

1. `eve pipeline cancel <run-id>` can stop an active pipeline run.
2. `eve env diagnose`, `eve env services`, and `eve env logs` provide strong diagnostics.
3. `eve db status` and `eve db destroy --force` exist for managed DB tenant recovery.
4. Worker internals already have rollback/delete deployment primitives.

### What is missing or inconsistent

1. `eve env delete` (API path) removes environment records but does not explicitly
   tear down k8s namespace resources first.
2. Rollback exists in worker internals but is not exposed as user-facing API/CLI.
3. API deploy supports `release_tag`, but CLI `eve env deploy` does not expose that
   path for quick rollback-to-known-release.
4. Direct deploy path sets `current_release_id` immediately after deploy request,
   not after readiness confirmation.
5. Local managed DB provisioning enforces TLS by default when `sslmode` is absent,
   which can fail in local setups.

## Proposal: Recovery as First-Class Product Surface

### P0 (must-have)

1. **Full environment teardown in `env delete`**
   - `eve env delete <env> --project <id> --force` should:
   - delete namespace resources (or entire namespace if dedicated),
   - clear environment record,
   - mark managed DB tenant for deletion,
   - return a clear teardown summary.
   - Behavior must be idempotent.

2. **User-facing rollback command**
   - Add `eve env rollback <env> --project <id> --release <release_id|tag|previous>`.
   - API endpoint should validate release belongs to same project/environment context.
   - Output should include release, readiness status, and warnings.

3. **Deploy by release tag in CLI**
   - Extend `eve env deploy` with `--release-tag <tag>`.
   - Enables instant redeploy of a known-good release without recomputing manifest inputs.

4. **Readiness-gated release pointer**
   - Only set `environments.current_release_id` when deployment is ready.
   - If deployment fails or times out, keep prior release pointer unchanged.

5. **Local managed DB TLS mode fix**
   - For local provider, do not force `sslmode=require` when local instance does not
     support TLS.
   - Add explicit config to control local DB TLS mode.

### P1 (high-value follow-up)

1. **`eve env reset` composite command**
   - `reset` = cancel active runs + teardown env + recreate env + optional redeploy.
   - Useful for local recovery loops and preview environments.

2. **Preflight for deploy image availability**
   - Validate referenced image tag/digest exists before switching workloads.
   - Fail fast with actionable error (registry/image/tag).

3. **Recovery diagnostics summary**
   - Add `eve env recover diagnose <env>` to summarize:
   - active pipeline runs,
   - last successful release,
   - pod failure reasons (`ImagePullBackOff`, crash loops),
   - managed DB tenant state,
   - one-command suggested next step.

## Interim Runbook (usable now)

Until P0 ships, app teams should use this sequence:

1. Cancel in-flight run: `eve pipeline cancel <run-id> --reason "recovery"`
2. Capture env diagnosis:
   - `eve env diagnose <project> <env> --events 50`
   - `eve env services <project> <env>`
3. If managed DB failed:
   - `eve db status --project <project> --env <env>`
   - `eve db destroy --project <project> --env <env> --force` (only when safe to recreate)
4. Redeploy with explicit ref:
   - `eve env deploy <env> --project <project> --ref <sha> --repo-dir <repo>`
5. Re-run manual scenario checks against env ingress and API contract.

## Implementation Map

Likely touchpoints for P0:

1. `apps/api/src/environments/environments.service.ts` (delete flow, deploy state updates)
2. `apps/api/src/environments/environments.controller.ts` (rollback/reset endpoints)
3. `packages/cli/src/commands/env.ts` (new `rollback`, `--release-tag`, improved delete output)
4. `packages/shared/src/schemas/release.ts` + env response schemas (request/response shape)
5. `apps/worker/src/deployer/deployer.controller.ts` (expose rollback/delete operations safely)
6. `apps/orchestrator/src/cron/managed-db-reconciler.service.ts` (local TLS handling)

## Success Criteria

1. A failed deploy can be recovered by app teams in under 5 minutes without kubectl.
2. `eve env delete` leaves no orphaned env workloads in k8s.
3. Rollback success rate is deterministic for valid release IDs/tags.
4. Manual scenario M01 and equivalent smoke checks pass after recovery workflows.
