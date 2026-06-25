# Platform Primitives for Agentic Apps

> Status: Idea
> Last Updated: 2026-02-11
>
> Inputs:
> - docs/ideas/pm-app-agentic-product-management.md (PM app as reference use case)
> - docs/ideas/agent-native-design.md (parity/granularity/composability principles)
> - docs/ideas/automated-software-factory-v3.md (AgentPack pattern)
> - docs/ideas/skills-sh-migration.md (pack distribution)
> - Codebase analysis of existing DB schema, API surface, and agent-runtime

## The Question

Eve Horizon can host agentic apps today. The PM app design
(`pm-app-agentic-product-management.md`) proves that — it maps cleanly onto
existing primitives: AgentPack distribution, org-scoped secrets, cross-project
job creation, chat gateway routing.

But "can be built" and "falls out naturally" are different things. What
primitives would make Eve the obvious PaaS for agentic apps — not just for PM,
but for any app where agents need to accumulate knowledge, share documents,
create projects, and operate across organizational boundaries?

This doc examines 7 candidates with concrete schemas, API designs, and
pros/cons for each.

---

## What Exists Today (Codebase Inventory)

Before proposing new primitives, here's what the platform already has:

### Storage & Attachments

| What | Status | Location | Notes |
|------|--------|----------|-------|
| org-fs PVC | Exists | `k8s/base/agent-runtime-pvc.yaml` | 5Gi ReadWriteMany, mounted at `/org`, used only for workspace provisioning |
| Build artifact metadata | DB table | `migrations/00028_add_builds.sql` | Only refs/metadata (image_ref, digest), not actual files |
| Job execution logs | DB table | `migrations/00001_initial_schema.sql` | JSONB `execution_logs` per attempt |
| `AttachmentSchema` | Defined in types | `packages/shared/src/schemas/attempt.ts` | name/mime/content in zod, used in `ContinueAttemptRequestSchema` |
| Attachment persistence | **Missing** | — | No DB table, no API endpoints |
| File upload/download API | **Missing** | — | No multipart endpoints anywhere |
| Org-level document store | **Missing** | — | org-fs PVC exists but has no structured usage or API |

### Auth & Permissions

| What | Status | Notes |
|------|--------|-------|
| User auth (SSH keys, OAuth) | Exists | Standard user-scoped authentication |
| Org-scoped secrets | Exists | Available to agents in jobs |
| 33 permissions including `project:manage` | Exists | Covers project CRUD |
| Service account / API key primitive | **Missing** | No backend-to-API auth path |

### Queries & Events

| What | Status | Notes |
|------|--------|-------|
| Project-scoped job queries | Exists | `GET /projects/:id/jobs` |
| Internal event system | Exists | `system.job.completed`, etc. for triggers |
| Cross-project queries | **Missing** | No org-level aggregation endpoints |
| External webhook delivery | **Missing** | Events are internal only |

---

## Primitive 1: Job Attachments (Documents on Jobs)

**The problem**: A job's context is its `description` (plain text) and `hints`
(key-value). When agents need to pass structured documents between jobs — a plan,
a code insight report, an architecture diagram — they have to:

- Stuff everything into the text description (loses structure)
- Write to a file in the workspace and hope the next agent reads it (fragile)
- Call an external API to store/retrieve (requires an external app to exist)

**What exists today**:

- `AttachmentSchema` defined in `packages/shared/src/schemas/attempt.ts`
- Used in `ContinueAttemptRequestSchema` — agents can *send* attachments mid-execution
- **But**: no DB table, no API endpoints, no job-level attachment field

**What we'd add**:

```sql
CREATE TABLE job_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,            -- "architecture-report.md"
  mime_type     TEXT NOT NULL DEFAULT 'text/plain',
  content       TEXT NOT NULL,            -- inline content (markdown, JSON, YAML)
  content_hash  TEXT,                     -- SHA-256 for dedup
  created_by    TEXT,                     -- agent slug or user ID
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_job_attachments_job ON job_attachments(job_id);
```

API:

