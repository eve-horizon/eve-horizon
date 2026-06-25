# Native Agentic App Primitives Roadmap

> Status: Idea
> Last Updated: 2026-02-11
>
> Inputs:
> - `docs/ideas/platform-primitives-for-agentic-apps.md` (primitive catalog with schemas and pros/cons)
> - `docs/ideas/agentic-pm-native-app-platform-gap-analysis.md` (PM app gap matrix and delivery path)
> - `docs/ideas/pm-app-agentic-product-management.md` (PM app as reference use case)
> - `docs/ideas/app-role-permissions-mapping-and-ops.md` (custom roles and policy-as-code)
> - `docs/plans/eve-native-container-registry-plan.md` (Distribution + S3 registry)
> - `docs/plans/managed-postgres-dbaas-plan.md` (managed Postgres DBaaS)

## Brief

Eve can host agentic apps today. The PM app design proves this — it maps onto existing primitives: AgentPack distribution, org-scoped secrets, cross-project job creation, chat gateway routing.

But "can be built with workarounds" and "falls out naturally" are different things. This doc defines the minimum set of platform primitives that make Eve the obvious PaaS for agentic apps — not just for PM, but for any app where agents accumulate knowledge, share documents, create projects, and operate across organizational boundaries.

The PM app is the reference use case. Every primitive here is horizontal — any Eve-compatible agentic app benefits.

---

## Three Categories of Work

1. **Agentic App Primitives** — what makes agents and cross-project apps capable.
2. **PaaS Infrastructure** — what makes deploying those apps frictionless.
3. **Access & Polish** — what makes the whole thing production-grade.

---

## Phase 0: Universal Unlockers

Cost the least, pay off the most. Every agentic app needs them. Build regardless of whether any specific app ships.

### 1. Job Attachments

**Problem**: A job's context is its `description` (plain text) and `hints` (key-value). When agents need to pass structured documents between jobs — a plan, a code insight report, an architecture diagram — they stuff everything into the description (loses structure), write to workspace files (fragile), or call an external API (requires the app to exist first).

**What exists**: `AttachmentSchema` defined in `packages/shared/src/schemas/attempt.ts`, used in `ContinueAttemptRequestSchema`. But no DB table, no API endpoints, no job-level attachment field.

**What we build**: New `job_attachments` table + CRUD API + CLI commands.

```
POST   /jobs/:id/attachments
GET    /jobs/:id/attachments
GET    /jobs/:id/attachments/:att_id
DELETE /jobs/:id/attachments/:att_id
```

```bash
eve jobs attach <job_id> --file plan.md --name "Implementation Plan"
eve jobs attachments <job_id>
```

**Value**: High. Every AgentPack benefits. PM agent writes a plan attachment, factory agent reads it. Eliminates the "pass context between agents" problem for most cases.

**Cost**: Low. Straightforward CRUD on a new table.

**Detail**: See `platform-primitives-for-agentic-apps.md`, Primitive 1.

### 2. Service Account Auth

**Problem**: An app backend needs to call the Eve API as a service, not as a user. Today, authentication is user-scoped (SSH keys, OAuth). App backends use long-lived user JWTs — a security debt that blocks production use.

**What exists**: User auth via SSH keys/OAuth. Org-scoped secrets available to agents in jobs. No service account or API key primitive.

**What we build**: New `service_accounts` table + scoped token issuance + CLI.

```bash
eve auth create-service-account --name "pm-app-backend" \
  --scopes "jobs:create,jobs:read,projects:read"
```

**Value**: High. Every Eve app with a backend needs this. Clean separation of human and machine auth.

**Cost**: Medium. New auth path, token service, rotation/revocation lifecycle.

**Detail**: See `platform-primitives-for-agentic-apps.md`, Primitive 7.

### What Phase 0 Unlocks

Any app backend can call the Eve API safely. Any agent can attach structured documents to jobs for other agents to read. The proxied web chat mechanism (app backend calls Eve internal chat API) already works with just these two primitives.

---

## Phase 1: Core Intelligence Layer

These make agentic apps dramatically simpler. Without them, every app builds its own knowledge store and aggregation layer.

### 3. Org Document Store (DB-Backed)

**Problem**: Agents accumulate knowledge that should persist across jobs and projects — architecture reports, risk assessments, product context. Today this knowledge lives in git (pollutes history), an external app's DB (chicken-and-egg), or the agent's memory (lost when the job ends).

