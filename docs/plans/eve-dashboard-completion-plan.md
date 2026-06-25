# Eve Dashboard Completion Plan

> **Status**: Shipped (6c98644; 22/22 Playwright tests pass on k3d)
> **Created**: 2026-03-30
> **Inputs**: `docs/plans/eve-dashboard-overhaul-goal.md`, `docs/plans/eve-dashboard-design.md`, `docs/plans/eve-dashboard-prototype.html`, `tests/manual/scenarios/32-dashboard-ui.md`

## Goal

Finish the dashboard to the level described in the design doc and prototype, then make the verification strict enough that we cannot call it "done" while major surfaces are still stubbed, shallow, or cosmetically present only.

This is not a last-mile polish pass. The current implementation ships a usable shell and a few data views, but it does not yet deliver the product described in `eve-dashboard-design.md`.

## Audit Summary

### What exists today

- `apps/dashboard` is present and deployed as a platform service.
- Auth is wired through `@eve-horizon/auth-react`; the original auth SDK gaps in the design doc are already closed.
- Overview, Board, Jobs, Environments, Spending, and System routes exist. Project route exists as a placeholder.
- A slide-over job detail panel with 5 tabs (Summary, Attempts, Logs, Result, Cost) and a log viewer with SSE streaming, search, ANSI color parsing, auto-scroll, and download exist.
- TanStack React Query is wired with appropriate polling intervals (3s for jobs, 10s for env health, 30s for analytics, 60s for cost).
- `recharts` is installed as a dependency (available for trend/sparkline work without adding new deps).
- Playwright auth fixture exists with SSH-based token injection for CI-compatible testing.
- There are 21 Playwright tests across 5 phases and one comprehensive manual scenario (scenario 32, already a completion gate).

### Backend endpoints already available (not yet consumed by dashboard)

The plan's backend section previously implied most read models need to be created. In fact, most already exist:

| Endpoint | Controller | Status |
|---|---|---|
| Agent directory | `GET /orgs/:org_id/agents` | Exists |
| Threads + messages | `GET /orgs/:org_id/threads`, `POST .../messages` | Exists |
| Pipelines + runs | `GET /projects/:id/pipelines`, `.../runs` | Exists |
| Workflows | `GET /projects/:id/workflows` | Exists |
| Releases | `GET /projects/:id/releases` | Exists |
| Schedules | `GET /projects/:id/schedules` | Exists |
| System logs/events/config/users/settings | `GET /system/logs/:service`, `/events`, `/config`, `/users`, `/settings` | Exists |
| Environment health + diagnostics | `GET /projects/:id/envs/:name/health`, `/diagnose` | Exists |
| Org-scoped events | `GET /orgs/:org_id/events` | **Missing** (only project-scoped exists) |
| Project topology / architecture | — | **Missing** (no endpoint) |
| Org attention summary | — | **Missing** |
| Daily spend time-series | — | **Missing** (only aggregate spend exists) |
| Project members | — | **Missing** (no `GET /projects/:id/members`) |
| Job review actions | — | **Missing** (no approve/reject mutations) |

### What is materially incomplete

| Surface | Current repo state | Why it is not done |
|---|---|---|
| **Shell / IA** | Sidebar-only shell in `apps/dashboard/src/components/layout.tsx`; no top bar context, no environment selector, no scope toggle, no secondary project anatomy nav | The design and prototype both depend on a richer two-level shell that carries org, project, environment, and admin context everywhere |
| **Overview** | Basic stat cards, recent activity, aggregate env counts, total spend only | Missing attention panel, project rollups, spend trend, drill-in behavior, richer env summary, and visual density expected by the spec |
| **Board** | Four columns, search, priority filter, optional harness filter | Missing epic/assignee/time-range filters, cross-project admin ergonomics, live transition polish, richer card metadata, and review-state affordances |
| **Job Detail / Logs** | 5 tabs exist (Summary, Attempts, Logs, Result, Cost). Log viewer has SSE streaming, text search, ANSI color, auto-scroll, and download. | Missing review actions, artifact links, attempt comparison, regex search, next/prev match navigation, timestamp toggle, log-level filtering, word-wrap toggle, virtualization for large logs, and copy affordances. Streaming UX needs stable scroll-disengage and reconnect handling. |
| **Project page** | `apps/dashboard/src/pages/project.tsx` is a placeholder that says "coming in Phase 6" | The entire project anatomy workspace is absent |
| **Architecture topology** | Not implemented | One of the defining features in the spec and prototype |
| **Agents + chat** | Not implemented | Missing cards, warm/cold state, recent threads, chat panel, and streaming conversation UX |
| **Pipelines / workflows / integrations / releases / schedules / members** | Not implemented | These are called out as first-class tabs in the design and are present in the prototype, but absent from the app |
| **Environments** | Aggregate health counts only | Missing per-environment cards, admin table, detail expansion, deploy history, and release context |
| **Spending** | Total, attempts, currency, and agent-cost table only | Missing trend views, project breakdown, top expensive jobs, budget/anomaly cues, and admin finance workflows |
| **System / admin mode** | Platform-admin-only system page with services + pods | Missing org-admin operational mode, attention model, service drill-in, events/log tail, users/settings panels, and proper role-scoped behavior |
| **Verification** | 21 Playwright tests across 5 phases (foundation through admin smoke), no dashboard unit tests, no dashboard API integration tests. Manual scenario 32 is a comprehensive completion gate. | Playwright coverage proves route presence and basic controls, not product completeness. Unit and API integration tiers are empty. Manual scenario is strong but automated regression coverage lags behind it. |

