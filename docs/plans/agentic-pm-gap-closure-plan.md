# Agentic PM Gap Closure Plan

> Status: Plan
> Last Updated: 2026-02-11
>
> Inputs:
> - `docs/plans/agentic-pm-app-reimagined-plan.md`
> - `docs/ideas/agentic-pm-gap-closure-sketch.md`
> - `docs/plans/agentic-app-identity-auth-access-plan.md` (Plan A)
> - `docs/plans/agentic-app-context-intelligence-plan.md` (Plan B)
> - `docs/plans/agentic-app-infra-provisioning-plan.md` (Plan C)
> - `docs/system/events.md`
> - `docs/system/threads.md`
> - `docs/system/manifest.md`
> - `docs/system/job-cli.md`
> - `docs/system/openapi.yaml`

## Brief

The reimagined PM plan (`agentic-pm-app-reimagined-plan.md`) defines the PM app
as a thin coordinator over Eve primitives and calls out nine remaining platform
gaps. The gap closure sketch (`agentic-pm-gap-closure-sketch.md`) turns those
gaps into concrete primitives.

This plan takes the sketch and produces an implementation-ready design:
concrete SQL, API contracts, CLI commands, worker behavior, and composition
rules. Every primitive is designed to dovetail with existing Eve infrastructure
so the PM app never touches anything that isn't already a platform capability.

## Design Principle

**One unifying idea: everything is a document, every document is addressable,
every address resolves to content, and every mutation emits an event.**

This means:
- Org docs and job attachments share a canonical addressing scheme.
- `resource_refs` on jobs resolve to files in the agent workspace.
- Doc mutations emit events that flow through the existing event spine.
- Events trigger webhooks, which are replayable.
- Batch job creation wires resource refs atomically.
- Cross-project messaging uses org-scoped threads (same thread primitive).
- Analytics aggregate event-derived data.
- OpenAPI ensures all of the above is trustworthy.

## Agent Experience Requirements (Non-Negotiable)

This plan is optimized for agents engineering apps on top of Eve. Each
primitive must be:

1. **Obvious by default**: one happy-path command for create/read/list/follow.
2. **Discoverable**: list endpoints exist for every new object type, and all
   new shapes are documented in OpenAPI examples.
3. **Debuggable from CLI**: every mutation has a corresponding inspect command
   (`show`, `list`, `diagnose`, `follow`, or `diff`) with machine-readable JSON.
4. **Deterministic for replay**: resource resolution snapshots are pinned to
   explicit hashes/versions at attempt start.
5. **Fail-fast with typed errors**: no silent partial success for required
   resources or graph validation.
6. **Traceable end-to-end**: API response/request IDs, event IDs, job IDs, and
   thread IDs are linkable in logs and diagnostics.

## Notation Conventions

- Controller route examples use Nest-style `:param`.
- OpenAPI parity tests use `{param}` paths (spec format).
- Any `:path` route parameter is a URL-encoded document path without a leading
  slash. CLI remains human-friendly and always accepts raw `--path`.

## Resolved Decisions

From the reimagined plan's open questions and the sketch's product decisions:

1. **Canonical artifacts live in Eve resources** (org docs + job attachments),
   not dual-written to the PM DB.
2. **Coordinator owns interaction and approvals**; deterministic execution lives
   in jobs/workflows/pipelines.
3. **PM control plane is single-org in v1** (one service principal per org).
4. **Orchestration lives in coordinator for interactive flows**, in
   workflows/pipelines for deterministic flows.

## Cross-Cutting Error Contract

All new endpoints in this plan must return machine-readable error codes and a
request trace handle in failure responses.

**Minimum error payload shape:**

```json
{
  "error": {
    "code": "resource_not_found",
    "message": "Resource org_docs:/pm/features/FEAT-123.md not found",
    "hint": "Check path, org scope, and version suffix",
    "details": { "uri": "org_docs:/pm/features/FEAT-123.md" }
  },
  "request_id": "req_abc123"
}
```

**Shared error code set (initial):**

| Code | Typical Surface |
|---|---|
| `resource_uri_invalid` | resource resolver, batch validation |
| `resource_not_found` | resolver, workspace hydration |
| `resource_access_denied` | resolver, org docs access |
| `doc_query_invalid_filter` | docs metadata query |
| `batch_graph_cycle` | batch job graph validation |
| `batch_node_unknown` | batch dependency references |
| `webhook_replay_window_invalid` | replay request validation |
| `thread_scope_forbidden` | org-thread access checks |
| `analytics_window_invalid` | analytics window parsing |

The same `error.code` values must appear in API responses, webhook replay logs,
and CLI `--json` output.

---

## Primitive 1: Versioned Org Documents

> Closes gaps: "docs.updated events + version listing" and "structured metadata
> queries for docs"

