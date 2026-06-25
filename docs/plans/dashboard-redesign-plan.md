# Dashboard Redesign Plan — "Horizon" UI

**Status**: Complete
**Started**: 2026-06-12
**Goal**: Rebuild `apps/dashboard` as a delightful, strictly read-only platform dashboard — elegant on mobile and desktop — with per-app cloud cost attribution.

---

## 1. Why

The current dashboard is functional but generic: icon-rail sidebar, flat cards, default Recharts styling, and **no mobile support at all** (the shell is a fixed `52px + 1fr` grid that collapses below ~768px). Cost visibility stops at LLM spend per agent; cloud (AWS) costs are collected in `cloud_cost_snapshots` but only exposed through admin JSON endpoints, never attributed to the apps that incur them.

## 2. Design Language — "Horizon"

Eve = evening horizon. The brand thread is a **dusk gradient** (amber → rose → violet) used sparingly: logo mark, active-state indicators, hero chart fills. Everything else is calm, layered, and content-first.

- **Dark-first** with a warm-paper light mode. Both ship; toggle persists.
- **Typography**: Space Grotesk for display numerals/headings, Inter for UI text, JetBrains Mono for IDs/logs. Loaded via Google Fonts (same mechanism as today).
- **Surfaces**: deep-ink background (`#0b0d12` family), cards with 12px radius, 1px low-contrast borders, subtle elevation on hover. No heavy shadows.
- **Charts**: gradient area/bar fills, rounded corners, no vertical gridlines, custom tooltips matching surface tokens, animated on mount.
- **Motion**: 150–250ms ease-out transitions; skeletons for loading; staggered card entrance on first paint only.
- **Density**: 13px base preserved (it suits an ops surface), but more generous page padding and section rhythm.

## 3. Information Architecture

Five top-level destinations (was seven) — exactly right for a mobile bottom tab bar:

| New | Replaces | Content |
| --- | --- | --- |
| **Home** `/` | Overview | Platform pulse: health strip, attention items (review/failed), active jobs, spend sparkline, activity feed |
| **Apps** `/apps` | Project + Environments | App cards (project × env): health, ingress links, release, services; drill-in detail view |
| **Jobs** `/jobs` | Jobs + Board | One page, list ⇄ board view toggle; job detail slide-over (desktop) / full-screen sheet (mobile) with log viewer |
| **Costs** `/costs` | Spending | LLM spend + **cloud cost per app** (attribution chart), trends, methodology + confidence panel |
| **System** `/system` | System (admin-gated) | Cluster services, pods, events, env health across orgs, config |

**Shell**:
- Desktop (≥1024px): 220px sidebar with labels + icons, collapsible to 56px rail; topbar holds org/project/env context switchers, job pulse, theme, user.
- Tablet (640–1024px): rail sidebar.
- Mobile (<640px): no sidebar; bottom tab bar (5 tabs, System appears only for admins); topbar condenses to context pill + avatar; dropdowns become bottom sheets.

**RBAC in the UI** (informed by `apps/api/src/auth/permissions.ts`):
- Members: only their orgs' data; System tab hidden; Costs shows org-scoped LLM spend + per-app cloud attribution for their org's apps.
- Org admin/owner: org-wide scope toggle (existing `adminScope` concept, redesigned as explicit "scope" control).
- Platform admin (`user.isAdmin`): System tab + cross-org cloud cost (bill-backed `/admin/cost/*`).
- Nav/routes derive visibility from auth state; admin-gated pages also handle 403 gracefully (no blank screens).

## 4. Cost-per-App Attribution

**Definition**: an "app" = a project's deployed environment (namespace `eve-{org}-{project}-{env}`), the unit users recognize.

**Two-tier model** (honesty first):
1. **Bill-backed truth** — AWS Cost Explorer totals from `cloud_cost_snapshots` (provider `aws`, by-service breakdown, MTD projection). Admin-only today.
2. **Usage-based weights** — OpenCost per-environment estimates (`/admin/cost/environments` source) used to allocate the bill across app namespaaces.

**Allocation**: `app_share = bill_total × (opencost_app_estimate ÷ Σ opencost_estimates)`. Cost not covered by any namespace estimate (control plane, NAT, shared infra) is shown explicitly as **Platform overhead** — never smeared invisibly. Each figure carries `confidence` + `coverage` from the snapshot row, surfaced in the UI with a methodology popover.

**New read-only endpoint** (final contract in §8 after API research): org-scoped `GET /orgs/:org_id/cost/apps?month=` returning per-app allocated cloud cost + LLM spend side by side, RBAC-filtered to the caller's org; plus admin variant across all orgs. Implemented in `apps/api/src/billing/`, reading existing tables only — no schema changes.

## 5. Implementation Phases

1. **Plan + research** (this doc) — API contracts confirmed, decision log started.
2. **API: cost attribution endpoint** — service + controller + unit tests; integration test hitting the API.
3. **Design system core** — new `index.css` tokens, tailwind config, fonts, primitives (Card, Stat, Badge, Sheet, Tabs, EmptyState, ChartTheme).
4. **Responsive shell** — sidebar/topbar/bottom-tabs/sheets, RBAC-driven nav.
5. **Pages** — Home, Apps (+detail), Jobs (list/board/detail), Costs, System.
6. **Polish loop** — Playwright screenshots at 390×844 and 1440×900 for every page, self-review, iterate.
7. **Final gates** — `pnpm build && pnpm test`, e2e suite update, k3d deploy, authenticated walkthrough as admin AND plain member, screenshots archived.

## 6. Verification

