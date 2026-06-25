# Silent Failure Remediation Plan

> **Status**: Draft
> **Priority**: P0 — This is actively breaking staging pipelines
> **Trigger**: Sentinel-mgr pipeline deploy failed because `resolveSecrets()` silently returned `[]`, preventing git auth injection for private repo clone

## Problem Statement

The worker's secret resolution and git auth injection chain **swallows every error**. When something goes wrong, the system silently degrades instead of failing fast — violating the project's own fail-fast principle (AGENTS.md).

The result: users see `git clone: authentication failed` when the real problem is upstream (missing config, API unreachable, bad response). Debugging requires tracing through 4+ layers of code to find a silent `return []`.

## Root Cause Analysis

### The Silent Failure Chain

```
Worker receives pipeline job
  → prepareWorkspace(repoUrl, gitSha, projectId)
    → injectGitAuth(repoUrl, projectId)
      → resolveSecrets(projectId)
        → loadConfig()
          → if (!EVE_INTERNAL_API_KEY || !EVE_API_URL) return []  ← SILENT
        → fetch(...secrets API...)
          → if (!response.ok) return []                           ← SILENT
        → SecretResolveResponseSchema.safeParse(json)
          → if (!parsed.success) return []                        ← SILENT
      → catch { return [] }                                       ← SILENT
    → secrets.find(s => s.type === 'github_token')
      → if (!token) return repoUrl                                ← SILENT (no token = no auth)
  → git clone <unauthenticated-url>
    → FAILS with "authentication required"                        ← USER SEES THIS
```

Every step in this chain returns a "safe" default instead of throwing. The code was designed for optional secrets, but it's used for **required operations** (private repo clone).

### Scope of the Problem

The same `resolveSecrets()` pattern is **copy-pasted across 5 services**:

| Service | File | Line |
|---------|------|------|
| PipelineRunnerService | `apps/worker/src/pipeline-runner/pipeline-runner.service.ts` | 678 |
| ActionExecutorService | `apps/worker/src/action-executor/action-executor.service.ts` | 1465 |
| DeployerService | `apps/worker/src/deployer/deployer.service.ts` | 1238 |
| InvokeService | `apps/worker/src/invoke/invoke.service.ts` | 762 |
| LoopService (orchestrator) | `apps/orchestrator/src/loop/loop.service.ts` | 1225 |

Each copy has the same silent failure pattern. Each returns `[]` or `{}` when secrets can't be resolved.

### Additional Silent Failures Found

1. **Git checkout cascade** (`apps/worker/src/git/git-workspace.ts:276-309`) — Three nested checkout strategies with empty catch blocks. Only the final attempt's error surfaces.

2. **Shallow clone fallback** (`apps/worker/src/git/git-workspace.ts:234-247`) — Original clone error is discarded when falling back to full clone.

3. **Health check DB errors** (`apps/*/src/health/health.controller.ts`) — Database connection errors caught and returned as `"degraded"` without logging.

4. **Manifest parse failures** (`apps/orchestrator/src/cron/cron-scheduler.service.ts:117`) — Bad YAML returns null, causing triggers to silently not register.

### Staging Config Status

Confirmed: `EVE_INTERNAL_API_KEY` **is present** in the staging `eve-app` K8s secret and mounted via `envFrom` in the base worker deployment. The staging overlay inherits this. So the immediate pipeline failure may have a different root cause (e.g., `loadConfig()` not reading the env var correctly, or a timing issue). This makes the silent failure even more damaging — we can't tell what actually went wrong.

## Design Principles

1. **Fail fast, fail loud** — If a required operation can't succeed, throw immediately with a clear message
2. **Distinguish required vs optional** — Secret resolution for git auth on a private repo is *required*. Resolution for optional harness hints is *optional*. The code should reflect this.
3. **One implementation, not five** — Extract shared secret resolution to a single module
4. **Startup validation** — Validate required config (EVE_INTERNAL_API_KEY, EVE_API_URL) at service startup, not at first use
5. **Context in errors** — Error messages should say what went wrong AND what the user should check

## Implementation Plan

### Phase 1: Extract shared secret client (foundation)

Extract the duplicated `resolveSecrets()` into a shared module that all services use.

**Create `apps/worker/src/api-client/secret-client.ts`:**

