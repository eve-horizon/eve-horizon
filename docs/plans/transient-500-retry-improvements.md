# Transient 500 Errors on Auto-Deploy: Root Cause & Retry Plan

## 5 Whys Root Cause Analysis

### The Problem
Eve-compatible apps triggering auto-deploys via `POST /projects/:id/envs/:name/deploy` occasionally receive transient 500 errors. When the client retries, duplicate deploys can be created.

### Why #1: Why does the client get a 500?
The API has **no global exception filter**. The worker app (`apps/worker/src/all-exceptions.filter.ts`) got one in commit `039c31e`, but the API (`apps/api/src/main.ts`) has none. Any unhandled exception — database timeout, connection pool exhaustion, transient network failure to the worker — becomes a bare 500 with no structured error body.

### Why #2: Why are there unhandled exceptions?
The `deployRelease()` method at `environments.service.ts:605-661` does a raw `fetch()` to the worker service with **no timeout, no retry, and minimal error handling**. If the worker is temporarily unavailable (pod restart, network hiccup), the fetch either hangs or throws a `TypeError`, which NestJS converts to a generic 500.

The `deployViaPipeline()` path at `environments.service.ts:237-289` calls `pipelineRunsService.createRun()` which calls `expander.expandPipeline()` — a chain of multiple DB inserts (run record, N job records, M dependency records) with **no transaction wrapping**. Any individual INSERT failure produces a partial state and a 500.

### Why #3: Why does retrying cause duplicate deploys?
The `deployViaPipeline()` call at line 277-282 **does not pass a `dedupeKey`** to `createRun()`:
```typescript
const { detail: pipelineRun } = await this.pipelineRunsService.createRun(
  projectId,
  pipelineName,
  pipelineRunRequest,
  'env-deploy',
  // dedupeKey parameter: MISSING
);
```
The deduplication machinery exists (`cancelExistingRunForDedupeKey` at `pipeline-runs.service.ts:774`), but the deploy path doesn't use it. Each retry creates a brand new pipeline run.

For `deployDirect()`, there's no idempotency at all — it creates a new release record and fires a new deploy to the worker each time.

### Why #4: Why isn't there a guard against concurrent deploys to the same environment?
The `findActiveRunByEnv()` method exists at `pipeline-runs.service.ts:525` and is used by the **health/status** endpoint (`findActivePipelineRunForEnv` at `environments.service.ts:183`), but it's **not checked before creating a new deploy**. The deploy endpoint blindly creates new runs without checking if one is already in flight.

### Why #5: Why wasn't this caught earlier?
The system was designed for manual CLI deploys where a human naturally avoids rapid retries. Auto-deploy via API (programmatic clients doing `POST` and retrying on failure) is a newer usage pattern that exposes the lack of idempotency. The deduplication infrastructure was built for explicit pipeline runs (which can pass `dedupe_key`), but the environment deploy wrapper skips it.

---

## Root Cause Summary

**Three independent gaps compound into the problem:**

1. **Missing error filter on API** — turns transient failures into opaque 500s
2. **No dedupeKey on env-deploy pipeline runs** — retries create duplicate runs
3. **No active-run guard on deploy** — nothing prevents concurrent deploys to the same env

---

## Proposed Changes

### 1. Add global exception filter to API
**File:** `apps/api/src/main.ts`
**What:** Port the `AllExceptionsFilter` pattern from `apps/worker/src/all-exceptions.filter.ts` to the API. This gives structured JSON error responses with status codes, timestamps, and error messages instead of bare 500s.
**Why:** Clients can distinguish between "server explicitly rejected" (retry-safe) vs. "unknown failure" (ambiguous).

### 2. Pass dedupeKey for env-deploy pipeline runs
**File:** `apps/api/src/environments/environments.service.ts` (~line 277)
**What:** Generate a dedupeKey from `${projectId}:${envName}:env-deploy` and pass it to `createRun()`. This uses the existing deduplication machinery to cancel any in-flight run when a retry arrives.
**Why:** Makes deploy retries safe — a retry supersedes the previous attempt rather than creating a parallel one.

### 3. Add active-run guard on the deploy endpoint
**File:** `apps/api/src/environments/environments.service.ts` (~line 198)
**What:** Before creating a new deploy, call `findActiveRunByEnv()`. If an active run exists for the same environment, return the existing run's details and `poll_url` instead of creating a new one. Include a `force` flag in `DeployRequest` to bypass this for intentional redeploys.
**Why:** Even without a dedupeKey, concurrent requests get a safe "already deploying" response. This is the belt to the dedupeKey's suspenders.

### 4. Add fetch timeout and structured error on deployRelease
**File:** `apps/api/src/environments/environments.service.ts` (~line 614)
**What:** Add an `AbortSignal.timeout()` to the worker fetch (e.g., 30s). On timeout or network failure, throw a `ServiceUnavailableException` with a clear message distinguishing "worker unreachable" from "worker rejected".
**Why:** Prevents hanging requests and gives clients a clear signal of what went wrong.

### 5. Client-side retry policy (already partially done)
**Context:** The previous conversation already narrowed client retries to only explicit 5xx responses. This is correct — network failures are ambiguous and should not be retried for non-idempotent operations.
**Remaining:** With change #2 (dedupeKey) and #3 (active-run guard), the server becomes idempotent, which means **all** retries become safe. Once the server-side changes land, the client can safely retry on network failures too.

---

## Implementation Order

```
[1] API exception filter          — standalone, no dependencies
[2] dedupeKey on env-deploy       — one-line change, existing infrastructure
[3] Active-run guard              — depends on #2 for clean interaction
[4] Fetch timeout on deployRelease — standalone, no dependencies
[5] Client retry policy update     — depends on #2 and #3 being deployed
```

Changes 1, 2, and 4 can be done in parallel. Change 3 builds on 2. Change 5 is a follow-up after server deploys.

---

## What This Does NOT Address (Out of Scope)

- **Transaction wrapping for pipeline expansion**: The job creation loop in `pipeline-expander.service.ts` creates jobs individually without a transaction. Worth fixing separately but not the cause of the reported issue.
- **Rate limiting on deploy endpoint**: No throttling exists. Worth adding but separate concern.
- **TOCTOU race in dedupeKey cancellation**: The check-then-cancel-then-create pattern isn't atomic. For the env-deploy use case (low concurrency, seconds apart), this is acceptable. A database-level unique constraint on `(dedupe_key, status NOT IN terminal)` would be the proper fix for high-concurrency scenarios.
