# Eve Dashboard — Design

> **Status**: Shipped (16a4770; 7/17 phases inline-marked, full impl landed)
> **Created**: 2026-03-27
> **Supersedes**: `system-dashboard-app-plan.md` (Jan 2026, pre-SSO)

## Vision

A single-shell web dashboard that gives every Eve user — from developer to platform admin — an instant, elegant view of what's happening across their projects. Login with SSO. See jobs flowing through phases in real time. Drill into logs. Spot problems before anyone reports them.

It should feel like a well-designed control room: dense with information, but never overwhelming. Sharp typography, restrained color, purposeful motion.

## What Changed Since the Old Plan

The old plan (Jan 2026) assumed CLI token-paste auth because the SSO stack didn't exist yet. Since then:

- **GoTrue + SSO broker** is production-ready (`apps/sso/`)
- **@eve-horizon/auth-react** ships `EveAuthProvider`, `useEveAuth()`, `EveLoginGate`
- **Analytics API** exists: `/orgs/:org_id/analytics/summary`, `/jobs`, `/env-health`, `/cost-by-agent`, `/pipelines`
- **System API** exists: pods, events, logs, config (admin-only)
- **Spend/billing** endpoints exist: org/project/job-level cost data
- **SSE streaming** is proven for job logs and pipeline runs

This plan uses SSO-first auth, reuses the shared auth SDK, and treats admin visibility as a first-class mode instead of bolting it on later.

It also assumes the dashboard should prefer existing org-scoped APIs before adding new cross-platform endpoints. For v1, the app should lean on:

- **Org queries**: `/orgs/:org_id/jobs`, `/orgs/:org_id/jobs/stats`, `/orgs/:org_id/events`
- **Org analytics**: `/orgs/:org_id/analytics/summary`, `/analytics/jobs`, `/analytics/env-health`, `/analytics/cost-by-agent`, `/analytics/pipelines`
- **Project-scoped detail APIs**: jobs, environments, pipelines, spend
- **System APIs**: `/system/*` only where the user actually has `system:*` permissions

---

## Two Modes, One App

### User Mode (default for org members)

You see **projects you can access in the active org**. The dashboard answers:
- What jobs are running right now?
- What finished recently — did anything fail?
- How much compute are my projects consuming?
- What's deploying and is it healthy?

### Admin Mode (default for org admins, available to platform admins)

You see **an operational view above a single project**. The exact scope depends on role:
- **Org admin** (`activeOrg.role === 'admin' || 'owner'`): all accessible projects in the active org
- **Platform admin** (`user.isAdmin === true`): org-wide admin view plus an optional platform-wide system view

The dashboard answers:
- How many projects are active? How many jobs across all of them?
- Are there stuck or failed jobs anywhere in the org?
- What resources is the org consuming?
- If I am `system_admin`, are platform services healthy? Any pods restarting?
- Who's spending the most? Any budget or spend anomalies?

Admins can always drill down into User Mode for any specific project. `system_admin` can additionally switch from org scope into a platform scope for system-only pages.

---

## Information Architecture

```
┌─────────────────────────────────────────────────────┐
│  Eve    [Project Switcher ▾]         [Admin ◉]  [U] │  ← Top bar
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─ Overview ─────────────────────────────────────┐ │  ← Default landing
│  │  Stat cards   |   Activity spark   |   Health  │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  ┌─ Job Board ────────────────────────────────────┐ │  ← Kanban
│  │  ready │ active │ review │ done (collapsed)    │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  ┌─ Job Detail (slide-over) ──────────────────────┐ │  ← Drill-in
│  │  Attempts │ Logs │ Result │ Cost               │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  Environments │ Pipelines │ Settings                │  ← Secondary nav
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Navigation

| Section | User Mode | Admin Mode |
|---------|-----------|------------|
| **Overview** | Project stats, recent activity, env health | Org-wide stats and all-project summary; platform health only for `system_admin` |
| **Board** | Kanban for selected project | Cross-project board for the active org; platform-wide board optional for `system_admin` |
| **Jobs** | Searchable job list with log viewer | Cross-project job list with org/project filters |
| **Project** | Anatomy view: architecture topology, agents (with chat), pipelines, workflows, integrations, releases, members | Same, scoped to admin-accessible projects |
| **Environments** | Deploy status per env | All envs across projects, health rollup |
| **Pipelines** | Runs for selected project | All pipeline activity in the active org |
| **System** (admin only) | — | Pods, services, events, config; `users` and `settings` are platform admin only (`user.isAdmin`) |
| **Spending** | Project cost summary | Org-wide cost, per-project breakdown, anomaly/budget indicators |

---

## Overview Page

The landing page. Dense, scannable, updated every 5 seconds.

### User Mode — Project Overview

```
┌──────────────────────────────────────────────────────────────┐
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐            │
│  │ 3      │  │ 7      │  │ 12     │  │ 2      │            │
│  │ active │  │ in rev │  │ done   │  │ failed │            │
│  │ jobs   │  │        │  │ today  │  │        │            │
│  └────────┘  └────────┘  └────────┘  └────────┘            │
│                                                              │
│  ┌─ Recent Activity ──────────────────────────────────────┐  │
│  │  ● job-a3f2 moved to active                    2m ago  │  │
│  │  ● deploy test-env completed                   5m ago  │  │
│  │  ● job-b7e1 failed (attempt 2)                12m ago  │  │
│  │  ● pipeline build-deploy succeeded            18m ago  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ Environments ─────────┐  ┌─ Cost (7d) ──────────────┐  │
│  │  staging    ● healthy  │  │  $12.40 total             │  │
│  │  preview-3  ● healthy  │  │  ▁▂▃▅▇▆▃  daily trend    │  │
│  │  test       ● degraded │  │  top: ingest-agent $4.20  │  │
│  └────────────────────────┘  └───────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

**Stat cards**: Large number, muted label. Color-coded only for problems (failed = red accent). No gratuitous color.

API sources for stat cards:
- `GET /orgs/:id/jobs/stats` → `by_phase.active`, `by_phase.review`, `by_phase.done` (for today, filter client-side by `updated_at`)
- Failed count: `GET /orgs/:id/analytics/summary?window=1d` → `jobs.failed`

**Recent activity**: Time-ordered feed of job phase transitions, deploys, pipeline completions, failures. Clickable — each item opens the relevant detail view.

API source: `GET /orgs/:id/events?limit=15`. Each event has `type`, `source`, `project_slug`, `status`, `created_at`. The dashboard must format these into human-readable text (see "Org events: human-readable payload" in API Gaps).

**Environments**: Compact list with health dot (green/yellow/red). Click to expand.

API source: `GET /orgs/:id/analytics/env-health` for the overview list (returns all envs with health status). For per-env detail on click: `GET /projects/:id/envs/:name/health`.

**Cost**: Sparkline of daily spend over the window. Top cost contributor. Links to full spending view.

API sources: `GET /orgs/:id/spend?since=<7d ago>` for the total. `GET /orgs/:id/analytics/cost-by-agent?window=7d` for top contributor. Daily sparkline requires either a new daily-bucket endpoint or 7 individual `GET /orgs/:id/spend` calls with day-scoped `since`/`until` (see API Gaps).

### Admin Mode — Operations Overview

```
┌──────────────────────────────────────────────────────────────┐
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐            │
│  │ 8      │  │ 24     │  │ 3      │  │ 12/14  │            │
│  │ active │  │ jobs   │  │ alerts │  │ envs   │            │
│  │ projs  │  │ today  │  │        │  │ healthy│            │
│  └────────┘  └────────┘  └────────┘  └────────┘            │
│                                                              │
│  ┌─ Attention Required ───────────────────────────────────┐  │
│  │  ▲ proj "ingest" — 2 stuck jobs (>30min active)        │  │
│  │  ▲ env "eden/staging" — degraded (1/3 pods ready)      │  │
│  │  ▲ agent-runtime — 3 restarts in last hour             │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ Projects ──────────┐  ┌─ System ─────────────────────┐  │
│  │  ingest    4 active │  │  api            ● running    │  │
│  │  eden      2 active │  │  orchestrator   ● running    │  │
│  │  docs      0 active │  │  worker         ● running    │  │
│  │  + 5 more           │  │  agent-runtime  ● warning    │  │
│  └─────────────────────┘  │  gateway        ● running    │  │
│                           │  sso            ● running    │  │
│  ┌─ Spend (7d) ────────┐  │  postgres       ● running    │  │
│  │  $142.80 total      │  └──────────────────────────────┘  │
│  │  ingest   $68.20    │                                     │
│  │  eden     $42.10    │                                     │
│  │  other    $32.50    │                                     │
│  └─────────────────────┘                                     │
└──────────────────────────────────────────────────────────────┘
```

**Attention Required**: The most important panel. Surfaces problems automatically:
- Jobs stuck in `active` for longer than expected
- Failed jobs with no retry
- Degraded environments
- Service restarts or unhealthy pods
- Budget thresholds exceeded

For org admins, this panel is org-scoped and should omit cluster-only detail. For platform admins (`user.isAdmin`), it can include platform health signals from `/system/*`. This is what an operator checks first. If it's empty, everything is fine.

**Admin mode API sources** (until `/system/summary` and `/orgs/:id/attention` exist):
- Stat cards: `GET /orgs/:id/analytics/summary?window=1d` (projects, jobs, environments counts)
- Attention panel: **client-side derived** — fetch `GET /orgs/:id/jobs?status=active` and filter for `updated_at < 30min ago` (stuck), plus `GET /orgs/:id/analytics/env-health` for degraded envs, plus `GET /system/pods` for restart counts (system_admin only)
- Projects table: `GET /orgs/:id/jobs/stats` → `by_project` array
- System services: `GET /system/status` + `GET /system/pods` (system_admin only)
- Spend: `GET /orgs/:id/spend?since=<7d ago>`

> **Why client-side attention is temporary**: Deriving attention items from 3+ API calls is fragile and slow. The `GET /orgs/:id/attention` endpoint (see API Gaps) should consolidate this into a single call with ranked severity.

---

## Job Board (Kanban)

The heart of the dashboard. Shows jobs moving through phases in real time.

### Layout

