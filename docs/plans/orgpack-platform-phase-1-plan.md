# OrgPack Platform Phase 1 Implementation Plan

> Status: Draft
> Last Updated: 2026-04-07
> Purpose: Deliver the thin platform additions required for OrgPack-grade org-scoped apps without moving coordination logic into core Eve.
> Depends On:
> - `docs/plans/company-as-intelligence-plan.md`
> Enables:
> - `docs/plans/starter-company-orgpack-v1-plan.md`
> - `docs/plans/lean-saas-company-orgpack-v1-plan.md`
>
> References:
> - `apps/api/src/org-queries/org-queries.controller.ts`
> - `apps/api/src/org-queries/org-queries.service.ts`
> - `packages/db/src/queries/org-queries.ts`
> - `packages/shared/src/schemas/org-query.ts`
> - `apps/api/src/orgs/orgs.controller.ts`
> - `apps/api/src/orgs/orgs.service.ts`
> - `apps/api/src/projects/projects.controller.ts`
> - `apps/api/src/jobs/jobs.service.ts`
> - `apps/api/src/jobs/jobs.controller.ts`
> - `apps/api/src/auth/scoped-access.service.ts`
> - `apps/api/src/auth/auth.service.ts` (AuthUser, JobTokenPayload)
> - `apps/api/src/org-fs-sync/org-fs-sync.controller.ts` (SSE reference implementation)
> - `packages/db/src/queries/orgs.ts`
> - `packages/db/src/queries/spend.ts`
> - `packages/db/src/queries/threads.ts`
> - `packages/shared/src/permissions.ts`
> - `packages/shared/src/schemas/agent-config.ts`
> - `packages/shared/src/schemas/agent-primitives.ts`
> - `apps/api/src/threads/org-threads.controller.ts`
> - `apps/api/src/threads/threads.service.ts`
> - `packages/cli/src/commands/org.ts`

## 0) Delivery Assumption

This plan assumes pre-deployment conditions:

1. Breaking changes are allowed across API, CLI, and schema where they simplify the platform.
2. The platform remains execution + memory + control + auth. Coordination logic stays in OrgPack apps.
3. We are optimizing for the lean-company wedge first, not for perfect enterprise generality.
4. Migrations land as forward-only SQL files under `packages/db/migrations/` starting at the next available number (current latest: `00089`).

## 0.1) Baseline Audit Before Starting

Before touching code, confirm the shipped surface area so we upgrade the right things:

1. `GET /orgs/:org_id/jobs`, `jobs/stats`, `events`, `agents/all` — already wired in `apps/api/src/org-queries/org-queries.controller.ts`.
2. `GET /orgs/:org_id/spend` — already wired in `apps/api/src/orgs/orgs.controller.ts` via `OrgsService.getSpend` and `spendQueries.sumOrgSpend`.
3. `GET /orgs/:org_id/events` already supports `type` glob and `since` ISO filters in `packages/db/src/queries/org-queries.ts:findEventsAcrossProjects`. No SSE surface exists yet.
4. `GET /orgs/:org_id/threads` — already wired in `apps/api/src/threads/org-threads.controller.ts`.
5. `thread_messages` schema today has only `direction` (`inbound`/`outbound`), `actor_*`, `body`, `job_id`, and delivery metadata — there is NO `kind` column and no decision state. Phase 1D must add that state.
6. Job tokens bypass access-group resolution in `ScopedAccessService.can()` (lines 32-36) and are authorized purely by the `permissions` array baked into the JWT. Pack authorization must respect this shape.

## 1) Why This Plan Exists

The umbrella company plan is now clear about the boundary:

1. The platform should provide org-scoped access and bounded elevated powers to one designated pack project.
2. The pack app should provide the world model, staffing logic, policies, and operating opinions.
3. The first concrete pack (`starter-company`) needs a reliable self-modifying loop: repo change -> push -> sync -> new agent available.

Today we already have part of the substrate:

1. Org job listing and stats.
2. Org event listing.
3. Org spend endpoint.
4. Org threads and org docs.
5. Project manifest + agent sync.

What is missing is the thin glue that makes these surfaces OrgPack-grade instead of merely adjacent.

## 2) Scope

Phase 1 platform work includes exactly seven capability areas:

1. OrgPack registration.
2. Org-wide event feed upgrades.
3. Org-wide job visibility upgrades.
4. Cross-project job creation by an authorized pack.
5. Org-wide capability discovery.
6. Org-level spend breakdown queries.
7. Typed thread decisions over org threads.

## 3) Non-goals

Do not build any of the following in this plan:

1. A platform-level world model service.
2. A platform-level policy engine or staffing DSL.
3. Company-graph tables.
4. A second task or issue system.
5. A special-purpose "hire agent" primitive.
6. Pack-specific product logic for `starter-company` or `lean-saas-company`.

## 4) Success Bar

This plan is successful when:

1. One project can be registered as an org pack.
2. Agents in that project can read org-wide events, jobs, capabilities, spend, and org threads using bounded permissions.
3. The same pack can create jobs in other projects in the same org with a visible audit trail.
4. The pack can use typed decisions on org threads for approval-mode operation.
5. `starter-company` can execute the self-staffing loop entirely on current platform primitives plus this Phase 1 work.

## 5) Execution Checklist

| Status | Area | Item | Acceptance |
| --- | --- | --- | --- |
| - [ ] | Registration | Migration adds `orgs.pack_project_id`; API + CLI set/clear/inspect | One project per org can be designated as pack project |
| - [ ] | Authz | `PackAuthService.isPackToken()` + reserved-prefix override in `ScopedAccessService` | Pack job tokens get only the documented elevated rights; no permission catalog bloat |
| - [ ] | Jobs query | `?status=blocked|stalled|recent_failures`, `?since=...`, enriched rows | Pack can triage the org without downloading full job bodies |
| - [ ] | Events query | `?source`, `?project_id`, new SSE `/events/stream` | World model can subscribe in real time, filter precisely |
| - [ ] | Capabilities | New unified `GET /orgs/:org_id/capabilities` | Pack can answer "what can this org do?" from one endpoint |
| - [ ] | Spend | `?group_by=project|agent_slug|workflow` via new DB function | Pack can attribute cost to outcomes/capabilities |
| - [ ] | Cross-project jobs | Pack can create jobs in sibling projects with provenance fields | Source project/job/agent captured and surfaced in `job show` |
| - [ ] | Rate limits | Per-pack rate limits + circuit breaker + reset endpoint | Runaway pack cannot spam the org |
| - [ ] | Threads | `threads.decision JSONB` + decision/resolve endpoints + CLI | Pack can run approval-mode workflows, humans decide from CLI |
| - [ ] | Tests | Integration tests for every capability, plus negative controls | Failing authorization or wrong-scope behavior is caught in CI |
| - [ ] | Manual | `tests/manual/scenarios/` OrgPack end-to-end entry | Scenario runs green against k3d |
| - [ ] | Docs | Update `eve-read-eve-docs` references and `eve-horizon-docs` | Agents and humans can find the new surface |

## 6) Phase 1A: OrgPack Registration + Permission Model

### Deliverables

1. Add `pack_project_id TEXT REFERENCES projects(id)` on `orgs` via a forward-only migration (next available number, e.g. `00090_orgpack_registration.sql`). Include a partial unique index so only one pack project per org.
2. Add API + CLI surfaces to set, clear, and inspect the current pack project:
   1. `PUT /orgs/:org_id/pack { project_id }` (requires `orgs:admin`)
   2. `DELETE /orgs/:org_id/pack` (requires `orgs:admin`)
   3. `GET /orgs/:org_id/pack` (requires `orgs:read`; returns the currently-registered pack project id/slug or null)
   4. `eve org set-pack <org_id> --project <slug-or-id>` and `eve org unset-pack <org_id>`
   5. Include `pack_project_id` on `GET /orgs/:org_id` responses
3. Add a reusable `PackAuthService` (or extend `ScopedAccessService`) with a single method: `isPackToken(user: AuthUser, org_id: string): Promise<boolean>`. It returns true when all of:
   1. `user.is_job_token === true`
   2. `user.org_id` resolves to the target org (by id or slug)
   3. `user.project_id === orgs.pack_project_id` (fresh lookup with in-request memoization; no stale cache)
