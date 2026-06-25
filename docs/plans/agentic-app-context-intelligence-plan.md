# Agentic App Plan B: Context Plane & Org Intelligence

> Status: Plan
> Last Updated: 2026-02-11
>
> Inputs:
> - `docs/ideas/agentic-app-platform-primitives-roadmap.md`
> - `docs/ideas/native-agentic-app-primitives-roadmap.md`
> - `docs/ideas/platform-primitives-for-agentic-apps.md` (Primitives 1, 2, 4, 5, 6)
> - `docs/ideas/agentic-pm-native-app-platform-gap-analysis.md`
>
> Parallel Streams:
> - **Plan A**: `docs/plans/agentic-app-identity-auth-access-plan.md`
> - **Plan C**: `docs/plans/agentic-app-infra-provisioning-plan.md`

## Brief

This plan covers the data primitives that let agents exchange structured context,
persist org-level knowledge, query across projects, and receive push
notifications when things happen.

Everything here touches API controllers, new DB tables, and the query layer. It
has no overlap with Plan A (auth middleware/RBAC) or Plan C (worker/deployer/
infra), so it runs fully in parallel.

## Why This Stream Exists

Agents pass context via job descriptions (lossy), workspace files (fragile), or
external stores (chicken-and-egg). Portfolio views require N+1 client loops.
Apps poll for updates. These five primitives turn Eve from "can host agentic
apps with workarounds" into "the natural platform for agentic apps."

---

## Phase 1: Job Attachments

### Problem

A job's context is its `description` (plain text) and `hints` (key-value).
Agents stuffing structured documents into descriptions lose structure. Writing
workspace files is fragile. There is no durable context-exchange primitive.

### What We Build

New `job_attachments` table + CRUD API + CLI commands.

**DB schema:**

```sql
CREATE TABLE job_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'text/plain',
  content       TEXT NOT NULL,
  content_hash  TEXT GENERATED ALWAYS AS (encode(sha256(content::bytea), 'hex')) STORED,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(job_id, name)
);

CREATE INDEX idx_job_attachments_job ON job_attachments(job_id);
```

**API:**

```
POST   /jobs/:id/attachments           -- attach a document
GET    /jobs/:id/attachments           -- list attachments (metadata only)
GET    /jobs/:id/attachments/:att_id   -- get attachment content
DELETE /jobs/:id/attachments/:att_id   -- remove attachment
```

**CLI:**

```bash
eve jobs attach <job_id> --file plan.md --name "Implementation Plan"
eve jobs attach <job_id> --stdin --name "Code Insight" --mime application/json
eve jobs attachments <job_id>
eve jobs attachment <job_id> --name "Implementation Plan"
```

### Implementation Notes

- Text-only (markdown, JSON, YAML). No binary blobs — store URL references for
  images/PDFs.
- Size limit: 1MB per attachment, 10MB total per job. Configurable per org.
- `content_hash` enables dedup and change detection.
- `created_by` stores agent slug or user ID.
- Attachments cascade-delete with the job.
- The existing `AttachmentSchema` in `packages/shared/src/schemas/attempt.ts`
  should be aligned with this table schema.

### Spec Format Convention

Structured plans use job attachments with conventional naming:

```bash
eve jobs attach <epic_id> --file spec.yaml --name "spec" --mime application/x-eve-spec
```

Factory agents look for attachments with mime `application/x-eve-spec`. No rigid
spec schema — let the format emerge from real usage.

### Exit Criteria

- Agents can attach, list, read, and delete documents on any job.
- CLI commands work end-to-end.
- Size limits enforced.

---

## Phase 2: Job Targeting + Resource Refs

### Problem

App backends must manually resolve agent IDs before creating jobs. The job
create API has no `target` field. Apps submit plumbing, not intent.

### What We Build

Add `target` and `resource_refs` to the job create payload.

**Schema change:**

```json
POST /projects/{project_id}/jobs
{
  "description": "Ground export feature in code reality",
  "target": {
    "agent_slug": "myapp-pm-code-recon",
    "team": "code-recon-team",
    "workflow": "deep-analysis"
  },
  "resource_refs": [
    { "kind": "attachment", "id": "att_abc" },
    { "kind": "org_doc", "path": "/reports/architecture.md" }
  ]
}
```

**Resolution rules:**

1. If `target.agent_slug` is set, resolve to agent ID and assign.
2. If `target.team` is set, route via team dispatch.
3. If `target.workflow` is set, create workflow execution.
4. `resource_refs` are stored on the job and available to the executing agent.

### Implementation Notes

