# Scenario 32: Dashboard Product Verification

**Time:** ~20-30 minutes
**Parallel Safe:** No
**LLM Required:** Yes
**Requires:** Browser (Playwright MCP), Eve CLI

Validates the dashboard as a finished product rather than a route smoke test. This scenario is the release gate for the work described in `docs/plans/eve-dashboard-completion-plan.md`: the shell, job workflow, project anatomy, admin mode, and UX all need to feel complete. A visible heading, placeholder copy, or empty state where real fixture data should exist is a failure.

## Prerequisites

- Scenario 01 (Smoke) passes.
- Scenario 02 (Job Execution) passes.
- Scenario 05 (Deploy Flow) passes.
- Scenario 18 (Org Threads) passes.
- Scenario 19 (Org Analytics) passes.
- Scenario 21 (Web Auth) passes.
- Dashboard is deployed and reachable at `http://dashboard.eve.lvh.me` for k3d or `https://dashboard.eve.example.com` for staging.
- You have an **admin** account for the target cluster.
- You have a separate **member** account for the target cluster. If you cannot verify member behavior, the scenario is blocked, not passed.
- The target org contains at least one fixture project with:
  - jobs in `ready`, `active`, `review`, and `done`
  - a deployed environment with multiple services
  - recent org events and non-zero spend
  - synced agents with at least one warm agent, one cold agent, and one recent thread
  - pipeline, workflow, release, schedule, integration, and member data

If any of the fixture data above is missing, stop and mark the scenario blocked. Do not accept empty states for the seeded verification project.

## Setup

### 1. Detect Environment

```bash
if [[ "${EVE_API_URL:-}" == "https://api.eve.example.com" ]]; then
  export DASHBOARD_URL="https://dashboard.eve.example.com"
  export ADMIN_EMAIL="admin@example.com"
else
  export DASHBOARD_URL="http://dashboard.eve.lvh.me"
  export ADMIN_EMAIL="admin@example.com"
fi

echo "EVE_API_URL=$EVE_API_URL"
echo "DASHBOARD_URL=$DASHBOARD_URL"
```

### 2. Verify Platform Reachability

```bash
eve system health --json
curl -sf -o /dev/null -w "%{http_code}" "$DASHBOARD_URL/"
curl -sf "$DASHBOARD_URL/api/health"
```

**Expected:**
- `eve system health --json` reports healthy status.
- Dashboard root returns `200`.
- `/api/health` succeeds through the dashboard proxy.

### 3. Acquire an Admin Token for Fast Session Setup

```bash
ADMIN_TOKEN=$(eve auth token --raw)
echo "Admin token length: ${#ADMIN_TOKEN}"
```

**Expected:**
- Token length is greater than 50.

### 4. Identify the Verification Project and Org

Export the org and project you intend to verify, then keep that project selected throughout the product checks unless a step explicitly switches scope.

```bash
export ORG_ID=<fixture_org_id>
export PROJECT_ID=<fixture_project_id>
```

## Phase 1: Access, Auth, and Shell

### 1.1 Unauthenticated Gate

Open the dashboard in a fresh browser session with no stored token.

```
browser_navigate: $DASHBOARD_URL
browser_snapshot
```

**Expected:**
- Login UI is visible.
- Dashboard content is not visible behind the auth gate.
- The primary path is browser-first SSO, not token-paste-only UX.

### 1.2 Real SSO Login

Complete one real browser login through the SSO path before using token injection for faster follow-up checks.

**Expected:**
- Browser redirects through the SSO flow and returns to the dashboard.
- There is no redirect loop.
- The authenticated app loads without a manual page refresh.

### 1.3 Authenticated Shell

After login, verify the shell itself before checking route content.

**Expected:**
- Sidebar and top-level chrome feel intentional, not like a generic admin template.
- Org switcher is visible and shows the active org name.
- Project selector is visible.
- Environment selector is visible on routes that need environment context.
- Admin/system scope controls appear for admin users.
- Active nav state is obvious.
- There are no placeholder nav items.

### 1.4 Token Injection Fast Path

For the remaining browser checks, token injection is acceptable after the real SSO path has been proven once.

```
browser_evaluate: sessionStorage.setItem('eve_access_token', '$ADMIN_TOKEN')
browser_navigate: $DASHBOARD_URL
browser_wait_for: text=Overview or text=Operations Overview (timeout: 10s)
```

**Expected:**
- The app loads directly into the authenticated shell.
- Auth state is preserved without another SSO round trip.

### 1.5 Org, Project, and Environment Switching

Switch orgs if multiple are available, then switch back to the verification org. Switch between at least two projects, then return to the seeded verification project. Change the active environment where supported.

