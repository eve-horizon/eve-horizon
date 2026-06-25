# Build/Deploy Observability Plan

> Status: Draft
> Last Updated: 2026-02-01
> Purpose: Close the observability gap that forces multi-agent investigation to diagnose build and deploy failures. Make every failure self-diagnosable from a single CLI command.

## Problem Statement

A deploy pipeline failure today produces `"No steps found"` from `eve pipeline logs` and `"buildctl failed with exit code 1"` as the only error context. Diagnosing the root cause required launching 4 separate investigation agents because:

1. **Build failures lose context** -- `BuildKitBuilder.spawnBuildctl()` (buildkit-builder.ts:174) throws `Error("buildctl failed with exit code ${exitCode}")` discarding the `outputLines` array it has been accumulating. The error message stored in `build_runs.error_message` is just that bare string.

2. **Pipeline logs CLI shows metadata, not logs** -- `handleLogs()` in pipeline.ts (line 546) fetches the run detail and prints step names/statuses, but never reads `execution_logs` or `build_logs`. The `logs_ref` field on step responses is available but unused.

3. **No pipeline follow mode** -- `eve job follow` and `eve job watch` use SSE streaming with rich formatting. The API already has SSE endpoints at `GET /pipeline-runs/:runId/stream` (pipeline-runs.controller.ts:144), but no CLI command consumes them.

4. **Pre-build phase is invisible** -- `prepareWorkspace()` (action-executor.service.ts:~1421) calls `this.logger.log()` but never `this.appendLog()`, so clone/checkout progress is invisible through the API.

5. **Multi-service builds fail-fast without partial status** -- `ImageBuilderService.buildAll()` (image-builder.service.ts:85) iterates services sequentially and throws on first failure. No record of which services already built successfully.

6. **Pipeline steps ARE jobs now, but CLI does not link them** -- `PipelineExpanderService` creates jobs for each pipeline step. The CLI doesn't surface build_id, job_id, or hints to run `eve build diagnose`.

## Goals

- Every build failure should be diagnosable from a single CLI command
- Pipeline failures should surface linked build/job context inline
- Pre-build phases (clone, workspace) should produce observable logs
- Real-time streaming should work for pipelines, not just jobs
- Error messages should carry structured context (type, tail of output, hints)

## Non-Goals

- Full APM/tracing integration (Datadog, Jaeger)
- Log aggregation or search across multiple runs
- Custom alerting or notification channels
- Build performance profiling or optimization

---

## Implementation Plan

### Phase 1: Immediate Wins (Worker-side, no API/CLI changes)

Highest-impact, lowest-risk. Purely additive -- existing `eve build diagnose` becomes dramatically more useful.

#### 1.1 Capture buildctl tail-of-output on failure

**File**: `apps/worker/src/builder/buildkit-builder.ts`

`spawnBuildctl()` currently throws at line 174 with a bare exit code. The `outputLines` array exists in `buildService()` but is inaccessible at the throw site.

**Change**: `spawnBuildctl` returns `{ exitCode }` instead of throwing. `buildService()` constructs the error with context:

```typescript
const { exitCode } = await this.spawnBuildctl(args, { cwd, env, onLine });
if (exitCode !== 0) {
  const tail = outputLines.slice(-30).join('\n');
  const failedStage = extractFailedStage(outputLines);
  throw new Error(
    `buildctl failed with exit code ${exitCode}` +
    (failedStage ? ` at ${failedStage}` : '') +
    `\n--- Last ${Math.min(outputLines.length, 30)} lines ---\n${tail}`
  );
}
```

New helper `extractFailedStage()` scans for BuildKit progress patterns (`#N [stage N/N] RUN ...`) to identify which Dockerfile layer failed.

#### 1.2 Pre-build phase logging

**File**: `apps/worker/src/action-executor/action-executor.service.ts`

Add optional `onLog` callback to `prepareWorkspace()`:

```typescript
private async prepareWorkspace(
  repoUrl: string, gitSha: string, projectId?: string,
  onLog?: (message: string) => void,
): Promise<string> {
  onLog?.(`Cloning ${safeUrl}...`);
  // ... clone ...
  onLog?.(`Checking out ${gitSha.substring(0, 8)}...`);
  // ... checkout ...
  onLog?.('Workspace ready');
  return workspace;
}
```