```
POST   /jobs/:id/attachments           — attach a document
GET    /jobs/:id/attachments           — list attachments
GET    /jobs/:id/attachments/:att_id   — get attachment content
DELETE /jobs/:id/attachments/:att_id   — remove attachment
```

CLI:

```bash
eve jobs attach <job_id> --file plan.md --name "Implementation Plan"
eve jobs attach <job_id> --stdin --name "Code Insight" --mime application/json
eve jobs attachments <job_id>
```

**Pros**:

- Low complexity — straightforward CRUD on a new table
- Agent-native — agents can read/write structured docs on any job
- Composable — PM agent writes a plan attachment, factory agent reads it
- Eliminates the "pass context between agents" problem for most cases
- Works with existing job lifecycle (attachments live and die with the job)

**Cons**:

- Text-only (no binary blobs). For images/PDFs, store a URL reference
- Doesn't solve org-wide knowledge persistence (job-scoped, not project-scoped)
- Could accumulate large text content; needs size limits

**Verdict**: **High value, low cost. Build this first.** It solves 80% of the
"agents passing structured context" problem and benefits every AgentPack, not
just PM.

---

## Primitive 2: Org Document Store (Structured Knowledge Base)

**The problem**: Agents accumulate knowledge that should persist across jobs
and projects — architecture reports, risk assessments, product context, team
conventions. Today this knowledge either lives in:

- The git repo (requires commit/push, pollutes history, only visible to agents
  with that checkout)
- An external app's DB (requires building the app first — chicken-and-egg)
- The agent's memory (lost when the job ends)

**What exists today**:

- `org-fs` PVC: a Kubernetes persistent volume mounted at `/org` in agent-runtime
  - 5Gi ReadWriteMany (production), ReadWriteOnce (local)
  - Currently used only for workspace provisioning and symlinks
  - No API access, no CRUD operations, no search — just raw filesystem
- No org-level document tables in the Eve database

### Option A: API-ified Org Filesystem (thin wrapper over org-fs)

Expose the existing org-fs PVC through Eve API endpoints:

```
POST   /orgs/:id/docs                     — write a document
GET    /orgs/:id/docs?path=/reports/       — list documents at path
GET    /orgs/:id/docs/:path               — read document content
PATCH  /orgs/:id/docs/:path               — update (full replace or patch)
DELETE /orgs/:id/docs/:path               — delete
GET    /orgs/:id/docs/search?q=...        — full-text search
```

Documents stored as files on the PVC, indexed in a lightweight DB table for
search and metadata:

```sql
CREATE TABLE org_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id),
  path          TEXT NOT NULL,              -- "/reports/my-saas-app/architecture.md"
  mime_type     TEXT NOT NULL DEFAULT 'text/markdown',
  size_bytes    BIGINT,
  content_hash  TEXT,
  created_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_vector TSVECTOR,
  UNIQUE(org_id, path)
);
```

Actual content lives on the PVC; DB holds metadata + search index.

**Pros**: Leverages existing infrastructure, agents can also access via filesystem
directly (they already have `/org` mounted), familiar file/folder mental model.

**Cons**: PVC is single-cluster (no cross-region), filesystem operations are
harder to make transactional, search requires separate indexing, managing
concurrent writes from multiple agents is messy.

### Option B: DB-Backed Document Store (Postgres-native)

Store everything in Postgres, no filesystem involved:

```sql
CREATE TABLE org_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id),
  project_id    UUID REFERENCES projects(id),  -- optional project scope
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
```

API: same as Option A. Additionally supports:

```
PATCH  /orgs/:id/docs/:path   — with body { "operations": [
  { "op": "replace", "search": "old text", "replace": "new text" },
  { "op": "append", "content": "new section..." },
  { "op": "insert_after", "anchor": "## Section", "content": "..." }
]}
```

This gives agents `search/replace` style editing — crucial for the agent-native
design principle of granular atomic operations.