```typescript
export interface SecretResolutionResult {
  secrets: SecretResolveItem[];
  /** Whether the API was reachable and returned secrets */
  resolved: boolean;
  /** If resolved is false, the reason why */
  error?: string;
}

export async function resolveProjectSecrets(
  projectId: string,
  options?: { userId?: string }
): Promise<SecretResolutionResult> {
  const config = loadConfig();

  if (!config.EVE_INTERNAL_API_KEY || !config.EVE_API_URL) {
    return {
      secrets: [],
      resolved: false,
      error: 'Worker missing EVE_INTERNAL_API_KEY or EVE_API_URL — cannot reach secrets API',
    };
  }

  try {
    const response = await fetch(...);
    if (!response.ok) {
      return {
        secrets: [],
        resolved: false,
        error: `Secrets API returned ${response.status}: ${response.statusText}`,
      };
    }
    const json = await response.json();
    const parsed = SecretResolveResponseSchema.safeParse(json);
    if (!parsed.success) {
      return {
        secrets: [],
        resolved: false,
        error: `Secrets API returned invalid response: ${parsed.error.message}`,
      };
    }
    return { secrets: parsed.data.data, resolved: true };
  } catch (err) {
    return {
      secrets: [],
      resolved: false,
      error: `Failed to reach secrets API: ${err instanceof Error ? err.message : err}`,
    };
  }
}
```

**Key change**: The caller now knows *whether* resolution succeeded, not just what came back.

**Files to update:**
- `apps/worker/src/pipeline-runner/pipeline-runner.service.ts` — Use shared client, remove local `resolveSecrets()`
- `apps/worker/src/action-executor/action-executor.service.ts` — Same
- `apps/worker/src/deployer/deployer.service.ts` — Same
- `apps/worker/src/invoke/invoke.service.ts` — Same
- `apps/orchestrator/src/loop/loop.service.ts` — Same (or extract orchestrator variant)

### Phase 2: Make git auth injection fail-fast for private repos

**`pipeline-runner.service.ts` and `action-executor.service.ts` — `injectGitAuth()`:**

```typescript
private async injectGitAuth(repoUrl: string, projectId: string): Promise<string> {
  if (!repoUrl.startsWith('http')) return repoUrl;

  const result = await resolveProjectSecrets(projectId);

  if (!result.resolved) {
    // Log the actual error — this is the context users need
    this.logger.error(
      `Cannot resolve secrets for git auth: ${result.error}. ` +
      `Clone of ${repoUrl} will proceed without authentication.`
    );
  }

  const token =
    result.secrets.find(s => s.type === 'github_token') ??
    result.secrets.find(s => ['GITHUB_TOKEN', 'GH_TOKEN'].includes(s.key));

  if (!token) {
    // Check if this is a private GitHub repo that needs auth
    const url = new URL(repoUrl);
    if (url.hostname.includes('github.com')) {
      this.logger.warn(
        `No GITHUB_TOKEN found for project ${projectId}. ` +
        `If ${repoUrl} is private, clone will fail. ` +
        `Set GITHUB_TOKEN via: eve secrets set GITHUB_TOKEN <value> --project <id>`
      );
    }
    return repoUrl;
  }

  // Inject token...
}
```

**Key change**: Error messages tell the user *what to do*, not just what happened.

### Phase 3: Add startup config validation

**Add to worker service bootstrap:**

```typescript
// In worker main.ts or module init
const config = loadConfig();
const warnings: string[] = [];

if (!config.EVE_INTERNAL_API_KEY) {
  warnings.push('EVE_INTERNAL_API_KEY is not set — secret resolution will be unavailable');
}
if (!config.EVE_API_URL) {
  warnings.push('EVE_API_URL is not set — API callbacks will be unavailable');
}

if (warnings.length > 0) {
  console.warn('='.repeat(60));
  console.warn('WORKER CONFIGURATION WARNINGS:');
  warnings.forEach(w => console.warn(`  - ${w}`));
  console.warn('='.repeat(60));
}
```

Same for orchestrator. This surfaces misconfig immediately on pod startup, not 10 minutes later when a job fails.

### Phase 4: Fix git-workspace silent retry cascade

**`apps/worker/src/git/git-workspace.ts` — checkout method:**