Wire in `handleBuild()`:
```typescript
workspace = await this.prepareWorkspace(project.repo_url, input.git_sha, projectId, (msg) => {
  void this.appendLog(attemptId, 'status', {
    message: msg, phase: 'workspace', timestamp: new Date().toISOString(),
  });
});
```

Apply same pattern in `handleRelease()`, `handleRun()`, `handleJob()`.

#### 1.3 Error classification

**New file**: `apps/worker/src/action-executor/error-classifier.ts`

```typescript
export function classifyBuildError(message: string): string {
  if (/authentication|could not read Username|401|403/i.test(message)) return 'auth_error';
  if (/clone failed|git clone|cannot run ssh/i.test(message)) return 'clone_error';
  if (/buildctl failed|dockerfile/i.test(message)) return 'build_error';
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return 'timeout_error';
  if (/no space|disk quota|ENOSPC/i.test(message)) return 'resource_error';
  if (/registry|push failed|manifest unknown/i.test(message)) return 'registry_error';
  return 'unknown_error';
}
```

**New file**: `packages/shared/src/error-codes.ts`

Error code enum with human labels and actionable hints:

| Code | Label | Hint |
|------|-------|------|
| `auth_error` | Authentication Error | Check GITHUB_TOKEN via `eve secrets set` |
| `clone_error` | Git Clone Error | Verify repo URL and access. Check `eve secrets list` |
| `build_error` | Build Error | Run `eve build diagnose <build_id>` for full output |
| `timeout_error` | Timeout Error | Consider increasing timeout or checking resources |
| `resource_error` | Resource Error | Check disk space and memory on build worker |
| `registry_error` | Registry Error | Check registry credentials via `eve secrets list` |
| `deploy_error` | Deploy Error | Run `eve env diagnose <project> <env>` |
| `unknown_error` | Unknown Error | Run `eve build diagnose <build_id>` or `eve job diagnose <job_id>` |

#### 1.4 DB migration for error_code

**New file**: `packages/db/migrations/00029_add_error_codes.sql`

```sql
ALTER TABLE build_runs ADD COLUMN error_code VARCHAR(64);
ALTER TABLE pipeline_step_runs ADD COLUMN error_code VARCHAR(64);
```

**File**: `packages/db/src/queries/builds.ts` -- Add `error_code` to `BuildRun` interface and `updateRun` method.

#### 1.5 Partial build tracking

**File**: `apps/worker/src/builder/image-builder.service.ts`

In `buildAll()` (line 85): still fail-fast, but record which services succeeded before failure. Enrich error message:

```
Build failed for service 'api': pnpm install failed
(1 other service built successfully: worker)
```

**File**: `apps/worker/src/action-executor/action-executor.service.ts`

Move artifact creation inside the per-service loop so partial artifacts are persisted before failure propagates.

#### 1.6 Structured error context in logs

In `handleBuild` catch block: log rich context, not just message:

```typescript
await this.appendLog(attemptId, 'error', {
  message,
  error_code: classifyBuildError(message),
  build_id: buildSpec.id,
  build_run_id: buildRun.id,
  failed_stage: extractFailedStage(logBuffer),
  output_tail: logBuffer.slice(-30).join('\n'),
  services_succeeded: Object.keys(imageDigests),
  timestamp: new Date().toISOString(),
});
```

---

### Phase 2: CLI + API Improvements

#### 2.1 `eve pipeline logs --follow`

**File**: `packages/cli/src/commands/pipeline.ts`

Add `--follow` flag to `handleLogs` (line 546). New function `handlePipelineFollow` connects to existing SSE endpoint `GET /pipeline-runs/:runId/stream`.

Mirror the pattern from `job.ts` `handleFollow` (line 2779):
- Use `fetch` with `Accept: text/event-stream`
- Parse SSE events (`log`, `complete`, `error`)
- Format with step-name prefixes:

```
[build] Cloning repository...
[build] buildkit addr: tcp://buildkitd.eve.svc:1234
[build] [api] #5 [dependencies 1/4] COPY pnpm-lock.yaml ...
[deploy] Deployment started; waiting up to 180s
[deploy] Deployment status: 1/1 ready
```