- `target` is optional — existing `assignee` field continues to work.
- `resource_refs` supports both job attachment IDs and org doc paths (Phase 3).
- `resource_refs` is a JSONB column on the jobs table.
- Agent slug resolution uses the existing agent registry lookup.
- Do NOT implement `resource_refs` as a job-only concept — it must support
  both attachments and org docs from v1.

### Exit Criteria

- Jobs can be created with `target.agent_slug` and auto-assigned.
- `resource_refs` stored on job and accessible to executing agent.
- Existing job creation (no target) still works unchanged.

---

## Phase 3: Org Document Store

### Problem

Agents accumulate knowledge that should persist across jobs and projects —
architecture reports, risk assessments, product context. Today this knowledge
is lost when jobs end or lives in git (pollutes history).

### What We Build

DB-backed document store with full-text search and search/replace edit API.

**DB schema:**

```sql
CREATE TABLE org_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id),
  project_id    UUID REFERENCES projects(id),
  path          TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'text/markdown',
  content       TEXT NOT NULL,
  content_hash  TEXT GENERATED ALWAYS AS (encode(sha256(content::bytea), 'hex')) STORED,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata      JSONB DEFAULT '{}',
  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(path, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) STORED,
  UNIQUE(org_id, path)
);

CREATE INDEX idx_org_docs_search ON org_documents USING GIN(search_vector);
CREATE INDEX idx_org_docs_project ON org_documents(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_org_docs_metadata ON org_documents USING GIN(metadata);
CREATE INDEX idx_org_docs_org_path ON org_documents(org_id, path);
```

**API:**

```
POST   /orgs/:id/docs                     -- create document
GET    /orgs/:id/docs?path=/reports/       -- list documents at path prefix
GET    /orgs/:id/docs/:path               -- read document
PUT    /orgs/:id/docs/:path               -- full replace
PATCH  /orgs/:id/docs/:path               -- search/replace edit
DELETE /orgs/:id/docs/:path               -- delete
GET    /orgs/:id/docs/search?q=...        -- full-text search
```

**Search/replace edit (PATCH):**

```json
{
  "operations": [
    { "op": "replace", "search": "old text", "replace": "new text" },
    { "op": "append", "content": "new section..." },
    { "op": "insert_after", "anchor": "## Section", "content": "..." }
  ]
}
```

**CLI:**

```bash
eve docs write --org org_xxx --path /reports/arch.md --file arch.md
eve docs read --org org_xxx --path /reports/arch.md
eve docs list --org org_xxx --path /reports/
eve docs search --org org_xxx --query "authentication flow"
eve docs delete --org org_xxx --path /reports/arch.md
```

### Implementation Notes

- Text documents only (markdown, JSON, YAML). Postgres handles these well up
  to ~10MB per doc.
- `project_id` is optional — documents can be org-scoped or project-scoped.
- `metadata` JSONB enables flexible tagging and categorization.
- Search/replace edit gives agents atomic document manipulation without
  full-content round-trips.
- Size limit: 10MB per document, configurable per org.
- `resource_refs` (Phase 2) can reference org docs by path.

### Exit Criteria

- Agents can CRUD org-level documents with full-text search.
- Search/replace edit works atomically.
- CLI commands work end-to-end.
- `resource_refs` on jobs can reference org doc paths.

---

## Phase 4: Cross-Project Query Endpoints

### Problem

An app managing multiple projects needs portfolio views. Today it loops through
each project and aggregates client-side. N+1 queries for basic dashboard data.

### What We Build

Org-scoped query endpoints with permission-aware filtering.

**API:**

```
GET /orgs/:id/jobs?status=open&agent_slug=pm-*     -- jobs across all projects
GET /orgs/:id/jobs/stats                            -- aggregate counts by status/project
GET /orgs/:id/events?type=system.job.*&since=...    -- org-wide event stream
GET /orgs/:id/agents                                -- all agents across projects
```

### Implementation Notes

- Permission filtering: results only include jobs/agents from projects where
  the caller has read access. Uses existing membership/permission model.
- When Plan A ships custom roles, the permission filter uses the union model.
  Until then, base membership roles work correctly.
- Pagination required — org-level queries can return large result sets.
  Cursor-based pagination (not offset).
- `agent_slug` filter supports glob patterns (`pm-*`).
- Stats endpoint returns aggregates, not individual records — efficient for
  dashboards.
- Event stream endpoint supports `since` parameter for incremental polling.

### Exit Criteria

- `GET /orgs/:id/jobs` returns permission-filtered jobs across all projects.
- Stats endpoint returns aggregate counts.
- Event stream supports incremental queries.
- Results respect project-level access control.

---

## Phase 5: Webhook Subscriptions

### Problem