Plan B Phase 3 defines the `org_documents` table. This primitive adds version
history, mutation events, and structured query — making org docs
production-grade for PM artifact storage.

### 1a. Version History

Every doc write creates an immutable version row. The `org_documents` table
always reflects the latest version; `org_document_versions` is the audit trail.

**DB schema:**

```sql
CREATE TABLE org_document_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id        UUID NOT NULL REFERENCES org_documents(id) ON DELETE CASCADE,
  version       INT NOT NULL,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  metadata      JSONB DEFAULT '{}',
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(doc_id, version)
);

CREATE INDEX idx_doc_versions_doc ON org_document_versions(doc_id, version DESC);
```

**Write behavior:**
1. Insert into `org_document_versions` with `version = current_max + 1`.
2. Update `org_documents` row with new content, content_hash, metadata,
   updated_at.
3. Emit `system.doc.updated` event (see 1b).
4. All three operations in a single transaction.

**API additions:**

```
GET /orgs/:org_id/docs/:path/versions           -- list versions (paginated)
GET /orgs/:org_id/docs/:path/versions/:version  -- read specific version
```

Path example:
- Doc path `/pm/features/FEAT-123.md`
- Route parameter `:path` value `pm%2Ffeatures%2FFEAT-123.md`

**CLI:**

```bash
eve docs versions --org org_xxx --path /pm/features/FEAT-123.md
eve docs read --org org_xxx --path /pm/features/FEAT-123.md --version 3
```

### 1b. Document Lifecycle Events

Doc mutations emit events through the existing event spine. These events are
stored in the `events` table and processed by the orchestrator's event router,
meaning they can trigger pipelines, match webhook subscriptions, and appear in
org event streams — no new event infrastructure needed.

**Event types:**
- `system.doc.created`
- `system.doc.updated`
- `system.doc.deleted`

**Payload shape:**

```json
{
  "org_id": "org_xxx",
  "project_id": "proj_xxx",
  "doc_id": "doc_xxx",
  "doc_version_id": "docv_xxx",
  "path": "/pm/features/FEAT-123/plans/v2.md",
  "version": 2,
  "content_hash": "sha256:abc123...",
  "actor_id": "svc_pm_control",
  "mutation_id": "mut_abc123",
  "request_id": "req_abc123",
  "metadata": { "feature_status": "review" }
}
```

**Implementation:** Emitted by the org docs controller after each successful
write transaction. Uses `source: "system"` and follows the existing event
storage pattern in `apps/api/src/services/events/`. `mutation_id` is stable for
retry dedupe; `request_id` links API logs, events, and webhook deliveries.

### 1c. Structured Metadata Query

Full-text search is not enough for PM filters (owner, priority, feature type,
status). Add a query endpoint that filters on the JSONB `metadata` column
using Postgres containment operators.

**API:**

```
POST /orgs/:org_id/docs/query
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

**Operator mapping:**

| Filter Operator | Postgres Expression |
|---|---|
| `eq` | `metadata @> '{"key": "value"}'::jsonb` |
| `in` | `metadata->'key' ?| array[...]` or `IN` over extracted text |
| `gte` / `lte` | `(metadata->>'key')::numeric >= N` |
| `exists` | `metadata ? 'key'` |
| `prefix` | `metadata->>'key' LIKE 'prefix%'` |

**CLI:**

```bash
eve docs query --org org_xxx --path-prefix /pm/features/ \
  --where 'metadata.feature_status in draft,review' \
  --sort updated_at:desc --limit 20
