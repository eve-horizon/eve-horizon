# Agentic App Platform Primitives Roadmap

> Status: Idea
> Last Updated: 2026-02-11
>
> Inputs:
> - `docs/ideas/platform-primitives-for-agentic-apps.md`
> - `docs/ideas/agentic-pm-native-app-platform-gap-analysis.md`
> - `docs/ideas/app-role-permissions-mapping-and-ops.md`
> - `docs/ideas/pm-app-agentic-product-management.md`
> - `docs/plans/eve-native-container-registry-plan.md`
> - `docs/plans/managed-postgres-dbaas-plan.md`

## Brief

This document defines the implementation order for platform primitives needed to
support arbitrary first-class agentic native apps.

Important context: container registry (`registry: eve`) and managed Postgres
(`x-eve.role: managed_db`) are already running in separate streams. They should
continue in parallel and must not block the core agentic-app primitive path.

## Scope and Assumptions

1. Pre-MVP environment: optimize for speed and clean primitives, not backward-compat ceremony.
2. Security-first ordering: machine identity and least-privilege come before feature breadth.
3. Single context model: job/resource context should converge, not fragment.
4. CLI-first operability: every primitive needs deterministic CLI surfaces.

## Streams

### Stream A (Primary): Agentic-App Core Primitives

This is the critical path for enabling broad app patterns (PM, support, ops,
portfolio, customer-facing agents).

### Stream B (Parallel): Runtime Substrate

Continue independently:
- Eve-native container registry
- Managed Postgres DBaaS

These are foundational runtime services, but not blockers for Stream A
primitives listed below.

## Ordered Primitive Backlog

| Order | Primitive | Why This Position | Key Dependency |
| --- | --- | --- | --- |
| 1 | Service principals + short-lived scoped tokens | Removes long-lived user-token workaround for app backends | None |
| 2 | Access visibility (`eve access can`, `eve access explain`) | Makes permission model debuggable before auth changes spread | 1 (shared principal model) |
| 3 | Custom role overlays + bindings | Enables least-privilege app personas and service identity grants | 1, 2 |
| 4 | Job attachments persistence + CRUD | Fastest durable context-exchange primitive with immediate app value | 1 (for backend writers) |
| 5 | Job `target` + `resource_refs` on create | Converts job creation from low-level routing to intent-level API | 4 |
| 6 | Org document store (DB-backed text/search/patch) | Durable cross-job/project knowledge substrate | 5 (shared resource refs) |
| 7 | Org-level query APIs (jobs/stats/events/agents) | Enables portfolio intelligence without N+1 client loops | 3 (permission filtering), 6 (resource use cases) |
| 8 | Webhook subscriptions (signed + retries) | Replaces polling with push for production app responsiveness | 7 |
| 9 | Project bootstrap API | Lets agents create/link projects declaratively | 1, 3 |
| 10 | Policy-as-code access sync (`.eve/access.yaml`) | Makes access model reproducible and CI-friendly | 3 |
| 11 | WebChat gateway provider (optional) | Useful shared transport, but proxied app backends already work | 1 |
| 12 | Formal spec DSL/OpenSpec hardening (optional) | Defer schema lock-in until real attachment/resource patterns stabilize | 4, 5, 6 |

## Phase Plan

### Phase 0: Identity and Authorization Baseline

1. Service principals + token minting.
2. Access explain/can visibility commands.
3. Custom role and binding overlays.

Exit criteria:
- App backend can authenticate without user tokens.
- Permission source is explainable for user and service principals.
- PM-style and app-specific least-privilege roles are enforceable.

### Phase 1: Context Plane Primitives

1. Job attachments CRUD and size limits.
2. Job `target` and `resource_refs`.
3. Org doc store with text search and patch operations.

Exit criteria:
- Agents can pass structured context durably.
- A single `resource_refs` model can reference both job attachments and org docs.
- Cross-job handoff does not depend on ad hoc repo files or external side stores.

### Phase 2: Org Intelligence and Reactive Apps

1. Org-level read/query endpoints.
2. Outbound webhook subscriptions with signing, retries, and delivery logs.

Exit criteria:
- Portfolio dashboards are API-native.
- PM/support/ops apps can move from polling to push updates.

### Phase 3: Provisioning and Governance UX

1. Project bootstrap API.
2. Policy-as-code access sync.

Exit criteria:
- Agent-initiated project creation is first-class.
- Access policy is declarative, reviewable, and drift-detectable.

### Phase 4: Optional Experience Layer

1. WebChat provider when multiple apps need thin chat transport.
2. Spec/OpenSpec hardening only after format conventions stabilize in production.

Exit criteria:
- Shared chat transport demonstrably reduces duplicated app backend logic.
- Spec schema adds clear interoperability value (not speculative complexity).

## Dependency Rules

1. Do not implement `resource_refs` as a job-only concept.
2. `resource_refs` must support both job attachments and org docs from v1.
3. Do not ship webhook subscriptions without strict signature verification and retries.
4. Do not ship custom role mutation flows without `can/explain` visibility in place.

## Parallel Streams Note

The container registry and managed Postgres streams continue in parallel and
should be integrated as they become ready. They improve runtime ergonomics and
operability, but they should not reorder Stream A unless a hard dependency
emerges during implementation.

## Bottom Line

Execute security and identity first, then context exchange, then org
intelligence/eventing, then bootstrap/governance ergonomics. Keep registry and
managed DB on their own tracks while this primitive set lands.