**Expected:**
- Each switch updates visible data and route context.
- No stale data from the previous org/project/environment remains visible.
- URL state and refreshed page state stay coherent.

### 1.6 Member Session

Repeat the login and shell checks in a second browser session using the member account.

**Expected:**
- Member can access the dashboard shell and project-scoped surfaces.
- Admin-only controls and system navigation are absent.
- Member cannot reach hidden admin routes by typing the URL directly.

## Phase 2: Overview, Board, and Job Workflow

### 2.1 Overview

Navigate to the overview page with the seeded verification project selected.

```
browser_navigate: $DASHBOARD_URL/
browser_wait_for: text=Overview or text=Operations Overview (timeout: 10s)
browser_snapshot
```

**Expected:**
- Stat cards show real values from seeded data.
- Recent Activity shows meaningful events, not a blank panel.
- Environment summary shows actual environments with health indicators.
- Spend summary includes real numbers and a trend visualization.
- Admin mode adds an attention/operations layer rather than just swapping labels.

### 2.2 Board

Navigate to the board and exercise filters.

```
browser_navigate: $DASHBOARD_URL/board
browser_wait_for: text=Ready (timeout: 10s)
browser_snapshot
```

**Expected:**
- `Ready`, `Active`, `Review`, and `Done` columns render with counts.
- Cards appear in the correct columns for the seeded jobs.
- Done-column collapse/expand behavior is present.
- Search, priority, and harness filters work.
- Assignee, epic, and time-range filters exist if the build is claiming spec completion.
- Admin board mode clearly distinguishes cross-project jobs.

### 2.3 Jobs Table

Navigate to the jobs table view and verify search/filter parity with the board.

**Expected:**
- Table view supports project-scoped and admin cross-project workflows.
- Clicking a row opens the same detail surface used from the board.
- Phase filtering and text search work without a full reload.

## Phase 3: Job Detail and Log Viewer

Open one `active`, one `review`, and one `done` job from the seeded project.

### 3.1 Summary and Attempts

**Expected:**
- Summary shows complete metadata: phase, priority, harness, assignee/reviewer, git context, timestamps, labels, and parent linkage when present.
- Attempts tab supports switching attempts and shows status, duration, and cost context.

### 3.2 Logs

Open the Logs tab on an active job and on a completed job.

**Expected:**
- Historical logs render with line numbers.
- Active-job logs stream live.
- Search highlights matches and supports navigation between matches.
- Timestamp, wrap, filter, copy, and download affordances are present.
- ANSI color output is rendered, not shown as raw escape sequences.
- Manual scroll-up disengages auto-scroll cleanly.

### 3.3 Result and Cost

**Expected:**
- Result tab shows readable result output with exit status and artifacts where available.
- Cost tab shows a real receipt breakdown for seeded jobs with usage data.
- Review-phase jobs expose approve/reject actions if the design-claimed workflow is implemented.

### 3.4 Close Behavior

**Expected:**
- Escape closes the panel.
- Returning to the board/table preserves context and selection state appropriately.

## Phase 4: Project Anatomy Workspace

Navigate to the Project route for the seeded verification project. This phase fails immediately if the route is a placeholder.

```
browser_navigate: $DASHBOARD_URL/project
browser_snapshot
```

**Expected:**
- There is no "coming soon", "coming in phase X", or other placeholder copy.
- The page has real secondary navigation or tabs for project anatomy surfaces.

### 4.1 Architecture

**Expected:**
- Topology renders services, databases, ingress, and agents with visible edges.
- Hovering a node highlights its connected graph and dims unrelated nodes.
- Clicking a node opens a real detail panel with runtime details.
- Environment switching redraws or updates topology data correctly.

### 4.2 Agents and Chat

Open the Agents tab and start a chat with a warm agent.

**Expected:**
- Agent cards show harness, warm/cold state, description, and thread count.
- Recent threads list is visible.
- Chat slide-over opens and feels integrated with the rest of the product.
- Sending a message yields a streaming response.
- Escape closes the chat panel cleanly.

### 4.3 Pipelines, Workflows, Integrations, Releases, Schedules, Members

Open each tab and verify the seeded data renders.

**Expected:**
- Pipelines show runs and step-state visualization.
- Workflows show trigger context and step summaries.
- Integrations show connection status and relevant metadata.
- Releases show tags/versions and environment association.
- Schedules show cron cadence and next/last run data.
- Members show real people with role badges and relevant metadata.

If any of these tabs are absent from the completed build, or present only as headings with no meaningful data, the scenario fails.

## Phase 5: Environments, Spending, and Admin/System

### 5.1 Environments

Navigate to the Environments page.