```

**Implementation note:** Build a reusable query builder that translates the
filter DSL into parameterized SQL. The same builder can later be applied to
attachment metadata queries without changing the `resource_refs` model.

### 1d. Discoverability + Debug Surface

Add explicit operator and agent visibility commands:

```bash
eve docs show --org org_xxx --path /pm/features/FEAT-123.md --verbose
eve docs versions --org org_xxx --path /pm/features/FEAT-123.md
eve event list --org org_xxx --type system.doc.updated --since 15m
```

`eve docs show --verbose` should include: `doc_id`, `current_version`,
`content_hash`, `updated_at`, and latest `mutation_id`.

### Exit Criteria

- Doc writes create immutable version rows.
- `system.doc.*` events appear in the events table and can trigger webhooks.
- Structured metadata queries return correct results with cursor pagination.
- Version listing and version-specific reads work via API and CLI.
- Doc metadata and version provenance are visible via one CLI read command.

---

## Primitive 2: Resource Plane (Resolver + Workspace Hydration)

> Closes gaps: "unified resource plane (attachments + docs)" and "auto-mount
> resource_refs into workspace"

This is the linchpin primitive. It gives agents a unified way to reference and
consume content from both org docs and job attachments as local files.

### 2a. Canonical Resource URIs

Every resource in Eve has a canonical URI:

| Store | URI Pattern | Example |
|---|---|---|
| Org docs (latest) | `org_docs:/{path}` | `org_docs:/pm/features/FEAT-123.md` |
| Org docs (pinned) | `org_docs:/{path}@v{version}` | `org_docs:/pm/features/FEAT-123.md@v4` |
| Job attachments | `job_attachments:/{job_id}/{name}` | `job_attachments:/myproj-a3f2dd12/plan.md` |

The `resource_refs` JSONB column on jobs (from Plan B Phase 2) stores these
URIs:

```json
[
  {
    "uri": "org_docs:/pm/features/FEAT-123.md@v4",
    "label": "Approved Plan",
    "required": true,
    "mount_path": "pm/approved-plan.md"
  },
  {
    "uri": "job_attachments:/myproj-a3f2dd12/code-insight.json",
    "label": "Code Insight",
    "required": false,
    "mount_path": "pm/code-insight.json"
  }
]
```

`resource_ref` fields:
- `uri` (required): canonical URI in supported scheme.
- `label` (optional): human-readable description used in logs/UI.
- `required` (optional, default `true`): fail provisioning if unresolved.
- `mount_path` (optional): relative file path under `.eve/resources/`; must not
  contain `..` or absolute prefixes.

If `mount_path` collides between refs, validation fails with
`resource_mount_conflict`.

### 2b. Resource Resolver Service

A shared service used by the worker (hydration), the API (ref validation), and
the CLI (direct resolution).

**Resolver contract:**

```typescript
interface ResolvedResource {
  uri: string;                    // canonical URI
  content: string;                // resolved content
  content_hash: string;           // sha256 of content
  mime_type: string;              // text/markdown, application/json, etc.
  version?: number;               // for org docs
  resolved_at: string;            // ISO timestamp (snapshot moment)
}

interface ResourceResolver {
  resolve(uri: string, org_id: string): Promise<ResolvedResource>;
  resolveMany(uris: string[], org_id: string): Promise<ResolvedResource[]>;
  validate(uri: string, org_id: string): Promise<{
    valid: boolean;
    error_code?: string;
    hint?: string;
  }>;
}
```

**Resolution rules:**
1. Parse the URI prefix to determine the backing store.
2. Query the appropriate table (`org_documents` or `job_attachments`).
3. Permission check: caller must have read access to the owning org/project.
4. Return immutable snapshot (content + hash + version).
5. Fail with `404` if the resource does not exist.
6. Fail with `403` if the caller lacks access.

**API:**

```
POST /orgs/:org_id/resources/resolve
```

```json
{
  "uris": [
    "org_docs:/pm/features/FEAT-123.md@v4",
    "job_attachments:/myproj-a3f2dd12/plan.md"
  ],
  "include_content": true
}
```

Response: array of `ResolvedResource` objects (content omitted in list mode;
included in single-resource mode).

**CLI:**

```bash
eve resources resolve org_docs:/pm/features/FEAT-123.md
eve resources ls org_docs:/pm/features/
eve resources cat org_docs:/pm/features/FEAT-123.md
```

### 2c. Workspace Hydration

The worker materializes `resource_refs` into the job workspace before harness
launch, using the same mount pattern as `x-eve.files`.

**Worker behavior:**
1. Read `resource_refs` from the job record.
2. Resolve each ref using the ResourceResolver.
3. Write content to `.eve/resources/{mount_path || store/path}`.
4. Write `.eve/resources/index.json` with metadata.
5. Inject `EVE_RESOURCE_INDEX=.eve/resources/index.json` into the environment.
6. Fail job provisioning if any required ref is missing or unreadable.
7. Preserve optional unresolved refs in index with `status=missing` and
   `error_code` for debugging.

**Workspace layout:**

```
.eve/resources/
  index.json                          # manifest of all resolved refs
  pm/
    approved-plan.md                  # from mount_path
    code-insight.json                 # optional attachment (if found)