**Pros**: Transactional (ACID), built-in full-text search, no infrastructure
dependency beyond existing Postgres, works across clusters if DB is shared,
content-addressable via hash, JSONB metadata enables flexible tagging/categorization,
agent-native CRUD + search/replace edit.

**Cons**: Postgres isn't ideal for large binary content (OK for text documents
up to ~10MB), requires migration, adds DB load. For truly large files, need S3
or similar.

### Option C: Hybrid (DB metadata + S3/PVC content)

DB stores metadata and small documents inline; large files stored on PVC or S3
with a pointer:

```sql
content       TEXT,                    -- inline for docs < 256KB
storage_ref   TEXT,                    -- "s3://org-docs/abc123" or "pvc:///org/docs/abc123"
storage_type  TEXT DEFAULT 'inline',   -- 'inline' | 's3' | 'pvc'
```

**Pros**: Best of both worlds — fast queries for small docs, scalable storage
for large files.

**Cons**: More complex, two code paths, eventual consistency between DB and
storage.

### Verdict

**Option B (DB-backed) for v1.** Text documents (markdown, JSON, YAML) are the
95% case for agentic knowledge. Postgres handles them beautifully with full-text
search. Keep Option C in the design for later if binary/large file support proves
necessary. The search/replace edit API is a game-changer for agent-native
document manipulation.

---

## Primitive 3: Project Bootstrapping (Agent-Triggered Project Creation)

**The problem**: Creating an Eve project today requires multiple manual steps:

1. Create a GitHub repo (manual)
2. `eve init` in the repo (CLI)
3. `eve projects create` to register (CLI)
4. `eve projects link` to connect repo (CLI)
5. Configure secrets, environments, build specs, agents...

An agent (e.g. a PM agent) should be able to say "create a new project for
payment processing" and have it exist.

**What exists today**:

- `eve init` command creates manifest + starter files in an existing repo
- `eve projects create` + `eve projects link` registers project in Eve
- GitHub credentials exist at org level (for builds/deploys)
- Permission model: member/admin/owner with 33 distinct permissions
- `project:manage` permission for project CRUD

**What we'd add**:

```
POST /orgs/:id/projects/bootstrap
{
  "name": "payment-service",
  "description": "Payment processing microservice",
  "template": "eve-starter",           // or "eve-api-starter", "eve-worker-starter"
  "git": {
    "provider": "github",
    "org": "myorg",                    // GH org to create repo in
    "visibility": "private"
  },
  "packs": ["software-factory"],       // pre-install these AgentPacks
  "environments": ["staging"],         // pre-configure these envs
  "created_by": "pm-user-id"
}
```

This endpoint:

1. Creates the GitHub repo (using org-level GH credentials)
2. Initializes it with the chosen template (`eve init`)
3. Registers the Eve project
4. Links the repo
5. Installs specified AgentPacks
6. Returns the project ID + repo URL

CLI:

```bash
eve projects bootstrap --name payment-service --template eve-starter --git-org myorg
```

**Pros**:

- Eliminates the multi-step bootstrapping ceremony
- Agents can trigger from any context (job, Slack, PM app UI)
- Uses existing org-level GitHub credentials — no per-user credential setup
- Template system means consistent project structure
- Composable: PM agent calls this API, doesn't need to know git internals

**Cons**:

- Requires org-level GitHub admin credentials (already needed for builds)
- Template management is a new concern (which templates? who maintains?)
- Permission model needs a "can create projects" gate (already exists: `project:manage`)
- Risk of repo sprawl if creation is too frictionless

**Verdict**: **Medium value, medium cost.** The API is straightforward but the
template system needs design. Could start with just the API endpoint that wraps
the existing CLI commands.

---

## Primitive 4: OpenSpec / Structured Plans as a First-Class Concept

**The problem**: Plans created by PM agents need to be understood by
implementation agents. Today plans are free-form markdown. This works for humans
but makes agent-to-agent handoff lossy — the implementation agent has to re-parse
the plan and may miss intent.

**What is OpenSpec**: A minimalist spec-driven development framework for
AI-assisted coding, particularly on brownfield (existing) projects. Core ideas:

- Specifications as structured documents that both humans and agents can parse
- Explicit contracts between "what to build" and "how to build it"
- Version-controlled alongside code
- Machine-readable format with human-readable presentation

### Option A: Eve-native spec format

Define a YAML/markdown spec structure that the PM agent writes and the factory
agent reads:

```yaml
# spec.yaml (committed to repo by pm-plan-drafter)
schema: eve/spec/v1
feature: user-data-export
status: approved
author: pm-plan-drafter

overview:
  goal: "Allow users to export their data as CSV and PDF"
  motivation: "Compliance requirement from legal team"

modules:
  - path: src/services/export/
    changes:
      - type: extend
        description: "Add user-facing export (currently admin-only)"
      - type: new
        description: "PDF generation using existing Puppeteer dependency"
  - path: src/api/routes/export.ts
    changes:
      - type: new
        description: "REST endpoints for triggering and downloading exports"

constraints:
  - "Must respect GDPR — PII filtering required"
  - "Async processing via existing Bull job queue"
  - "Rate limit: 1 export per user per hour"

acceptance:
  - "User can export own data as CSV from settings page"
  - "User can export own data as PDF from settings page"
  - "Exports processed async with email notification on completion"
  - "PII fields are filtered based on user's data sharing preferences"

code_grounding:
  insight_version: 3
  last_recon: "2026-02-10T14:30:00Z"
```

### Option B: Adopt OpenSpec directly

Use their framework and make Eve tooling aware of it:

```bash
eve specs list                              # list specs in project
eve specs validate spec.yaml                # validate against schema
eve jobs create --from-spec spec.yaml       # create job pre-loaded with spec context
```

### Option C: Specs as job attachments with conventions

Don't create a new primitive. Use Primitive 1 (job attachments) with a
conventional naming pattern:

```bash
eve jobs attach <epic_id> --file spec.yaml --name "spec" --mime application/x-eve-spec
```

Factory agents look for attachments with mime `application/x-eve-spec` and treat
them as structured plans.

### Analysis

**Pros (of having any spec format)**:

- Eliminates ambiguity in PM → implementation handoff
- Machine-parseable means agents can validate plans against code
- Version-controlled specs give audit trail
- Standard format enables tooling (validation, diffing, visualization)

**Cons**:

- Another format to maintain and document
- Risk of over-specification — plans become rigid when they should evolve
- Free-form markdown is often good enough (agents are good at parsing prose)
- OpenSpec itself is early-stage and may not mature

**Verdict**: **Option C for now (specs as job attachments with conventions),
evolve to Option A if patterns stabilize.** Don't invest in a rigid spec format
prematurely — the agent-native philosophy says agents should handle loose
structure. But do provide a conventional way to attach structured plans to jobs,
and let the format emerge from real usage.

---

## Primitive 5: Cross-Project Queries (Org-Level Intelligence)

**The problem**: An app managing multiple projects (PM app, dashboard, portfolio
tool) needs to ask "which projects have open security risks?" or "what's the
total job backlog across my org?" Today it would need to loop through each
project, query the Eve API, and aggregate client-side.

**What exists today**:

- All queries are project-scoped (e.g., `GET /projects/:id/jobs`)
- No org-level aggregation endpoints
- The Eve API DB has all the data — it's just not exposed cross-project

**What we'd add**:

```
GET /orgs/:id/jobs?status=open&agent_slug=pm-*    — jobs across all projects
GET /orgs/:id/jobs/stats                          — aggregate counts/status
GET /orgs/:id/events?type=system.job.*&since=...  — org-wide event stream
GET /orgs/:id/agents                              — all agents across projects
```

**Pros**:

- Enables portfolio-level views without N+1 queries
- PM app, dashboard, and any org-level tool benefits
- Data already exists — just needs exposure

**Cons**:

- Permission model complexity (which projects can this user/service see?)
- Performance (cross-project queries on large orgs)
- Could leak information if permissions aren't strict