```
┌─ ready ────────┐ ┌─ active ───────┐ ┌─ review ───────┐ ┌─ done ─────┐
│                │ │                │ │                │ │ ░░░░░░░░░░ │
│  ┌───────────┐ │ │  ┌───────────┐ │ │  ┌───────────┐ │ │ ░ 47 done ░│
│  │ feat: add │ │ │  │ fix: auth │ │ │  │ refactor  │ │ │ ░ today   ░│
│  │ user sync │ │ │  │ timeout   │ │ │  │ db layer  │ │ │ ░░░░░░░░░░│
│  │ P2 · zai  │ │ │  │ P1 · ●2m │ │ │  │ P2 · ★    │ │ │            │
│  └───────────┘ │ │  └───────────┘ │ │  └───────────┘ │ │ ┌─ latest ┐│
│                │ │                │ │                │ │ │ cleanup  ││
│  ┌───────────┐ │ │  ┌───────────┐ │ │                │ │ │ ✓ 3m ago ││
│  │ test:     │ │ │  │ deploy    │ │ │                │ │ └──────────┘│
│  │ coverage  │ │ │  │ staging   │ │ │                │ │            │
│  │ P3 · code │ │ │  │ P0 · ●5m │ │ │                │ │ ┌─ latest ┐│
│  └───────────┘ │ │  └───────────┘ │ │                │ │ │ migrate  ││
│                │ │                │ │                │ │ │ ✓ 8m ago ││
└────────────────┘ └────────────────┘ └────────────────┘ │ └──────────┘│
                                                         └────────────┘
```

### Design Principles

**Compact cards**: Each card shows title (truncated), priority badge, harness icon, and a duration indicator for active jobs. No description on the card — that's in the detail view.

**Done column is collapsed by default**: Shows a count badge ("47 done today") with the 2-3 most recent completions visible. Click to expand into a scrollable list. This prevents the done column from dominating since most jobs end up there.

**Active column has live indicators**: A subtle pulse dot and elapsed time on active jobs. Failed attempts show a red accent.

**Review column has review badges**: Star icon for human review required. Shows reviewer if assigned.

**Filters bar** (above the board):
- Epic/parent filter (dropdown)
- Harness filter (mclaude/zai/code/...)
- Priority filter
- Assignee filter
- Time range (today / 7d / 30d / all)
- Search (title text match)

**Live updates**:
- Project board: poll `GET /projects/{id}/jobs`
- Org board: poll `GET /orgs/{org_id}/jobs` and use `GET /orgs/{org_id}/jobs/stats` for cheap summary counters
- Platform board (`system_admin` only): use `GET /jobs` with explicit filters

Animate cards between columns with a subtle slide transition. New cards fade in from the top of their column.

### Admin Board

In admin mode, the board shows jobs across all projects in the active org by default. Each card gets a small project badge. Filters include project multi-select. The board can get dense — default to showing only `ready`, `active`, and `review` columns (done is collapsed and shows count only). Only `system_admin` should be able to jump to a platform-wide board backed by `/jobs`.

---

## Job Detail (Slide-Over Panel)

Clicking a job card opens a slide-over panel from the right (60% width). The board stays visible underneath — you can see context while inspecting a job.

### Tabs

**Summary**
- Title, description, phase, priority
- Parent/children links (breadcrumb for epics)
- Assignee, reviewer, labels
- Git metadata (branch, ref, commit)
- Timestamps (created, started, completed)
- Harness + profile

**Attempts**
- List of attempts with status, duration, cost
- Click to switch log view to that attempt
- Compare button (cost comparison between attempts)

**Logs**
- Full-height log viewer with monospace text
- SSE streaming for active jobs (live tail)
- Search within logs (Ctrl+F style, with regex support)
- Filter by log level (info/warn/error)
- Auto-scroll toggle (on by default for active, off for completed)
- Line numbers, timestamps, copy selection
- Download raw log button

**Result**
- Rendered result output
- Exit code, duration
- Cost receipt summary
- Links to any artifacts

**Cost**
- Receipt breakdown (tokens in/out, model, duration)
- Cost comparison across attempts if multiple

### Actions (contextual)

| Phase | Available Actions |
|-------|-------------------|
| ready | Claim, Edit, Cancel |
| active | Follow (live logs) |
| review | Approve, Reject, View PR |
| done | View Result, Re-run |

---

## Log Viewer

The log viewer is a first-class component, not an afterthought. Engineers spend real time in logs.

### Features

- **Live streaming**: SSE connection for active jobs. New lines appear at the bottom with a subtle highlight flash.
- **Search**: Inline search bar (Ctrl+K or `/`). Highlights all matches, up/down to navigate between them. Supports regex.
- **Filtering**: Toggle buttons for log levels. Hide/show lifecycle events (heartbeats, phase transitions).
- **Timestamps**: Relative by default ("2s ago"), click to toggle absolute.
- **Word wrap**: Toggle on/off.
- **ANSI color support**: Render terminal colors from harness output.
- **Large log handling**: Virtualized scrolling. Only render visible lines. Lazy-load earlier lines on scroll-up.
- **Copy**: Click a line to copy it. Select range to copy block. "Copy all" button.
- **Download**: Download full log as `.log` file.

### Log Search Across Jobs

A top-level search capability:
- Search logs across all jobs in a project
- Filter by time range, harness, phase
- Results show matching lines with job context
- Click to open the job's log viewer at that line

API: use `GET /jobs/{id}/attempts/{n}/logs?after=0` for completed jobs and SSE for active attempts (`GET /jobs/{id}/stream` or `GET /jobs/{id}/attempts/{n}/stream`).

---

## Environments View

### User Mode

```
┌─ test ─────────────────────────────────────────────┐
│  Status: ● deployed    Release: v0.3.12            │
│  Services:  web ● 2/2   api ● 3/3   worker ● 1/1  │
│  URL: https://web.myapp-test.lvh.me                │
│  Last deploy: 12 minutes ago                       │
│                                           [Deploy] │
└────────────────────────────────────────────────────┘
```

Compact cards per environment. Health dots per service. Click to expand and see pod-level detail, recent events, and deploy history.

### Admin Mode

Table view of all environments across all projects in the active org by default. `system_admin` can optionally widen that to platform scope.

| Project | Env | Status | Services | Release | Last Deploy |
|---------|-----|--------|----------|---------|-------------|
| eden | staging | ● healthy | 3/3 | v1.2.0 | 2h ago |
| ingest | test | ● degraded | 2/3 | v0.8.1 | 45m ago |

Sort by status (degraded first), project, or recency.

---

## Spending View

### User Mode — Project Cost

- Total spend for selected time window (7d default)
- Daily cost chart (bar chart)
- Breakdown by agent/harness
- Top 10 most expensive jobs
- Cost per attempt comparison for expensive jobs

### Admin Mode — Org / Platform Cost

- Total platform spend
- Per-project breakdown (bar chart, table)
- Per-agent breakdown
- Budget status per org (if budgets configured)
- Trend line (is spend increasing/decreasing?)

**API sources and rendering notes**:
- Total spend: `GET /orgs/:id/spend?since=<window_start>` → `summary.base_total_usd` (string — parse as float for display)
- Agent breakdown: `GET /orgs/:id/analytics/cost-by-agent?window=7d` → array of `{ agent, cost, attempts, tokens_in, tokens_out }`
- Project breakdown (admin): `GET /projects/:id/spend?since=<window_start>` per project, or use the `by_project` breakdown from jobs/stats
- Top jobs: not currently available as a dedicated endpoint — derive from job list with cost fields, or add `GET /orgs/:id/analytics/top-jobs-by-cost?window=7d` (nice-to-have)
- Budget status: derived UX until a first-class budget endpoint exists (budgets can be read from org settings but alerts require client-side threshold comparison)

> **Cost values are strings**: The spend API returns decimal strings (`"12.40"`) not numbers. Always use `parseFloat()` and format with `toFixed(2)` for display. The `billed_currency` field should be shown alongside totals.

---

## System View (Admin Only)

### Services Panel

Live status of platform services. Data from `/system/status`, `/system/pods`, and `/system/env-health`.

```
┌─ Services ──────────────────────────────────────────┐
│  api            ● running   3/3 pods   12ms p50     │
│  orchestrator   ● running   1/1 pods   —            │
│  worker         ● running   2/2 pods   —            │
│  agent-runtime  ● warning   2/3 pods   1 restart    │
│  gateway        ● running   1/1 pods   8ms p50      │
│  sso            ● running   1/1 pods   15ms p50     │
│  postgres       ● running   1/1 pods   —            │
└─────────────────────────────────────────────────────┘
```

Click a service to see:
- Pod list with status, age, restarts
- Recent events (from `/system/events`)
- Log tail (from `/system/logs/:service`)

### Users Panel

List of all users, their orgs, roles. From `/system/users`. This panel is `system_admin` only.

### Settings Panel

System settings viewer/editor. From `/system/settings`. This panel is `system_admin` only.

### Scope Rules

- **Org admins** can use `/system/status`, `/system/pods`, `/system/events`, `/system/logs/:service`, and `/system/envs`, but results are RBAC-filtered to their org where applicable.
- **Platform admins** (`user.isAdmin`) get full cluster visibility plus `/system/users` and `/system/settings`.
- The UI should hide routes and nav items the current token cannot use; do not rely on 403 handling as the primary UX.

---

## Authentication

### SSO Login Flow

Uses the existing SSO broker + `@eve-horizon/auth-react` SDK. SSO is the default path; token paste remains a fallback because the shared login form already supports it.

```
1. User visits dashboard URL
2. EveAuthProvider checks sessionStorage for `eve_access_token`
3. If cached token exists and not expired (client-side JWT decode), validate it with /auth/me
4. If no valid cached token, fetch /auth/config and probe {sso_url}/session with cookies
5. If SSO session exists, cache a fresh Eve RS256 access token in sessionStorage
6. If not authenticated, EveLoginGate renders the shared login form (EveLoginForm)
7. Login form defaults to SSO redirect and can fall back to token paste
8. Logout clears sessionStorage token and best-effort POSTs to {sso_url}/logout
```

Active org selection is persisted separately in `localStorage` under `eve_active_org_id`, so it survives tab closes while the auth token does not.

The auth-react SDK handles all of this. The dashboard wraps the app in `<EveAuthProvider>` and uses `useEveAuth()` plus the shared client helpers.

### Org Switcher Data Flow

The org switcher needs display names, but the auth SDK only provides `{ id, role }` per membership. Here's the data flow:

```
1. EveAuthProvider bootstraps → useEveAuth() returns orgs: [{ id, role }]
2. Dashboard fetches org names:
   - For each org in memberships, call GET /orgs/:id (returns name, slug, etc.)
   - Cache in React Query with staleTime: Infinity (org names don't change often)
   - Or: fix /auth/me memberships to include name/slug (see API Gaps — preferred)
3. Org switcher dropdown renders: org name + role badge
4. On org switch:
   - switchOrg(orgId) updates context
   - localStorage persists eve_active_org_id
   - All React Query caches with org-scoped keys are invalidated
   - Active project resets to "all projects" (no stale project from previous org)
```

**Project switcher** (within an org):
```
GET /orgs/:id/projects → returns [{ id, name, slug, repo_url }]
```
Rendered as a dropdown in the top bar. Switching project scopes the board, overview, and detail views. "All projects" is the default for org admins; regular members default to their first accessible project.

### Role-Based UI

| Condition | Sees |
|-----------|------|
| `activeOrg.role === 'member'` | Accessible projects in the active org, no admin sections |
| `activeOrg.role === 'admin' \|\| 'owner'` | All projects in the active org, org-wide board/overview/spend, no system users/settings |
| `user.isAdmin === true` | Everything, including platform system pages and platform scope toggle |