```

**Index format:**

```json
{
  "resolved_at": "2026-02-11T10:00:00Z",
  "resources": [
    {
      "uri": "org_docs:/pm/features/FEAT-123.md@v4",
      "local_path": ".eve/resources/pm/approved-plan.md",
      "content_hash": "sha256:abc...",
      "version": 4,
      "label": "Feature Brief",
      "required": true,
      "status": "resolved"
    },
    {
      "uri": "job_attachments:/myproj-a3f2dd12/code-insight.json",
      "local_path": ".eve/resources/pm/code-insight.json",
      "required": false,
      "status": "missing",
      "error_code": "resource_not_found"
    }
  ]
}
```

**Why this shape:** Agents use normal file tools (`rg`, `grep`, `cat`) on
stable local paths. The index file gives programmatic access to metadata. Data
authority remains DB-backed.

### 2d. Provisioning Diagnostics

Hydration must be inspectable without kubectl:

- Persist attempt-level hydration summary in attempt metadata:
  `resolved_count`, `missing_optional_count`, `failed_required_count`,
  per-ref status.
- Emit worker-side provisioning events:
  `system.resource.hydration.started|completed|failed`.
- Extend `eve job diagnose <job-id>` to render a "Resources" section with
  URI, local path, hash/version, and failure hint.

### Exit Criteria

- `resource_refs` on jobs resolve to files in the workspace at job start.
- Agents can read resources as local files without API calls.
- `eve resources` CLI commands work for ad-hoc resolution.
- Missing or inaccessible refs fail the job before harness launch.
- `eve job diagnose` shows hydration provenance for every resource ref.

---

## Primitive 3: Webhook Replay + Backfill

> Closes gap: "webhook replay/backfill for missed events"

Plan B Phase 5 defines webhook subscriptions with HMAC signing and retry queue.
This primitive adds replay and backfill so production apps can recover from
missed delivery windows.

### API

```
POST /orgs/:org_id/webhooks/:wh_id/replays
GET  /orgs/:org_id/webhooks/:wh_id/replays/:replay_id
```

```json
{
  "from": { "event_id": "evt_abc123" },
  "to": { "time": "2026-02-11T10:00:00Z" },
  "max_events": 5000,
  "dry_run": false
}
```

**Response (dry_run=true):**

```json
{
  "event_count": 147,
  "earliest": "2026-02-10T22:15:00Z",
  "latest": "2026-02-11T09:58:00Z",
  "would_deduplicate": 3
}
```

**Response (dry_run=false):**

```json
{
  "replay_id": "rpl_xxx",
  "status": "queued",
  "requested": 147,
  "deduplicated": 3,
  "enqueued_at": "2026-02-11T10:01:00Z"
}
```

**Replay status response (`GET .../replays/:replay_id`):**

```json
{
  "replay_id": "rpl_xxx",
  "subscription_id": "wh_xxx",
  "status": "running",
  "requested": 147,
  "processed": 52,
  "replayed": 49,
  "deduplicated": 3,
  "failed": 0,
  "started_at": "2026-02-11T10:01:01Z",
  "updated_at": "2026-02-11T10:01:21Z"
}
```

### Reliability Rules

- **Dedupe key:** `(subscription_id, event_id)`. If a delivery already exists
  for this pair, skip it.
- **Replay enqueues deliveries** — normal signing, retry, and dead-letter rules
  still apply.
- **Dry-run** returns count + time range for operator safety before committing.
- **Replay lifecycle:** `queued -> running -> completed|failed|cancelled`.
- **Rate limit:** max 10,000 events per replay request, max 3 concurrent
  replays per subscription.
- **Cursor support:** `from.event_id` allows incremental replay from a known
  good position.
- **Operator traceability:** each replay gets `replay_id` for progress queries,
  audits, and incident timelines.

### CLI

```bash
eve webhooks replay --org org_xxx --webhook wh_xxx \
  --from evt_abc123 --to 2026-02-11T10:00:00Z --dry-run
eve webhooks replay --org org_xxx --webhook wh_xxx \
  --from evt_abc123 --to 2026-02-11T10:00:00Z
