# Production Hardening: Quick Wins Plan

> **Status**: Complete
> **Date**: 2026-03-15
> **Motivation**: Close the eight easiest gaps between Eve Horizon's current capabilities and a fully production-hardened agent platform. Each feature is small (hours, not weeks), fits existing patterns, and compounds our positioning as "the platform that already solved the 80% problem."
> **Scope**: 8 features across data engineering, retry/recovery, cost governance, and observability. No new services, no new tables (one migration adds columns to existing tables).
> **Input**: `docs/ideas/production-agent-infrastructure-gap-analysis.md`

## Design Philosophy

These features share a design principle: **surface what the system already knows.**

Eve Horizon already computes content hashes, tracks lifecycle timestamps, logs
routing decisions to stdout, records per-phase durations in execution logs, and
stores receipts with job/agent metadata. Most of these "gaps" are presentation
gaps, not capability gaps. The work is wiring existing data into queryable,
CLI-accessible form.

Where we do add new behavior (dedup, auto-expiry, auto-retry), we follow the
established pattern: a column on the existing table, a background cleanup loop
matching `AuthModule.replayPurgeTimer` or `RunnerReaperService`, and a CLI
surface.

---

## Feature 1: Content Deduplication at Ingest

### Problem

Every `eve ingest` call creates a new `ingest_records` row and a new S3 object,
even if the identical file was uploaded minutes ago. Teams processing documents
from multiple channels (Slack, email, API) get duplicate processing jobs.

### Design

Use S3's ETag (MD5 of content for single-part uploads) as a lightweight content
fingerprint. At confirm time, check for an existing confirmed ingest record with
the same fingerprint within the same project. If found, return the existing
record instead of firing a new processing event.

**Why ETag, not a computed SHA256?** At confirm time we already call
`storage.getObjectMetadata()` which returns `etag`. Computing SHA256 would
require downloading the file from S3 — potentially hundreds of megabytes — just
to hash it. ETag is free. For multi-part uploads (>5GB), ETag is not a content
hash, so this is a documented follow-up if upload flow changes to multipart.

**Why project-scoped, not org-scoped?** Different projects may legitimately
process the same file with different agents/workflows. Dedup within a project
catches the real duplicates (same file via CLI + Slack + API).

### Schema Change

```sql
-- Migration: add content_fingerprint and dedup index to ingest_records
ALTER TABLE ingest_records
  ADD COLUMN IF NOT EXISTS content_fingerprint TEXT;

-- Dedup lookup: find confirmed records with same fingerprint in same project
CREATE INDEX IF NOT EXISTS idx_ingest_fingerprint
  ON ingest_records (project_id, content_fingerprint)
  WHERE content_fingerprint IS NOT NULL AND status != 'failed';
```

### Implementation

**`apps/api/src/ingest/ingest.service.ts` — `confirm()` method:**

```typescript
// After getObjectMetadata() succeeds (line ~133):
const fingerprint = metadata.etag?.replace(/"/g, '');

if (fingerprint) {
  const existing = await this.db`
    SELECT id, status FROM ingest_records
    WHERE project_id = ${record.project_id}
      AND content_fingerprint = ${fingerprint}
      AND id != ${record.id}
      AND status IN ('processing', 'done')
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (existing.length > 0) {
    // Mark this record as a duplicate, link to original
    await this.db`
      UPDATE ingest_records
      SET status = 'done',
          content_fingerprint = ${fingerprint},
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = ${record.id}
    `;
    return {
      ...record,
      status: 'done',
      deduplicated: true,
      original_id: existing[0].id,
    };
  }
}

// Save fingerprint on this record regardless
await this.db`
  UPDATE ingest_records
  SET content_fingerprint = ${fingerprint}, updated_at = NOW()
  WHERE id = ${record.id}
`;