### Specific verification problems

- `tests/manual/scenarios/32-dashboard-ui.md` is already rewritten as a 7-phase completion gate with 40+ checks covering auth, overview, board, job detail, project anatomy, environments, spending, admin/system, and UX quality. It explicitly fails on placeholders and missing tabs.
- `apps/dashboard/e2e/dashboard.spec.ts` has 21 tests across 5 phases but only covers foundation, basic navigation, and smoke-level board/job/admin checks. It lacks coverage for project anatomy, log search, SSE streaming, topology, agents/chat, and most Phase 6-9 features from the design.
- There are no dashboard unit tests under `apps/dashboard/src/**/*.test.tsx`.
- The design doc calls for `apps/api/test/integration/dashboard-api.integration.test.ts`; that file does not exist.

## Completion Bar

The dashboard is complete only when all of the following are true:

1. Every route shown in navigation is feature-complete, not a stub or placeholder.
2. The project workspace includes Architecture, Agents, Pipelines, Workflows, Integrations, Releases, Schedules, and Members with real data and drill-in behavior.
3. The board and job detail flow are good enough for daily operator use, not just demo clicks.
4. Org-admin and platform-admin experiences both exist and match backend permissions.
5. Empty states appear only for genuinely empty data, never for unimplemented capability.
6. The dashboard matches the design intent: dense, elegant, legible, and fast, not a generic Tailwind admin shell.
7. Verification fails if any of the above regresses.

## Delivery Principles

- **Use the design doc as product truth**. Use the prototype as the interaction and visual quality reference.
- **Do not rebuild auth**. Reuse the existing `@eve-horizon/auth-react` provider and focus effort on product surfaces.
- **Prefer first-class read models over client-side stitching** when the UI needs ranked attention items, topology data, cross-project rollups, or per-service drill-in.
- **No shipped placeholders**. If a route is present in navigation, it must do real work.
- **Verification must track slices as they ship**. Do not defer tests until the end.

## Workstreams

### 1. Shell, Navigation, and Shared State

**Outcome**: the dashboard has the correct information architecture before deeper surfaces land.

**Frontend work**
- Rework the app shell to match the design/prototype: sidebar + top bar + route-local secondary navigation where needed.
- Promote org, project, environment, and admin/platform scope into shared dashboard state rather than route-local state.
- Deep-link selectors and tabs through the URL so views are linkable and refresh-safe.
- Add the missing environment selector and explicit admin/platform scope control.
- Raise the visual bar: typography, spacing, density, motion, and hierarchy should align with the prototype rather than the current neutral admin template.

**Acceptance**
- Switching org, project, environment, and mode updates all dependent views predictably.
- The shell remains stable across all routes and slide-overs.
- No route requires hidden state to be usable after refresh.

### 2. Overview, Board, and Job Workflow Surfaces

**Outcome**: the landing page and kanban become operational tools rather than summaries.

**Overview**
- Add the missing admin attention panel.
- Replace aggregate env counts with a real env rollup list.
- Add spend trend visualization and drill-in entry points.
- Add richer project rollups for admin mode.

**Board**
- Add epic, assignee, and time-range filters, plus stronger admin project filtering.
- Improve card design: richer metadata, review cues, and better done-column behavior.
- Make live updates visually legible: transitions, inserts, and movement between phases.

**Jobs page**
- Support org-admin cross-project mode instead of project-only table behavior.
- Add stronger filtering, sort order, and direct deep-links into job detail.

**Acceptance**
- An operator can answer "what is broken right now?" from Overview and Board without jumping elsewhere.
- Admin mode provides real cross-project value instead of a slightly wider summary.

### 3. Job Detail, Review Actions, and Log Viewer

**Outcome**: the detail panel is good enough for real debugging and review.

**Detail panel**
- Add review actions, artifact/result links, attempt selection, and attempt comparison.
- Improve Summary with full metadata parity from the design.

**Log viewer** (text search, SSE streaming, ANSI color, auto-scroll, and download already exist)
- Add next/previous match navigation, regex mode, level filters, timestamp toggle, word-wrap toggle, and copy affordances.
- Add virtualization so large logs stay smooth.
- Harden SSE streaming: stable scroll-disengage behavior, reconnect on drop, and active-line highlighting.

**Acceptance**
- A reviewer can inspect a review-phase job and take action from the panel.
- A developer can debug a long-running or failed job without leaving the dashboard.

### 4. Project Anatomy Workspace

**Outcome**: the most differentiated part of the product actually exists.

**Architecture**
- Build the topology view with hover highlighting, click-to-inspect, and environment switching.
- Show health pills and resource summaries above the topology.