The `useEveAuth()` hook provides `user`, `orgs`, `activeOrg`, and `switchOrg()`. The UI should use:
- `user.isAdmin` for platform-only sections (requires SDK fix — see API Gaps table)
- `activeOrg?.role === 'admin' || activeOrg?.role === 'owner'` for org-admin sections
- `project_role` resolution via `X-Eve-Project-Id` only when a route needs project-scoped controls

> **SDK gap**: Today `EveUser.role` is typed as `'owner' | 'admin' | 'member'` and the provider doesn't surface the `is_admin` boolean from `/auth/me`. `EveAuthOrg` only has `{ id, role }` — no `name` or `slug`. Both must be fixed before Phase 1 can ship — see API Gaps table.

---

## Technical Architecture

### Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | React 18 + Vite | Fast builds, proven ecosystem, auth-react SDK is React |
| Styling | Tailwind CSS + CSS variables | Fast iteration without locking the design into generic defaults |
| State | TanStack Query (React Query) | Caching, polling, background refetch — perfect for dashboard |
| Routing | React Router 7 | Standard, lightweight |
| Charts | Recharts or Nivo | Lightweight, React-native charting |
| Log viewer | Custom (virtualized) | No existing library handles SSE + search + ANSI well enough |
| Icons | Lucide React | Clean, consistent, MIT |

### Deployment Model

**Platform-integrated service**, not a separate app:

```
apps/dashboard/          ← New app in the Eve Horizon monorepo
  src/
    components/          ← Shared UI components
    pages/               ← Route-level pages
    hooks/               ← Data fetching hooks (React Query)
    lib/                 ← API client, SSE helpers
  public/
  vite.config.ts
```

Deployed as part of the Eve platform (not as an eve-deployed app). The dashboard service:
- Serves the built SPA (static files)
- Exposes a same-origin `/api` proxy to the Eve API (avoids CORS and keeps auth/client setup simple)
- Uses the same K8s namespace as other Eve services

Ingress: `http://dashboard.eve.lvh.me` (local), `https://dashboard.eve.example.com` (staging)

### API Communication

```
Browser → Dashboard (BFF proxy) → Eve API
                ↓
         SSE connections (same-origin proxy or direct API when needed)
```

- All REST calls should go through the same-origin `/api` proxy
- SSE can be proxied the same way; if the browser connects directly, use the existing token query-param support deliberately and sparingly
- React Query handles polling intervals per query type:

| Data | Poll Interval | Notes |
|------|---------------|-------|
| Job list (board) | 3s | Core real-time feel |
| Analytics summary | 30s | Doesn't change fast |
| Environment health | 10s | Important but slower-changing |
| System status | 10s | Admin mode |
| Active job logs | SSE (real-time) | No polling, event stream |
| Cost data | 60s | Slow-changing |

### Data Flow for Kanban

```
1. React Query: GET /projects/{id}/jobs?limit=200
2. Client groups jobs by phase into columns
3. On poll: diff new data against current, animate transitions
4. Done column: only fetch last 20 by default, "load more" for history
5. Optimistic updates: on user action (approve/reject), move card immediately,
   revert if API call fails
```

For admin mode cross-project board (org-queries use `status` param, cursor pagination):
```
GET /orgs/{org_id}/jobs?status=ready&limit=100
GET /orgs/{org_id}/jobs?status=active&limit=100
GET /orgs/{org_id}/jobs?status=review&limit=100
```

For `system_admin` platform-wide board (jobs endpoint uses `phase` param, offset pagination):
```
GET /jobs?phase=ready&limit=100
GET /jobs?phase=active&limit=100
GET /jobs?phase=review&limit=100
```

> **Implementation note**: Org-scoped jobs (`/orgs/:id/jobs`) use `?status=` with cursor-based pagination (`?cursor=`). Project-scoped and platform-wide jobs (`/projects/:id/jobs`, `/jobs`) use `?phase=` with offset-based pagination (`?offset=`). The data-fetching hooks must abstract this difference so board components don't care which endpoint backs them.

### Job Card Field Mapping

The three job endpoints return slightly different shapes. Here's how each maps to the card UI:

**Project-scoped** (`GET /projects/:id/jobs`) — full job object:
```
Card title     ← job.title
Priority badge ← job.priority (0-4)
Harness label  ← job.harness (string, e.g. "mclaude")
Duration       ← computed from job.started_at (only when phase=active)
Column         ← job.phase
Assignee       ← job.assignee
Parent link    ← job.parent_id
```

**Org-scoped** (`GET /orgs/:id/jobs`) — lightweight item:
```
Card title     ← item.title
Priority badge ← item.priority
Harness label  ← NOT returned — omit or fetch lazily on card click
Duration       ← NOT returned — omit on org board
Column         ← item.phase
Project badge  ← item.project_name + item.project_slug
Assignee       ← item.assignee
```

> **UX consequence**: The org board cards are simpler than project board cards — no harness badge, no live duration. This is acceptable: the org board is for scanning across projects, not inspecting individual jobs. Clicking a card opens the detail panel which fetches the full job via `GET /jobs/:id`.

**Stat counters** (cheap, no full job fetch):
```
GET /orgs/:id/jobs/stats → { total, by_phase: { ready: N, active: N, review: N, done: N }, by_project: [...] }
```
Use this for the board column header counts and the overview stat cards. Poll every 3s alongside the job list.

---

## Design Language

### Principles

1. **Dense but breathable**: Pack information in, but use consistent spacing and alignment to keep it scannable. No card for the sake of a card.

2. **Monochrome with purposeful color**: Base UI is neutral grays on white (light) or dark gray on near-black (dark). Color is reserved for status (green/amber/red), priority badges, and interactive elements.

3. **Typography-driven hierarchy**: Use font weight and size to create hierarchy, not color or decoration. Headings in 500 weight, data in 400, labels in 300.

4. **Motion is information**: Animate only when it communicates state change — a card sliding between columns, a counter incrementing, a log line appearing. No decorative animation.

5. **Light and dark as peers**: The dashboard should feel intentional in both themes. Do not let one theme become the neglected fallback.

### Color System

```
Background:     #0a0a0a (dark) / #fafafa (light)
Surface:        #141414 (dark) / #ffffff (light)
Surface raised: #1a1a1a (dark) / #f5f5f5 (light)
Border:         #262626 (dark) / #e5e5e5 (light)
Text primary:   #fafafa (dark) / #0a0a0a (light)
Text secondary: #a1a1a1 (dark) / #737373 (light)
Text muted:     #525252 (dark) / #a3a3a3 (light)

Accent (interactive): #3b82f6 (blue-500)
Success:              #22c55e (green-500)
Warning:              #f59e0b (amber-500)
Error:                #ef4444 (red-500)

Priority badges:
  P0: red-500 bg
  P1: amber-500 bg
  P2: blue-500 bg (default)
  P3: gray-500 bg
  P4: gray-700 bg
```

### Typography

```
Font:       IBM Plex Sans (headings + body) / JetBrains Mono (logs, code, IDs)
Sizes:      12px (labels) / 13px (body) / 14px (emphasis) / 18px (section) / 24px (page)
Weights:    300 (muted) / 400 (body) / 500 (headings) / 600 (stat numbers)
Line-height: 1.5 (body) / 1.2 (headings) / 1.6 (logs)
```

### Component Patterns

**Stat Card**: Large number (24px, 600 weight), small label beneath (12px, muted). Optional sparkline. No border — uses background differentiation.

**Job Card**:
```
┌─────────────────────┐
│ feat: add user sync │  ← Title (13px, 500, truncated)
│ P2 · zai · ●3m     │  ← Priority badge + harness + duration
└─────────────────────┘
```
Minimal chrome. Priority is a small colored dot or pill, not a large badge. Harness shown as a short monospace label. Duration only on active jobs.

**Activity item**: Dot + text + relative time. Dot color matches the event type. Compact — fits 8-10 items without scrolling.

**Health indicator**: Small filled circle (8px). Green = healthy, amber = degraded, red = down. No text label needed for the dot itself — the label is the service/env name next to it.

---

## Project Anatomy View

The Project page is a comprehensive visual anatomy of a project — its services, agents, pipelines, integrations, and infrastructure. Accessed via the **Project** nav item in the sidebar. The page uses a tab bar to organize sub-views.

> **Prototype**: See `docs/plans/eve-dashboard-prototype.html` for a live interactive prototype of this section.

### Tab Bar

```
Architecture | Agents (5) | Pipelines (3) | Workflows | Integrations | Releases | Schedules | Members
```

Active tab has a blue underline indicator. Badges show counts for agents and pipelines.

> **Note**: The prototype HTML doesn't include a Schedules tab yet — add it when implementing Phase 8.

---

### Architecture Tab (Hero Feature)

A **live topology diagram** showing the deployed infrastructure for the selected environment. This is the default tab and the centerpiece of the Project page.