// Continue with normal event emission...
```

**CLI output** (`eve ingest` confirm step):

```
✓ File confirmed (deduplicated — identical to ing_abc123, skipping reprocessing)
```

**Opt-out**: Add `--force` flag to `eve ingest confirm` that skips the dedup
check. Useful when the same file should be reprocessed with different
instructions.

### What This Doesn't Do

- No cross-project dedup (intentional — different projects, different processing)
- No content-level dedup (same data in different formats) — that's an agent concern
- No retroactive fingerprinting of existing records — new uploads only

---

## Feature 2: Dead Letter Handling

### Problem

When a job fails its final attempt, it moves to `cancelled` phase with a close
reason. There's no way to query "show me all jobs that failed after exhausting
retries" vs "show me jobs that were intentionally cancelled." Dead letters are
invisible.

### Design

Add a `failure_disposition` field to jobs that distinguishes intentional
cancellation from exhausted-retry failure. Surface via CLI filter.

This follows the existing pattern: the `close_reason` field already stores why
a job ended, but it's free-text. `failure_disposition` is an enum that enables
structured queries.

### Schema Change

```sql
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS failure_disposition TEXT
  CHECK (failure_disposition IN ('cancelled', 'failed', 'upstream_failed'));
```

### Implementation

**`packages/db/src/queries/jobs.ts` — `markJobFailed()`:**

Set `failure_disposition = 'failed'` on the primary job, and
`failure_disposition = 'upstream_failed'` on cascaded downstream jobs.

**`packages/db/src/queries/jobs.ts` — existing cancel paths:**

Set `failure_disposition = 'cancelled'` when a job is explicitly cancelled
by a user or API call (as opposed to failing from execution).

**CLI:**

```bash
# Show dead letters (jobs that failed, not cancelled)
eve job list --dead-letters

# Equivalent filter
eve job list --phase cancelled --disposition failed

# Retry a dead letter
eve job retry <job-id>
```

**API:**

```
GET /projects/{id}/jobs?phase=cancelled&failure_disposition=failed
```

### What This Doesn't Do

- No automatic retry queue — that's Feature 7 (below)
- No separate dead letter table — these are just regular jobs with a queryable flag
- No TTL on dead letters — they stay until manually retried or archived

---

## Feature 3: Per-Phase Latency in Diagnostics

### Problem

`eve job diagnose` shows total attempt duration but can't distinguish "slow
because the LLM took 90 seconds" from "slow because git clone took 60 seconds."
The data already exists in execution logs (lifecycle events with phase +
duration_ms) but isn't surfaced.

### Design

Parse existing lifecycle execution logs and present a latency waterfall in
`eve job diagnose` output. Zero schema changes. Pure presentation.

### Implementation

**`packages/cli/src/commands/job.ts` — `handleDiagnose()`:**

After fetching logs, filter for lifecycle events and build a waterfall:

```typescript
const lifecycleLogs = logs.filter(l =>
  l.type === 'harness' || l.type === 'provision' || l.type === 'cleanup'
);

// Group by phase and extract durations from content
const phases = lifecycleLogs
  .filter(l => l.content?.duration_ms != null)
  .map(l => ({
    phase: l.content.phase ?? l.type,
    action: l.content.action ?? '',
    duration_ms: l.content.duration_ms,
  }));