4. Define the exact elevated capability set in code as a typed enum (`PackCapability`):
   1. `org_queries:read` — org-wide jobs/events/capabilities/spend endpoints
   2. `org_threads:decide` — typed-decision writes on org threads
   3. `cross_project_jobs:create` — create jobs in sibling projects within the same org
   4. `org_docs:write_reserved` — writes under `/operating-model/**`, `/world-model/**`, and any other reserved prefixes declared in code
   5. `org_fs:write_reserved` — same, for org filesystem paths under reserved prefixes

### Authorization mechanism (explicit)

Job tokens today bypass access-group resolution: `ScopedAccessService.can()` short-circuits on `is_job_token` and returns `user.permissions.includes(permission)`. Pack authorization must respect that shape instead of bolting on a parallel ACL system.

Two options considered; we pick option B:

- **Option A (rejected)**: issue pack job tokens with `orgdocs:write`, `orgfs:write`, and a synthetic `orgpack:*` permission baked into the JWT at job-creation time. Rejected because it makes revocation of pack status mid-job impossible and requires the orchestrator to know about pack status when minting job tokens.
- **Option B (chosen)**: keep the job token permission set unchanged and add a check in the relevant controllers (cross-project job creation, decision writes, reserved-prefix writes) that calls `PackAuthService.isPackToken()` before allowing the elevated action. For reserved-prefix writes under org docs/fs, extend `ScopedAccessService.can()` so that when `is_job_token` is true AND the target resource path is under a reserved prefix AND `isPackToken()` succeeds, permission is granted even though the token lacks `orgdocs:write` / `orgfs:write`.

This keeps pack status live (mutable by an admin mid-session), keeps the permission catalog unchanged, and makes the elevated code paths explicit and greppable.

### Likely touchpoints

1. `packages/db/migrations/00090_orgpack_registration.sql` (new file; adjust number if `00090_*` is taken when work starts)
2. `packages/db/src/queries/orgs.ts`
3. `apps/api/src/orgs/orgs.controller.ts` (pack sub-routes)
4. `apps/api/src/orgs/orgs.service.ts`
5. `apps/api/src/auth/scoped-access.service.ts` (reserved-prefix override)
6. `apps/api/src/auth/pack-auth.service.ts` (new file)
7. `packages/shared/src/schemas/orgs.ts` (or dedicated `orgpack.ts`) — request/response types
8. `packages/cli/src/commands/org.ts`

### Design notes

1. Registration is an org setting, not a per-agent override.
2. Pack powers derive from `(job_token.org_id, job_token.project_id) == (orgs.id, orgs.pack_project_id)` — never from agent slug allowlists.
3. Reserved prefixes live as a typed constant in shared code so both docs and fs share one source of truth.
4. `pack_project_id` is nullable. An org with no pack registered behaves exactly as today.
5. Changing pack registration while a pack job is running is safe: the next elevated action re-checks pack status.

### Verification loop

1. Integration test: set a pack project for an org via API and CLI, then fetch it back; unset and assert null.
2. Integration test: a normal project job token is denied by each pack-gated endpoint.
3. Integration test: a pack-project job token is granted on each pack-gated endpoint for its own org and denied in a different org.
4. Integration test: revoking pack registration while a token is still valid causes the next elevated call to fail.
5. Integration test: pack job tokens can write under `/operating-model/**` in org docs but cannot write outside reserved prefixes unless they carry the relevant explicit permission.

## 7) Phase 1B: Org Query Upgrades

This phase extends existing org query surfaces instead of inventing new services.

### 7A. Jobs

Current baseline already exists in:

1. `apps/api/src/org-queries/org-queries.controller.ts` (`GET /orgs/:org_id/jobs`, `/jobs/stats`)
2. `apps/api/src/org-queries/org-queries.service.ts`
3. `packages/db/src/queries/org-queries.ts:findJobsAcrossProjects`
4. `packages/shared/src/schemas/org-query.ts`

Required upgrades:

1. Add a `since` ISO timestamp filter and derived views: `status=blocked`, `status=stalled`, `status=recent_failures`. Define each in one place:
   1. `blocked` — phase `ready` or `active` with an unsatisfied dependency or gate
   2. `stalled` — phase `active` with no attempt progress in N minutes (make N configurable, default 30)
   3. `recent_failures` — latest attempt `failed` within the `since` window