```
┌─ Stat Pills ────────────────────────────────────────────────────┐
│  6 Services   5 Healthy   1 Degraded   2 Databases   3 Agents  │
└─────────────────────────────────────────────────────────────────┘

┌─ Topology Canvas (SVG) ────────────────────────────── [+][-][↺]─┐
│                                                                   │
│  INGRESS        ┌────────────────────┐                           │
│                 │ ● Ingress          │                           │
│                 │   *.eden-stg.lvh.me│                           │
│                 └────────┬───────────┘                           │
│                    ┌─────┼─────┐                                 │
│  SERVICES    ┌─────┴──┐ ┌┴────┴──┐ ┌──────────┐                │
│              │ ● web  │ │ ● api  │ │ ● gateway│   AGENTS       │
│              │ 2/2    │ │ 3/3    │ │ 1/2 ▲    │   ┌──────────┐│
│              └────────┘ └───┬────┘ └──────────┘   │◆ ingest  ││
│                       ┌─────┼─────┐               │  claude   ││
│  PLATFORM    ┌────────┴──┐ ┌┴────────┐            ├──────────┤│
│              │ ● orchestr│ │ ● worker│            │◆ review  ││
│              │ 1/1       │ │ 2/2     │            │  zai     ││
│              └────┬──────┘ └──┬──────┘            ├──────────┤│
│                   │           │                    │◆ deploy  ││
│  DATA        ┌────┴────┐ ┌───┴────┐              │  cold    ││
│              │ ◆ Postgres│ │ ◆ Redis│              └──────────┘│
│              │ db-medium │ │ cache  │                          │
│              └──────────┘ └────────┘                          │
│                                                                   │
│  ┌─ Node Detail Panel (slides up on click) ──────────────────┐  │
│  │ ● gateway     PODS                  CPU  35m/250m (14%)   │  │
│  │ Service·NestJS  ● gateway-a2e1-k8mn  MEM  128Mi/256Mi     │  │
│  │ 1/2 running     ● gateway-..p3qr ▲  UP   1h 22m          │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Node types and visual encoding**:

| Node Type | Left Border | Health Dot | Details |
|-----------|------------|------------|---------|
| Ingress | Green | Green/Red | URL, TLS status |
| Service | Blue | Green/Amber/Red | Name, replica count, framework |
| Database | Cyan | Green/Red | Type, class (db-medium, cache) |
| Agent | Purple (dashed border) | Green (warm) / Gray (cold) | Name, harness, status |

**Interactions**:
- **Hover a node** → Connected nodes and edges stay visible; everything else dims to 20% opacity. Connected edges glow slightly.
- **Click a node** → Detail panel slides up from the bottom showing: type, replicas, pod list (with per-pod health), URLs, CPU/memory, uptime.
- **Animated data flow** → Small blue particles travel along edge paths using SVG `<animateMotion>`, showing traffic direction. 2-3 particles per edge with staggered timing.
- **Health pulses** → Green health dots have a subtle expanding ring animation. Amber dots pulse faster.
- **Environment selector** → Top bar env dropdown switches topology data to show a different environment's infrastructure.

**API data sources**:
- Services: `GET /projects/:id/envs/:name/health` (returns `status`, `deployment.available_replicas`, `deployment.desired_replicas`, `warnings`) + `GET /projects/:id/envs/:name/diagnose` (full diagnostic)
- Databases: `GET /projects/:id/envs/:name/db/managed` (returns managed DB status, class, storage)
- Agents: `GET /projects/:id/agents` (config list: slug, name, description, harness) + `GET /orgs/:id/agent-runtime/status` (pod list: pod_name, status, active_jobs, last_heartbeat)
- Ingress: derived from environment URL pattern (`{component}.{orgSlug}-{projectSlug}-{env}.lvh.me`)

**Data joining for topology nodes**:
```
Services  → /envs/:name/health gives replicas + status per component
Agents    → /projects/:id/agents gives config, /agent-runtime/status gives pods
            Join by: pod_name contains agent slug (e.g. ar-triage-w1 → question-triage)
            Agent with no matching running pod → "cold"
Databases → /envs/:name/db/managed (if no managed DB, omit the data layer)
Ingress   → Always present for deployed envs; URL is deterministic
```

**Implementation**: SVG-based rendering within the React app. Use `@xyflow/react` (React Flow) for the production implementation — it handles pan/zoom, node positioning, and edge routing. The prototype uses raw SVG to demonstrate the visual design.

**Polling**: Environment health polls every 10s. Agent status every 15s. Node detail refreshes on-demand when clicked.

---

### Agents Tab

A grid of agent cards with chat initiation capability, plus a recent threads feed.

```
┌─ Agent Cards Grid ──────────────────────────────────────────────┐
│ ┌────────────────────┐ ┌────────────────────┐ ┌──────────────┐ │
│ │ ◆ Ingest Agent     │ │ ◆ Review Agent     │ │ ◆ Deploy Bot │ │
│ │ claude · ● warm    │ │ zai · ● warm       │ │ code · ● cold│ │
│ │                    │ │                    │ │              │ │
│ │ Document processing│ │ Code review auto-  │ │ Deployment   │ │
│ │ and knowledge      │ │ mation. Analyzes   │ │ orchestration│ │
│ │ extraction...      │ │ PRs for...         │ │ and env...   │ │
│ │                    │ │                    │ │              │ │
│ │ 3 threads [Chat →] │ │ 1 thread  [Chat →] │ │ 0 thr [Chat]│ │
│ └────────────────────┘ └────────────────────┘ └──────────────┘ │
└─────────────────────────────────────────────────────────────────┘

