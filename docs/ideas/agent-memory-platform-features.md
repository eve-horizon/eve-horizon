# Agent Memory: First-Class Platform Features

> Status: Idea
> Last Updated: 2026-02-15
>
> Inputs:
> - `docs/ideas/platform-primitives-for-agentic-apps.md` (primitive catalog)
> - `docs/ideas/native-agentic-app-primitives-roadmap.md` (delivery roadmap)
> - `docs/system/db.md`, `docs/system/threads.md`, `docs/system/events.md` (current primitives)
> - `docs/plans/org-fs-sync-api-cli-spec.md` (org filesystem sync)
> - `docs/system/auth.md` (access groups, scoped bindings, default-deny model)
> - eve-skillpacks gap analysis (storage primitives inventory + agent memory patterns)

## The Question

Eve Horizon now has storage primitives at every timescale: workspace files, job
attachments, threads, org documents, org filesystem, managed databases, and
events. An agent can build memory by composing these pieces.

But composition is the wrong default. Teams repeatedly hand-roll startup
sequences, naming conventions, cleanup, and search strategies.

What platform features would make agent memory fall out naturally instead of
requiring bespoke assembly each time?

This proposal defines 7 features, ordered by delivery gates, with explicit
contracts and migration paths.

---

## Design Contract (Applies to All Features)

1. **Security first**: Memory follows the platform default-deny data plane.
   Read/write access is explicit via access groups and scoped bindings.
2. **Single lifecycle source of truth**: Lifecycle scheduling and status live in
   first-class `org_documents` columns. Metadata can carry hints but is not
   authoritative for lifecycle automation.
3. **Namespace taxonomy is fixed in v1**:
   - Agent-owned: `/agents/{agent-slug}/memory/{category}/{key}.md`
   - Shared: `/agents/shared/memory/{category}/{key}.md`
   - Categories: `learnings`, `decisions`, `runbooks`, `context`,
     `conventions`
4. **Context carryover config location is explicit**: v1 defines carryover in
   repo-first `agents.yaml` (not in manifest). Manifest-level defaults can be
   considered later.
5. **Search source vocabulary is canonical**: `memory`, `docs`, `threads`,
   `attachments`, `events` are used consistently in API and responses.
6. **Embeddings are model-bound, not hardcoded**: embedding dimensions derive
   from the configured embedding model for the org; docs should not assume a
   fixed global dimension.

---

## What Exists Today (Inventory)

| Primitive | Scope | Searchable | Versioned | TTL | Events |
|-----------|-------|------------|-----------|-----|--------|
| Workspace files | Job | No | Via git | Job lifetime | No |
| Job attachments | Job | By name | No | Permanent | No |
| Threads | Project/Org | By time | No | Permanent | No |
| Resource refs | Job | No | Pinned version | Job lifetime | Yes |
| Org Document Store | Org | Full-text (tsvector) | Yes | No | Yes |
| Org Filesystem | Org | No | Via events | No | Yes |
| Managed DB | Environment | SQL | No | No | No |
| Secrets | Multi-scope | By key | No | No | No |
| Event spine | Project/Org | By type/time | No | No | Core |

Gaps are not raw storage capacity; gaps are connective tissue between storage,
retrieval, freshness, and job startup behavior.

---

## Golden Path (End-to-End)

This is the intended user journey after these features ship:

1. A reviewer agent finishes a job and writes a durable learning to
   `/agents/code-reviewer/memory/learnings/auth-retry.md`.
2. The platform stores provenance metadata and lifecycle schedule
   (`review_due`) on the document row.
3. Next job start auto-hydrates `.eve/context/` from the agent's configured
   memory categories and shared conventions.
4. During execution, the agent calls `eve search` across `memory,docs,threads`
   rather than querying each primitive manually.
5. Thread decisions are distilled into shared memory docs and indexed for future
   retrieval.
6. Lifecycle automation marks stale memory and triggers review jobs before
   knowledge rot accumulates.

Result: memory behavior becomes default platform behavior, not custom agent
bootstrapping logic.

---

## Feature 1: Agent Memory Namespaces

### Problem

Each team invents its own org-doc path conventions, making memory hard to
discover, audit, and share.

### Contract

Define a thin convention layer over org docs (no new storage primitive):

```text
/agents/{agent-slug}/memory/{category}/{key}.md
/agents/shared/memory/{category}/{key}.md
```

| Category | Purpose | Example |
|----------|---------|---------|
| `learnings` | Patterns discovered during work | `auth-retry-backoff.md` |
| `decisions` | Durable decisions and rationale | `chose-jwt-over-sessions.md` |
| `runbooks` | Operational procedures | `deploy-rollback-steps.md` |
| `context` | Stable project/domain context | `api-architecture-overview.md` |
| `conventions` | Shared standards and norms | `api-style.md` |