2. Enrich row shape with `title`, `phase`, `latest_attempt_status`, `latest_attempt_ended_at`, `agent_slug`, `project_slug`, `cost_usd_24h` — no full logs or attempt blobs.
3. Preserve current permission filtering semantics for non-pack callers: non-admin users still only see projects they can read.

### 7B. Events

Current baseline exists at `GET /orgs/:org_id/events` in `org-queries.controller.ts`. The DB query already supports `type` glob and `since` ISO timestamp (`packages/db/src/queries/org-queries.ts:findEventsAcrossProjects`). No SSE surface exists yet.

Required upgrades:

1. Add `source` and `project_id` filters to the paginated query and DB function.
2. Add a new SSE endpoint `GET /orgs/:org_id/events/stream` following the same pattern as `org-fs-sync.controller.ts:streamEvents` (`@Sse()`, `Observable<MessageEvent>`, resume cursor via `after_seq` or `after_id`).
3. Reuse the existing events table; do not build a second event system.
4. The stream should respect the same filter query params as the paginated endpoint and re-apply permission filtering per event.

### 7C. Capabilities

Current baseline is fragmented:

1. org-wide agents via `GET /orgs/:org_id/agents/all` (`OrgQueriesService.findAgents`)
2. manifests synced per project (stored in `project_agent_configs` and parsed from manifests)
3. deployments and services tracked in `environment_deployments` and environment health tables

Required upgrades:

1. Introduce a unified `GET /orgs/:org_id/capabilities`.
2. Support `?type=agent|workflow|pipeline|service|app_cli`, `?project=<slug-or-id>`, and `?search=<text>` (substring match on name/description).
3. Return a lightweight discovery shape — each row carries `type`, `id`, `name`, `project_id`, `project_slug`, `description`, `status`, and a single `source` pointer back to its definition (manifest path, agent config row id, etc). No deep denormalization.
4. Aggregate across `project_agent_configs`, parsed manifests (workflows/pipelines/app CLIs), and `environment_deployments` joined through `projects.org_id`.

### 7D. Spend

Current baseline exists at `GET /orgs/:org_id/spend` in `orgs.controller.ts`, backed by `OrgsService.getSpend` and `spendQueries.sumOrgSpend` in `packages/db/src/queries/spend.ts`. Today it returns a single org-wide total.

Required upgrades:

1. Add `group_by` support for `project`, `agent_slug`, and `workflow` (derived from `job_attempts.receipt_json` joined through `jobs`).
2. Preserve the current ungrouped summary when `group_by` is omitted.
3. Return receipt-grounded grouped totals with the same shape as `sumOrgSpend` per group: `base_total_usd`, `billed_total`, `billed_currency`, `attempts`.
4. Implement as a new DB function `sumOrgSpendGrouped(orgId, { since, until, group_by })` — do not overload `sumOrgSpend`.

### Likely touchpoints

1. `packages/db/src/queries/org-queries.ts`
2. `apps/api/src/org-queries/*`
3. `apps/api/src/orgs/*`
4. `packages/db/src/queries/spend.ts`
5. `packages/shared/src/schemas/org-query.ts`
6. `packages/cli/src/commands/org.ts`

### Verification loop

1. API integration tests for every new query parameter.
2. SSE or long-poll integration test for the org events stream.
3. CLI smoke coverage for jobs/events/spend/capabilities output.
4. Permission regression tests to ensure non-pack callers still only see accessible projects.

## 8) Phase 1C: Cross-Project Job Creation

### Deliverables

1. Allow a registered pack job token to create jobs in sibling projects within the same org via the existing `POST /projects/:target_project_id/jobs` endpoint.
2. Preserve normal project-level isolation for every other caller.
3. Capture source attribution on the created job. Fields (added to the `jobs` table via the same migration as Phase 1A, or as a separate follow-up migration if cleaner):
   1. `source_project_id TEXT REFERENCES projects(id)` — the originating pack project
   2. `source_job_id VARCHAR(64) REFERENCES jobs(id)` — the originating pack job (nullable for non-job origins)
   3. `source_agent_slug TEXT` — the originating pack agent
4. Expose the provenance fields on `GET /jobs/:id` and in `eve job show` output.
5. Apply simple per-org rate limits and circuit breakers before the loop goes autonomous.

### Rate limiting and circuit breakers