┌─ Recent Threads ────────────────────────────────────────────────┐
│ ◆ Ingest Agent — PDF batch processing          4m ago    ●     │
│ ◆ Review Agent — PR #284 auth refactor        18m ago          │
│ ◆ QA Agent — Regression suite run #42          1h ago          │
└─────────────────────────────────────────────────────────────────┘
```

**Agent card features**:
- Purple left border accent (agent visual identity)
- Harness badge in monospace (claude/zai/code/gemini)
- Status: warm (green dot) or cold (gray dot)
- Description (2-3 lines, truncated)
- Active thread count
- **Chat button** — opens the chat slide-over panel

**API sources**: `GET /projects/:id/agents` for agent list. `GET /projects/:id/threads` for recent threads.

---

### Chat Slide-Over Panel

Opens from the right (540px width) with a backdrop overlay. Enables direct conversation with any agent.

```
┌─ Chat Panel ──────────────────────────────────────┐
│ ◆ Ingest Agent                               [×] │
│ claude · ● warm · eden/staging                    │
├───────────────────────────────────────────────────┤
│                                                   │
│ ◆ Hello! I'm the Ingest Agent. I handle           │
│   document processing and knowledge extraction.   │
│                                                   │
│                    What's the status of the   AC  │
│                    latest batch run?               │
│                                                   │
│ ◆ The latest batch run processed **247 docs**     │
│   with a **98.8% success rate**:                  │
│                                                   │
│   ┌─ code block ───────────────────────────┐      │
│   │ Processed: 247 total                   │      │
│   │   Success: 244 (98.8%)                 │      │
│   │   Failed:    3 (1.2%)                  │      │
│   └────────────────────────────────────────┘      │
│                                                   │
│   Want me to retry the failed documents?▌         │
│                                                   │
├───────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────┐ ┌──────┐ │
│ │ Message Ingest Agent...             │ │  ▶   │ │
│ └─────────────────────────────────────┘ └──────┘ │
└───────────────────────────────────────────────────┘
```

**Features**:
- Agent identity header (name, harness, status, environment)
- Message thread with user/agent visual distinction (user = blue, agent = dark surface)
- **Streaming response** with blinking cursor (typewriter effect via character-by-character rendering)
- Code block rendering with monospace font and dark background
- Enter to send, Shift+Enter for newline
- Escape to close

**API sources**:
- Create thread: `POST /projects/:id/chat/route` (routes to the agent)
- List messages: `GET /threads/:id/messages`
- Post message: `POST /threads/:id/messages`
- Thread history: `GET /projects/:id/threads`

---

### Pipelines Tab

Pipeline definitions with step visualization and recent run history.

```
┌─ build-deploy ─────────────────────────── on push to main ──────┐
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ (✓) build ── (✓) test ── (✓) release ── (●) deploy ── (—) │  │
│  └──────────────────────────────────────────────────────────┘    │
│  Recent runs                                                     │
│  ● run-a8f2e1  deploying — step 4/5                      2m ago │
│  ● run-7c3d09  completed                                 1h ago │
│  ● run-5e1fa4  completed                                 4h ago │
└──────────────────────────────────────────────────────────────────┘
```

**Step indicators**: ✓ done (green), ● running (blue, pulsing), — pending (gray), ✗ failed (red). Connected by lines that turn green when the step completes.

**API sources**: `GET /projects/:id/pipelines` for definitions. `GET /projects/:id/pipelines/:name/runs` for run history. `GET /pipeline-runs/:id/stream` for live streaming.

---

### Integrations Tab

Connected service cards with status and configuration actions.

**API sources**: `GET /orgs/:org_id/integrations` for the list. Each card shows connection status, channel/webhook configuration, and last activity. Includes an "Add Integration" placeholder card.

---

### Workflows Tab

Workflow cards showing event-driven job orchestration. Each card shows:

```
┌─ question-evolution ─────────────── ⚡ question.answered ──┐
│  [triage] → [evolve (conditional)]                          │
│  Agents: question-triage, question-agent                    │
│  Permissions: yolo · Last triggered: 4m ago · Runs today: 18│
└─────────────────────────────────────────────────────────────┘
```

**Card fields**: Name, trigger event type, step sequence (with conditional indicators), agent names, permission mode, last trigger time, daily run count, timeout.

**API source**: `GET /projects/:id/workflows`. Returns workflow definitions from the project manifest. Each workflow has `name`, `trigger`, `steps[]`, `agents[]`, and `timeout`.

> **UX note**: Workflows don't have a "run history" API today — the card shows `runs_today` from the workflow definition's metadata, not from a separate runs endpoint. A future `GET /projects/:id/workflows/:name/runs` would enable a drill-in view like pipelines have.

---

### Releases Tab

Release history table:

| Tag | Git SHA | Environment | Created By | Date |
|-----|---------|------------|-----------|------|
| `v0.3.12` | `a8f2e1d` | sandbox (active) | admin@example.com | 12m ago |
| `v0.3.11` | `7c3d09b` | superseded | admin@example.com | 2d ago |

**API source**: `GET /projects/:id/releases?limit=20`. Returns `[{ tag, git_sha, env_name, created_by, created_at, status }]`. Active release (currently deployed) gets a green badge; superseded releases get a muted badge. Click a release to see the pipeline run that produced it (if pipeline_run_id is present).

---

### Schedules Tab

Active cron schedules for automated job creation:

| Schedule | Cron | Next Run | Last Run | Status |
|----------|------|----------|----------|--------|
| nightly-sync | `0 2 * * *` (daily at 2am) | in 4h | 20h ago | succeeded |
| weekly-report | `0 9 * * 1` (Mon 9am) | in 3d | 4d ago | succeeded |

**API source**: `GET /projects/:id/schedules?limit=20`. Returns `[{ name, cron, next_run_at, last_run_at, last_run_status }]`. Cron expressions should be rendered with a human-readable translation (use `cronstrue` library). Shows a "Run Now" button for manual triggering.

---

### Members Tab

Project team table:

**API source**: `GET /projects/:id/members`. Returns `[{ user_id, email, display_name, role, last_active_at }]`. Role shown as a colored badge (admin = blue, member = gray). For org admins, show an "Add Member" button and allow role changes inline. Service principals (agents) should be visually distinguished with a bot icon.

---

## Implementation Phases

### Phase 1 — Foundation (1-2 days)

- Create `apps/dashboard` in the monorepo
- Vite + React + Tailwind + React Router setup
- Auth integration with `@eve-horizon/auth-react`
- Same-origin `/api` proxy layer
- K8s deployment manifest + ingress
- Login flow and active-org bootstrap working end-to-end

**Deliverable**: Can log in via SSO, switch active org, and land in a routed app shell.

### Phase 2 — Overview + Navigation (2-3 days)

- App shell (sidebar nav, top bar, project switcher)
- Overview page with stat cards (project + org job counts by phase)
- Recent activity feed from org/project events
- Environment health summary
- Cost sparkline
- Dark/light mode toggle
- React Query setup with polling

**Deliverable**: Landing page shows live project stats, activity, and env health.

### Phase 3 — Job Board (3-4 days)

- Kanban board with ready/active/review/done columns
- Job cards with priority, harness, duration
- Done column collapse/expand behavior
- Filters bar (epic, harness, priority, assignee, search)
- 3-second polling with animated transitions
- Admin cross-project board variant

**Deliverable**: Can watch jobs flow through phases in real time.

### Phase 4 — Job Detail + Logs (3-4 days)

- Slide-over panel with summary/attempts/logs/result tabs
- Log viewer with SSE streaming for active jobs
- Log search (inline, with regex)
- ANSI color rendering
- Virtualized scrolling for large logs
- Attempt list with cost comparison
- Review actions (approve/reject)

**Deliverable**: Can inspect any job, read its logs, approve/reject reviews.

### Phase 5 — Admin Mode (2-3 days)

- Org-admin overview page (org-wide stats, attention panel)
- System-admin platform view (services, pods, health, restarts)
- Cross-project job and environment views
- User management view (`system_admin` only)
- Spending breakdown (per-project, per-agent)
- Admin scope toggle in top bar

**Deliverable**: `org_admin` can operate across an org, and `system_admin` can see platform health at a glance.

### Phase 6 — Project Anatomy: Architecture Topology (3-4 days)

- Project page with tab navigation (Architecture, Agents, Pipelines, Workflows, Integrations, Releases, Members)
- Architecture topology diagram using `@xyflow/react` (React Flow)
- Node types: Service, Database, Ingress, Agent (each with distinct visual encoding)
- Edge rendering with animated data flow particles
- Hover highlighting (dim unconnected nodes/edges)
- Click-to-inspect with slide-up detail panel (pods, CPU, memory, uptime)
- Environment selector in top bar switches topology data
- Health stat pills above the diagram (services count, healthy/degraded/down, databases, agents)

**Deliverable**: Can see a live visual topology of any project environment, hover to trace connections, click to inspect node details.

### Phase 7 — Project Anatomy: Agents + Chat (3-4 days)

- Agent cards grid with harness badge, status indicator, description, thread count
- Chat slide-over panel (540px, backdrop overlay)
- Chat message thread with user/agent visual distinction
- Streaming response rendering (character-by-character with cursor)
- Code block and inline code rendering in chat messages
- Thread history in agents tab (Recent Threads section)
- Chat routing via `POST /projects/:id/chat/route`
- Enter to send, Escape to close

**Deliverable**: Can browse project agents, open a chat with any agent, and have a streaming conversation.

### Phase 8 — Project Anatomy: Pipelines + Integrations + Remaining Tabs (2-3 days)

- Pipeline cards with step visualization (done/running/pending/failed indicators)
- Pipeline run history with status dots and timestamps
- Pipeline log streaming (SSE) on run click
- Integration cards with connection status, configuration, and test buttons
- Workflows, Releases, Schedules, and Members tabs (data display)
- Environment cards with deploy status, service health
- Deploy history and rollback UI

**Deliverable**: Full project anatomy — every dimension of a project visible from one page.

### Phase 9 — Polish (2-3 days)

- Empty states and loading skeletons
- Error boundaries and retry UI
- Keyboard shortcuts (project switcher, search, navigation)
- Responsive layout (works on 1024px+)
- Performance audit (bundle size, render cycles)
- Accessibility pass (focus management, screen reader labels)

**Deliverable**: Production-quality UX.

---

## API Endpoint Reference (Response Shapes)

The dashboard depends on these endpoints. All response schemas live in `packages/shared/src/schemas/`. This section documents the actual response shapes — the implementation must render these fields, not invented ones.

### Core Data: Jobs

**`GET /projects/:id/jobs?phase=active&limit=200`** — full job objects, offset pagination
```typescript
{
  items: [{
    id: string,              // e.g. "eden-a3f2dd12"
    title: string,
    description?: string,
    phase: string,           // ready | active | review | done | cancelled
    priority: number,        // 0-4
    harness?: string,        // mclaude | claude | zai | gemini | code | codex
    assignee?: string,
    reviewer?: string,
    labels: string[],
    parent_id?: string,
    started_at?: string,
    completed_at?: string,
    created_at: string,
    updated_at: string,
    git_branch?: string,
    git_ref?: string,
  }],
  pagination: { limit: number, offset: number, total: number }
}
```

**`GET /orgs/:id/jobs?status=active&limit=100`** — lightweight items, cursor pagination
```typescript
{
  items: [{
    id: string,
    project_id: string,
    project_slug: string,    // for project badge on org board
    project_name: string,
    title: string,
    phase: string,
    priority: number,
    assignee?: string,
    labels: string[],
    created_at: string,
    updated_at: string,
    // NOTE: no harness, no started_at — card is simpler
  }],
  pagination: { limit: number, has_more: boolean, next_cursor?: string }
}
```

**`GET /orgs/:id/jobs/stats`** — cheap counters for stat cards
```typescript
{
  total: number,
  by_phase: { ready: N, active: N, review: N, done: N, cancelled: N },
  by_project: [{ project_id: string, project_name: string, count: number }]
}
```

### Core Data: Events + Activity Feed

**`GET /orgs/:id/events?limit=20`** — for the activity feed
```typescript
{
  items: [{
    id: string,
    project_id: string,
    project_slug: string,
    type: string,            // job.phase_changed, deploy.completed, pipeline.step_completed, etc.
    source: string,
    status: string,
    created_at: string,
    // NOTE: no human-readable description — the dashboard must render
    // activity text from (type + project_slug + status). Build a
    // formatEventDescription(event) helper to map event types to prose.
  }],
  pagination: { limit: number, has_more: boolean, next_cursor?: string }
}
```

> **UX note**: Events do not carry a pre-formatted message. The dashboard must maintain a mapping of `event.type` → human-readable template (e.g. `"job.phase_changed"` → `"Job {source} moved to {status}"`). Unknown event types should render as `"{type} — {source}"` rather than crash.

### Core Data: Analytics + Cost

**`GET /orgs/:id/analytics/summary?window=7d`** — overview stat cards
```typescript
{
  window: string,          // "7d"
  window_start: string,    // ISO timestamp
  window_end: string,
  projects: number,
  jobs: { created: N, completed: N, failed: N, active: N },
  pipelines: { runs: N, success_rate: 0.85, avg_duration_s: N },
  deployments: { total: N, successful: N, rollbacks: N },
  environments: { total: N, healthy: N, degraded: N, unknown: N }
}
```

**`GET /orgs/:id/analytics/cost-by-agent?window=7d`** — spending breakdown
**`GET /orgs/:id/spend?since=2026-03-20T00:00:00Z`** — total spend
```typescript
{
  org_id: string,
  summary: {
    since?: string,
    until?: string,
    base_total_usd: string,    // string, not number — render as currency
    billed_total: string,
    billed_currency: string,
    attempts: number,
  }
}
```

> **Rendering note**: `base_total_usd` and `billed_total` are string-encoded decimals, not numbers. Parse with `parseFloat()` for display and arithmetic. The sparkline on the overview needs daily buckets — this endpoint returns a single aggregate. The dashboard must either call `/spend` with 7 separate `since`/`until` windows or build a daily-breakdown endpoint (see API Gaps).

### Core Data: Environments

**`GET /projects/:id/envs/:name/health`** — per-environment health card
```typescript
{
  project_id: string,
  env_name: string,
  namespace?: string,
  status: 'ready' | 'deploying' | 'degraded' | 'unknown',
  ready: boolean,
  deployment?: {
    ready: boolean,
    available_replicas: number,
    desired_replicas: number,
    conditions: [{ type: string, status: string, message?: string }]
  },
  warnings?: string[],
  checked_at: string,
  k8s_available: boolean,
  active_pipeline_run?: { id: string, pipeline_name: string, status: string }
}
```

Health dot mapping: `ready` → green, `deploying` → blue, `degraded` → amber, `unknown` → gray.

### Core Data: Agents

**`GET /projects/:id/agents`** — agent cards grid
```typescript
{
  project_id: string,
  agents: [{
    id: string,
    slug?: string,
    name?: string,             // display name — falls back to slug
    description?: string,
    harness_profile?: string,  // maps to harness badge (claude, zai, etc.)
    // NOTE: no "warm/cold" status here — that comes from agent-runtime
  }]
}
```

**`GET /orgs/:id/agent-runtime/status`** — warm/cold status for each agent
```typescript
{
  pods: [{
    org_id: string,
    pod_name: string,
    status: string,          // "running", "pending", etc.
    capacity: number,
    last_heartbeat_at: string,
    stale?: boolean,
    active_jobs?: number,
  }]
}
```

> **Join required**: The agents list comes from the project config; the warm/cold status comes from the agent-runtime pod list. The dashboard must join these by matching agent slugs to pod names (pods are named `ar-{agentSlug}-*`). An agent with no matching running pod is "cold".

### Auth Bootstrap

**`GET /auth/me`** — session validation + memberships
```typescript
{
  authenticated: boolean,
  user_id?: string,
  email?: string,
  role?: string,             // "admin", "member", "owner", "system_admin"
  is_admin?: boolean,        // true only for platform system_admin
  memberships?: [{
    org_id: string,
    role: string,            // "owner" | "admin" | "member"
    // NOTE: no name, no slug — must fetch org names separately
  }]
}
```

---

## API Requirements (Gaps to Fill)

Most data is already available. These gaps need filling for a polished dashboard:

| Gap | Description | Priority | Blocks Phase |
|-----|-------------|----------|--------------|
| **Auth SDK: `isAdmin` on EveUser** | `EveUser` type has no `isAdmin` field. The `/auth/me` response returns `is_admin: boolean` but the provider doesn't map it. Fix: add `isAdmin: boolean` to `EveUser` in `packages/auth-react/src/types.ts` and pass through from the API response in `provider.tsx`. | P0 | Phase 1 (role-based UI) |
| **Auth SDK: org names on EveAuthOrg** | `EveAuthOrg` only has `{ id, role }` — no `name` or `slug`. The org switcher needs display names. **Preferred fix**: enrich `/auth/me` memberships to include `org_name` and `org_slug` (small join in `auth.service.ts`). **Alternative**: fetch `GET /orgs/:id` per membership after bootstrap (N+1 calls, cache with React Query). | P0 | Phase 2 (org switcher) |
| **Spend daily buckets** | `GET /orgs/:id/spend` returns a single aggregate. The cost sparkline on the overview needs daily data points. Either add `?bucket=daily` support to the spend endpoint, or add a new `GET /orgs/:id/analytics/cost-history?window=7d&bucket=daily` endpoint. | P1 | Phase 2 (overview sparkline) |
| **Org events: human-readable payload** | Events from `GET /orgs/:id/events` have `type`, `source`, `status` but no message text or structured payload (e.g., job title, env name). The dashboard must maintain a client-side event formatter. Consider adding an `event.payload` JSON field with structured context to avoid brittle string mapping. | P1 | Phase 2 (activity feed) |
| **Platform summary** | `GET /system/summary` — system-admin aggregate across orgs: total jobs, env health, spend, service status in one call. Currently requires 4+ separate calls. | P1 | Phase 5 (`system_admin` landing) |
| **Attention items** | `GET /system/attention` and/or `GET /orgs/:id/attention` — stuck jobs (active >30min), degraded envs, service restarts in one call. Currently requires client-side derivation from multiple endpoints. | P1 | Phase 5 (admin overview) |
| **Org job items: harness field** | `GET /orgs/:id/jobs` returns lightweight items without `harness`. The org board cards can't show the harness badge. Fix: add `harness` to `OrgJobItemSchema` and the underlying query. | P2 | Phase 3 (org board cards) |
| **Org job items: started_at field** | `GET /orgs/:id/jobs` doesn't return `started_at`, so the org board can't show active job duration. Fix: add `started_at` to `OrgJobItemSchema`. | P2 | Phase 3 (org board duration) |
| **Job search** | `GET /jobs/search?q=...` — full-text search across job titles and descriptions. No search endpoint exists today. For Phase 3, the board can use client-side title matching on the fetched job list (works for <500 jobs). Server-side search needed for scale. | P2 | Phase 3 (board search) |
| **Log search** | `GET /jobs/:id/logs/search?q=...` — search within a job's logs server-side. Today log search must be client-side (fetch all lines, search in JS). Works for <10K lines; server-side needed for large logs. | P2 | Phase 4 (log viewer) |
| **Cross-job log search** | `GET /projects/:id/logs/search?q=...` — search logs across all jobs in a project. Power feature for debugging. | P3 | Phase 4 (power feature) |

> **Note**: Pipeline analytics (`GET /orgs/:org_id/analytics/pipelines`) already exists. Managed DB info (`GET /projects/:id/envs/:name/db/managed`) already exists. Both were listed as gaps in earlier drafts but are implemented.

**Implementation priority**: Fix the two P0 auth SDK gaps first — they block the entire dashboard. The P1 gaps (daily spend buckets, event payload, platform summary, attention) should be addressed during or before the phase they block. P2-P3 gaps can ship with client-side workarounds initially.

---

## Open Questions

1. **Separate repo or monorepo?** This plan assumes monorepo (`apps/dashboard`). Alternative: new repo via `eve init` for dogfooding. Monorepo is simpler for platform integration and avoids CORS entirely.

2. **Server-side rendering?** This plan assumes SPA. SSR adds complexity but improves initial load. Probably not worth it for a dashboard — users are authenticated, there's no SEO need.

3. **Notification system?** The "attention" panel is passive (poll-based). A future version could add browser notifications for critical events (job failure, env degraded). Not in scope for v1.

---

## Success Criteria

- A developer can log in, see their project's jobs, and read logs — all without touching the CLI
- An `org_admin` can tell within 10 seconds if their org needs attention
- A `system_admin` can tell within 10 seconds if the platform is healthy or needs attention
- The board updates visibly within 5 seconds of a job phase change
- Log viewer handles 10,000+ line logs without jank
- The UI feels fast, sharp, and professional — not like a generic admin template
- Role boundaries are obvious in the UI and match backend permissions without surprise 403s

---

## Test Plan

Testing is layered: unit tests validate component logic in isolation, integration tests verify API contracts the dashboard depends on, and Playwright e2e tests exercise the full stack against a live k3d deployment. Each implementation phase has a corresponding verification gate — the phase is not done until its Playwright tests pass.

### Unit Tests

**Where**: `apps/dashboard/src/**/*.test.tsx`

**Framework**: Vitest + React Testing Library (same toolchain as the rest of the monorepo).

#### Auth & Bootstrap

| Test | What it verifies |
|------|-----------------|
| **EveAuthProvider renders children when authenticated** | Mock `useEveAuth()` returns valid user → children render, no login gate |
| **EveLoginGate shows login form when unauthenticated** | Mock returns `user: null` → `EveLoginForm` renders |
| **EveLoginGate shows loading fallback** | Mock returns `loading: true` → loading skeleton renders |
| **Org switcher updates active org** | `switchOrg(orgId)` called → React Query cache invalidated, new org selected |
| **Admin mode toggle visible for org_admin** | User with `activeOrg.role === 'admin'` → toggle renders |
| **Admin mode toggle hidden for member** | User with `activeOrg.role === 'member'` → toggle absent |
| **System nav items hidden for org_admin** | `user.isAdmin !== true` → System/Users/Settings nav items absent |
| **System nav items visible for system_admin** | `user.isAdmin === true` → all nav items present |

#### Data Hooks

| Test | What it verifies |
|------|-----------------|
| **useJobsByPhase groups correctly** | Given mixed-phase job array → returns `{ ready: [...], active: [...], review: [...], done: [...] }` |
| **useJobsByPhase handles empty response** | API returns `[]` → all columns empty, no error |
| **useOrgJobs normalizes status→phase** | Org endpoint `status` field mapped to standard `phase` enum |
| **useOrgJobs handles cursor pagination** | First page returns `cursor` → hook automatically fetches next page |
| **useProjectJobs handles offset pagination** | First page at `offset=0` → increments offset for next fetch |
| **useJobStats returns stat card data** | `/orgs/:id/jobs/stats` response → `{ active: N, review: N, done: N, failed: N }` |
| **useAnalyticsSummary respects window param** | `window=7d` → query key includes window, refetch on change |
| **useEnvHealth maps status to health indicator** | `healthy` → green, `degraded` → amber, `critical`/`failed` → red |
| **useSystemStatus returns service list** | `/system/status` response → array of `{ name, status, pods, restarts }` |
| **SSE hook connects on mount, disconnects on unmount** | Mock EventSource → `onmessage` fires, cleanup closes connection |
| **SSE hook reconnects on error** | EventSource `onerror` → reconnect with backoff |

#### Components

| Test | What it verifies |
|------|-----------------|
| **StatCard renders number and label** | `value=42, label="active"` → renders "42" in 24px/600 weight, "active" in 12px/muted |
| **StatCard error accent** | `accent="error"` → red color applied |
| **JobCard shows title truncated** | Title > 30 chars → truncated with ellipsis |
| **JobCard shows duration on active** | `phase="active", startedAt=2m ago` → shows "●2m" |
| **JobCard hides duration on ready** | `phase="ready"` → no duration indicator |
| **JobCard priority badge color** | P0=red, P1=amber, P2=blue, P3=gray, P4=dark-gray |
| **DoneColumn collapsed by default** | Renders count badge, shows only 2-3 recent items |
| **DoneColumn expands on click** | Click count badge → full scrollable list |
| **ActivityFeed renders items in time order** | Given unsorted items → renders newest first |
| **ActivityFeed item click navigates** | Click item → router navigates to job detail |
| **HealthDot renders correct color** | `status="healthy"` → green, `"degraded"` → amber, `"critical"` → red |
| **LogViewer auto-scrolls when active** | `autoScroll=true` → scrolls to bottom on new lines |
| **LogViewer stops auto-scroll on manual scroll-up** | User scrolls up → auto-scroll disengages |
| **LogViewer search highlights matches** | Search "error" → all occurrences highlighted |
| **LogViewer ANSI rendering** | Input with ANSI codes → correct color spans |
| **SlideOver opens on card click** | Click job card → panel slides in from right |
| **SlideOver shows correct tab** | Default tab = Summary, click Logs → logs tab active |
| **Dark/light theme toggle** | Toggle click → CSS variables switch, persisted to localStorage |

### Integration Tests

**Where**: `apps/api/test/integration/dashboard-api.integration.test.ts`

**Prerequisite**: Running stack (`./bin/eh test integration`) with test data seeded.

These tests verify the API contracts the dashboard depends on. They run against the live API with a real database — no mocks.

| Test | Endpoint | What it verifies |
|------|----------|-----------------|
| **Auth config returns SSO URL** | `GET /auth/config` | Response contains `supabase_url`, `anon_key`, `sso_url` (all non-null on k3d) |
| **Auth me with valid token** | `GET /auth/me` | Returns `authenticated: true`, `user_id`, `memberships` array |
| **Auth me without token** | `GET /auth/me` | Returns `authenticated: false`, no error |
| **Org jobs list** | `GET /orgs/:id/jobs` | Returns array, supports `?status=active`, cursor pagination |
| **Org jobs stats** | `GET /orgs/:id/jobs/stats` | Returns phase counts, project breakdown |
| **Org events** | `GET /orgs/:id/events` | Returns event list with `type`, `created_at`, cursor pagination |
| **Analytics summary** | `GET /orgs/:id/analytics/summary` | Returns job counts, cost totals for `?window=7d` |
| **Analytics env-health** | `GET /orgs/:id/analytics/env-health` | Returns per-env health status |
| **Analytics cost-by-agent** | `GET /orgs/:id/analytics/cost-by-agent` | Returns agent cost breakdown |
| **Org spend** | `GET /orgs/:id/spend` | Returns spend data with `?since=` ISO timestamp |
| **Project jobs with phase filter** | `GET /projects/:id/jobs?phase=active` | Returns only active jobs, offset pagination |
| **Project envs list** | `GET /projects/:id/envs` | Returns environment array with name-based keys |
| **Job detail** | `GET /jobs/:id` | Returns full job with attempts, metadata |
| **Job logs** | `GET /jobs/:id/attempts/1/logs?after=0` | Returns log lines with sequence numbers |
| **Job SSE stream** | `GET /jobs/:id/stream` | SSE connection established, `Content-Type: text/event-stream` |
| **System status** | `GET /system/status` | Returns service health (requires admin token) |
| **System pods** | `GET /system/pods` | Returns pod list (requires admin token) |
| **System events** | `GET /system/events` | Returns K8s event list (requires admin token) |
| **System env-health** | `GET /system/env-health` | Returns aggregated health with `?status=` filter |
| **System users (admin only)** | `GET /system/users` | Returns user list with org memberships |
| **Platform jobs (admin only)** | `GET /jobs?phase=ready` | Returns cross-org job list (requires `jobs:admin`) |
| **RBAC: member cannot access system** | `GET /system/users` with member token | Returns 403 |
| **RBAC: org_admin cannot access system users** | `GET /system/users` with org_admin token | Returns 403 |

### Playwright E2E Tests

**Where**: `apps/dashboard/e2e/`

**Framework**: Playwright (new addition to the monorepo). Tests run against the dashboard deployed to k3d at `http://dashboard.eve.lvh.me`, backed by the live Eve API at `http://api.eve.lvh.me`.

