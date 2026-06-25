# Agentic PM Native App: Platform Gap Analysis and Primitive Roadmap

> Status: Idea  
> Last Updated: 2026-02-11  
>
> Inputs:
> - `docs/ideas/agent-native-design.md`
> - `docs/ideas/pm-app-agentic-product-management.md`
> - `docs/system/agents.md`
> - `docs/system/chat-routing.md`
> - `docs/system/threads.md`
> - `docs/system/events.md`
> - `docs/system/job-api.md`
> - `docs/system/app-service-eve-api-access.md`
> - `docs/system/auth.md`
> - `docs/system/openapi.yaml`

## Brief

Design Eve so a PM can work through a native Eve-compatible app that:

1. Sees portfolio-level state across projects in one org.
2. Chats with a top-level PM agent that interviews for requirements.
3. Pulls reality from target project agents (codebase, architecture, constraints).
4. Produces grounded roadmap artifacts and hands off cleanly to implementation agents (for example, Software Factory packs).

This doc maps what works now, where platform friction exists, and what primitives would make this pattern first-class.

---

## Agent-Native Success Criteria

Using `agent-native-design.md` as the lens:

- **Parity**: PM can do in chat/UI what agents can do through primitives.
- **Granularity**: platform exposes atomic primitives; PM workflows are composed by agents.
- **Composability**: new PM workflows are mostly prompt/config changes.
- **Emergence**: app can support unplanned PM asks without new backend features for each one.

---

## What Already Works

### Execution and Routing

- PM app can be a normal Eve project (services + manifest + environments).
- PM AgentPacks can be installed into target projects via `x-eve.packs`.
- Org-unique agent slugs support cross-project targeting from chat.
- Threads and thread messages provide continuity.
- Team dispatch + coordination threads support multi-agent execution patterns.

### Data + Flow

- Jobs, hierarchies, dependencies, and review states exist.
- Event spine exists for inbound events and trigger-based orchestration.
- PM app can poll Eve API and drive jobs/pipelines from its backend.

---

## Reality Check vs Existing PM Idea Doc

`docs/ideas/pm-app-agentic-product-management.md` is directionally right on architecture, but its "No Platform Gaps" claim is optimistic for current implementation details.

Important mismatches:

1. It shows `agent_slug` on job create payload, but job create schema currently has no such field.
2. It assumes practical service-to-service auth; current guidance is long-lived user tokens.
3. It assumes easy cross-project visibility for PMs; today, broad job listing is admin-gated.
4. It leans on callback-style updates; first-class outbound webhook subscriptions are not implemented.

---

## Gap Matrix

| Gap | Why It Matters for PM App | Current State | Proposed Primitive |
| --- | --- | --- | --- |
| Service principal auth | PM backend needs safe machine identity to call Eve API across org projects | Uses long-lived user JWT pattern | `service_principals` + short-lived scoped tokens (org/project/env/action scopes) |
| Cross-project PM read model | PM needs portfolio dashboard without admin overreach | Project iteration + per-project queries; global jobs list is admin route | Org-scoped portfolio query endpoints with role-aware filtering |
| Job targeting by slug/team/workflow | PM backend should submit intent-level jobs, not resolve internals manually | API create accepts `assignee`, no `agent_slug` target field | Add `target` object on job create (`agent_slug`, `team`, `workflow`) |
| First-class job inputs/resources | PM workflows need docs, interviews, transcripts, architecture packets as durable context | No first-class job attachments/resources at create; attempt `attachments` path is not implemented end-to-end | Resource store + typed resource references on jobs and attempts |
| Push callbacks | PM UI needs low-latency updates when jobs/runs complete | Polling and custom app-side callbacks | Webhook subscriptions for job/pipeline/thread lifecycle events |
| Project bootstrap for PM role | PM should be able to initiate new projects/repo scaffolds without manual platform operator flow | Project create requires existing `repo_url` + branch | `project bootstrap` primitive (repo create from template + manifest seed + project sync) |
| PM capability profile | PMs need broad product visibility but limited infra mutation | Roles are member/admin/owner + permission bundles | Capability presets for PM personas (read-many, write-few) |
| API discoverability drift | PM app and agent tooling should rely on accurate API contract | Thread endpoints exist in controller path but are not in OpenAPI export | Keep OpenAPI in lockstep for app/tool reliability |

---

## Proposed Native PM Architecture (Reference)

### 1) PM Control Project (Eve App)

Runs PM web app + API + PM-side agents:

- `pm-concierge`: requirement interview and clarification loop.
- `pm-synthesizer`: normalizes notes/transcripts into structured artifacts.
- `pm-roadmap`: portfolio planning and prioritization suggestions.
- `pm-handoff`: converts approved plan into implementation jobs/workstreams.

### 2) Target Project PM AgentPack

Installed in each target app repo:

- `pm-code-recon`: architecture/code/path analysis.
- `pm-feasibility`: constraints and migration/risk checks.
- `pm-plan-drafter`: implementation plan proposal grounded in actual repo state.

### 3) Shared Platform Primitives

- Job execution, hierarchy, and review.
- Threads for continuity and coordination.
- Event lifecycle for UI sync and automation.
- Resource/docs API for durable context exchange.

---

## End-to-End Flow (Desired)

1. PM describes a feature in PM app chat.
2. `pm-concierge` interviews PM until acceptance criteria and constraints are explicit.
3. PM app launches recon jobs in selected target projects.
4. Target project agents return structured context packets to PM resource store.
5. `pm-plan-drafter` composes grounded plan alternatives.
6. PM approves one, and `pm-handoff` creates implementation epic/workstream jobs.
7. Software Factory pack (or equivalent) executes delivery.
8. PM dashboard updates automatically from webhook/event subscriptions.

---

## Option Set (Platform Strategy)

### Option A: App-Layer Assembly Only

Build PM app now using existing primitives and workarounds.

**Pros**
- Fastest path to first shipped PM app.
- No core API changes required initially.

**Cons**
- Security debt (long-lived user-token service auth).
- Higher complexity in PM backend (manual slug/ID resolution, polling).
- Harder for third-party Eve apps to reuse the pattern.

### Option B: PM-Enabling Platform Additions (Recommended)

Add a small set of reusable primitives while building PM app.

**Pros**
- Better security and cleaner tenancy boundaries.
- Reusable by other cross-project agentic apps.
- Keeps PM app thin and mostly declarative.

**Cons**
- Requires coordinated API/schema/CLI work.

### Option C: Resource Plane First

Start by building a generic org/project resource filesystem/knowledge plane.

**Pros**
- Strong long-term substrate for many agent-native apps.
- Best fit for parity/composability goals.

**Cons**
- Larger scope; delays PM app value.
- Requires clear lifecycle, ACL, indexing, and cost decisions upfront.

---

## Recommended Delivery Path

### Phase 0: Ship PM App MVP with Current Primitives

- Build PM app and PM AgentPack.
- Use current job/thread/event model.
- Use temporary service-token workaround for backend Eve API calls.
- Validate real PM workflow end-to-end.

### Phase 1: Add Three Critical Primitives

1. Service principals + scoped short-lived tokens.
2. Job `target` + job `resource_refs`.
3. Outbound webhook subscriptions.

This removes most PM app workaround complexity.

### Phase 2: Add Portfolio and Bootstrap Primitives

1. Org-level PM dashboard query APIs.
2. Project bootstrap flow (repo create + manifest seed + sync).
3. PM capability profile(s) for least-privilege access.

### Phase 3: Resource Plane Expansion

- Typed resource store with CRUD/search/versioning.
- OpenSpec-backed artifact types for briefs/plans/decision logs.
- Optional org-shared workspace semantics for cross-project PM context.

---

## Candidate API Shapes (Sketch)

### 1) Service Principals

```http
POST /orgs/{org_id}/service-principals
POST /service-principals/{id}/tokens
```

### 2) Job Targeting + Context Inputs

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

### 3) Webhook Subscriptions

```http
POST /orgs/{org_id}/webhooks/subscriptions
```

```json
{
  "events": ["job.completed", "pipeline_run.completed", "thread.message.created"],
  "url": "https://pm.example.com/eve/events",
  "secret_ref": "WEBHOOK_SIGNING_SECRET"
}
```

### 4) Project Bootstrap

```http
POST /orgs/{org_id}/projects/bootstrap
```

```json
{
  "name": "Payments Rework",
  "slug": "payrwk",
  "repo": {
    "provider": "github",
    "owner": "acme",
    "template": "eve-horizon/eve-horizon-starter",
    "private": true
  },
  "manifest_template": "web-api-basic"
}
```

---

## Standards Alignment (Avoid Lock-In)

Adopt standards where they reduce bespoke surface area:

- **OpenSpec** for PM artifact structure (briefs, requirements deltas, plan docs).
- **MCP resource patterns** for context/resource discovery and tool exposure.
- **CloudEvents envelope** for outbound webhook payload shape.
- **OpenAPI webhooks/callback semantics** for API-level contract clarity.
- **AsyncAPI** for documenting event streams where applicable.

---

## Open Questions

1. Should PM artifacts be canonical in PM app DB, in target repos, or dual-written by design?
2. Should PM portfolio APIs be derived read models or direct cross-project federation queries?
3. Do we want one PM app per org, or a multi-org PM control plane?
4. Should project bootstrap require GitHub App install, PAT, or both?
5. How much of PM role/capability should be fixed presets vs custom permission packs?

---

## Bottom Line

Eve can already host a strong PM-native app pattern, but it is not frictionless yet. A small, deliberate primitive set (service principals, job targeting + resources, webhook subscriptions, and project bootstrap) turns this from a custom app pattern into a reusable platform capability for agentic product development.