1. **Per-pack rate limit**: default `max_cross_project_jobs_per_minute = 10` and `per_hour = 200`. Enforced in-process in `JobsService` with a small sliding-window counter keyed on `(source_project_id, target_project_id)`.
2. **Circuit breaker**: if a pack's cross-project jobs produce >50% `failed` or `cancelled` results over the last 20 jobs, refuse new cross-project creations from that pack and emit a `system.orgpack.circuit_open` event. Resettable via a new `POST /orgs/:org_id/pack/circuit/reset` endpoint (requires `orgs:admin`).
3. Both limits are org-configurable via `orgs.pack_settings JSONB` (new nullable column on `orgs`, defaults to platform defaults when NULL).
4. Document the defaults in `eve-read-eve-docs` `references/jobs.md` when the work ships.

### Design notes

1. Reuse the existing `POST /projects/:project_id/jobs` surface — no `POST /orgs/:org_id/jobs` or special cross-project endpoint.
2. Treat pack-originated cross-project jobs as normal jobs with richer provenance, not as a special job type.
3. The pack authorization check happens in `JobsService.create` (or a guard): if the caller is a job token and `target_project.org_id !== caller.org_id`, reject. If the caller is a job token and `target_project.org_id === caller.org_id` but `target_project.id !== caller.project_id`, allow only when `PackAuthService.isPackToken(caller, target_project.org_id)` returns true.

### Likely touchpoints

1. `apps/api/src/jobs/jobs.service.ts`
2. `apps/api/src/jobs/jobs.controller.ts`
3. `packages/db/migrations/000XX_cross_project_job_provenance.sql` (or bundled with Phase 1A migration)
4. `packages/db/src/queries/jobs.ts`
5. `packages/shared/src/schemas/job.ts` — response shape
6. `apps/api/src/auth/pack-auth.service.ts` (reused)

### Verification loop

1. Integration test: pack job token creates a job in another project in the same org; resulting job has `source_project_id`, `source_job_id`, and `source_agent_slug` populated.
2. Integration test: the same token is denied when the target project is in a different org.
3. Negative test: ordinary project job token remains project-local only.
4. Rate-limit test: 11 cross-project creations in one minute — the 11th fails with a rate-limit error and an actionable message.
5. Circuit-breaker test: after 11 failed results out of the last 20 cross-project jobs, the 21st create is refused and a `system.orgpack.circuit_open` event is emitted.
6. Reset test: `POST /orgs/:org_id/pack/circuit/reset` clears the breaker and subsequent creates succeed.

## 9) Phase 1D: Typed Thread Decisions

### Reality check

Today `thread_messages` has only `direction` (`inbound`/`outbound`), `actor_*`, `body`, `job_id`, and delivery metadata — there is NO `kind` column and no decision state anywhere on threads or messages. The umbrella plan was slightly wrong about "message kinds already support status/directive/question/update"; any decision feature needs new state.

### Deliverables

1. Add a `decision JSONB` column on `threads` (nullable) via a new migration. This is cheaper and simpler than a full message-kind enum for v1 and matches the "metadata first" design note.
2. Decision shape (enforced via Zod, not DB constraints):
   ```json
   {
     "status": "pending" | "approved" | "rejected" | "cancelled",
     "risk_class": "low" | "medium" | "high" | "critical",
     "linked_job_id": "proj-abc123" | null,
     "requested_by": "agent:policy-engine" | "user:u_xxx",
     "requested_at": "2026-04-05T14:00:00Z",
     "decided_by": "user:u_xxx" | "agent:ceo" | null,
     "decided_at": "2026-04-05T14:10:00Z" | null,
     "rationale": "..." | null
   }
   ```
3. Add API endpoints:
   1. `POST /orgs/:org_id/threads/:thread_id/decision` — create or replace the decision block (gated by `PackAuthService.isPackToken` OR `orgs:admin` for humans)
   2. `POST /orgs/:org_id/threads/:thread_id/decision/resolve` — set status to `approved`/`rejected`/`cancelled` with rationale; records `decided_by` and `decided_at`
   3. `GET /orgs/:org_id/threads?decision_status=pending` — filter the existing thread list