Currently: Three nested try/catch blocks with empty catch.

Fix: Log each attempt before retrying:

```typescript
// Attempt 1: direct checkout
try {
  await this.runGit(['checkout', ref]);
  return;
} catch (err) {
  this.logger.debug(`Direct checkout of '${ref}' failed: ${(err as Error).message}, trying remote tracking...`);
}

// Attempt 2: create tracking branch
try {
  await this.runGit(['checkout', '-B', ref, `origin/${ref}`]);
  return;
} catch (err) {
  this.logger.debug(`Remote tracking checkout of '${ref}' failed: ${(err as Error).message}, trying detached HEAD...`);
}

// Attempt 3: detached HEAD (final — let it throw)
await this.runGit(['checkout', '--detach', ref]);
```

Same for the shallow clone fallback — log the original error before retrying with full clone.

### Phase 5: Surface errors in pipeline action results

When a pipeline build/release/deploy action fails, the error should include the root cause, not just "git clone failed".

**In `prepareWorkspace()`:**

```typescript
try {
  await execFileAsync('git', ['clone', '--no-checkout', cloneUrl, workspace], ...);
} catch (err) {
  const errMsg = err instanceof Error ? err.message : String(err);
  // If this looks like an auth failure, add context
  if (errMsg.includes('Authentication failed') || errMsg.includes('could not read Username')) {
    throw new Error(
      `Git clone failed (authentication): ${errMsg}. ` +
      `Check that GITHUB_TOKEN is set for this project via 'eve secrets set'.`
    );
  }
  throw new Error(`Git clone failed: ${errMsg}`);
}
```

### Phase 6: Add health check error logging

Quick win. All three health controllers swallow DB errors — add `console.error` before returning degraded status.

## Test Strategy

1. **Unit tests** for the new `secret-client.ts`:
   - Returns `resolved: false` with clear error when config missing
   - Returns `resolved: false` with status code when API returns error
   - Returns `resolved: false` with parse error when response malformed
   - Returns `resolved: true` with secrets on success

2. **Integration tests** for error propagation:
   - Pipeline build action with missing GITHUB_TOKEN → error message mentions "GITHUB_TOKEN"
   - Pipeline build action with unreachable secrets API → error message mentions "secrets API"
   - Worker startup without EVE_INTERNAL_API_KEY → console warning at startup

3. **Verify existing tests still pass** — the interface change from `[]` to `{secrets, resolved, error}` will require updating callers.

## Files Changed (Estimated)

| File | Change |
|------|--------|
| `apps/worker/src/api-client/secret-client.ts` | **NEW** — Shared secret resolution client |
| `apps/worker/src/pipeline-runner/pipeline-runner.service.ts` | Remove local `resolveSecrets()`, use shared client, improve `injectGitAuth()` |
| `apps/worker/src/action-executor/action-executor.service.ts` | Same as pipeline-runner |
| `apps/worker/src/deployer/deployer.service.ts` | Same — use shared client |
| `apps/worker/src/invoke/invoke.service.ts` | Same — use shared client |
| `apps/orchestrator/src/loop/loop.service.ts` | Use shared client (or extract orchestrator variant) |
| `apps/worker/src/git/git-workspace.ts` | Add logging to checkout cascade and clone fallback |
| `apps/worker/src/main.ts` | Add startup config validation |
| `apps/orchestrator/src/main.ts` | Add startup config validation |
| `apps/*/src/health/health.controller.ts` (x3) | Add error logging |
| Tests | New unit tests for secret-client, update integration tests |

## Risk Assessment

- **Low risk**: All changes are in error handling paths. Happy-path behavior is unchanged.
- **Backward compatible**: The shared client returns the same data — just with metadata about resolution success.
- **Pre-deployment**: No users to break. We can refactor aggressively.

## Immediate Action (Staging Fix)

While implementing the above, the immediate staging pipeline failure should be investigated by checking:
1. `kubectl -n eve logs deployment/eve-worker --tail=100` — Look for any config warnings
2. `kubectl -n eve exec deploy/eve-worker -- env | grep EVE_` — Verify env vars are present
3. If EVE_INTERNAL_API_KEY is present but `loadConfig()` isn't reading it, check `packages/shared/src/config.ts`