Optional `--step <name>` narrows to single step using `GET /pipeline-runs/:runId/steps/:name/stream`.

#### 2.2 Pipeline logs REST endpoint

**File**: `apps/api/src/pipelines/pipeline-runs.controller.ts`

New endpoint:
```
GET /pipeline-runs/:runId/logs?step=<name>&after_seq=<n>&limit=<n>
```

**File**: `apps/api/src/pipelines/pipeline-runs.service.ts`

New method `getRunLogs()` that fetches `execution_logs` for all `step_run_id`s belonging to the pipeline run. Returns entries sorted by sequence, prefixed with step name.

#### 2.3 `eve pipeline logs` shows actual logs

**File**: `packages/cli/src/commands/pipeline.ts`

Update `handleLogs` snapshot mode to call the new REST endpoint. Display actual build/execution logs with step prefixes and timestamps, not just step metadata.

#### 2.4 Surface build_id hints on failure

**File**: `packages/cli/src/commands/pipeline.ts`

When displaying a failed build step, check for `build_id` in output/error logs and print:
```
  Hint: Run 'eve build diagnose bld_xxx' for full build details
```

**File**: `apps/worker/src/action-executor/action-executor.service.ts`

Ensure `build_id` is logged in error entries (currently only set on success path at ~line 430).

#### 2.5 Build log timestamps

**File**: `packages/cli/src/commands/build.ts`

In `handleLogs` (line 307), prefix each line with `[HH:MM:SS]` from entry timestamp. Currently shows raw text only.

#### 2.6 Help text

**File**: `packages/cli/src/commands/pipeline.ts` -- Add `--follow` to usage.
**File**: `packages/cli/src/lib/help.ts` -- Update pipeline command docs.

---

### Phase 3: Structured Error Reporting

#### 3.1 Error hints in CLI

**Files**: `packages/cli/src/commands/pipeline.ts`, `packages/cli/src/commands/build.ts`

When displaying errors, look up `error_code` from `packages/shared/src/error-codes.ts` and print actionable hint:

```
  Error: buildctl failed with exit code 1 at [build 3/5] RUN pnpm install
  Type:  Build Error
  Hint:  Run 'eve build diagnose bld_xxx' for full build output. Check Dockerfile and build context.
```

#### 3.2 Buildkit stage extraction

**File**: `apps/worker/src/builder/buildkit-builder.ts`

New function:
```typescript
function extractFailedStage(outputLines: string[]): string | null {
  for (let i = outputLines.length - 1; i >= 0; i--) {
    const match = outputLines[i].match(/#\d+\s+\[([^\]]+)\]\s+(.+)/);
    if (match) return `[${match[1]}] ${match[2]}`;
  }
  return null;
}
```

Included in error message for immediate visibility without needing `eve build diagnose`.

---

### Phase 4: Documentation & Skills

#### 4.1 System docs

**File**: `docs/system/builds.md`

Add "Observability" section:
- `eve build logs <id>` -- timestamped build output
- `eve build diagnose <id>` -- full state (spec + runs + artifacts + logs)
- Error codes and what they mean
- How to read buildkit output (layer numbering, cache markers)

**File**: `docs/system/pipelines.md`

Add:
- `eve pipeline logs <pipeline> <run-id> --follow` -- real-time streaming
- `eve pipeline logs <pipeline> <run-id> --step <name>` -- step-specific logs
- Pipeline-to-build-to-job linkage explanation

#### 4.2 AGENTS.md

**File**: `AGENTS.md`

Add "Build/Deploy Debugging Ladder" section:

```markdown
### Build/Deploy Debugging Ladder
1. `eve pipeline logs <pipeline> <run-id> --follow` -- real-time streaming
2. `eve pipeline logs <pipeline> <run-id>` -- snapshot with inline errors + hints
3. `eve build diagnose <build_id>` -- full build state (shown in pipeline output on failure)
4. `eve env diagnose <project> <env>` -- K8s deployment diagnostics
5. `eve job diagnose <job_id>` -- full job execution details
```

#### 4.3 Skills

The following Claude Code skills (loaded via `.agents/skills/`) should be updated with the new commands and debugging flows:

- **eve-deploy-debugging**: Add pipeline follow, build diagnosis from pipeline failure
- **eve-job-debugging**: Add build_id lookup from job output, error code interpretation
- **eve-platform-debugging**: Add build observability layer

---

## File Change Summary

| Phase | File | Change | Risk |
|-------|------|--------|------|
| 1 | `apps/worker/src/builder/buildkit-builder.ts` | Return exitCode from spawnBuildctl; include output tail + failed stage in error | Low |
| 1 | `apps/worker/src/action-executor/action-executor.service.ts` | Pre-build logging via onLog callback; error classification; build_id in error logs | Low |
| 1 | `apps/worker/src/builder/image-builder.service.ts` | Partial build tracking in buildAll | Low |
| 1 | `apps/worker/src/action-executor/error-classifier.ts` | **NEW** -- error classification function | None |
| 1 | `packages/shared/src/error-codes.ts` | **NEW** -- error codes with labels and hints | None |
| 1 | `packages/db/migrations/00029_add_error_codes.sql` | **NEW** -- error_code columns on build_runs, pipeline_step_runs | Low |
| 1 | `packages/db/src/queries/builds.ts` | error_code in BuildRun interface + updateRun | Low |
| 2 | `packages/cli/src/commands/pipeline.ts` | --follow SSE mode; actual log display; build_id hints; help text | Medium |
| 2 | `apps/api/src/pipelines/pipeline-runs.controller.ts` | GET /pipeline-runs/:id/logs endpoint | Low |
| 2 | `apps/api/src/pipelines/pipeline-runs.service.ts` | getRunLogs method | Low |
| 2 | `packages/cli/src/commands/build.ts` | Timestamps in log display | Low |
| 2 | `packages/cli/src/lib/help.ts` | Updated help text | Low |
| 3 | `packages/cli/src/commands/pipeline.ts` | Error code + hint display | Low |
| 3 | `packages/cli/src/commands/build.ts` | Error code + hint display | Low |
| 3 | `apps/worker/src/builder/buildkit-builder.ts` | extractFailedStage function | Low |
| 4 | `docs/system/builds.md` | Observability section | None |
| 4 | `docs/system/pipelines.md` | New CLI flags and log retrieval | None |
| 4 | `AGENTS.md` | Debugging ladder section | None |

## Sequencing

- **Phase 1** is independent -- ship first. No API/CLI changes. Immediately improves `eve build diagnose` output.
- **Phase 2** depends on Phase 1 error_code column for hint display but `--follow` is independent (SSE endpoints exist).
- **Phase 3** depends on Phases 1+2 being in place.
- **Phase 4** documents actual implemented behavior, so comes last.

## Verification

### Phase 1
- Trigger build with broken Dockerfile (`COPY nonexistent.txt .`)
- Verify `eve build diagnose <id>` shows: last 30 lines of buildkit output, error_code, failed stage
- Verify pre-build logs appear (clone, checkout, workspace ready)
- Build manifest with 2 services where second fails; verify partial success reported

### Phase 2
- `eve pipeline run deploy --ref HEAD --env sandbox`
- Parallel terminal: `eve pipeline logs deploy <run_id> --follow` -- verify real-time output
- After completion: `eve pipeline logs deploy <run_id>` -- verify actual build logs (not just metadata)
- On failure: verify `Hint: Run 'eve build diagnose ...'` appears

### Phase 3
- Remove GITHUB_TOKEN, trigger build -- verify error_code=auth_error and hint about `eve secrets set`
- Trigger Dockerfile build failure -- verify failed stage name in error output

### Phase 4
- Review docs/system/builds.md and pipelines.md for accuracy against implementation
- Verify AGENTS.md debugging ladder matches actual command behavior

## Related

- [builds-first-class-primitive-plan.md](./builds-first-class-primitive-plan.md) -- Build spec/run/artifact primitive (implemented)
- [job-execution-observability-v2.md](./job-execution-observability-v2.md) -- Job lifecycle events (implemented, same pattern)
- [silent-failure-remediation-plan.md](./silent-failure-remediation-plan.md) -- Secret resolution silent failures (same theme)
- [pipeline-build-and-registry-push-plan.md](./pipeline-build-and-registry-push-plan.md) -- Pipeline build integration