**Verdict**: **High value, medium cost.** This is needed for any org-level
intelligence tool, not just PM. Start with `GET /orgs/:id/jobs` with permission
filtering and expand from there.

---

## Primitive 6: Webhooks / Event Callbacks

**The problem**: An agentic app wants to know when a job completes in a target
project. Today it has to poll. This is wasteful and adds latency.

**What exists today**:

- `system.job.completed`, `system.job.failed` events exist internally
- Events are used for triggers within Eve (pipelines, workflows)
- No external webhook delivery

**What we'd add**:

```
POST /projects/:id/webhooks
{
  "url": "https://pm.myorg.com/api/webhooks/eve",
  "events": ["system.job.completed", "system.job.failed"],
  "filter": { "agent_slug": "pm-*" },
  "secret": "whsec_..."
}
```

When matching events fire, Eve POSTs a signed payload to the URL.

**Pros**:

- Real-time event delivery, no polling
- Standard webhook pattern (HMAC-signed, retries, delivery log)
- Benefits any app that integrates with Eve, not just PM

**Cons**:

- Webhook infrastructure (retry queues, delivery tracking) is non-trivial
- Security surface (outbound HTTP from Eve platform)
- Dead letter handling for failed deliveries

**Verdict**: **High value, high cost.** Important for production-grade agentic
apps but can be deferred — polling with exponential backoff works for v1. Build
when multiple apps need it.

---

## Primitive 7: Service Account Authentication

**The problem**: An app backend needs to call the Eve API as a service, not as a
user. Today, authentication is user-scoped (SSH keys, OAuth tokens). A backend
service needs a durable, non-user token.

**What exists today**:

- User auth via SSH keys or OAuth
- Org-scoped secrets (available to agents in jobs)
- No "service account" or "API key" primitive for backend-to-API communication

**What we'd add**:

```bash
eve auth create-service-account --name "pm-app-backend" --scopes "jobs:create,jobs:read,projects:read"
# Returns: eve_svc_xxxxxxxxxxxx
```

```sql
CREATE TABLE service_accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id),
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  scopes      TEXT[] NOT NULL,
  created_by  UUID REFERENCES users(id),
  last_used   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Pros**:

- Clean separation of human auth and service auth
- Scoped permissions (principle of least privilege)
- Auditable (last_used, created_by)
- Standard pattern (every PaaS has service accounts)

**Cons**:

- Another auth path to maintain
- Token rotation, revocation, audit trail

**Verdict**: **High value, medium cost.** Every Eve app with a backend will need
this. Build it as a platform primitive.

---

## Primitive 8: Web Chat (Agentic Apps as Chat Endpoints)

**The problem**: Agentic apps need a chat interface. A PM talks to agents through
a web UI. A dashboard lets operators chat with debugging agents. A customer
portal lets end-users interact with support agents. Today the gateway supports
Slack and Nostr — but no web-native transport.

**What exists today**:

- Gateway plugin architecture with `GatewayProvider` interface
- Two providers: **Slack** (webhook transport) and **Nostr** (subscription transport)
- All routing, identity resolution, agent dispatch, thread management is shared
  infrastructure in `GatewayChatService` — providers only handle transport +
  normalization into `NormalizedInbound`
- Internal chat API: `POST /internal/orgs/:id/chat/route` (command dispatch) and
  `POST /internal/orgs/:id/chat/dispatch` (listener dispatch)
- Thread key format: `provider:account_id:channel[:thread_id]`
- Generic webhook controller: `POST /gateway/providers/:provider/webhook`

**There are two distinct mechanisms for getting web chat working, and they serve
different scenarios.**

---

### Mechanism A: WebChat Gateway Provider (Platform-Level)

A new `webchat` provider registered in the gateway, sitting alongside Slack and
Nostr. The web app connects directly to the gateway via WebSocket.

```
┌─────────────────────┐         ┌──────────────────────────────────────┐
│   Any Web App        │         │   Eve Gateway                        │
│                      │         │                                      │
│   React UI ──────WebSocket────►│  WebChatProvider                     │
│                      │         │    ├─ authenticate (JWT/session)     │
│                      │         │    ├─ parse → NormalizedInbound      │
│                      │         │    └─ sendMessage → WebSocket push   │
│                      │         │         │                            │
│                      │         │    GatewayChatService (shared)       │
│                      │         │    ├─ resolve org + identity         │
│                      │         │    ├─ route to agent                 │
│                      │         │    └─ create job → response          │
│                      │         │                                      │
└─────────────────────┘         └──────────────────────────────────────┘
```

**Implementation**:

```typescript
class WebChatGatewayProvider implements GatewayProvider {
  name = 'webchat';
  transport = 'subscription';       // WebSocket, like Nostr
  capabilities = ['inbound', 'outbound', 'identity'];

