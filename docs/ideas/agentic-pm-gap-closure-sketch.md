# Agentic PM App Gap Closure Sketch

> Status: Superseded by `docs/plans/agentic-pm-gap-closure-plan.md`
> Last Updated: 2026-02-11
>
> Inputs:
> - `docs/plans/agentic-pm-app-reimagined-plan.md`
> - `docs/plans/agentic-app-identity-auth-access-plan.md`
> - `docs/plans/agentic-app-context-intelligence-plan.md`
> - `docs/plans/agentic-app-infra-provisioning-plan.md`
> - `docs/system/events.md`
> - `docs/system/threads.md`
> - `docs/system/openapi.yaml`

## Brief

`docs/plans/agentic-pm-app-reimagined-plan.md` already defines the PM app
shape and calls out the remaining platform gaps. This doc turns those gaps into
a concrete closure sketch with API, data model, CLI, and rollout guidance.

Goal: close all remaining gaps while preserving the PM app principle of a thin
coordinator and Eve-native primitives.

## Resolved Product Decisions

These answers remove ambiguity from the reimagined plan's open questions:

1. Canonical artifacts live in Eve resources (org docs + job attachments), not
   dual-written to the PM DB.
2. Coordinator owns interaction and approvals; deterministic execution lives in
   jobs/workflows/pipelines.
3. PM control plane is single-org in v1 (one service principal per org). Multi-org
   control plane is a v2 concern.

## Gap Closure Matrix

| Gap from Reimagined PM Plan | Closure Primitive | Phase |
| --- | --- | --- |
| Unified resource plane (attachments + docs, versioning, ACL) | Adapter-backed Resource FS over existing `org_documents` + `job_attachments` with canonical roots | 1 |
| `docs.updated` events + doc version listing | Versioned writes + `system.doc.*` events + versions API | 1 |
| Structured metadata queries for docs | `POST /orgs/:id/docs/query` filter DSL + indexes | 1 |
| Auto-mount `resource_refs` into workspace | Worker resolver + preflight snapshot mount under stable `.eve/resources/*` roots | 1 |
| Webhook replay/backfill | Replay endpoint + cursor-based enqueue + delivery dedupe | 2 |
| Batch job creation (atomic epic + children graph) | `POST /projects/:id/jobs/batch` transactional DAG API | 3 |
| Cross-project agent-to-agent messaging | Org-scoped thread primitive for agent mailboxes | 3 |
| Org-level analytics (pipelines/releases/deploy/env health) | Org analytics read model + aggregate endpoints | 4 |
| OpenAPI parity (threads/events/webhooks) | CI contract gate for generated OpenAPI + path coverage tests | 2 |

## Primitive Sketches

### 1) Adapter-Backed Resource FS (Use Existing DB Stores First)

Do not introduce a brand-new storage plane first. Use existing DB-backed stores
as canonical sources and add a resolver layer with stable roots.

**Existing canonical stores:**
- `org_documents` (org/project-scoped docs, metadata, full-text search)
- `job_attachments` (job-scoped structured artifacts)

**Canonical resource roots:**
- `org_docs:/<path>`
- `job_attachments:/<job_id>/<attachment_name_or_id>`

**Resolver contract:**
1. Accept existing `resource_refs` (`kind=org_doc|attachment` + `path|id`).
2. Normalize each ref to canonical URI + metadata.
3. Resolve content from the backing store.
4. Return immutable snapshot metadata (hash/version/updated_at) used by worker
   hydration.

This gives a unified resource plane behavior without migration risk and keeps
`/orgs/:id/docs*` and `/jobs/:id/attachments*` as first-class APIs.

### 2) Doc Versioning + `system.doc.*` Events

Every doc write creates a new version and emits events.

**Event types:**
- `system.doc.created`
- `system.doc.updated`
- `system.doc.deleted`

**Payload shape (example):**

```json
{
  "org_id": "org_xxx",
  "project_id": "proj_xxx",
  "doc_id": "doc_xxx",
  "path": "/pm/features/FEAT-123/plans/v2.md",
  "version": 2,
  "content_hash": "sha256:...",
  "actor_id": "svc_pm_control"
}
```

**Storage note:** implement doc versions as an append-only
`org_document_versions` table (or equivalent) keyed by `doc_id + version`.

**API additions:**
- `GET /orgs/:id/docs/:path/versions`
- `GET /orgs/:id/docs/:path/versions/:version`

### 3) Structured Metadata Query

Full-text search is not enough for PM filters (owner, priority, feature type,
project tags, status).

**API sketch:**

```http
POST /orgs/{org_id}/docs/query
```

```json
{
  "path_prefix": "/pm/features/",
  "where": {
    "metadata.feature_status": { "in": ["draft", "review"] },
    "metadata.owner": { "eq": "pm-team" },
    "metadata.risk_score": { "gte": 4 }
  },
  "sort": [{ "field": "updated_at", "direction": "desc" }],
  "limit": 50,
  "cursor": null
}
```

**Implementation note:** this is a docs-first query surface backed by
`org_documents.metadata` indexes. Attachment query expansion can be added later
without changing `resource_refs` roots.