```

**Output format:**

```
Latency Breakdown (attempt #1):
  provision/clone     12,340ms  ████████░░░░░░░░  14%
  provision/setup      2,100ms  █░░░░░░░░░░░░░░░   2%
  invoke/harness      71,200ms  ████████████████  82%
  cleanup/workspace    1,400ms  █░░░░░░░░░░░░░░░   2%
  ─────────────────────────────
  Total               87,040ms
```

### What This Doesn't Do

- No new instrumentation — uses existing lifecycle events only
- No API change — this is CLI presentation only
- Phases that don't emit lifecycle events won't appear (acceptable; the major
  phases all log today)

---

## Feature 4: Routing Decision Logging

### Problem

When debugging why a job executed a certain way, operators ask: "Why did this go
to agent-runtime instead of the worker? Why was mclaude chosen as harness?" The
orchestrator logs this to stdout but not to execution logs — so it's lost when
pods restart.

### Design

Write a structured `routing` execution log at claim time, capturing the
decision and its inputs. This follows the existing pattern: lifecycle events
are already written to execution logs at invoke time; routing events should be
written at claim time.

### Implementation

**`apps/orchestrator/src/loop/loop.service.ts` — after successful claim:**

```typescript
await this.executionLogs.append(attempt.id, {
  type: 'routing',
  content: {
    execution_type: job.execution_type,
    target: agentRuntimeUrl ? 'agent-runtime' : 'worker',
    target_url: agentRuntimeUrl ?? workerUrl,
    harness: selection.harness,
    harness_source: selection.source,
    harness_checked: selection.checked,
    agent_id: job.assignee,
    resource_class: job.hints?.resource_class,
    budget: {
      max_tokens: budgetConfig?.max_tokens,
      max_cost: budgetConfig?.max_cost,
    },
  },
});
```

**Surfaced in diagnostics:**

```
Routing:
  Target:    agent-runtime (http://agent-runtime:4749)
  Harness:   mclaude (source: project, checked: [explicit, project, system])
  Agent:     code-reviewer
  Budget:    max_tokens=200000, max_cost=$2.00
```

### What This Doesn't Do

- No changes to the routing logic itself — pure observability
- No new log type enum needed — `'routing'` is a free-form execution-log type like
  existing `'harness'`, `'provision'`, etc.

---

## Feature 5: Cost Breakdown by Agent and Team

### Problem

`eve analytics summary` shows org-wide totals. When the CFO asks "which agent is
costing us the most?", there's no answer without manual SQL queries. The data
exists: receipts link to attempts, attempts have `agent_id`, jobs have
`assignee` and `actor_user_id`.

### Design

Add agent/team grouping dimensions to the analytics service. No schema change —
this is a query change.

### Implementation

**`apps/api/src/analytics/analytics.service.ts` — new method:**

```typescript
async getCostByAgent(
  orgId: string,
  windowStart: Date,
): Promise<AgentCostBreakdown[]> {
  return this.db`
    SELECT
      COALESCE(a.agent_id, j.assignee, 'unassigned') AS agent,
      COUNT(a.id) AS attempts,
      SUM(a.receipt_base_total_usd) AS total_cost_usd,
      SUM(a.token_input) AS total_input_tokens,
      SUM(a.token_output) AS total_output_tokens
    FROM job_attempts a
    JOIN jobs j ON j.id = a.job_id
    JOIN projects p ON p.id = j.project_id
    WHERE p.org_id = ${orgId}
      AND a.ended_at >= ${windowStart}
      AND a.receipt_base_total_usd IS NOT NULL
    GROUP BY COALESCE(a.agent_id, j.assignee, 'unassigned')
    ORDER BY total_cost_usd DESC
  `;
}
```

**API:**

```
GET /analytics/cost-by-agent?org_id=org_xxx&window=7d
```

**CLI:**

```bash
eve analytics cost-by-agent --org org_xxx --window 7d
```

**Output:**

```
Agent Cost Breakdown (last 7 days):
  code-reviewer     $12.40  (142 attempts, 2.1M input tokens)
  doc-processor      $8.70  ( 89 attempts, 1.4M input tokens)
  coordinator        $3.20  ( 31 attempts, 0.5M input tokens)
  unassigned         $0.80  (  6 attempts, 0.1M input tokens)
  ─────────────────────────
  Total             $25.10
```

### What This Doesn't Do

- No per-agent budget caps (that's a Tier 2 feature)
- No team-level grouping yet (agents don't reliably reference teams in current schema)
- No cost anomaly detection — just reporting

---

## Feature 6: `created_by` on Jobs

### Problem

Jobs track `assignee` (who runs the job) and `actor_user_id` (who triggered it
via API), but `actor_user_id` was added late (migration 00016) and isn't
consistently populated across all job creation paths. Some paths populate it,
others don't. The field name is also confusing — "actor" in Eve's event system
means something different.

### Design

Ensure `actor_user_id` is populated on every job creation path by extracting it
from the authenticated request context. No new column needed — the field exists,
it just needs consistent population.

### Implementation

**Audit all job creation paths and ensure `actor_user_id` is set:**

1. `POST /projects/{id}/jobs` — API direct creation → extract from `req.user`
2. `POST /projects/{id}/jobs/batch` — batch creation → extract from `req.user`
3. Event-triggered job creation (orchestrator) → set to `'system'`
4. Chat-initiated jobs (gateway → API) → set to the chat user identity
5. Scheduled jobs → set to `'scheduler'`
6. Pipeline step jobs → set to the pipeline run initiator (propagate from parent)

**CLI surface:**

```bash
eve job show <id> --verbose
# Output includes:
#   Created by: user_abc123 (admin@example.com)
```

**Diagnostics enrichment:**

Add `created_by` to `eve job diagnose` output alongside existing routing info.

### What This Doesn't Do

- No rename of the column (would break existing queries; not worth a migration)
- No retroactive backfill (old jobs stay as-is; new writes use `actor_user_id`
  consistently)
- No access control implications (this is observability, not authorization)

---

## Feature 7: Automatic Retry with Configurable Policies

### Problem

When a job fails due to a transient error (network timeout, rate limit, API
blip), an operator must manually re-run it. The attempt model already supports
`trigger_type = 'auto_retry'` and the orchestrator has recovery loops — but
there's no policy that says "retry this job up to 3 times with exponential
backoff."

### Design

Add retry policy fields to the job `hints` JSONB. The orchestrator's existing
recovery loop evaluates these when an attempt fails. If retries remain, it
creates a new `pending` attempt with `trigger_type = 'auto_retry'` and a
`defer_until` timestamp.

This follows the established pattern exactly: `defer_until` already exists on
jobs (used for gate-blocked requeuing), `trigger_type = 'auto_retry'` already
exists on attempts (used for review rejection retries), and the orchestrator's
`recoverCompletedAttempts` loop already handles attempts that need reprocessing.

### Schema Change

```sql
-- No table changes needed. Retry policy lives in hints JSONB:
-- hints.retry.max_attempts (default: 1 = no retry)
-- hints.retry.backoff_seconds (default: 60)
-- hints.retry.backoff_multiplier (default: 2)
-- hints.retry.retryable_errors (default: ['attempt_timeout', 'attempt_stale'])
```

### Implementation

**`apps/orchestrator/src/loop/loop.service.ts` — in the attempt completion handler:**

When an attempt ends with `status = 'failed'`:

```typescript
const retryPolicy = job.hints?.retry ?? {};
const maxAttempts = retryPolicy.max_attempts ?? 1;
const currentAttempt = attempt.attempt_number;

if (currentAttempt < maxAttempts) {
  const isRetryable = !retryPolicy.retryable_errors
    || retryPolicy.retryable_errors.includes(attempt.error_code);

  if (isRetryable) {
    const backoffBase = retryPolicy.backoff_seconds ?? 60;
    const multiplier = retryPolicy.backoff_multiplier ?? 2;
    const delaySec = backoffBase * Math.pow(multiplier, currentAttempt - 1);
    const deferUntil = new Date(Date.now() + delaySec * 1000);

    await this.jobs.createPendingAttempt(job.id, {
      trigger_type: 'auto_retry',
      result_summary: `Auto-retry #${currentAttempt + 1} after ${attempt.error_code ?? 'failure'} (backoff: ${delaySec}s)`,
    });

    await this.jobs.updatePhase(job.id, 'ready', { defer_until: deferUntil });

    this.logger.log(
      `Job ${job.id}: scheduling auto-retry #${currentAttempt + 1} in ${delaySec}s`
    );
    return; // Don't mark job as failed yet
  }
}

// Max retries exhausted or non-retryable error
await this.markJobFailed(job, attempt, 'failed');  // sets failure_disposition
```

**Manifest surface** (workflow steps):

```yaml
workflows:
  process-document:
    steps:
      - name: ingest
        agent: doc-processor
        retry:
          max_attempts: 3
          backoff_seconds: 30
          retryable_errors: [attempt_timeout, attempt_stale]
```

The workflow service already resolves step config into job `hints` — adding
`retry` is a pass-through.

**CLI surface:**

```bash
# Create a job with retry policy
eve job create --agent doc-processor \
  --retry-max 3 --retry-backoff 30

# View retry status in diagnostics
eve job diagnose <id>
# Output includes:
#   Retry Policy: max=3, backoff=30s×2, retryable=[attempt_timeout, attempt_stale]
#   Attempts: 2/3 (next retry in 47s)
```

### What This Doesn't Do

- No circuit breaker (stop all jobs for an agent if failure rate is high) — future feature
- No per-tool retry (retry a single tool call within an attempt) — that's harness-level
- No automatic escalation to human — use existing HITL review gates for that

---

## Feature 8: Automatic Document Expiration

### Problem

Org documents with `expires_at` timestamps are never cleaned up. Expired docs
remain readable and searchable indefinitely. The lifecycle columns exist, the
indexes exist, but no background process acts on them.

### Design

A lightweight cleanup loop in the API service (matching the `AuthModule` replay
purge pattern) that transitions expired documents to `archived` status and
optionally deletes them after a grace period.

Two-phase approach:
1. **Expire**: `expires_at < NOW()` → set `lifecycle_status = 'expired'`
2. **Archive**: `lifecycle_status = 'expired'` AND `expires_at < NOW() - grace` → soft-delete (move content to version history, clear content on main doc)

This preserves the document path and metadata for audit while reclaiming
the content storage.

### Implementation

**`apps/api/src/org-documents/org-documents.module.ts`:**

```typescript
// Following AuthModule.replayPurgeTimer pattern
private expiryTimer?: ReturnType<typeof setInterval>;

onModuleInit(): void {
  // Run every 15 minutes
  this.expiryTimer = setInterval(
    () => void this.processExpiredDocs().catch(err =>
      this.logger.error(`Doc expiry cycle failed: ${err}`)
    ),
    15 * 60 * 1000,
  );
}

onModuleDestroy(): void {
  if (this.expiryTimer) clearInterval(this.expiryTimer);
}

private async processExpiredDocs(): Promise<void> {
  // Phase 1: Mark newly expired docs
  const expired = await this.db`
    UPDATE org_documents
    SET lifecycle_status = 'expired', updated_at = NOW()
    WHERE expires_at IS NOT NULL
      AND expires_at <= NOW()
      AND lifecycle_status = 'active'
    RETURNING id, org_id, path
  `;

  if (expired.length > 0) {
    this.logger.log(`Marked ${expired.length} documents as expired`);
  }

  // Phase 2: Archive docs expired for >7 days (configurable)
  const graceDays = parseInt(process.env.EVE_DOC_EXPIRY_GRACE_DAYS ?? '7', 10);
  const archived = await this.db`
    UPDATE org_documents
    SET lifecycle_status = 'archived',
        content = '[archived]',
        updated_at = NOW()
    WHERE lifecycle_status = 'expired'
      AND expires_at <= NOW() - INTERVAL '1 day' * ${graceDays}
    RETURNING id, org_id, path
  `;

  if (archived.length > 0) {
    this.logger.log(`Archived ${archived.length} documents (content preserved in version history)`);
  }
}
```

**KV expiry** (piggyback on the same timer):

```typescript
// Also purge expired KV entries
await agentKvQueries(this.db).purgeExpired(1000);
```

The `purgeExpired()` method already exists in `packages/db/src/queries/agent-kv.ts`
but nothing calls it today.

**CLI surface:**

```bash
# List documents approaching expiry
eve docs list --org org_xxx --lifecycle-status expired

```

### What This Doesn't Do

- No hard delete — archived docs keep path/metadata for audit, content stored in version history
- No notification before expiry — agents/owners could be warned, but that's a future feature
- No org-level toggle to disable auto-expiry — all orgs get it (can set `EVE_DOC_EXPIRY_GRACE_DAYS` very high to effectively disable)

---

## Migration

A single migration covers Features 1 and 2, plus supporting indexes:

```sql
-- Migration: 00080_production_hardening.sql

-- Feature 1: Ingest deduplication
ALTER TABLE ingest_records
  ADD COLUMN IF NOT EXISTS content_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_ingest_fingerprint
  ON ingest_records (project_id, content_fingerprint)
  WHERE content_fingerprint IS NOT NULL AND status != 'failed';

-- Feature 2: Dead letter disposition
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS failure_disposition TEXT
  CHECK (failure_disposition IN ('cancelled', 'failed', 'upstream_failed'));

-- Backfill: existing cancelled jobs with close_reason containing 'failed'
-- get 'failed' disposition; others get 'cancelled'
UPDATE jobs
SET failure_disposition = CASE
  WHEN close_reason ILIKE '%failed%' OR close_reason ILIKE '%error%' THEN 'failed'
  WHEN close_reason ILIKE '%upstream%' THEN 'upstream_failed'
  ELSE 'cancelled'
END
WHERE phase = 'cancelled' AND failure_disposition IS NULL;

-- Index for dead letter queries
CREATE INDEX IF NOT EXISTS idx_jobs_dead_letters
  ON jobs (project_id, failure_disposition)
  WHERE phase = 'cancelled' AND failure_disposition = 'failed';
```

---

## Implementation Order

Features are ordered by dependency and risk:

| Phase | Features | Depends On | Risk | Effort |
|-------|----------|------------|------|--------|
| 1 | **Migration** (schema changes) | Nothing | Low | 1 hour |
| 2 | **F3**: Per-phase latency in diagnostics | Nothing | Zero (CLI-only) | 2 hours |
| 3 | **F4**: Routing decision logging | Nothing | Zero (append-only log) | 2 hours |
| 4 | **F6**: `created_by` consistency | Nothing | Low (audit + populate) | 3 hours |
| 5 | **F5**: Cost breakdown by agent | Nothing | Low (read-only query) | 3 hours |
| 6 | **F8**: Auto document expiration | Migration | Low (background loop) | 3 hours |
| 7 | **F1**: Content dedup at ingest | Migration | Low (confirm-time check) | 4 hours |
| 8 | **F2**: Dead letter handling | Migration | Low (query + CLI) | 3 hours |
| 9 | **F7**: Auto-retry policies | F2 (uses failure_disposition) | Medium (orchestrator change) | 6 hours |

**Total estimated effort: ~3 days of focused work.**

Phases 2-5 are zero-risk (read-only or CLI-only changes) and can be done first
to build momentum. Phase 9 (auto-retry) is the most complex because it touches
the orchestrator's attempt lifecycle — it should be the last feature implemented
and tested carefully against the k3d stack.

---

## Testing Strategy

| Feature | Test Type | How |
|---------|-----------|-----|
| F1: Dedup | Integration | Upload same file twice, verify second returns `deduplicated: true` |
| F2: Dead letters | Integration | Create job, fail it, query `--dead-letters`, verify disposition |
| F3: Latency | Manual | Run job against k3d, check `eve job diagnose` shows waterfall |
| F4: Routing log | Manual | Run job, check `eve job logs` shows routing event |
| F5: Cost by agent | Integration | Create jobs with different agents, check analytics grouping |
| F6: Created by | Integration | Create job via API with auth, verify `actor_user_id` populated |
| F7: Auto-retry | Integration + Manual | Create job with retry policy, trigger timeout, verify auto-retry |
| F8: Doc expiry | Integration | Create doc with `expires_at` in past, wait for loop, verify status change |

Manual test scenario candidates:
- **Scenario 31**: Production hardening smoke test (dedup, dead letters, retry, cost breakdown)
- Can be added to `tests/manual/scenarios/31-production-hardening.md`

---

## CLI Summary

New commands and flags across all features:

```bash
# Feature 1: Dedup
eve ingest confirm <id> --force       # Skip dedup check

# Feature 2: Dead letters
eve job list --dead-letters            # Show failed (not cancelled) jobs
eve job list --disposition failed      # Explicit filter
eve job retry <id>                     # Re-run a dead letter

# Feature 3: Latency (no new commands, enhanced output)
eve job diagnose <id>                  # Now includes latency waterfall

# Feature 4: Routing (no new commands, enhanced output)
eve job diagnose <id>                  # Now includes routing decision
eve job logs <id>                      # Routing event visible in logs

# Feature 5: Cost by agent
eve analytics cost-by-agent --window 7d

# Feature 6: Created by (no new commands, enhanced output)
eve job show <id> --verbose            # Shows created_by

# Feature 7: Auto-retry
eve job create --retry-max 3 --retry-backoff 30

# Feature 8: Doc expiry (no new commands expected; if needed, extend existing docs filters)
eve docs list --org org_xxx --lifecycle-status expired
```

---

## What This Plan Deliberately Excludes

These are Tier 2/3 features from the gap analysis that warrant separate plans:

- **Cost anomaly alerts** — needs alerting infrastructure (webhooks? email? Slack?)
- **Per-agent budget caps** — needs budget enforcement changes and a new table
- **Vector embeddings / semantic search** — needs embedding pipeline and pgvector
- **PII redaction** — needs LLM proxy (Phase 3 of secret hardening)
- **Task checkpointing / mid-job resume** — needs fundamental job model changes
- **Compliance audit log** — needs request-level middleware across all services
- **Chunking library** — useful but not urgent; agents handle this well enough via prompts

Each of these is a plan-sized feature on its own. This plan is about the
compound value of doing eight small things well.
