# Long-Running Script Job Durability Plan

> **Status**: Proposed 2026-05-21
> **Scope**: One Eve Horizon implementation PR
> **Source**: Downstream gap report: "Long-running script jobs should survive worker HTTP request boundaries"
> **Related**:
> - `docs/plans/workflow-script-step-materialization-plan.md` - shipped in `release-v0.1.284`; workflow `script:` / `run:` steps materialize as script jobs
> - `docs/plans/script-action-step-toolchains-plan.md` - shipped 2026-05-19; declarative toolchains on script/action-run
> - `docs/plans/script-step-env-overrides-injection-plan.md` - shipped 2026-05-20; `env_overrides` injection into script/action-run bash
> - `docs/plans/agent-runtime-feature-parity-plan.md` - established the accepted-then-poll runner-event pattern
> - `docs/plans/app-ingress-tuning-plan.md` - context on the 300s ingress timeout

## Problem

Workflow `script:` steps can legitimately run for many minutes: dispatch child
agent jobs, wait for those children, collect results, and publish a review
package. Authors can declare a long `script.timeout`, but today the parent
script can fail at about five minutes with `Failed to invoke worker: fetch
failed` while its child jobs keep running.

That failure is a transport artifact, not the script's authoritative timeout.
The script publish phase never runs, the child results are orphaned, and users
are pushed into external continuation protocols outside the workflow.

## Current Wiring

Agent jobs already use the durable shape:

- `apps/orchestrator/src/worker/worker.client.ts` posts to `/invoke`.
- `apps/worker/src/invoke/invoke.controller.ts` returns HTTP 202 immediately.
- The worker emits `runner.completed` / `runner.failed`.
- The orchestrator polls events with `pollForCompletion()`.

Script and action jobs do not:

- `invokeScriptJob()` and `invokeActionJob()` call `invokeSimpleWorkerJob()`.
- `invokeSimpleWorkerJob()` opens one blocking HTTP request to
  `/scripts/execute` or `/actions/execute` and waits for the full result body.
- `ScriptExecutorController` and `ActionExecutorController` await the executor
  before returning HTTP 200.
- Script and action-run commands use `execFileAsync('bash', ['-c', command])`,
  so stdout/stderr are buffered until process exit and capped at 1 MB.

There is also a timeout-source mismatch to fix in the same PR:

- Workflow and pipeline script steps persist `script_timeout_seconds` on the job
  row.
- The orchestrator currently passes `job.hints?.timeout_seconds ?? 1800` as the
  worker invocation timeout.
- A script step with `script.timeout: 5400` can therefore still be polled with a
  default 30-minute ceiling unless the manifest also set a hints timeout.

## Goal

A script or pipeline `action: { type: run }` job should complete or fail by its
declared execution timeout, not by an HTTP request boundary. Long-running script
and action-run output should be visible incrementally through normal attempt
logs instead of appearing only after process exit.

## Single PR Scope

The PR should make the smallest coherent change that closes the gap:

1. Make `/scripts/execute` and `/actions/execute` accepted-then-background
   endpoints that mirror `/invoke`.
2. Make the orchestrator submit script/action jobs with a short HTTP timeout,
   then poll runner events for completion.
3. Use the correct execution timeout source for the poll ceiling:
   `job.script_timeout_seconds` for script jobs, `action_input.timeout_seconds`
   or `action_input.timeout` for `action: { type: run }`, then
   `job.hints.timeout_seconds`, then the existing default.
4. Replace `execFileAsync` for script and action-run bash with a small worker-local
   streaming process helper based on `spawn`.
5. Write stdout/stderr incrementally to `execution_logs`, keep a bounded tail for
   `resultText` / `resultJson`, and enforce an explicit output cap with one
   warning log when truncation starts.
6. Enforce script/action-run timeout in the worker process helper with
   SIGTERM, a short grace period, then SIGKILL.
7. Return the same `HarnessResult` shape to the orchestrator through
   `runner.completed`; use structured error messages/log content for
   `script_timeout`, `action_run_timeout`, `worker_submit_failed`, and
   `poll_timeout`.

## Keep Out Of This PR

- A generic `packages/shared` runner background-execution abstraction. Three
  small controller paths can be unified later if duplication becomes painful.