**What exists**: `org-fs` PVC mounted at `/org` in agent-runtime. 5Gi ReadWriteMany. Used only for workspace provisioning — no API, no CRUD, no search.

**What we build**: New `org_documents` table in Postgres with full-text search, search/replace edit API, and CRUD endpoints.

```
POST   /orgs/:id/docs
GET    /orgs/:id/docs?path=/reports/
GET    /orgs/:id/docs/:path
PATCH  /orgs/:id/docs/:path
DELETE /orgs/:id/docs/:path
GET    /orgs/:id/docs/search?q=...
```

The search/replace edit API gives agents atomic document manipulation — crucial for the agent-native design principle of granular operations.

**Value**: High. Agent knowledge persistence is the substrate for every cross-project app.

**Cost**: Medium. Migration, new controller, Postgres tsvector indexing.

**Detail**: See `platform-primitives-for-agentic-apps.md`, Primitive 2 (Option B).

### 4. Cross-Project Queries

**Problem**: An app managing multiple projects needs portfolio-level views. Today it loops through each project, queries the Eve API, and aggregates client-side. N+1 queries for basic dashboard data.

**What exists**: All queries are project-scoped (`GET /projects/:id/jobs`). The DB has all the data — it's just not exposed cross-project.

**What we build**: Org-scoped query endpoints with permission-aware filtering.

```
GET /orgs/:id/jobs?status=open&agent_slug=pm-*
GET /orgs/:id/jobs/stats
GET /orgs/:id/events?type=system.job.*&since=...
GET /orgs/:id/agents
```

**Value**: High. Needed for any org-level intelligence tool — PM, dashboard, portfolio, monitoring.

**Cost**: Medium. New query endpoints, permission filter layer for project-level access control.

**Detail**: See `platform-primitives-for-agentic-apps.md`, Primitive 5.

### 5. Job Targeting

**Problem**: PM app backend (or any orchestrator) must manually resolve agent IDs before creating jobs. The API `create` accepts `assignee` but has no `agent_slug` target field. Apps should submit intent, not resolve internals.

**What exists**: Job create schema has no `target` or `agent_slug` field.

**What we build**: Add a `target` object to the job create payload.

```json
POST /projects/{project_id}/jobs
{
  "description": "Ground export feature in code reality",
  "target": { "agent_slug": "myapp-pm-code-recon" },
  "resource_refs": [
    { "kind": "pm.brief", "id": "res_abc" }
  ]
}
```

**Value**: Medium-high. Makes job creation declarative and agent-native.

**Cost**: Low. Schema change + job creation service update.

**Detail**: See `agentic-pm-native-app-platform-gap-analysis.md`, Gap Matrix.

### What Phase 1 Unlocks

An app can store persistent knowledge, query across all its projects, and create intent-level jobs that route to the right agent. This is the minimum viable "agentic PaaS" — apps compose real multi-project workflows without building custom infrastructure.

---

## Phase 2: PaaS Infrastructure (Parallel Track)

Can be built **in parallel with Phase 1** — touches completely different code paths (worker/deployer/infra vs. API/controllers/queries).

### 6. Native Container Registry

**Problem**: Every Eve project that deploys containers must provision a registry, create and rotate credentials, configure secrets, specify registry config in the manifest, and manage image retention. Significant friction for new users and simple apps.

**What we build**: Eve runs an instance of Distribution (the reference OCI registry used by Docker Hub, GHCR, GitLab) as a platform service. Image layers stored in S3. Eve handles all auth via short-lived scoped JWTs.

Manifest experience:

```yaml
registry: eve
# That's it. No host, namespace, or auth needed.
```

**Value**: High. Eliminates the biggest onboarding friction for new apps.

**Cost**: High. K8s manifests, worker builder/deployer changes, token service, infra repo modules.

**Detail**: See `docs/plans/eve-native-container-registry-plan.md`.

### 7. Managed Postgres DBaaS

**Problem**: Eve apps have two DB choices: run Postgres as a manifest service (operational burden) or wire an external DB URL (manual provisioning). Neither is zero-friction.

**What we build**: A third mode — Eve provisions and manages Postgres per environment. Integrates with existing billing/usage infrastructure.

Manifest experience:

```yaml
services:
  db:
    x-eve:
      role: managed_db
      managed:
        class: db.p1
        engine: postgres
        engine_version: "16"
  api:
    environment:
      DATABASE_URL: ${managed.db.url}
```

**Value**: High. Eliminates the second biggest deployment friction.

**Cost**: High. Orchestrator reconciler, provider interface (RDS first), deployer preflight, manifest schema, billing integration.

**Detail**: See `docs/plans/managed-postgres-dbaas-plan.md`.

### What Phase 2 Unlocks

A new agentic app goes from "manually provision registry + DB + credentials" to `registry: eve` + `role: managed_db`. Time-to-deploy drops from hours to minutes.

---

## Phase 3: Access Control & Roles

Depends on service accounts (Phase 0) being in place.

### 8. Custom Roles & Permission Bindings

**Problem**: Roles are fixed to `member/admin/owner`. Apps need roles like `pm_manager` (broad read, narrow write) or `support_triage` (jobs + threads only). Teams over-grant `admin` when they only need a narrow permission subset.

**What we build**: Custom role definitions + role bindings as additive overlays on top of existing membership roles. CLI-first operations.

```bash
eve access roles create pm_manager --org org_xxx \
  --permissions jobs:read,jobs:write,threads:read,threads:write,chat:write
eve access bind --project proj_xxx --user user_abc --role pm_manager
eve access can --user user_abc --project proj_xxx --permission chat:write
```

Effective permission resolution: `expand(base_membership_role) UNION all(bound_custom_role_permissions)`.

**Value**: Medium-high. Least-privilege by default for every app.

**Cost**: Medium. New tables, permission resolution update, CLI commands.

**Detail**: See `app-role-permissions-mapping-and-ops.md`.

### 9. Policy-as-Code Sync

**Problem**: Roles managed only in the DB drift across environments and aren't reviewable.

**What we build**: `.eve/access.yaml` schema + validate/plan/sync commands.

```bash
eve access validate --file .eve/access.yaml
eve access plan --file .eve/access.yaml --org org_xxx
eve access sync --file .eve/access.yaml --org org_xxx
```

**Value**: Medium. Enables CI-friendly drift detection and agent automation.

**Cost**: Low. New sync command, YAML schema validation.

**Detail**: See `app-role-permissions-mapping-and-ops.md`, Phase 2.

### What Phase 3 Unlocks

App users and service accounts get exactly the permissions they need. A PM has broad product visibility without admin powers. An app's service account is scoped to its required operations.

---

## Phase 4: Production Polish

These turn "works" into "production-grade."

### 10. Webhook Subscriptions

**Problem**: Apps need push notifications when jobs/pipelines complete. Polling works but wastes resources and adds latency.

**What we build**: Outbound webhook delivery with HMAC signing, retry queue, delivery log, and CloudEvents envelope.

```json
POST /projects/:id/webhooks
{
  "url": "https://pm.myorg.com/api/webhooks/eve",
  "events": ["system.job.completed", "system.job.failed"],
  "filter": { "agent_slug": "pm-*" },
  "secret": "whsec_..."
}
```

**Value**: High. Every production app wants push over polling.

**Cost**: High. Webhook infrastructure (retry queues, delivery tracking, dead letter handling).

**Detail**: See `platform-primitives-for-agentic-apps.md`, Primitive 6.

### 11. Project Bootstrap API

**Problem**: Creating an Eve project requires multiple manual steps (create repo, `eve init`, `projects create`, `projects link`, configure secrets/environments/agents). An agent should be able to say "create a new project" and have it exist.

**What we build**: Single API endpoint that wraps the existing multi-step ceremony.

```
POST /orgs/:id/projects/bootstrap
```

```bash
eve projects bootstrap --name payment-service \
  --template eve-starter --git-org myorg
```

**Value**: Medium. Enables agent-triggered project creation.

**Cost**: Medium. API endpoint, GitHub API integration, template system design.

**Detail**: See `platform-primitives-for-agentic-apps.md`, Primitive 3.

### 12. WebChat Gateway Provider

**Problem**: Agentic apps need a web-native chat transport. Today the gateway supports Slack and Nostr but no browser-native WebSocket path.

**What we build**: A `webchat` provider registered in the gateway, following existing Slack/Nostr patterns. WebSocket transport. ~300 lines of code.