- Unit: `pnpm test` (workspace) — existing dashboard vitest + new API tests.
- Screenshot loop: headless script (`apps/dashboard/scripts/`) injecting `eve auth token --raw`, shooting all routes at both viewports into `tmp/playwright-browser/screenshots/`.
- e2e: update `apps/dashboard/e2e/dashboard.spec.ts` for new IA; seed via `e2e/seed.sh`.
- Member-view check: second (non-admin) user/org to prove scoping — System hidden, admin cost endpoints unused (no 403 spam in console).
- Deploy: `./bin/eh k8s deploy`, walkthrough at `http://dashboard.eve.lvh.me`.

## 7. Decision Log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-06-12 | Keep React+Vite+Tailwind+Recharts stack | Modern, already wired into build/deploy; redesign is design-layer work, not framework churn |
| 2026-06-12 | Merge 7 nav items → 5 (Jobs+Board merge; Project+Environments → Apps) | Mobile bottom-tab fit; "apps" is the user's mental model, not "projects vs environments" |
| 2026-06-12 | Cost attribution = bill total allocated by OpenCost weights, with explicit "Platform overhead" residual | Honest: bill-backed totals, usage-backed shares, unallocated cost never hidden |
| 2026-06-12 | App = project × environment (namespace) | Matches `eve-{org}-{project}-{env}` runtime reality and user perception |
| 2026-06-12 | No DB schema changes; new endpoint reads existing tables | Read-only mandate; lower risk |

## 8. API Contracts (confirmed)

**`GET /orgs/:org_id/cost/apps?month=YYYY-MM`** (`orgs:read`, org-scoped via PermissionGuard param extraction) and **`GET /admin/cost/apps?month=`** (`system:admin`). Implemented in `apps/api/src/billing/app-cost.service.ts` (+ `org-cost.controller.ts`).

Response (`AppCostReport`): `window{month,start,end}`, `method` (`bill_allocated_by_opencost` | `opencost_direct` | `none`), `bill{provider,source,amount*,projected_amount*,currency,confidence,coverage,observed_at,stale}`, `infra{source,cluster_env_total_usd*,cluster_shared_usd*,platform_overhead_usd*,allocation_factor,observed_at,stale}`, `llm{total_usd,attempts}`, `totals`, `apps[]{org_id,project_id,project_name/slug,llm_usd,llm_attempts,cloud_usd,total_usd,environments[]{environment_id,env_name,namespace,opencost_usd,cloud_usd,confidence,observed_at}}`, admin-only `orgs[]`.

`*` = **redacted (null) in the org-scoped response** — members never see cluster-wide bill totals or platform overhead; they get their own apps' allocations plus provenance (provider, confidence, coverage, freshness).

Sources: `cloud_cost_snapshots` (AWS CE, cluster scope `example-cluster` or `EVE_CLOUD_COST_SCOPE_KEY`) + `environment_cost_snapshots` (OpenCost per-namespace + `shared:platform` row) + receipts via new `spendQueries.sumSpendByProject`. Allocation: `factor = bill / (Σ env_estimates + shared)`; app share = estimate × factor; remainder = explicit platform overhead. Verified live on k3d: $402.37 bill → factor 1.306651, overhead $125.96, allocations reconcile exactly.

## 9. Progress Log

- 2026-06-12: Plan written. Research complete (8.4k LOC dashboard, no mobile shell, spend page LLM-only). k3d healthy.
- 2026-06-12: Cost attribution API implemented + 8 unit tests green (16 total billing). Live-verified on k3d. Demo seed: `tests/manual/seed-demo-costs.sql`.
- 2026-06-12: Horizon design system (new `index.css` tokens, Space Grotesk/Inter/JetBrains Mono, dusk gradient brand thread, dark default). Responsive shell: desktop sidebar / tablet rail / mobile bottom tabs + sheet dropdowns. New IA: Home, Apps, Jobs (list⇄board merged), Costs, System(admin) with legacy redirects. Old overview/board/spending/environments pages folded in and removed. Screenshot harness: `apps/dashboard/scripts/shoot.mjs` (390×844 + 1440×900, token-injected). Member test user `member@test.local` seeded locally for RBAC walkthrough.
- 2026-06-12: Iteration rounds 1–3. Fixed mobile grid blowout (`minmax(0,1fr)` shell columns, shrinking context pill), made "All projects" the default lens for every role (org-wide jobs/apps now member-visible, RBAC server-side), humanized activity-feed event text, thousands separators on stats. Found and fixed a real `@eve-horizon/auth-react` bug: cancelled bootstrap (StrictMode remount) cleared freshly-validated tokens. RBAC verified at API level: member 200 on own org cost report (bill+overhead redacted, 8 apps), 403 on `/admin/cost/apps` and foreign orgs. Visual walkthroughs captured for member (no System nav, org-only costs) and admin scope (cross-org apps with org chips, platform overhead tile, AWS bill panel with by-service bars, methodology + allocation factor).
- 2026-06-12: e2e spec updated for new IA (nav, context pill, board columns, redirects, costs/apps headings); auth fixture email drift fixed. Workspace build green; all unit suites pass (incl. 16 billing tests).
- 2026-06-12: Final gates passed. Full `pnpm build` + all unit suites green. Final k3d deploy; **34/34 Playwright e2e tests pass** against the deployed dashboard. Deployed walkthrough captured for admin (all routes, both viewports), admin scope (cross-org costs + system) and member (`member@test.local`: four nav tabs, org-scoped costs, system access-gated). Screenshots in `tmp/playwright-browser/screenshots/*-final*`. Follow-up filed: eve-horizon-tsn1t (CLI parity `eve org cost apps`).