- A new manifest field or CLI flag.
- A DB migration.
- Reworking the legacy `/pipeline-runs/:id/execute` path.
- A new parent/child job result protocol. Scripts can continue to use
  `eve job wait` / `eve job show`.
- New `eve job diagnose` UX. Structured logs/results are enough for this PR;
  improve diagnose output later only if the existing renderer does not surface
  the new error codes clearly.
- Worker self-termination for script/action jobs. Shared worker deployments
  should stay alive.

## Implementation Details

### Worker Controllers

Update:

- `apps/worker/src/script-executor/script-executor.controller.ts`
- `apps/worker/src/action-executor/action-executor.controller.ts`

Both endpoints should:

- accept `{ jobId, attemptId, projectId }`
- return HTTP 202 with `{ accepted: true, attemptId }` after validation
- return `{ accepted: false, error }` for missing required fields, matching the
  `/invoke` controller shape
- start background execution without awaiting it
- wrap execution in `withCorrelationContext({ jobId, attemptId })`
- emit `runner.started`, `runner.completed`, and `runner.failed` with the same
  camelCase payload shape used by `apps/worker/src/invoke/invoke.controller.ts`
  and consumed by `pollForCompletion()`

`runner.completed.result` is the same `HarnessResult` previously returned in
the synchronous HTTP response.

### Orchestrator Submit And Poll

Update:

- `apps/orchestrator/src/worker/worker.client.ts`
- `apps/orchestrator/src/worker/worker.service.ts`
- `apps/orchestrator/src/loop/loop.service.ts`

Replace the long blocking fetch in `invokeSimpleWorkerJob()` with
`invokeSubmitAndPoll()`:

- POST to `/scripts/execute` or `/actions/execute` with
  `{ jobId, attemptId, projectId }`
- use a short submit timeout, defaulting to 30 seconds and optionally controlled
  by `EVE_WORKER_SUBMIT_TIMEOUT_MS`
- return `worker_submit_failed: ...` if the submit request fails, returns non-2xx,
  or returns `{ accepted: false }`
- after acceptance, call `pollForCompletion(projectId, attemptId, jobId, ...)`

Thread `projectId` from `loop.service.ts` through `WorkerService.executeScript`
and `executeAction`.

Compute the poll timeout from the job row, not only from `hints`:

- script: `(job.script_timeout_seconds ?? job.hints?.timeout_seconds ?? 1800) * 1000 + 60_000`
- action-run: `(action_input.timeout_seconds ?? action_input.timeout ?? job.hints?.timeout_seconds ?? 1800) * 1000 + 60_000`
- other action types: keep the existing hint/default behavior

The 60-second grace lets the worker-side timeout fire first and emit the
authoritative `runner.failed` event. If no terminal event arrives, the
orchestrator returns `poll_timeout: ...`.

### Streaming Bash Helper

Add one worker-local helper, for example:

- `apps/worker/src/execution/streaming-command.ts`

Use it from:

- `apps/worker/src/script-executor/script-executor.service.ts`
- `apps/worker/src/action-executor/action-executor.service.ts` for `handleRun`
  only

The helper should:

- call `spawn('bash', ['-c', command], { cwd, env })`
- line-buffer stdout and stderr
- flush logs in small batches, for example every 32 lines or 500 ms
- append `output` logs as data arrives so `eve job follow` sees progress
- maintain a small in-memory tail, for example the last 4 KB per stream, for
  `resultText` / `resultJson`
- enforce `EVE_SCRIPT_OUTPUT_CAP_BYTES`, defaulting to 10 MB per stream
- after the cap, keep draining the stream but stop storing more content and
  write one `warning` log that names the cap and stream
- enforce timeout with SIGTERM, then SIGKILL after a short grace period
- on timeout, write an `error` log with `code`, `timeout_seconds`, and
  `duration_ms`

Script timeouts should use `code: 'script_timeout'`; action-run timeouts should
use `code: 'action_run_timeout'`.

Do not add progress events in the first pass unless they fall out naturally from
the helper. Incremental output plus terminal runner events closes the reported
gap.

## Tests

Add focused tests where they fit the current tree:

- Worker controller tests for script/action:
  - valid request returns 202 immediately
  - missing `projectId` returns `{ accepted: false, error }`
  - successful background execution emits `runner.completed`
  - thrown executor error emits `runner.failed`
- Orchestrator worker client tests:
  - accepted submit leads to event polling and returns the terminal result
  - submit rejection/non-2xx returns `worker_submit_failed`
  - no terminal event returns `poll_timeout`
  - script/action-run poll timeout is derived from the job-specific timeout
- Script executor tests:
  - stdout/stderr are logged before process exit
  - output above the cap is truncated with one warning
  - `sleep 999` with a short timeout is killed and logs `script_timeout`
- Action executor `handleRun` tests:
  - same streaming and timeout behavior for `action: { type: run }`
- Integration test in `apps/api/test/integration/pipelines-workflows.integration.test.ts`:
  - workflow script step with `script.timeout: 600` and a body that crosses the
    300-second ingress boundary succeeds
  - the same step with a short timeout fails with `script_timeout`, not
    `Failed to invoke worker: fetch failed`

For the long-running success test, keep the integration harness practical. If a
real six-minute test is too expensive for the default suite, gate it behind the
repo's existing slow/integration mechanism and add a faster unit-level test that
proves the submit request is short-lived while process execution continues in
background.

## Docs In The PR

Update only docs that describe shipped behavior once the code is in the same PR:

- `docs/system/job-api.md` - script/action jobs submit quickly and complete via
  runner events; `script.timeout` is the authoritative script ceiling
- `docs/system/workflows.md` - long-running workflow script steps are supported
  without holding an orchestrator-worker HTTP request open
- `docs/system/pipelines.md` - `action: { type: run }` uses the same durable
  script execution model
- `docs/system/worker-types.md` - worker still runs script/action bash in the
  worker service, but command execution is backgrounded and streamed

Do not update `../eve-skillpacks` for this planning-only edit. When the behavior
ships, update the public Eve references in the release/doc-sync step:

- `references/jobs.md`
- `references/pipelines-workflows.md`
- `references/deploy-debug.md`

## Acceptance Criteria

- A workflow `script:` step with `script.timeout: 600` can run longer than 300
  seconds and complete successfully.
- The orchestrator never holds a single `/scripts/execute` or `/actions/execute`
  HTTP request open for the full command duration.
- `eve job follow <step-job-id>` shows output while a long script/action-run is
  still running.
- Script output above the configured cap does not crash the process; one warning
  log records truncation.
- A script timeout fails with structured `script_timeout`, not `Failed to invoke
  worker: fetch failed`.
- A pipeline `action: { type: run }` command has the same transport durability
  and streaming log behavior.
- Existing short script and action-run jobs still return the same successful
  `HarnessResult` shape to the orchestrator.

## References

| File | Why |
| --- | --- |
| `apps/orchestrator/src/worker/worker.client.ts` | `pollForCompletion()`, durable `/invoke` client, and current blocking script/action client |
| `apps/orchestrator/src/worker/worker.service.ts` | Worker service signatures to thread `projectId` |
| `apps/orchestrator/src/loop/loop.service.ts` | Dispatches `execution_type='script'` / `'action'` and owns job-specific timeout selection |
| `apps/worker/src/invoke/invoke.controller.ts` | Accepted-then-background controller shape to mirror |
| `apps/worker/src/script-executor/script-executor.controller.ts` | Current synchronous script endpoint |
| `apps/worker/src/action-executor/action-executor.controller.ts` | Current synchronous action endpoint |
| `apps/worker/src/script-executor/script-executor.service.ts` | Current `execFileAsync` script execution and post-exit log writes |
| `apps/worker/src/action-executor/action-executor.service.ts` | Current `handleRun` `execFileAsync` execution and post-exit log writes |
| `packages/shared/src/api-client/event-emitter.ts` | Existing runner event emitter and payload shape used by `/invoke` |
| `packages/shared/src/workflow/step-execution.ts` | Parses workflow/pipeline script timeout into `script_timeout_seconds` |
| `docs/system/workflows.md` | Documents workflow script materialization |
| `docs/system/pipelines.md` | Documents pipeline script/action-run semantics |
