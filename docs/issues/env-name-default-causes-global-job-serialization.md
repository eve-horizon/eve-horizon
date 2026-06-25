# defaults.env Causes Global Job Serialization

> **Status**: OPEN
> **Severity**: High — silently breaks all multi-job projects
> **Created**: 2026-03-31
> **Discovered in**: downstream deck-builder deployment (DeckBld project)

## Problem

When a manifest declares `x-eve.defaults.env: sandbox`, **every** ad-hoc job created via the API inherits `env_name: sandbox`. This causes every job — research tasks, planning tasks, chat messages, web research — to acquire an exclusive environment gate (`env:{project_id}:sandbox`). The result: only one job can run at a time across the entire project, regardless of whether the job has anything to do with environment mutation.

In practice, a single stuck or long-running agent job holds the gate and blocks everything else — including deploy pipelines, migrations, and other unrelated agent work. The app developer has no idea this is happening until they notice jobs queuing up with 200+ failed claim attempts.

## Impact (Real Incident)

On the DeckBld project:
- A deck-planning agent job acquired the sandbox gate and ran for ~5 minutes
- During that time, 6 other jobs (research runs, chat messages, a migration) were blocked
- When the agent job retried 287 times before succeeding, each retry held the gate for the attempt duration
- The migration job couldn't run, meaning the `trigger_match_count` column was missing for hours
- Debugging took over an hour because the symptoms (jobs stuck in `ready`, instant-fail attempts) gave no indication that env gating was the cause

## Root Cause

`env_name` serves two completely unrelated purposes:

1. **API scope** — resolves which app APIs (in-cluster service URLs, CLIs) are available to the job
2. **Environment gate** — acquires an exclusive mutex to prevent concurrent environment mutations

These concerns are conflated in a single field. The manifest default `x-eve.defaults.env` was designed so apps don't have to pass `--env sandbox` on every CLI command, but it has the side effect of gating every job.

### Code Path

**Job creation** (`apps/api/src/jobs/jobs.service.ts:467-470`):
```typescript
const envDefault = defaults.env;
if (data.env_name === undefined && typeof envDefault === 'string' && envDefault.length > 0) {
  data.env_name = envDefault;  // Every job gets env_name from manifest
}
```

**Job claim** (`apps/api/src/jobs/jobs.service.ts:1190-1193`):
```typescript
const explicitGates = job.hints?.gates ?? [];
const envGate = job.env_name ? [`env:${job.project_id}:${job.env_name}`] : [];
const requiredGates = [...explicitGates, ...envGate];
```

Every job with `env_name` acquires the gate. No distinction between "I need the API" and "I'm mutating the environment".

### Why the Workaround is Bad

The current workaround is for app code to pass `env_name: null` in every `createJob` call:

```typescript
await eve.createJob({
  description: '...',
  hints: { app_apis: ['app'] },
  env_name: null,  // <-- every app must remember this or jobs serialize
});
```

This is a trap:
- Nothing in the docs warns about it
- The manifest default _looks_ helpful ("my jobs will target sandbox by default")
- The failure mode is silent — jobs just queue, no error message explains why
- Workflow steps (which set env_name differently) work fine, masking the issue
- App developers discover it only after their agents grind to a halt in production

## Proposed Fix

### Option A: Don't apply `defaults.env` to ad-hoc jobs (simplest)

The environment default should only apply to **pipeline steps** and **action jobs** — things that actually interact with the environment lifecycle. Ad-hoc jobs created via `POST /projects/:id/jobs` should default to `env_name: null`.

```typescript
// jobs.service.ts:467-470
const envDefault = defaults.env;
if (data.env_name === undefined && typeof envDefault === 'string' && envDefault.length > 0) {
  // Only apply env default to pipeline/action jobs, not ad-hoc agent jobs
  if (data.run_id || data.action_type) {
    data.env_name = envDefault;
  }
}
```

App APIs still resolve without `env_name` — `resolveApisFromManifest()` already falls back to the first active environment's service URLs. This path is proven: workflow step jobs use it today.

### Option B: Separate API scope from environment gate (cleanest)

Introduce `api_env` (or reuse `hints.app_apis`) as the API resolution scope, independent of the gate:

```typescript
// Job claim — only gate on env_name for action/deploy jobs
const envGate = (job.env_name && job.action_type) ? [`env:${job.project_id}:${job.env_name}`] : [];
```

Or more precisely, only gate when `hints.env_gate !== false`:

```typescript
const shouldGate = job.env_name && (job.hints?.env_gate !== false);
const envGate = shouldGate ? [`env:${job.project_id}:${job.env_name}`] : [];
```

This preserves backward compatibility — existing pipelines and action jobs still gate — while letting agent jobs opt out.

### Option C: Gate only action_type jobs (most precise)

The environment gate exists to prevent concurrent deploys/migrations from conflicting. Gate only when `action_type` is set:

```typescript
const envGate = (job.env_name && job.action_type) ? [`env:${job.project_id}:${job.env_name}`] : [];
```

This is the most surgical fix. Pipeline steps have `action_type` (deploy, migrate, release). Ad-hoc agent jobs don't. The gate applies exactly where it's needed.

## Recommendation

**Option A** for the immediate fix (one line, zero risk to pipelines). **Option C** as the follow-up (gate only actions, env_name becomes purely an API scope for all other jobs).

Both options require no changes to existing manifests, CLI behavior, or pipeline definitions. The only observable change: ad-hoc jobs stop blocking each other.

## Files to Change

| File | Change |
|------|--------|
| `apps/api/src/jobs/jobs.service.ts:467-470` | Option A: skip env default for non-pipeline jobs |
| `apps/api/src/jobs/jobs.service.ts:1190-1193` | Option C: gate only when action_type is set |
| `apps/api/test/integration/job-env-gates.integration.test.ts` | Add test: ad-hoc job with env_name does NOT acquire gate |

## Workaround (Current)

Apps must explicitly pass `env_name: null` in every `createJob` call. This is what the downstream deck-builder deployment does today. It works but shouldn't be necessary.