eve webhooks replay-status --org org_xxx --webhook wh_xxx --replay rpl_xxx
```

### Exit Criteria

- Operators can replay missed webhook delivery windows.
- Deduplication prevents double-delivery.
- Dry-run accurately reports replay scope.
- Replayed deliveries follow normal signing and retry rules.
- Replay progress can be inspected by `replay_id` until terminal state.

---

## Primitive 4: Batch Job Graph API

> Closes gap: "batch job creation for atomic epic + children graphs"

PM handoff creates an entire implementation graph — epic + child jobs +
dependencies + resource refs — in one atomic API call.

### API

```
POST /projects/:project_id/jobs/batch
POST /projects/:project_id/jobs/batch/validate
```

```json
{
  "idempotency_key": "pm-plan-FEAT-123-v4",
  "nodes": [
    {
      "key": "epic",
      "title": "Implement user data export",
      "description": "CSV + PDF export with GDPR compliance",
      "type": "epic",
      "resource_refs": [
        { "uri": "org_docs:/pm/features/FEAT-123.md", "label": "Feature Brief" },
        { "uri": "org_docs:/pm/features/FEAT-123/plans/v4.md", "label": "Approved Plan" }
      ]
    },
    {
      "key": "api",
      "title": "Build export API endpoints",
      "parent": "epic",
      "target": { "agent_slug": "myapp-sf-coder" },
      "resource_refs": [
        { "uri": "org_docs:/pm/features/FEAT-123/plans/v4.md", "label": "Plan" }
      ],
      "git": { "branch": "feat/export-api", "commit": "auto", "push": "on_success" }
    },
    {
      "key": "worker",
      "title": "Add async export worker",
      "parent": "epic",
      "target": { "agent_slug": "myapp-sf-coder" },
      "git": { "branch": "feat/export-worker", "commit": "auto", "push": "on_success" }
    },
    {
      "key": "tests",
      "title": "Write export integration tests",
      "parent": "epic",
      "target": { "agent_slug": "myapp-sf-verifier" },
      "git": { "branch": "feat/export-tests", "commit": "auto", "push": "on_success" }
    }
  ],
  "dependencies": [
    { "job": "worker", "depends_on": ["api"] },
    { "job": "tests", "depends_on": ["api", "worker"] }
  ]
}
```

### Semantics

1. **Validate graph** — reject cycles, check max depth (3), verify parent
   references and dependency keys.
2. **Validate permissions** — caller must have `jobs:write` in the project.
3. **Validate resource refs** — all URIs must resolve (using Primitive 2).
4. **Single transaction** — create all jobs, wire parent/child relations, add
   dependency edges, store resource refs. All-or-nothing.
5. **Idempotency** — if `idempotency_key` matches an existing batch, return
   the existing job tree rather than creating duplicates.
6. **Deterministic ordering** — topological job creation order is stable for
   identical input (tie-break by node key).
7. **`/validate` endpoint** — returns normalized graph and structured field
   errors, creates no jobs.
8. **Return the full tree** — response includes all created job IDs mapped
   to their keys.

### Response

```json
{
  "batch_id": "batch_xxx",
  "idempotency_key": "pm-plan-FEAT-123-v4",
  "jobs": {
    "epic": { "job_id": "myproj-a3f2dd12", "phase": "ready" },
    "api": { "job_id": "myproj-a3f2dd12.1", "phase": "ready" },
    "worker": { "job_id": "myproj-a3f2dd12.2", "phase": "ready", "blocked_by": ["myproj-a3f2dd12.1"] },
    "tests": { "job_id": "myproj-a3f2dd12.3", "phase": "ready", "blocked_by": ["myproj-a3f2dd12.1", "myproj-a3f2dd12.2"] }
  }
}
```

**Validation error response (`POST .../validate`):**

```json
{
  "valid": false,
  "errors": [
    {
      "code": "batch_node_unknown",
      "node_key": "tests",
      "field": "dependencies[1].depends_on[1]",
      "message": "Unknown dependency key: workerz",
      "hint": "Use one of: epic, api, worker, tests"
    }
  ]
}
```

### CLI

```bash
eve job batch --project proj_xxx --file batch.json
eve job batch validate --project proj_xxx --file batch.json
```

### Exit Criteria

- Batch creates a complete job tree with dependencies in one transaction.
- Resource refs on batch nodes are validated and stored.
- Idempotency prevents duplicate creation.
- `eve job tree` shows the created graph correctly.
- Failed validation rolls back the entire batch.
- Validation errors are field-specific and actionable without reading server logs.

---

## Primitive 5: Org-Scoped Threads for Cross-Project Messaging

> Closes gap: "agent-to-agent cross-project messaging primitive"

The thread primitive already has everything needed for messaging. This primitive
adds org-level scope so threads can exist outside any single project, enabling
cross-project agent communication.

### Schema Change

Add `org_id` and `scope` to the threads table:

```sql
ALTER TABLE threads ADD COLUMN org_id UUID REFERENCES orgs(id);
ALTER TABLE threads ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'
  CHECK (scope IN ('project', 'org'));