4. Add CLI affordances in `packages/cli/src/commands/thread.ts`:
   1. `eve thread decide <thread_id> --approve --rationale "..."`
   2. `eve thread decide <thread_id> --reject --rationale "..."`
   3. `eve thread decide <thread_id> --cancel`
5. Emit `system.orgpack.decision.{opened,resolved}` events so the world model agent can observe approvals.

### Design notes

1. Start with a single JSONB column on `threads` rather than a whole new decision subsystem.
2. Only promote decision history to a dedicated table if a single current decision per thread becomes insufficient (e.g. multi-step approvals).
3. Approval conversations stay thread-backed — the decision is metadata, the discussion is still thread messages.
4. Rejecting a decision does NOT cancel the `linked_job_id` automatically; that is a pack-layer policy choice.

### Likely touchpoints

1. `packages/db/migrations/000XX_thread_decisions.sql` (adds `threads.decision JSONB`)
2. `packages/db/src/queries/threads.ts`
3. `apps/api/src/threads/org-threads.controller.ts`
4. `apps/api/src/threads/threads.service.ts`
5. `packages/shared/src/schemas/agent-primitives.ts` (extend `ThreadResponseSchema` with `decision` field)
6. `packages/cli/src/commands/thread.ts`
7. `apps/api/src/auth/pack-auth.service.ts` (reused for authz)

### Verification loop

1. Integration test: create an org thread, attach a decision, resolve it, and read the final state back.
2. Integration test: a pack job token can open a decision; a non-pack job token is denied.
3. Integration test: `GET /orgs/:org_id/threads?decision_status=pending` returns only threads with a pending decision.
4. CLI smoke test: `eve thread decide ... --approve --rationale "..."` moves a decision from `pending` to `approved` with `decided_by`/`decided_at` recorded.
5. Events test: resolving a decision emits `system.orgpack.decision.resolved`.
6. Regression test: ordinary thread listing/messages still work with no decision attached.

## 10) Phase 1E: Hardening, Docs, and End-to-End Validation

### Deliverables

1. Integration tests for the full OrgPack permission envelope (see verification loops above; this phase bundles them into a single `orgpack-*` test file under `tests/integration/`).
2. Rate limiting and circuit breakers wired up and covered (from Phase 1C).
3. Manual test scenario under `tests/manual/scenarios/` that exercises the end-to-end flow against the k3d stack.
4. Public doc updates in `eve-skillpacks/eve-work/eve-read-eve-docs/references/`:
   1. `cli-org-project.md` — `eve org set-pack`, `eve org unset-pack`, new decision commands
   2. `overview.md` — OrgPack concept, one-paragraph summary
   3. `jobs.md` — cross-project job creation semantics, rate limits, provenance fields
   4. `agents-teams.md` — pack project registration effects on agents in that project
   5. Corresponding updates in `eve-horizon-docs` for human-facing docs

### End-to-end validation scenario

Use a temporary org with:

1. one registered pack project (`coord`)
2. one sibling app project (`infra`)
3. one pack agent (`policy-engine`) running in `coord`

Prove that the pack can:

1. Query `GET /orgs/:org_id/jobs?status=blocked`, `/events/stream`, `/capabilities`, `/spend?group_by=project`
2. Write a doc under `/operating-model/**` in org docs
3. Create a job in `infra` via cross-project creation with full provenance
4. Open an org decision thread with `risk_class=medium` linked to that job
5. Read the sibling job's status through the shipped org jobs endpoint
6. A human approves the decision via `eve thread decide --approve`, observable on the stream

### Negative controls the same scenario must fail

1. A job token from `infra` (non-pack) cannot create a job in `coord`.
2. A job token from `coord` cannot query a different org's jobs.
3. Unregistering `coord` as the pack mid-scenario causes the next elevated call to fail with a clear error.

## 11) Milestone Acceptance

Phase 1 is done when all of the following are true:

1. `starter-company` can be installed without platform workarounds.
2. The platform still has no company graph, policy engine, or world model service.
3. Pack powers are bounded, auditable, and test-covered.
4. Rate limits and circuit breakers are in place and exercised by tests.
5. `eve-skillpacks/eve-work/eve-read-eve-docs/references/` is updated in the same PR stream that ships the surfaces (no trailing doc debt).
6. The `tests/manual/scenarios/` entry for OrgPack end-to-end runs green against k3d.