**Config**: `apps/dashboard/playwright.config.ts`

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  baseURL: 'http://dashboard.eve.lvh.me',
  timeout: 30_000,
  retries: 1,
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
```

**Auth fixture**: Tests that need an authenticated session use a shared auth fixture that obtains an Eve token via SSH challenge (same as CLI login), then injects it into `sessionStorage` before page load. This avoids depending on the GoTrue UI for every test.

```typescript
// e2e/fixtures/auth.ts
import { test as base, type Page } from '@playwright/test';

type AuthFixtures = {
  authedPage: Page;        // system_admin session
  memberPage: Page;        // org member session (no admin)
};

export const test = base.extend<AuthFixtures>({
  authedPage: async ({ browser }, use) => {
    const token = await getEveToken('admin@example.com');
    // The auth-react SDK stores the token in sessionStorage under 'eve_access_token'.
    // Playwright's storageState only supports localStorage, so we inject via
    // page.evaluate after creation.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('http://dashboard.eve.lvh.me');
    await page.evaluate((t) => sessionStorage.setItem('eve_access_token', t), token);
    await page.reload();
    await use(page);
    await context.close();
  },
  // memberPage: similar, with a non-admin user
});
```

#### Phase 1 Tests — Foundation

| Test | Steps | Assertions |
|------|-------|------------|
| **Login page renders** | Navigate to `/` unauthenticated | Login form visible, SSO button present |
| **SSO redirect works** | Click SSO button | Redirects to `sso.eve.lvh.me` |
| **Token login works** | Paste valid Eve token in token input, submit | Redirects to dashboard, user avatar visible in top bar |
| **Authenticated redirect** | Navigate to `/` with valid token in storage | Skips login, lands on overview |
| **Logout clears session** | Click user menu → Logout | Returns to login page, token cleared from storage |
| **API proxy works** | Authenticated, inspect network | All `/api/*` requests resolve (no CORS errors, no 502) |
| **Org switcher shows orgs** | Click org switcher in top bar | Dropdown lists user's orgs |
| **Org switch updates context** | Select different org | Page data refreshes, org name in top bar updates |

#### Phase 2 Tests — Overview + Navigation

| Test | Steps | Assertions |
|------|-------|------------|
| **Overview renders stat cards** | Navigate to `/` authenticated | 4 stat cards visible with numeric values |
| **Stat cards show real data** | API has jobs in various phases | Cards show non-zero counts matching API response |
| **Activity feed shows events** | Org has recent events | Activity list shows items with timestamps |
| **Activity item navigates** | Click an activity item | Navigates to relevant detail view |
| **Environment health dots** | Project has environments | Health dots render with correct colors |
| **Cost sparkline renders** | Org has spend data | Sparkline SVG present, non-empty |
| **Navigation works** | Click each nav item | Correct page renders, URL updates |
| **Project switcher filters** | Select a project | Overview data scopes to selected project |
| **Dark mode toggle** | Click theme toggle | Background changes, all text remains readable |
| **Dark mode persists** | Toggle dark, reload page | Dark mode still active |
| **Polling updates data** | Create a job via CLI while page is open | New job appears within 5 seconds |

#### Phase 3 Tests — Job Board

| Test | Steps | Assertions |
|------|-------|------------|
| **Board renders columns** | Navigate to Board page | 4 columns visible: ready, active, review, done |
| **Job cards in correct columns** | Create jobs in different phases via CLI | Cards appear in matching columns |
| **Done column collapsed** | Board has done jobs | Done column shows count badge, not all cards |
| **Done column expands** | Click done column header | Scrollable list of done jobs appears |
| **Card shows priority badge** | Job has P0 priority | Red priority dot/pill visible |
| **Card shows harness** | Job created with `mclaude` harness | "mclaude" label on card |
| **Active card shows duration** | Active job running for 2m | "●2m" indicator on card |
| **Card click opens detail** | Click any job card | Slide-over panel opens from right |
| **Filter by priority** | Select P0 in filter bar | Only P0 jobs visible |
| **Filter by harness** | Select "zai" in filter bar | Only zai jobs visible |
| **Search filter** | Type job title fragment | Only matching jobs visible |
| **Clear filters** | Click clear/reset | All jobs visible again |
| **Live card transition** | Move a job from ready→active via CLI | Card animates from ready to active column |
| **Admin board shows project badges** | Switch to admin mode | Job cards show project name badge |
| **Admin board cross-project** | Admin mode, multiple projects have jobs | Jobs from all projects visible |

#### Phase 4 Tests — Job Detail + Logs

| Test | Steps | Assertions |
|------|-------|------------|
| **Slide-over shows summary** | Click job card | Title, phase, priority, timestamps visible |
| **Slide-over shows attempts** | Job with 2+ attempts | Attempt list with status, duration per attempt |
| **Log viewer renders lines** | Click Logs tab on completed job | Log lines visible with line numbers |
| **Log viewer SSE streaming** | Open Logs tab on active job | New lines appear in real time |
| **Log search highlights** | Type in log search bar | Matching text highlighted, match count shown |
| **Log search navigation** | Press up/down in search | Scrolls to previous/next match |
| **ANSI colors rendered** | Job logs contain ANSI escapes | Colored text rendered (not raw escape codes) |
| **Log auto-scroll active job** | Open active job logs | View stays at bottom as new lines arrive |
| **Log scroll-up disengages auto-scroll** | Scroll up manually | New lines still arrive but view stays at scroll position |
| **Result tab shows output** | Click Result tab on done job | Exit code, duration, cost visible |
| **Cost tab shows receipt** | Click Cost tab | Token counts, model, cost breakdown |
| **Review actions: approve** | Open job in review phase, click Approve | Job moves to done, card transitions on board |
| **Review actions: reject** | Open job in review, click Reject | Job returns to ready (or previous phase) |
| **Close slide-over** | Click outside panel or press Escape | Panel closes, board visible |

#### Phase 5 Tests — Admin Mode

| Test | Steps | Assertions |
|------|-------|------------|
| **Admin toggle visible for org_admin** | Login as org admin | Admin toggle in top bar |
| **Admin toggle hidden for member** | Login as member | No admin toggle |
| **Admin overview shows org stats** | Enable admin mode | Stat cards show org-wide numbers |
| **Attention panel surfaces problems** | Create a stuck job (active >30min) | "Attention Required" panel shows the stuck job |
| **System panel for system_admin** | Login as system_admin, admin mode | Services panel with pod status |
| **System panel hidden for org_admin** | Login as org_admin, admin mode | No system services panel |
| **Spending breakdown** | Admin mode with cost data | Per-project cost table |
| **Platform scope toggle (system_admin)** | Click platform scope | Data switches from org-scoped to platform-wide |

#### Phase 6 Tests — Architecture Topology

| Test | Steps | Assertions |
|------|-------|------------|
| **Topology renders nodes** | Navigate to Project → Architecture tab | SVG nodes for services, databases, agents visible |
| **Node hover highlights connections** | Hover over `api` node | Connected nodes stay bright, others dim to 20% |
| **Node click shows detail panel** | Click `api` node | Detail panel slides up with pods, CPU, memory |
| **Environment selector switches data** | Change environment in top bar | Topology redraws with different env's infrastructure |
| **Agent nodes show warm/cold** | Agents tab data loaded | Warm agents have green dot, cold have gray |

#### Phase 7 Tests — Agents + Chat

| Test | Steps | Assertions |
|------|-------|------------|
| **Agent cards grid renders** | Navigate to Project → Agents tab | Agent cards with name, harness, status visible |
| **Chat panel opens** | Click "Chat" button on agent card | Slide-over panel appears from right, 540px wide |
| **Chat message sends** | Type message, press Enter | User message appears, agent response streams in |
| **Chat streaming cursor** | Agent is responding | Blinking cursor visible during streaming |
| **Chat panel closes on Escape** | Press Escape while chat is open | Panel closes, board visible underneath |
| **Recent threads list** | Agents tab with active threads | Thread list with agent name, preview, timestamp |

#### Phase 8 Tests — Environments + Pipelines + Remaining Tabs

| Test | Steps | Assertions |
|------|-------|------------|
| **Environment cards render** | Navigate to Environments page | Cards per environment with health dots |
| **Environment detail expands** | Click an environment card | Pod list, events, deploy history visible |
| **Admin env table** | Admin mode, Environments page | Cross-project table, sortable by status |
| **Pipeline runs list** | Navigate to Project → Pipelines tab | Recent runs with step status indicators |
| **Pipeline step visualization** | Pipeline with mixed step states | Done=green, running=blue pulse, pending=gray, failed=red |
| **Workflows tab renders** | Navigate to Project → Workflows tab | Workflow cards with trigger, steps, last run |
| **Releases tab renders** | Navigate to Project → Releases tab | Release table with tag, SHA, env, timestamp |
| **Members tab renders** | Navigate to Project → Members tab | Member list with name, role badge, last active |

#### Phase 9 Tests — Polish

| Test | Steps | Assertions |
|------|-------|------------|
| **Empty state: no jobs** | New project with no jobs | Helpful empty state message, not blank page |
| **Loading skeletons** | Slow network (throttle) | Skeleton placeholders during load |
| **Error boundary** | API returns 500 | Error message with retry button, no white screen |
| **Keyboard: Cmd+K opens search** | Press Cmd+K | Search modal opens |
| **Responsive at 1024px** | Resize to 1024px | Layout adapts, no horizontal scroll |
| **10k line log performance** | Open job with 10k+ log lines | Page stays responsive, no jank |

### Seed Data Script

Playwright tests need predictable data. A seed script creates the baseline state before tests run.

**Where**: `apps/dashboard/e2e/seed.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

export EVE_API_URL=http://api.eve.lvh.me

# Ensure test org
ORG_ID=$(eve org ensure "dashboard-test" --slug dashboard-test --json | jq -r '.id')

# Ensure test project
PROJECT_ID=$(eve project ensure --org "$ORG_ID" --name "DashTest" --slug dashtest \
  --repo-url https://github.com/eve-horizon/eve-horizon-starter --json | jq -r '.id')

# Create jobs in various phases for board tests
eve job create --project "$PROJECT_ID" --title "Ready job" --priority 2 --phase ready
eve job create --project "$PROJECT_ID" --title "P0 critical" --priority 0 --phase ready
eve job create --project "$PROJECT_ID" --title "Active job" --priority 1 --phase active
eve job create --project "$PROJECT_ID" --title "Review needed" --priority 2 --phase review
for i in $(seq 1 5); do
  eve job create --project "$PROJECT_ID" --title "Done job $i" --priority 3 --phase done
done

echo "Seed complete: org=$ORG_ID project=$PROJECT_ID"
```

The seed script is idempotent — `eve org ensure` and `eve project ensure` are no-ops if the resources exist. Job creation is additive but tests should filter by project to avoid interference.

---

## Verification Loop on k3d

A step-by-step procedure to verify the dashboard end-to-end on the local k3d stack. Run after implementing each phase to confirm it works before moving on.

### Prerequisites

```bash
# 1. Stack must be running and healthy
./bin/eh status                    # k8s_owner: true, cluster running
eve system health --json           # {"status":"ok"}

# 2. Build and deploy the dashboard
cd apps/dashboard
pnpm build                         # Vite build
cd ../..
./bin/eh k8s-image push dashboard   # Build + import Docker image to k3d
./bin/eh k8s deploy                 # Apply manifests (includes dashboard)

# 3. Verify dashboard is reachable
curl -s -o /dev/null -w '%{http_code}' http://dashboard.eve.lvh.me
# → 200

# 4. Verify API proxy works through dashboard
curl -s http://dashboard.eve.lvh.me/api/health | jq .
# → {"status":"ok"}

# 5. Seed test data
bash apps/dashboard/e2e/seed.sh

# 6. Install Playwright (first time only)
cd apps/dashboard
npx playwright install chromium
cd ../..
```

### Phase 1 Verification: Foundation

```bash
# A. Run Phase 1 Playwright tests
cd apps/dashboard
npx playwright test e2e/phase1-foundation.spec.ts
cd ../..

# B. Manual spot-check: open in browser
open http://dashboard.eve.lvh.me
# → Should see login form
# → Paste a valid Eve token (from `eve auth token`)
# → Should land on overview page
# → Top bar shows user email and org switcher
# → Org switcher lists orgs from the token

# C. Verify SSO flow (requires GoTrue + SSO running in k3d)
# → Click "Sign in with SSO" on login page
# → Should redirect to sso.eve.lvh.me
# → After login, should redirect back to dashboard with session
```

**Gate**: Phase 1 is done when `phase1-foundation.spec.ts` passes and manual SSO login works.

### Phase 2 Verification: Overview + Navigation

```bash
# A. Run Phase 2 tests
cd apps/dashboard
npx playwright test e2e/phase2-overview.spec.ts
cd ../..

# B. Manual spot-check: data freshness
# → Create a job via CLI:
eve job create --project <id> --title "Dashboard live test" --phase ready
# → Dashboard overview should show updated stat card within 5 seconds
# → Activity feed should show the new job event

# C. Verify dark mode
# → Toggle dark mode in UI
# → All text readable, no invisible elements
# → Reload page — dark mode persists

# D. Take screenshots for design review
cd apps/dashboard
npx playwright test e2e/phase2-overview.spec.ts --update-snapshots
cd ../..
```

**Gate**: Phase 2 is done when `phase2-overview.spec.ts` passes and live polling visibly updates within 5 seconds.

### Phase 3 Verification: Job Board

```bash
# A. Run Phase 3 tests
cd apps/dashboard
npx playwright test e2e/phase3-board.spec.ts
cd ../..

# B. Manual spot-check: live card transitions
# → Open the board page in a browser
# → In another terminal, move a job through phases:
JOB_ID=$(eve job create --project <id> --title "Watch me move" --phase ready --json | jq -r '.id')
sleep 3   # Wait for poll
eve job update $JOB_ID --phase active
sleep 3   # Watch card animate from ready → active
eve job update $JOB_ID --phase review
sleep 3   # Watch card animate from active → review
eve job update $JOB_ID --phase done
# → Card should animate through each column

# C. Admin board verification
# → Toggle admin mode
# → Board should show jobs from all projects in the org
# → Each card should have a project badge
```

**Gate**: Phase 3 is done when `phase3-board.spec.ts` passes and live card transitions are visible within 5 seconds of phase change.

### Phase 4 Verification: Job Detail + Logs

```bash
# A. Run Phase 4 tests
cd apps/dashboard
npx playwright test e2e/phase4-detail.spec.ts
cd ../..

# B. Manual spot-check: SSE log streaming
# → Create a real agent job (requires Z_AI_API_KEY in test org secrets):
JOB_ID=$(eve job create --project <id> --title "Log stream test" \
  --harness mclaude --description "Say hello world" --json | jq -r '.id')
# → Open the job in the dashboard, click Logs tab
# → Should see log lines appearing in real time via SSE
# → Search for "hello" in the log search bar
# → Matches should highlight

# C. Large log performance
# → Open a completed job with 1000+ log lines
# → Scroll up and down rapidly
# → No jank or dropped frames (check with browser DevTools Performance tab)
```

**Gate**: Phase 4 is done when `phase4-detail.spec.ts` passes and SSE log streaming works with no visible lag.

### Phase 5 Verification: Admin Mode

```bash
# A. Run Phase 5 tests
cd apps/dashboard
npx playwright test e2e/phase5-admin.spec.ts
cd ../..

# B. Manual spot-check: attention panel
# → Login as system_admin, enable admin mode
# → Create a "stuck" job (active phase, old timestamp):
#    This requires direct DB or a test helper since CLI doesn't fake timestamps
# → Attention panel should surface it

# C. System panel verification
# → System page should show all Eve services (api, orchestrator, worker, etc.)
# → Each service shows pod count and status
# → Click a service → see pod list, recent events, log tail
```

**Gate**: Phase 5 is done when `phase5-admin.spec.ts` passes and the system panel shows accurate pod health matching `kubectl -n eve get pods`.

### Phase 6 Verification: Architecture Topology

```bash
# A. Run Phase 6 tests
cd apps/dashboard
npx playwright test e2e/phase6-topology.spec.ts
cd ../..

# B. Manual spot-check: topology interactions
# → Navigate to Project → Architecture tab
# → Hover nodes → connected nodes stay bright, others dim
# → Click a service node → detail panel slides up (pods, CPU, memory)
# → Switch environment in top bar → topology redraws

# C. Verify data sources
# → Services match: eve env show <project> <env>
# → Agents match: eve project agents <project>
```

**Gate**: Phase 6 is done when `phase6-topology.spec.ts` passes and topology hover/click interactions work smoothly.

### Phase 7 Verification: Agents + Chat

```bash
# A. Run Phase 7 tests
cd apps/dashboard
npx playwright test e2e/phase7-agents.spec.ts
cd ../..

# B. Manual spot-check: chat interaction
# → Navigate to Project → Agents tab
# → Click "Chat" on an agent card → panel slides open
# → Send a message → agent response streams in with cursor
# → Press Escape → panel closes
```

**Gate**: Phase 7 is done when `phase7-agents.spec.ts` passes and chat streaming visually works.

### Phase 8 + 9 Verification

```bash
# A. Run remaining tests
cd apps/dashboard
npx playwright test e2e/phase8-envs-pipelines.spec.ts e2e/phase9-polish.spec.ts
cd ../..

# B. Full suite regression
cd apps/dashboard
npx playwright test
cd ../..
# → All tests pass

# C. Performance check
# → Open dashboard with browser DevTools
# → Lighthouse audit: Performance > 90, Accessibility > 90
# → Bundle size: < 500KB gzipped (check Vite build output)
```

**Gate**: All Playwright tests pass. Lighthouse scores meet thresholds. Bundle size within budget.

---

## k3d vs Staging: Gap Analysis

The local k3d stack covers ~90% of verification. These gaps can only be tested on staging.

### Gaps That Cannot Be Reproduced on k3d

| Gap | Why k3d Differs | Staging Behavior | Mitigation |
|-----|----------------|-----------------|------------|
| **Real SSO with email** | k3d GoTrue uses local Mailpit — no real email delivery | Staging sends real emails via configured SMTP | Verify login flow on staging with a real email address |
| **HTTPS / TLS** | k3d uses plain HTTP (`http://dashboard.eve.lvh.me`) | Staging uses TLS (`https://dashboard.eve.example.com`) | Verify no mixed-content errors, cookie `Secure` flag works |
| **Cross-origin SSO cookies** | k3d: all services on `*.lvh.me` (same root domain) | Staging: SSO broker may be on a different subdomain | Verify SSO session probe works cross-origin on staging |
| **Multi-user concurrency** | k3d: single user testing | Staging: multiple users may be active | Verify React Query cache isolation between tabs/sessions |
| **Large dataset performance** | k3d: 10-50 jobs, 1-3 projects | Staging: hundreds of jobs, many projects | Verify pagination, scroll performance, and poll latency with real data volume |
| **CDN / static asset caching** | k3d: no CDN, direct nginx serve | Staging: may use CloudFront or similar | Verify cache busting works after deploys (Vite content-hash) |

### Gaps That CAN Be Reproduced on k3d

| Scenario | How to reproduce | Notes |
|----------|-----------------|-------|
| Auth flow (token-based) | Seed script + Playwright auth fixture | Covers 95% of auth logic |
| All API data flows | Seed script creates jobs, envs, events | Real API, real DB |
| SSE streaming | Create agent job with real harness | Live log streaming |
| Role-based visibility | Create users with different roles | member, org_admin, system_admin |
| Dark/light mode | Toggle in UI | Pure client-side |
| Board real-time updates | CLI job mutations during test | Poll-based updates |
| Error handling | Stop API mid-test, or return mock errors | Error boundaries, retry |
| Empty states | Fresh project with no data | All empty state variants |

### Staging Verification Checklist (Post-k3d)

After k3d verification passes and the dashboard is deployed to staging:

```
[ ] 1. Dashboard reachable at https://dashboard.eve.example.com
       curl -s -o /dev/null -w '%{http_code}' https://dashboard.eve.example.com
       # → 200

[ ] 2. SSO login works end-to-end
       # Open dashboard → Click SSO → Login with admin@example.com → Land on overview
       # No CORS errors, no redirect loops

[ ] 3. API proxy resolves correctly
       # Browser DevTools → Network tab → all /api/* calls return 200
       # No mixed-content warnings (HTTP from HTTPS page)

[ ] 4. Org switcher shows real orgs
       # Multiple orgs visible, switching updates data

[ ] 5. Overview shows real data
       # Stat cards reflect actual job counts
       # Activity feed shows real recent events
       # Environment health matches `eve system env-health`

[ ] 6. Board shows real jobs
       # Jobs from staging projects visible in correct columns
       # Live polling updates when jobs change

[ ] 7. Log viewer works with real logs
       # Open a completed job → Logs tab → lines render
       # Open an active job → SSE streaming works

[ ] 8. Admin mode for system_admin
       # System panel shows staging services
       # Pod counts match `kubectl -n eve get pods`
       # Service health matches `eve system status`

[ ] 9. Performance with real data volume
       # Board with 100+ jobs: no visible lag
       # Overview with 10+ projects: renders in < 2s
       # Log viewer with 5000+ lines: scrolls smoothly

[ ] 10. Responsive layout
        # Resize browser to 1024px → no horizontal scroll
        # All text readable, no overlapping elements
```

---

## CI Integration

Playwright tests run as part of the dashboard's CI pipeline. They are **not** part of `pnpm test` (which runs unit tests only).

```yaml
# .github/workflows/dashboard-e2e.yml (sketch)
name: Dashboard E2E
on:
  pull_request:
    paths: ['apps/dashboard/**']

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install
      - run: pnpm --filter dashboard build
      # Start a minimal API mock or use docker-compose for integration
      - run: npx playwright install chromium
      - run: cd apps/dashboard && npx playwright test
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: apps/dashboard/playwright-report/
```

For k3d-based verification (full stack), tests run manually as part of the verification loop above. CI uses a lighter mock-backed variant to keep pipeline times reasonable.