CREATE INDEX idx_threads_org ON threads(org_id) WHERE scope = 'org';
```

**Scope rules:**
- `scope = 'project'`: existing behavior (thread belongs to a project).
- `scope = 'org'`: thread belongs to the org, accessible by any project member.

### Thread Key Convention

Cross-project agent messaging uses an ergonomic client key and a canonical
stored key:

```
Client key:    agents:{topic}
Stored key:    org:{org_id}:agents:{topic}
```

Examples:
- `agents:pm-status:FEAT-123` — PM status channel for a feature.
- `agents:pm-handoff:plan-v4` — handoff coordination thread.
- `agents:pm-code-recon:myapp` — recon results channel.

The API canonicalizes client keys by prepending `org:{org_id}:` before
persisting. This keeps CLI usage short while preserving global uniqueness.

### API

```
POST /orgs/:org_id/threads                          -- create org-scoped thread
GET  /orgs/:org_id/threads?scope=org&key_prefix=... -- list org threads
GET  /orgs/:org_id/threads/:thread_id               -- get thread
POST /orgs/:org_id/threads/:thread_id/messages      -- post message
GET  /orgs/:org_id/threads/:thread_id/messages      -- list messages
```

These mirror the existing project-scoped thread endpoints. Permission: caller
must be a member of the org.

**Job token access rule (critical for safety):**
- Job tokens may access org-scoped threads only when:
  1. job token org matches `thread.org_id`, and
  2. thread ID is explicitly present in job hints
     (`hints.pm_thread_id` or `hints.coordination.thread_id`).

Otherwise return `403 thread_scope_forbidden`.

### CLI

```bash
eve thread create --org org_xxx --key "agents:pm-status:FEAT-123"
eve thread list --org org_xxx --scope org --key-prefix agents:pm-status:
eve thread messages thr_xxx --since 10m
eve thread post thr_xxx --body '{"kind":"status","body":"Code recon complete"}'
eve thread follow thr_xxx
```

### Agent Usage Pattern

The PM coordinator creates an org thread for a feature. When it dispatches jobs
to target projects, it includes the thread ID in the job hints:

```json
{
  "description": "Ground FEAT-123 in code reality",
  "target": { "agent_slug": "myapp-pm-code-recon" },
  "hints": {
    "pm_thread_id": "thr_xxx",
    "pm_feature_id": "FEAT-123"
  }
}
```

The target agent posts results back to the org thread:

```bash
eve thread post $PM_THREAD_ID --body '{"kind":"result","body":"..."}'
```

The PM coordinator follows the thread and updates the UI when results arrive.

### Exit Criteria

- Org-scoped threads can be created, listed, and messaged.
- Agents in different projects can post to the same org thread.
- Existing project-scoped threads are unaffected.
- Thread follow (SSE) works for org threads.
- Job token access is explicit and constrained by thread ID hints.

---

## Primitive 6: Org Analytics Read Model

> Closes gap: "org-level analytics for pipelines/releases/deploy/env health"

PM dashboards need aggregates across projects. This primitive adds org-level
analytics endpoints that query existing data with permission-aware filtering.

### API Endpoints

```
GET /orgs/:org_id/analytics/summary
GET /orgs/:org_id/analytics/pipelines?window=7d
GET /orgs/:org_id/analytics/deployments?window=30d
GET /orgs/:org_id/analytics/jobs?window=7d
GET /orgs/:org_id/analytics/env-health
```

### Summary Response

```json
{
  "as_of": "2026-02-11T10:05:00Z",
  "window_start": "2026-02-04T10:05:00Z",
  "window_end": "2026-02-11T10:05:00Z",
  "window": "7d",
  "projects": 12,
  "jobs": {
    "created": 87,
    "completed": 71,
    "failed": 8,
    "active": 8
  },
  "pipelines": {
    "runs": 34,
    "success_rate": 0.88,
    "avg_duration_s": 245
  },
  "deployments": {
    "total": 19,
    "successful": 17,
    "rollbacks": 2
  },
  "environments": {
    "total": 24,
    "healthy": 22,
    "degraded": 1,
    "unknown": 1
  },
  "meta": {
    "cache_hit": true,
    "project_scope_count": 12
  }
}
```

### Implementation Notes

- **Permission filtering:** Results only include data from projects where the
  caller has read access. Uses existing membership model.
- **No new tables.** All analytics are derived from existing tables (jobs,
  pipeline_runs, environments, events) via aggregate queries.
- **Window parameter:** `1d`, `7d`, `30d`, `90d`. Default `7d`.
- **Caching:** Results are cached for 5 minutes per org+window+caller scope.
  Cache invalidated on relevant events.
- **Cursor pagination** on the per-entity endpoints (pipelines, deployments,
  jobs) for large orgs.
- **Freshness metadata:** every response includes `as_of`, `window_start`,
  `window_end`, and cache metadata.
- **Debug mode:** `?debug=true` adds query provenance (`source_tables`,
  row-count summaries) to aid operator troubleshooting.

### CLI

```bash
eve analytics summary --org org_xxx --window 7d
eve analytics pipelines --org org_xxx --window 30d
eve analytics env-health --org org_xxx
eve analytics summary --org org_xxx --window 7d --debug --json
```

### Exit Criteria

- Summary endpoint returns correct aggregates across all accessible projects.
- Permission filtering excludes projects the caller cannot read.
- Window parameter controls the time range.
- CLI renders a readable dashboard output.
- Responses expose freshness and scope metadata for debugging.

---

## Primitive 7: OpenAPI Contract Gate

> Closes gap: "OpenAPI parity for threads/events/webhooks"

Current OpenAPI spec (`docs/system/openapi.yaml`) drifts from controllers. This
primitive makes spec accuracy a CI invariant.

### Mechanism

1. **Generate spec from controllers in CI** using NestJS Swagger plugin
   (`@nestjs/swagger`). The decorators already exist on most controllers.
2. **Compare generated spec to committed `docs/system/openapi.yaml`** using
   a structural diff (ignoring whitespace, key ordering).
3. **Fail CI on drift** — any path, schema, or parameter mismatch blocks merge.
4. **Auto-update command:** `eve api spec generate` writes the spec locally
   for review and commit.
5. **Spec lint gate:** every new operation must include `operationId`,
   auth requirements, one success example, and one typed error example.

Path style rule:
- Controller routes may use `:param`.
- OpenAPI paths must use `{param}`.
- Parity tests compare normalized forms to avoid false negatives.

### Parity Tests

Add explicit path coverage tests for currently-missing surfaces:

```typescript
const requiredPaths = [
  '/threads/{thread_id}/messages',
  '/orgs/{org_id}/threads',
  '/orgs/{org_id}/threads/{thread_id}/messages',
  '/projects/{project_id}/events',
  '/orgs/{org_id}/events',
  '/orgs/{org_id}/webhooks',
  '/orgs/{org_id}/webhooks/{wh_id}/deliveries',
  '/orgs/{org_id}/webhooks/{wh_id}/replays',
  '/orgs/{org_id}/webhooks/{wh_id}/replays/{replay_id}',
  '/orgs/{org_id}/docs',
  '/orgs/{org_id}/docs/query',
  '/orgs/{org_id}/docs/{path}/versions',
  '/orgs/{org_id}/docs/{path}/versions/{version}',
  '/orgs/{org_id}/resources/resolve',
  '/projects/{project_id}/jobs/batch',
  '/projects/{project_id}/jobs/batch/validate',
  '/orgs/{org_id}/analytics/summary',
  '/orgs/{org_id}/analytics/pipelines',
  '/orgs/{org_id}/analytics/deployments',
  '/orgs/{org_id}/analytics/jobs',
  '/orgs/{org_id}/analytics/env-health',
];
```

### CLI

```bash
eve api spec                     # fetch live spec from running API
eve api spec generate            # generate from source and write to docs/
eve api spec diff                # compare generated vs committed
```

### Exit Criteria

- CI fails on OpenAPI drift.
- All new endpoints from this plan appear in the spec.
- `eve api spec` commands work for developer workflow.
- Generated spec includes examples for both happy path and typed errors.

---

## Phased Rollout

### Phase 1: Resource Plane Hardening

**Ship Primitives 1 + 2 together.**

Doc versioning, events, metadata query, resource resolver, and workspace
hydration form a coherent unit. They must ship together because:
- The resolver needs versioned docs to create immutable snapshots.
- Workspace hydration uses the resolver.
- PM artifact flows need metadata query to find the right docs.
- Doc events enable webhook-driven UI updates from day one.

**Dependency:** Plan B Phase 3 (org docs table) must exist first. Plan B
Phases 1-2 (attachments, resource_refs) should ship concurrently.

### Phase 2: Reactive Reliability + API Contract Integrity

**Ship Primitives 3 + 7 together.**

Webhook replay and OpenAPI parity are about trust. Production apps need to
know that events won't be silently lost and that the API contract is accurate.
These are independent of each other but both serve the reliability theme.

**Dependency:** Plan B Phase 5 (webhook subscriptions) must exist first.

### Phase 3: Planning Graph + Collaboration Core

**Ship Primitives 4 + 5 together.**

Batch job creation and org-scoped threads are the PM handoff primitives.
The handoff agent creates a job graph (Primitive 4) and coordinates via org
threads (Primitive 5). They compose naturally: batch jobs reference resource
refs, and the org thread carries coordination messages about the batch.

**Dependency:** Primitives 1 + 2 (resource plane) should be stable so batch
jobs can validate resource refs.

### Phase 4: Portfolio Intelligence

**Ship Primitive 6.**

Analytics read models depend on having good event data and stable pipelines
from prior phases. This is the capstone — PM dashboards get org-wide
visibility.

**Dependency:** Primitives 1-5 should be stable. Richer event data from
doc events (Primitive 1b) and webhook replay (Primitive 3) improves analytics
fidelity.

---

## Composition Map

How primitives compose to support the PM app end-to-end flow:

```
1. PM captures idea
   → Coordinator writes org doc (/pm/ideas/IDEA-xxx.md)
   → Primitive 1: versioned write + system.doc.created event