  // WebSocket endpoint: wss://gateway.eve/providers/webchat/ws
  // Auth: JWT token in connection handshake → maps to Eve user
  // Thread key: webchat:<org_id>:<user_id>:<thread_id>
  // Inbound: { agent_slug, text, thread_id } → NormalizedInbound
  // Outbound: sendMessage() pushes JSON frame to open WebSocket
}
```

Register in `app.module.ts`:

```typescript
registry.registerFactory('webchat', {
  create: () => new WebChatGatewayProvider(),
});
```

**When to use this**:

- **Simple chat UIs** that just need to talk to Eve agents without custom logic
- **Multi-tenant chat widgets** — e.g. an embeddable chat component any Eve app
  can drop in
- **Admin/operator consoles** — quick access to agents without building a backend
- **Any app that doesn't need to intercept, enrich, or store conversations
  independently**

**Pros**:

- Zero backend work for the app — just connect a WebSocket from the frontend
- Shared infrastructure — auth, routing, threading, agent dispatch all handled
- Consistent experience across all chat surfaces (Slack, Nostr, web)
- One provider serves every web app in the ecosystem

**Cons**:

- App has no control over the conversation pipeline — can't enrich messages
  with app-specific context before they reach agents
- Conversations live in Eve's thread system, not the app's DB — harder for the
  app to query, display, or augment them
- App can't intercept agent responses to transform or store them before showing
  to the user

---

### Mechanism B: Backend-Proxied Chat (App-Level)

The web app's own backend acts as the intermediary. The React UI talks to the
app's API, which calls Eve's internal chat endpoints directly. No gateway
provider needed.

```
┌─────────────────────┐         ┌─────────────────┐         ┌──────────────┐
│   PM App (Web)       │         │   PM App API     │         │   Eve API    │
│                      │         │                  │         │              │
│   React UI ──WebSocket───────► │  /ws/chat        │         │              │
│                      │         │    │              │         │              │
│                      │         │    ├─ enrich with │         │              │
│                      │         │    │  PM context  │         │              │
│                      │         │    │  (feature,   │         │              │
│                      │         │    │   insight,   │         │              │
│                      │         │    │   plan)      │         │              │
│                      │         │    │              │         │              │
│                      │         │    ├─ store in ───────► discussions table │
│                      │         │    │  PM DB       │         │              │
│                      │         │    │              │         │              │
│                      │         │    └─ dispatch ──────────► /internal/     │
│                      │         │                  │  POST   │ orgs/:id/    │
│                      │         │                  │         │ chat/route   │
│                      │         │    ◄── response ─┼─────────┤              │
│                      │         │    │              │         │              │
│                      │         │    ├─ store resp  │         │              │
│                      │         │    │  in PM DB    │         │              │
│                      │         │    │              │         │              │
│                      │         │    └─ push to ────────► React UI          │
│                      │         │       WebSocket  │         │              │
└─────────────────────┘         └─────────────────┘         └──────────────┘
```

**When to use this**:

- **Apps with their own data model** — the PM app has ideas, features, plans,
  discussions, code insights. Conversations need to be stored in and enriched
  by this model.
- **Context-heavy interactions** — before a PM's message reaches an agent, the
  backend attaches the current feature context, latest code insight, and
  relevant plan version. The agent gets a richer prompt.
- **Apps that transform responses** — the PM app might parse agent responses
  to extract structured data (code insights, plan updates) and store them in
  the appropriate tables before forwarding to the UI.
- **Multi-agent orchestration** — the app backend decides which agent(s) to
  route to based on app-level state, not just the message text.
- **Apps that need conversation history in their own DB** — for search,
  analytics, audit trails, or feeding back into agent context.

**Pros**:

- Full control over the conversation pipeline
- App-specific context enrichment before agent dispatch
- Conversations stored in the app's own DB alongside domain data
- App can orchestrate multiple agents, fan out to teams, merge responses
- No dependency on gateway — uses Eve's internal API directly

**Cons**:

- More code — the app builds its own WebSocket endpoint and chat pipeline
- Duplicates some gateway functionality (connection management, threading)
- Auth handled by the app (uses service account token for Eve API calls)

---

### When to Use Which

| Scenario | Mechanism | Why |
|----------|-----------|-----|
| Embeddable chat widget for any Eve app | **A (Gateway)** | Zero backend, plug and play |
| System dashboard with agent chat | **A (Gateway)** | Simple, no custom data model |
| PM app with rich domain model | **B (Proxied)** | Needs context enrichment + own DB |
| Customer support portal | **B (Proxied)** | Needs to store/search conversations, route by customer context |
| CLI/terminal chat interface | **A (Gateway)** | Thin client, just sends/receives |
| App that orchestrates multi-agent workflows | **B (Proxied)** | Needs to control routing and fan-out |
| Quick internal tool / hackathon project | **A (Gateway)** | Fast to build, no backend needed |
| Production SaaS with chat features | **B (Proxied)** | Needs reliability, storage, analytics |

### The Pragmatic Path

**Build both**, but in order:

1. **Mechanism B works today** — the internal chat API (`/internal/orgs/:id/chat/route`)
   already exists. Any app backend with a service account token (Primitive 7)
   can call it. The PM app should use this from day one.

2. **Mechanism A (WebChat provider)** is a platform investment that pays off
   when multiple apps need simple chat. Build it when the second or third app
   needs chat, or when we want an embeddable widget. The provider is ~300 lines
   following the Slack/Nostr patterns.

**Verdict**: **Mechanism B is free today (just needs service accounts). Mechanism A
is medium cost, build when demand appears.** Both are valuable; they serve
different points on the simplicity-vs-control spectrum.

---

## Priority Ranking

| # | Primitive | Value | Cost | When |
|---|-----------|-------|------|------|
| 1 | Job Attachments | High | Low | **Now** — enables agent context passing everywhere |
| 2 | Service Account Auth | High | Medium | **Now** — needed for any app backend |
| 3 | Org Document Store (DB-backed) | High | Medium | **Phase 1** — agent knowledge persistence |
| 4 | Cross-Project Queries | High | Medium | **Phase 1** — org-level intelligence |
| 5 | Project Bootstrapping API | Medium | Medium | **Phase 2** — agent-triggered project creation |
| 6 | Spec Format (conventions) | Medium | Low | **Phase 2** — emerges from job attachments |
| 7 | Webhooks | High | High | **Phase 3** — replace polling in production |
| 8 | WebChat Gateway Provider | Medium | Medium | **Phase 3** — when multiple apps need simple chat |

---

## The "Ship Order" Argument

Build primitives 1–2 first because they unblock the entire ecosystem, not just
one app. Every AgentPack benefits from job attachments. Every Eve app backend
needs service accounts. These are horizontal enablers.

Primitives 3–4 are the accelerators that make agentic apps dramatically simpler
— instead of building a custom DB for knowledge persistence, apps lean on the
org document store. Instead of N+1 API calls, they use cross-project queries.

Primitives 5–8 are polish that turn the platform from "works" to
"production-grade."

The key insight: **primitives 1 and 2 cost little and pay off immediately across
every use case.** They should be built regardless of whether the PM app or any
specific agentic app moves forward. And for web chat, the proxied approach
(Mechanism B) works today with just a service account — no new platform code
required.