### 4) Stable `resource_refs` Mounting in Workspaces

`resource_refs` must become deterministic files available to agents at job
start, not just JSON metadata.

**Worker behavior:**
1. Resolve refs before harness launch using canonical roots (`org_docs:/...`,
   `job_attachments:/...`).
2. Materialize a read-only snapshot into `.eve/resources/`.
3. Write `.eve/resources/index.json` with source URI + snapshot metadata.
4. Inject `EVE_RESOURCE_INDEX=.eve/resources/index.json`.
5. Fail job provisioning if any required ref is missing or unreadable.

**Path convention:**
- `.eve/resources/org_docs/<path>`
- `.eve/resources/job_attachments/<job_id>/<name-or-id>`

**Why this shape:** agents can use normal file tools (`rg`, `grep`, `cat`) on
stable local paths while data authority remains DB-backed.

### 5) Webhook Replay and Backfill

Missed webhook windows must be recoverable without manual DB forensics.

**API sketch:**
- `POST /orgs/:id/webhooks/:wh_id/replay`
- `POST /orgs/:id/webhooks/:wh_id/replay-from-cursor`

**Replay request example:**

```json
{
  "from": { "event_id": "evt_abc123" },
  "to": { "time": "2026-02-11T10:00:00Z" },
  "max_events": 5000,
  "dry_run": false
}
```

**Reliability rules:**
- Dedupe key: `(subscription_id, event_id)`.
- Replay enqueues deliveries; normal signing/retry rules still apply.
- Support dry-run count for operator safety.

### 6) Batch Job Creation for Atomic Graphs

PM handoff needs atomic creation of epic + child jobs + dependencies.

**API sketch:**

```http
POST /projects/{project_id}/jobs/batch
```

```json
{
  "idempotency_key": "pm-plan-123-v4",
  "nodes": [
    { "key": "epic", "title": "Implement export feature", "phase": "ready" },
    { "key": "api", "title": "Build export API", "parent": "epic" },
    { "key": "worker", "title": "Add async exporter", "parent": "epic" }
  ],
  "edges": [
    { "from": "api", "to": "worker", "type": "depends_on" }
  ]
}
```

**Semantics:**
- Validate DAG + permissions first.
- Single transaction for create + relation wiring.
- All-or-nothing failure on validation or write error.

### 7) Cross-Project Agent Messaging Primitive

Use org-scoped thread continuity instead of ad hoc callbacks between projects.

**Primitive:** org-scoped threads (`scope = org`) with agent participants.

**Thread key convention:**
- `org:{org_id}:agents:{sender_slug}:{receiver_slug}:{topic}`

**API sketch:**
- `POST /orgs/:id/threads`
- `POST /orgs/:id/threads/:thread_id/messages`
- `GET /orgs/:id/threads/:thread_id/messages`

This keeps cross-project messaging on the same thread/message/event model
already used for chat and coordination.

### 8) Org-Level Analytics Read Model

PM dashboards need aggregates across pipelines, releases, deployments, and env
health with permission-aware filtering.

**Aggregate endpoints:**
- `GET /orgs/:id/analytics/summary`
- `GET /orgs/:id/analytics/pipelines`
- `GET /orgs/:id/analytics/releases`
- `GET /orgs/:id/analytics/deployments`
- `GET /orgs/:id/analytics/env-health`

**Core metrics (v1):**
- Pipeline run success rate by project and window.
- Release throughput and lead time to deploy.
- Deployment failure/rollback rate.
- Unhealthy environment count and duration.

### 9) OpenAPI Parity for Threads, Events, Webhooks

Current contract drift blocks reliable app/client generation.

**Closure mechanics:**
1. Generate OpenAPI from controllers in CI.
2. Compare generated spec to committed `docs/system/openapi.yaml`.
3. Fail CI on path/schema drift.
4. Add explicit parity tests for:
   - `/threads/*`
   - `/projects/*/events*` and org event routes
   - webhook subscription/delivery/replay routes

## Rollout Sequence

### Phase 1: Resource Plane Hardening

Ship primitives 1-4 together (adapter-backed roots + version/events + query +
workspace hydration) so PM artifacts, refs, and file-tool ergonomics are
coherent from day one.

### Phase 2: Reactive Reliability + API Contract Integrity

Ship primitives 5 and 9 together so production apps can recover missed events
and trust generated API contracts.

### Phase 3: Planning Graph and Collaboration Core

Ship primitives 6 and 7 so PM handoff and cross-project coordination are
transactional and first-class.

### Phase 4: Portfolio Intelligence

Ship primitive 8 using org analytics read models once event and data fidelity
from prior phases is stable.

## Exit Criteria (All Gaps Closed)

1. PM app can store, version, query, and reference artifacts without side stores.
2. Agents receive `resource_refs` as stable files in workspace on every run.
3. Operators can replay webhook windows with dedupe and signed delivery history.
4. PM handoff creates complete job graphs atomically in one API call.
5. Agents can message across projects via org-scoped thread primitives.
6. PM dashboard reads org-wide delivery analytics via first-class endpoints.
7. OpenAPI spec is CI-enforced and includes threads/events/webhooks surfaces.