```typescript
class WebChatGatewayProvider implements GatewayProvider {
  name = 'webchat';
  transport = 'subscription';
}
```

Note: The proxied chat approach (Mechanism B — app backend calls Eve internal chat API) already works with service accounts from Phase 0. The WebChat provider is for zero-backend simple chat UIs.

**Value**: Medium. Unlocks embeddable chat widgets and simple admin consoles.

**Cost**: Medium. New gateway provider, WebSocket endpoint, JWT auth in handshake.

**Detail**: See `platform-primitives-for-agentic-apps.md`, Primitive 8.

---

## Dependency Graph

```
Phase 0 ─── 1. Job Attachments ──────────────────────────────┐
         └─ 2. Service Account Auth ─┬── Phase 3 (Roles) ───┤
                                     │                       │
Phase 1 ─── 3. Org Document Store ───┤                       ├── Phase 4
         ├─ 4. Cross-Project Queries ┤                       │   (Webhooks,
         └─ 5. Job Targeting ────────┘                       │    Bootstrap,
                                                             │    WebChat)
Phase 2 ─── 6. Native Registry ─────── (parallel) ──────────┘
         └─ 7. Managed Postgres ─────── (parallel)
```

Phases 0, 1, and 2 can run concurrently:
- **Phases 0+1** touch API controllers, query layer, and new tables.
- **Phase 2** touches worker/deployer, infra repo, and k8s manifests.

Phase 3 depends on Phase 0 (service accounts must exist before binding roles to them). Phase 4 depends on Phases 0+1 (webhooks and bootstrap assume service auth and job targeting exist).

---

## Priority Summary

| Phase | Primitives | Value | Cost | Parallel? |
|-------|-----------|-------|------|-----------|
| **0** | Job Attachments, Service Account Auth | Highest | Low–Medium | Start immediately |
| **1** | Org Document Store, Cross-Project Queries, Job Targeting | High | Medium | After Phase 0 starts |
| **2** | Native Registry, Managed Postgres | High | High | Parallel with Phase 1 |
| **3** | Custom Roles, Policy-as-Code | Medium-High | Medium | After Phase 0 ships |
| **4** | Webhooks, Project Bootstrap, WebChat | Medium-High | Medium-High | After Phases 0+1 ship |

---

## The Strategic Argument

Phases 0+1 are the agentic primitives — they make Eve the obvious place to build apps where agents cooperate across projects. Phase 2 is the PaaS story — zero-config infrastructure. Phase 3 is security hardening. Phase 4 is production polish.

Phases 0 and 1 cost little and pay off immediately across every use case. Service accounts + job attachments + org doc store + cross-project queries + job targeting — five primitives that turn Eve from "can host agentic apps with workarounds" into "the natural platform for agentic apps."

The registry and DBaaS (Phase 2) are higher cost but eliminate the two biggest deployment frictions. They run in parallel since they touch the worker/deployer/infra layer, not the API/intelligence layer.

---

## Spec Format Note

Structured plans (OpenSpec or Eve-native spec YAML) are intentionally not a separate primitive. They emerge naturally from job attachments (Phase 0) with conventional naming: agents attach a document with mime `application/x-eve-spec` and other agents look for it. If patterns stabilize after real usage, formalize the format later. Don't invest in a rigid spec schema prematurely — the agent-native philosophy says agents handle loose structure well.

---

## Standards Alignment

Adopt standards where they reduce bespoke surface area:

- **CloudEvents envelope** for outbound webhook payloads.
- **MCP resource patterns** for context/resource discovery and tool exposure.
- **OCI Distribution Spec** for the native container registry.
- **Docker Token Auth** for registry authentication.
- **OpenAPI** kept in lockstep with actual API surface for app/tool reliability.

---

## Open Questions

1. Should the org document store support project-scoped documents (optional `project_id` on `org_documents`), or should project-scoped knowledge live only in job attachments?
2. Should cross-project query endpoints return union results or federated results (one response vs. per-project grouping)?
3. Should service accounts be org-scoped only, or also project-scoped for tighter isolation?
4. Should custom role names be globally unique per org, or namespaced by app?
5. How much of the project bootstrap flow should be synchronous (return project ID) vs. asynchronous (return a bootstrap job ID)?
6. Should webhook subscriptions live at org or project scope? (Probably both, with org-level subscriptions filtering by project.)