**Expected:**
- Member/project mode shows real environment cards for the seeded project.
- Environment details include service health and release/deploy context.
- Admin mode adds cross-project visibility instead of the same aggregate counts presented differently.

### 5.2 Spending

Navigate to the Spending page.

**Expected:**
- Spend totals, trends, and breakdowns use real seeded data.
- Admin mode provides project-level or org-level breakdowns, not just a single agent table.
- Expensive jobs and anomaly/budget cues appear if the completed implementation claims them.

### 5.3 System and Admin Mode

Verify as admin, then verify restriction as member.

**Expected for admin:**
- System page shows services, pods, and drill-in behavior.
- Org-admin and platform-admin experiences differ correctly.
- Users/settings panels exist for `system_admin` if they are part of the shipped surface.

**Expected for member:**
- System access is blocked cleanly.
- The dashboard does not leak admin-only navigation or controls.

## Phase 6: UX Quality

### 6.1 Theme Quality

Toggle dark and light mode on Overview and Project pages.

**Expected:**
- Both themes feel intentional.
- Contrast remains strong.
- No route has broken styling or invisible content in either theme.

### 6.2 Responsive and Interaction Quality

Resize to a common laptop width around 1024px and revisit Overview, Board, Project, and Job Detail.

**Expected:**
- No accidental horizontal scroll for primary workflows.
- Slide-overs, tables, topology, and chat remain usable.
- Motion feels purposeful and smooth, not jarring.

### 6.3 Empty, Loading, and Error States

Use an intentionally empty project if you need to validate empty states separately.

**Expected:**
- Empty states are helpful and specific.
- Loading states are designed, not blank.
- Error states offer retry/recovery rather than a white screen.

## Phase 7: Platform Conformance and Data Cross-Checks

### 7.1 Proxy and Auth

```bash
curl -sf "$DASHBOARD_URL/api/health"
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" "$EVE_API_URL/auth/me"
```

**Expected:**
- Dashboard proxies the API successfully through `/api`.
- Auth state is backed by Eve auth, not custom app auth.

### 7.2 Data Cross-Check

Pick at least one number each from Overview, Board, Spending, and System and compare it against the CLI or API.

```bash
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" "$EVE_API_URL/orgs/$ORG_ID/jobs/stats"
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" "$EVE_API_URL/orgs/$ORG_ID/analytics/summary?window=1d"
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" "$EVE_API_URL/orgs/$ORG_ID/spend"
eve system status --json
```

**Expected:**
- Dashboard numbers match the underlying API/CLI within the expected polling window.
- Admin/system counts shown in the UI line up with system status.

## Success Criteria

### Product Surface

- [ ] Auth gate, SSO login, and authenticated shell all work
- [ ] Member and admin experiences are both verified
- [ ] Overview, Board, Jobs, Environments, Spending, and System are all functional
- [ ] Project route is fully implemented with real anatomy tabs
- [ ] Architecture topology is interactive and data-backed
- [ ] Agents tab includes thread list and streaming chat
- [ ] Pipelines, Workflows, Integrations, Releases, Schedules, and Members all render real data

### Workflow Quality

- [ ] Board and Jobs views support real operator workflows
- [ ] Job detail supports real debugging and review workflows
- [ ] Log viewer behavior is good enough for active and completed jobs
- [ ] Admin mode provides meaningful cross-project operations value

### UX Quality

- [ ] Dark and light themes both meet the quality bar
- [ ] Responsive behavior is acceptable at common laptop widths
- [ ] Empty, loading, and error states are productized
- [ ] No placeholder copy or fake-complete surfaces remain

### Conformance

- [ ] `/api` proxy works through the dashboard
- [ ] Dashboard data matches Eve API / CLI cross-checks
- [ ] Verification fixture data is visible where expected

## Debugging

| Symptom | Diagnostic | Fix |
|---|---|---|
| Dashboard does not load | `curl -I "$DASHBOARD_URL"` | Check dashboard deployment and ingress |
| Auth loop or failed login | `curl -sf "$EVE_API_URL/auth/config"` | Verify SSO config and current session state |
| Board or overview is empty for seeded project | `curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" "$EVE_API_URL/orgs/$ORG_ID/jobs/stats"` | Reseed fixture data before re-running |
| Project page is still a stub | Open `/project` directly | Fail the scenario and continue only after implementation lands |
| System counts do not match | `eve system status --json` | Check whether the dashboard is polling stale data or using the wrong scope |
| Theme or layout breaks on one route | Toggle theme and resize on that route | Treat as UX regression, not minor polish |

## Cleanup

```bash
# No teardown is required unless you created temporary verification data.
# If you created ad hoc jobs or threads during the run, record that in the report.
```