2. PM requests code grounding
   → Coordinator creates job with target.agent_slug + resource_refs
   → Plan B: job targeting + attachments
   → Primitive 2: workspace hydration (agent gets idea doc as file)

3. Agent returns code insight
   → Agent writes org doc (/pm/projects/slug/insights/latest.json)
   → Primitive 1: versioned write + system.doc.updated event
   → Primitive 5: agent posts to org thread with status

4. PM approves plan → handoff
   → Coordinator calls batch job API
   → Primitive 4: atomic epic + children + deps + resource refs
   → Primitive 2: each child job gets relevant plan sections as files

5. PM tracks progress
   → Webhooks deliver job lifecycle events
   → Primitive 3: replay missed events if needed
   → Primitive 5: org thread carries coordination updates
   → Primitive 6: analytics summary for portfolio view

6. PM queries features
   → Primitive 1c: structured metadata query over /pm/features/
   → Filter by status, owner, risk score, project
```

---

## CLI-First Debug Ladder (Agent Workflow)

Agents should be able to isolate failures without kubectl access. For each
primitive, define one primary diagnose path:

| Primitive | First Command | Then |
|---|---|---|
| 1 (docs) | `eve docs show --org <org> --path <path> --verbose` | `eve docs versions ...`, `eve event list --org <org> --type system.doc.* --since 15m` |
| 2 (resources) | `eve job diagnose <job-id>` | `eve resources resolve <uri> --json`, inspect `.eve/resources/index.json` |
| 3 (webhook replay) | `eve webhooks replay-status --org <org> --webhook <wh> --replay <rpl>` | `eve webhooks deliveries --org <org> --webhook <wh>` |
| 4 (batch graph) | `eve job batch validate --project <proj> --file batch.json` | `eve job batch ...`, `eve job tree <root-job-id>` |
| 5 (org threads) | `eve thread list --org <org> --scope org --key-prefix agents:` | `eve thread messages <thread-id> --since 10m`, `eve thread follow <thread-id>` |
| 6 (analytics) | `eve analytics summary --org <org> --window 7d --debug --json` | `eve analytics pipelines ...`, `eve analytics env-health ...` |
| 7 (OpenAPI) | `eve api spec diff` | `eve api spec generate`, re-run parity tests |

Design requirement: if the command in "First Command" cannot explain a failure,
that is a platform observability gap and should be treated as a bug.

---

## What This Plan Does NOT Cover

These remain in their respective plans and are not duplicated here:

- **Service principals + tokens** → Plan A Phase 1
- **Job attachments table** → Plan B Phase 1
- **Job targeting (target field)** → Plan B Phase 2
- **Org document table** → Plan B Phase 3
- **Cross-project query endpoints** → Plan B Phase 4
- **Webhook subscriptions** → Plan B Phase 5
- **Native container registry** → Plan C Phase 1
- **Managed Postgres** → Plan C Phase 2
- **Project bootstrap** → Plan C Phase 3
- **WebChat gateway** → Plan C Phase 4

This plan builds on top of those primitives. The dependency chain is:

```
Plan B Phase 3 (org docs)     ─┐
Plan B Phases 1-2 (attachments)─┤── Primitive 1 + 2 (resource plane)
                                │