**Agents**
- Build agent cards with harness, warm/cold state, description, and thread counts.
- Add recent threads list and agent chat slide-over with streaming response UX.

**Pipelines / Workflows / Integrations / Releases / Schedules / Members**
- Implement each tab as a real surface, not a heading and placeholder copy.
- Preserve density and visual coherence across tabs so the project workspace feels like one product.

**Acceptance**
- The Project route becomes a primary destination, not a dead end.
- Every tab shown in the prototype/design exists and is useful.

### 5. Environments, Spending, and Admin/System Completion

**Outcome**: operational and finance views meet the spec.

**Environments**
- Add real environment cards and an admin table.
- Support detail expansion, release context, deploy history, and degraded-service drill-in.

**Spending**
- Add trends, project breakdown, top expensive jobs, and budget/anomaly indicators.
- Differentiate member, org-admin, and platform-admin value instead of showing one thin table to everyone.

**System / admin**
- Add org-admin operational overview rather than treating system views as platform-admin-only.
- Add service drill-in, events, and log tails.
- Implement users/settings panels for `system_admin`.
- Align route visibility and access behavior with real permissions.

**Acceptance**
- Org admins can actually operate an org.
- Platform admins can inspect services without dropping to kubectl for first-pass diagnosis.

### 6. Polish, Performance, and Accessibility

**Outcome**: the UX is first-rate rather than merely complete.

- Add loading skeletons, robust empty states, and retryable error states.
- Audit responsive behavior at 1024px+ and common laptop widths.
- Add keyboard support for major interactions.
- Budget performance for topology, board polling, and large logs.
- Run an accessibility pass on focus management, contrast, labeling, and slide-over behavior.

**Acceptance**
- No jarring blank states or layout breakage.
- Large-log and high-job-count views remain responsive.
- Theme parity is intentional in both light and dark modes.

## Backend / Read-Model Work Required

The current UI can only go so far with the existing fetches. Many endpoints already exist but the dashboard doesn't consume them yet. Before building more client-side joins, confirm or add first-class endpoints for:

**Already exist (need dashboard integration):**
- Agent directory (`GET /orgs/:org_id/agents`) and thread listing (`GET /orgs/:org_id/threads`, `POST .../messages`)
- Pipeline listing and runs (`GET /projects/:id/pipelines`, `.../runs`)
- Workflow listing (`GET /projects/:id/workflows`)
- Release listing (`GET /projects/:id/releases`)
- Schedule listing (`GET /projects/:id/schedules`)
- System drill-in: service logs (`GET /system/logs/:service`), cluster events (`GET /system/events`), config (`GET /system/config`), users (`GET /system/users`), settings (`GET /system/settings`)
- Environment health (`GET /projects/:id/envs/:name/health`) and diagnostics

**Need to be created:**
- Org attention summary (ranked, cross-project attention items for admin mode)
- Daily spend buckets (time-series data for trend visualization; current `/orgs/:org_id/spend` is aggregate only)
- Project topology / architecture read model (no endpoint exists; the defining visualization feature has no data source)
- Org-scoped events endpoint (dashboard calls `GET /orgs/:org_id/events` but the API only has project-scoped `GET /projects/:id/events` — the dashboard currently works around this via the analytics controller)
- Member listing per project (no `GET /projects/:id/members` endpoint)
- Review actions on jobs (approve/reject/request-changes mutations for review-phase jobs)

The auth-related API gaps in the original design are already fixed and should be removed from the critical path.

## Suggested Delivery Order

1. **Rebuild the shell and shared state**
2. **Finish Overview, Board, Jobs, and Job Detail**
3. **Land Project Anatomy end to end**
4. **Finish Environments, Spending, and Admin/System**
5. **Polish, performance, accessibility, and release-gate verification**

## Verification Strategy

The dashboard needs a stricter test pyramid. Scenario 32 is already a completion gate; automated coverage must catch up.

### Required automated coverage

- Add dashboard unit tests for layout state, role-gated nav, filters, cards, slide-overs, and log viewer behavior.
- Add dashboard API integration tests for the exact contracts the UI consumes.
- Split Playwright coverage by product slice instead of keeping a single lightweight smoke file. The existing 21 tests cover foundation through basic admin; add suites for project anatomy, log viewer features, agent chat, and advanced admin workflows.

### Manual coverage (already in place)

- Scenario 32 is already rewritten as a 7-phase completion gate that fails on placeholders, missing tabs, and unexpected empty states.
- It verifies member, org-admin, and platform-admin behavior separately.
- It verifies the Project workspace in full, including topology and agent chat.
- As new Playwright suites land per-slice, the manual scenario remains the final release gate.

## Exit Criteria

Do not close dashboard work until all of the following are true:

- `apps/dashboard/src/pages/project.tsx` is no longer a placeholder route.
- Scenario 32 verifies the full product surface and passes.
- Dashboard unit tests exist and cover core behavior.
- Dashboard API integration tests exist and cover the consumed contracts.
- Playwright coverage is split by feature area and passes on the finished product.
- The UX review result is "ship-worthy" against the design/prototype bar, not merely "functional enough."