Apps need push notifications when jobs/pipelines complete. Polling wastes
resources and adds latency.

### What We Build

Outbound webhook delivery with HMAC signing, retry queue, and delivery log.

**DB schema:**

```sql
CREATE TABLE webhook_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id),
  project_id    UUID REFERENCES projects(id),  -- NULL = org-wide
  url           TEXT NOT NULL,
  events        TEXT[] NOT NULL,
  filter        JSONB DEFAULT '{}',
  secret_hash   TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id   UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL,
  payload           JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  attempts          INT NOT NULL DEFAULT 0,
  last_attempt_at   TIMESTAMPTZ,
  response_status   INT,
  response_body     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_deliveries_pending ON webhook_deliveries(status)
  WHERE status IN ('pending', 'retrying');
```

**API:**

```
POST   /orgs/:id/webhooks                    -- create subscription (org-wide)
POST   /projects/:id/webhooks                -- create subscription (project-scoped)
GET    /orgs/:id/webhooks                    -- list subscriptions
GET    /orgs/:id/webhooks/:wh_id             -- get subscription
DELETE /orgs/:id/webhooks/:wh_id             -- delete subscription
GET    /orgs/:id/webhooks/:wh_id/deliveries  -- delivery log
POST   /orgs/:id/webhooks/:wh_id/test        -- send test event
```

**Payload format (CloudEvents envelope):**

```json
{
  "specversion": "1.0",
  "type": "system.job.completed",
  "source": "eve://orgs/org_xxx/projects/proj_yyy",
  "id": "evt_abc123",
  "time": "2026-02-11T10:30:00Z",
  "data": {
    "job_id": "job_xxx",
    "agent_slug": "pm-code-recon",
    "status": "completed"
  }
}
```

**Signing:** HMAC-SHA256 of the raw payload body, sent in `X-Eve-Signature-256`
header.

**CLI:**

```bash
eve webhooks create --org org_xxx --url https://pm.myorg.com/webhooks/eve \
  --events system.job.completed,system.job.failed \
  --filter '{"agent_slug":"pm-*"}'
eve webhooks list --org org_xxx
eve webhooks deliveries --org org_xxx --webhook wh_xxx
eve webhooks test --org org_xxx --webhook wh_xxx
```

### Implementation Notes

- Retry policy: exponential backoff — 1m, 5m, 30m, 2h, 12h. Max 5 retries.
- Dead letter: after max retries, delivery status = `failed`. Subscription
  auto-disabled after 10 consecutive failures. `eve webhooks enable` to re-enable.
- Filter supports `agent_slug` glob and `project_id` match.
- Delivery worker: background job processor that reads pending deliveries and
  dispatches HTTP requests. Separate from the event processing pipeline.
- Hooks into existing internal event system — when `system.job.completed` fires,
  the webhook delivery worker checks for matching subscriptions and enqueues.
- Strict signature verification: subscription `secret` is hashed for storage,
  raw secret used for HMAC computation.

### Exit Criteria

- Webhooks fire reliably on matching events with signed payloads.
- Retry and dead letter handling works correctly.
- Delivery log shows attempt history with response codes.
- Test endpoint sends a synthetic event for verification.

---

## Cross-Stream Dependencies

| This Plan Provides | Plans A/C Consume |
|---|---|
| Job attachments | Plan C: project bootstrap can attach initial docs |
| Org doc store | Plan C: bootstrap templates can seed org docs |
| Resource refs | Shared model referenced by both job targeting and org docs |

| This Plan Consumes | From Plan A |
|---|---|
| Service principal auth | Backend callers authenticate via service tokens (soft dep — user auth works until Plan A ships) |
| Custom role bindings | Org query permission filtering uses union model (soft dep — base roles work until Plan A ships) |

---

## Code Surface

| Area | Key Files |
|---|---|
| Job model | `packages/db/src/queries/jobs.ts`, `packages/shared/src/schemas/job.ts` |
| Attempt attachments (existing type) | `packages/shared/src/schemas/attempt.ts` |
| API controllers | `apps/api/src/controllers/` |
| Event system | `apps/api/src/services/events/` |
| DB migrations | `packages/db/migrations/` |
| CLI commands | `packages/cli/src/commands/` |

---

## Delivery Summary

| Phase | Primitive | Cost | Unlocks |
|---|---|---|---|
| 1 | Job attachments | Low | Durable context exchange between agents |
| 2 | Job target + resource_refs | Low | Intent-level job creation |
| 3 | Org document store | Medium | Persistent org-level knowledge |
| 4 | Cross-project queries | Medium | Portfolio views without N+1 loops |
| 5 | Webhook subscriptions | High | Push updates, no polling |