Plan B Phase 5 (webhooks)      ─┤── Primitive 3 (replay)
                                │
Primitive 1 + 2                ─┤── Primitive 4 + 5 (graph + threads)
                                │
Primitive 1-5                  ─┴── Primitive 6 (analytics)

Primitive 7 (OpenAPI gate) is independent — ship anytime.
```

---

## Testing Strategy

### Integration Tests

Each primitive gets integration tests that run against the docker compose stack:

| Primitive | Test Scenario |
|---|---|
| 1a | Write doc → verify version row + version listing |
| 1b | Write doc → verify `system.doc.updated` event emitted |
| 1c | Create docs with metadata → query → verify filters + typed filter errors |
| 2a-b | Resolve pinned + latest URIs → verify content hash/version semantics |
| 2c | Create job with required/optional refs → claim → verify `.eve/resources/index.json` statuses and diagnose output |
| 3 | Create subscription → replay window → verify dedupe + replay status lifecycle by `replay_id` |
| 4 | `batch/validate` returns actionable field errors; valid batch creates jobs + deps atomically |
| 5 | Create org thread → cross-project posting works; unauthorized job token returns `thread_scope_forbidden` |
| 6 | Create jobs/pipelines across projects → verify aggregates + freshness metadata (`as_of`, window bounds) |
| 7 | Add controller endpoint → verify generated spec includes braces-style path + typed error example |

### Manual Test Scenario

End-to-end PM flow using the manual test harness:

1. Create org docs for a feature brief and code insight.
2. Verify doc provenance with `eve docs show --verbose` and `eve docs versions`.
3. Create a job with required and optional `resource_refs` pointing to both docs.
4. Verify workspace hydration and inspect with `eve job diagnose <id>`.
5. Validate then create a batch job graph (`eve job batch validate`, then `eve job batch`).
6. Verify job tree, dependencies, and idempotency behavior.
7. Create org thread and post cross-project messages.
8. Verify webhook delivery and replay status (`eve webhooks replay-status`).
9. Query analytics summary with `--debug` and verify freshness metadata.

---

## Exit Criteria (All Gaps Closed)

1. PM app stores, versions, queries, and references artifacts without side
   stores.
2. Agents receive `resource_refs` as stable files in workspace on every run.
3. Operators can replay webhook windows with dedupe and signed delivery history.
4. PM handoff creates complete job graphs atomically in one API call.
5. Agents message across projects via org-scoped thread primitives.
6. PM dashboard reads org-wide analytics via first-class endpoints.
7. OpenAPI spec is CI-enforced and includes all new surfaces.
8. Every primitive has a CLI-first diagnose command that surfaces root-cause data.
9. New API surfaces return typed error codes and traceable request IDs.