Metadata envelope in `org_documents.metadata`:

```json
{
  "memory": {
    "owner_type": "agent",
    "owner_slug": "code-reviewer",
    "category": "learnings",
    "confidence": 0.85,
    "created_by_job": "proj-a3f2dd12",
    "tags": ["auth", "security", "retry-patterns"],
    "supersedes": "/agents/code-reviewer/memory/learnings/auth-old-pattern.md"
  }
}
```

CLI:

```bash
eve memory set --agent code-reviewer --category learnings --key auth-retry \
  --file ./findings.md --tags auth,security --confidence 0.9
eve memory set --shared --category conventions --key api-style \
  --file ./api-conventions.md

eve memory get --agent code-reviewer --key auth-retry
eve memory list --agent code-reviewer --category learnings
eve memory list --shared --category conventions
```

API wrappers (thin layer over org docs):

```text
POST   /orgs/:id/agents/:slug/memory
GET    /orgs/:id/agents/:slug/memory
GET    /orgs/:id/agents/:slug/memory/:key
PUT    /orgs/:id/agents/:slug/memory/:key
DELETE /orgs/:id/agents/:slug/memory/:key
GET    /orgs/:id/memory/search?q=...
```

Access control contract:

- Default-deny applies.
- Agent-owned namespace: writable by owner agent + admins; readable only via
  explicit grants.
- Shared namespace: readable/writable only via explicit group grants.

### Failure Mode

Raw docs API bypasses conventions and memory shape drifts.

### Migration

No backfill required. Existing docs continue to work. Teams can adopt namespace
paths incrementally; CLI wrappers enforce conventions for new writes.

### Success Metric

- >= 90% of new memory docs written under canonical `/agents/.../memory/...`
- `eve memory list` returns results for pilot agents without custom path filters

---

## Feature 2: Agent KV Store

### Problem

Agents need lightweight operational state with TTL (`last_seen_commit`,
`focus_area`, counters). Org docs are too heavy; managed DB requires schema.

### Contract

Add minimal `agent_kv` table:

```sql
CREATE TABLE agent_kv (
  id          TEXT PRIMARY KEY DEFAULT gen_typeid('akv'),
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agent_slug  TEXT NOT NULL,
  namespace   TEXT NOT NULL DEFAULT 'default',
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  ttl_seconds INTEGER,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, agent_slug, namespace, key)
);

CREATE INDEX idx_agent_kv_lookup
  ON agent_kv(org_id, agent_slug, namespace, key);
CREATE INDEX idx_agent_kv_expiry
  ON agent_kv(expires_at) WHERE expires_at IS NOT NULL;
```

CLI:

```bash
eve kv set --agent code-reviewer --key last_commit --value '"abc123"' --ttl 86400
eve kv get --agent code-reviewer --key last_commit
eve kv list --agent code-reviewer --namespace sprint-42
eve kv mget --agent code-reviewer --keys last_commit,review_count,focus_area
eve kv delete --agent code-reviewer --key last_commit
```

API:

```text
PUT    /orgs/:id/agents/:slug/kv/:namespace/:key
GET    /orgs/:id/agents/:slug/kv/:namespace/:key
DELETE /orgs/:id/agents/:slug/kv/:namespace/:key
GET    /orgs/:id/agents/:slug/kv/:namespace
POST   /orgs/:id/agents/:slug/kv/:namespace/mget
```

TTL enforcement:

- Read-time filter: ignore expired keys.
- Periodic delete job: hard-delete expired rows.

Security contract:

- v1 read/write scope is owner agent + admins only.
- Cross-agent KV reads are excluded from v1.

### Failure Mode

KV starts carrying large documents and turns into a second doc store.

### Migration

Introduce as opt-in primitive; no changes required for existing agent flows.

### Success Metric

- Pilot agents remove workspace-file hacks for runtime state.
- Median cold-start state hydration uses `mget` with <= 3 API calls.

---

## Feature 3: Document Lifecycle Automation

### Problem

Memory docs accumulate and decay. Stale or expired knowledge remains searchable
without freshness signals.

### Contract

Lifecycle fields are first-class columns on `org_documents`:

```sql
ALTER TABLE org_documents ADD COLUMN review_due TIMESTAMPTZ;
ALTER TABLE org_documents ADD COLUMN expires_at TIMESTAMPTZ;
ALTER TABLE org_documents ADD COLUMN lifecycle_status TEXT
  DEFAULT 'active'
  CHECK (lifecycle_status IN ('active', 'stale', 'archived', 'expired'));

CREATE INDEX idx_org_docs_review_due
  ON org_documents(review_due) WHERE review_due IS NOT NULL;
CREATE INDEX idx_org_docs_expires
  ON org_documents(expires_at) WHERE expires_at IS NOT NULL;
```

