# Eve Dashboard Overhaul Goal

> **Status**: Active
> **Created**: 2026-03-31
> **Source**: user execution brief for `eve-horizon-32cj`
> **Related**: `docs/plans/eve-dashboard-design.md`, `docs/plans/eve-dashboard-completion-plan.md`

## Core Goal

Turn the dashboard system app into both:

- the best showcase for the Eve platform
- a genuinely useful operations surface for app developers, org admins, and platform admins

This is not a light polish pass. The bar is a dashboard that looks intentional, feels fast, and helps people understand and operate Eve systems without dropping to CLI or kubectl for first-pass diagnosis.

## Product Standard

The dashboard must:

- look polished on every route, not just the landing page
- keep top-level context stable across navigation
- surface the most important warnings and failures without hunting
- make drill-downs obvious and fast
- be useful for real work, not only demos or screenshots

In practice that means org, app, and environment selection at the top of the shell must persist while moving between views, and every route in navigation must do real work rather than act as a placeholder.

## Primary User Outcomes

The dashboard should let a user quickly:

### 1. Understand an app and its runtime shape

- what services are running
- what environments exist and whether they are healthy
- what cloud resources are attached or being consumed
- which agents are configured, warm, active, or expensive
- which threads and conversations matter right now

### 2. Diagnose issues

- see failing or stuck jobs immediately
- inspect job logs and service logs without context switching
- find environment health problems and degraded services quickly
- move from a summary view into the exact thread, attempt, log stream, or resource that explains the issue

### 3. Surface action items clearly

- warnings and errors should be visually obvious
- attention-worthy states should be ranked above general activity
- the dashboard should answer "what needs attention now?" before "what happened recently?"

### 4. Understand spend

- show agent costs clearly
- make it easy to see expensive jobs, expensive agents, and cost trends
- support both project-level and admin-level spend views

## Audience Modes

The same app must serve three overlapping audiences:

- **App developers**: understand project anatomy, jobs, agents, threads, releases, logs, and spend for their app
- **Org admins**: see cross-project activity, degraded environments, operational issues, and rollups for the active org
- **Platform admins**: inspect system services, platform health, cluster issues, and org-level operational load

The shell and navigation should make those scope changes feel natural rather than like separate disconnected tools.

## Required Behavior

- Org/app/environment context persists across route changes.
- Every visible screen is polished and functional.
- Broken flows are fixed, not worked around in the UI.
- If existing APIs block a good UX, add or adjust read models/endpoints.
- Empty states appear only when data is actually empty, not because a feature is unfinished.

## Development And Validation Approach

Use the local k3d stack as the primary working environment and install the reference app at `../../eve-horizon/eden` if it is not already present. Exercise it like a real app:

- deploy Eden into the local stack
- kick off jobs
- simulate chats with agents
- generate logs, threads, failures, and cost activity
- use that real activity to evaluate and improve the dashboard

Testing must use Playwright. Prefer realistic operator workflows over route-smoke checks. Think like both an app developer and an org/platform admin and use those workflows to drive what gets built or fixed.

## Success Criteria

The dashboard overhaul is successful when:

- selection state persists reliably across views
- key operational questions can be answered from the UI in seconds
- logs, warnings, failures, costs, agents, and threads are easy to reach
- the dashboard feels like a strong platform product, not a generic admin shell
- Playwright coverage exercises the important workflows that make the dashboard trustworthy