CLI:

```bash
eve docs create --org $ORG --path /agents/reviewer/memory/learnings/auth.md \
  --file ./auth.md --review-in 30d
eve docs create --org $ORG --path /agents/shared/memory/context/sprint-42.md \
  --file ./sprint.md --expires-in 14d
eve docs stale --org $ORG --overdue-by 7d
eve docs review --org $ORG --path /agents/reviewer/memory/learnings/auth.md \
  --next-review 30d
```

Maintenance job:

1. Mark `stale` when `review_due < now()`.
2. Mark `expired` when `expires_at < now()`.
3. Emit lifecycle events (`system.doc.stale`, `system.doc.expired`).
4. Optionally archive/delete expired docs after grace period.

Lifecycle source-of-truth rule:

- Scheduling reads from columns only.
- Any lifecycle fields in metadata are informational and ignored by automation.

### Failure Mode

Over-aggressive expiry removes still-useful knowledge.

### Migration

Add nullable columns; default existing docs to `active` with no deadlines.
Enable lifecycle checks per org/project gradually.

### Success Metric

- Stale memory backlog remains bounded (target: < 10% overdue beyond SLA).
- Search results expose lifecycle/freshness so stale docs are down-ranked.

---

## Feature 4: Context Carryover Protocol

### Problem

Agents start jobs cold and rebuild context with custom boot logic.

### Contract

Define carryover in repo-first `agents.yaml` (canonical v1 location):

```yaml
version: 1
agents:
  code_reviewer:
    slug: code-reviewer
    context:
      memory:
        categories: [learnings, runbooks]
        max_items: 10
        max_age: 30d
      docs:
        - path: /agents/shared/memory/conventions/
          recursive: true
      parent_attachments:
        names: [findings.json, plan.md]
      threads:
        coordination: true
        max_messages: 20
```

Worker hydration expands this into workspace files:

```text
.eve/context/
├── memory/
├── docs/
├── parent/
└── threads/
```

Hydration behavior:

- Reuse resource hydration pipeline and events.
- On partial failure, start job with available context and emit diagnostics.
- No hard failure unless configured as strict mode in future.

### Failure Mode

Over-hydration increases startup latency and token bloat.

### Migration

Keep existing manual startup logic working. Teams opt in by adding `context`
block per agent.

### Success Metric

- Cold-start context prep time falls without bespoke scripts.
- Token usage for startup prompts drops due to deterministic carryover files.

---

## Feature 5: Unified Search

### Problem

Knowledge is fragmented across docs, memory entries, threads, attachments, and
events; agents must query each system separately.

### Contract

Single endpoint with canonical source names:

```text
GET /orgs/:id/search?q=<query>&sources=memory,docs,threads,attachments,events
```

Response contract:

- `source` is one of: `memory`, `docs`, `threads`, `attachments`, `events`.
- Results include snippet, score, timestamps, and source-specific locator fields.

CLI:

```bash
eve search "authentication retry" --org $ORG
eve search "authentication retry" --org $ORG --sources memory,docs,threads
eve search "authentication retry" --org $ORG --agent code-reviewer
```

Implementation:

1. Fan out query to selected sources.
2. Score per source, merge, and deduplicate.
3. Apply freshness weighting and source priors.

Source adapters:

- Docs/memory: existing tsvector + metadata filters.
- Threads: tsvector index on message body.
- Attachments: opt-in indexed content.
- Events: text over indexed payload fragments and event metadata.

### Failure Mode

Noisy ranking hides the most actionable source.

### Migration

Ship in slices:

1. `docs + memory`
2. add `threads`
3. add `attachments` and `events`

### Success Metric

- Agents resolve memory queries in one command instead of N source-specific
  calls.
- Top-5 relevance for pilot queries improves against baseline manual fan-out.

---

## Feature 6: Vector Search on Org Docs

### Problem

Keyword search misses semantically similar knowledge when terms differ.

### Contract

Add semantic retrieval with model-bound embedding dimension:

```sql
-- <EMBED_DIM> comes from configured embedding model for the org/deployment.
ALTER TABLE org_documents ADD COLUMN embedding vector(<EMBED_DIM>);
ALTER TABLE org_documents ADD COLUMN embedding_model TEXT;
ALTER TABLE org_documents ADD COLUMN embedded_at TIMESTAMPTZ;

CREATE INDEX idx_org_docs_embedding
  ON org_documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

Embedding pipeline:

- Async worker consumes `system.doc.created` and `system.doc.updated`.
- Writes embedding, model id, and timestamp.
- Query embedding generated at search time.

CLI/API:

```bash
eve docs search --org $ORG --query "authentication resilience" --mode text
eve docs search --org $ORG --query "authentication resilience" --mode semantic
eve docs search --org $ORG --query "authentication resilience" --mode hybrid
```

```text
GET /orgs/:id/docs/search?q=...&mode=text|semantic|hybrid
```

Hybrid scoring blends lexical and semantic rank.

### Failure Mode

Model changes invalidate existing vectors and degrade relevance.

### Migration

Opt-in per org. Initial backfill command populates embeddings for existing docs.
Model change requires re-embed migration and index rebuild.

### Success Metric

- Recall improves for synonym-heavy queries.
- Semantic mode finds relevant docs that text mode misses.

---

## Feature 7: Thread-to-Knowledge Distillation

### Problem

High-value decisions remain buried in thread message history.

### Contract

Support manual and automatic distillation from thread messages to durable docs.

Trigger modes:

1. Manual CLI.
2. Auto on thread close (threshold-driven).
3. Periodic rolling distillation for long-running threads.

CLI:

```bash
eve thread distill <thread-id> --to /agents/shared/memory/decisions/sprint-42.md
eve thread distill <thread-id> --agent code-reviewer --category decisions --key sprint-42
eve thread distill <thread-id> --auto --threshold 20 --interval 7d
```

Pipeline:

1. Select message window (since last distillation marker).
2. Run distillation prompt.
3. Write/append target doc.
4. Update thread summary.
5. Emit `system.thread.distilled`.

Ownership default:

- Team or coordination threads distill to shared namespace.
- Agent-private threads distill to owner namespace.

### Failure Mode

Low-quality summaries introduce incorrect durable knowledge.

### Migration

Start manual-only with explicit target paths. Enable auto mode after quality
guardrails (confidence, citations, review workflow) are validated.

### Success Metric

- Share of major thread decisions captured in searchable docs increases.
- Time-to-onboard for new agents drops due to distilled context availability.

---

## Delivery Gates (Decision Criteria)

| Gate | Features | Entry Criteria | Exit Criteria |
|------|----------|----------------|---------------|
| **v1: Structure** | 1, 2, 3 | Org docs + ACL + cron primitives available | Namespace adoption >= 90%, KV used by pilot agents, lifecycle job running and observable |
| **v2: Access** | 4, 5 | v1 stable in production-like usage | Startup context is declarative for pilot agents, unified search replaces manual fan-out in runbooks |
| **v3: Intelligence** | 6, 7 | v2 operational metrics stable | Semantic recall gain demonstrated, distillation quality guardrails pass acceptance tests |

These gates replace "value/cost only" prioritization with explicit ship
criteria.

---

## Dependency Graph

```text
Feature 1 (Namespaces) -----> Feature 4 (Context Carryover)
          |                  \
          |                   -> Feature 5 (Unified Search)
          |
Feature 3 (Lifecycle) ------> Feature 7 (Distillation)

Feature 5 (Unified Search) --> Feature 6 (Vector Search)

Feature 2 (KV Store) is independent and can ship in parallel with 1-3.
```

---

## Architectural Argument

The features intentionally layer:

- **Structure (v1)**: Namespaces, KV, lifecycle.
- **Access (v2)**: Carryover and unified retrieval.
- **Intelligence (v3)**: Semantic recall and thread distillation.

Each layer is useful alone, but together they turn memory from custom glue code
into a platform capability.

---

## Agent-Native Lens

These features align with the principles in
`docs/ideas/agent-native-design.md`:

- **Parity**: Every memory operation is available through API and CLI.
- **Granularity**: KV, namespace, lifecycle, search, and distillation are
  small composable primitives.
- **Composability**: Carryover and unified search compose existing stores into
  one runtime model.
- **Emergent capability**: Layered primitives produce durable institutional
  memory behavior.

---

## Open Questions

1. Should `agent_kv` remain in platform DB long-term, or graduate to a managed
   DB-backed implementation for specific enterprise isolation requirements?
2. What is the default freshness/relevance weighting in unified search for
   stale-but-relevant documents?
3. Should vector embeddings be enabled by default for new orgs, or opt-in to
   control inference cost?
4. What minimum quality signals (citations, confidence threshold, human review)
   are required before enabling automatic thread distillation globally?

---

## Relation to Existing Roadmap

This proposal sits alongside
`docs/ideas/native-agentic-app-primitives-roadmap.md`:

- Phase 0/1 primitives remain foundational.
- This document defines the memory behavior layer on top of those primitives.
- Most effort is conventions and orchestration glue; the largest net-new
  technical investment is semantic indexing plus distillation quality controls.
