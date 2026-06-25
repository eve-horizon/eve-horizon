# System Dashboard App Plan (Eve Horizon UI)

> Plan (Proposed)
> Last Updated: 2026-01-29

## Context

We want a standalone, deployable dashboard app (built from the starter template) that provides a modern web UI for Eve Horizon. The app should:
- Be a React + Tailwind SPA with a polished, intuitive UX.
- Map directly to the Eve Horizon REST API.
- Support admin and non-admin users.
- Provide a real-time-ish Kanban board of jobs, with Epic/Story drilldowns.
- Offer integrated review (PR links) and job debugging (logs, attempts).

### References

- Starter init flow: `../eve-horizon-starter/docs/GETTING-STARTED.md`
- Auth & roles: `docs/system/auth.md`, `docs/system/openapi.yaml`
- Job lifecycle & endpoints: `docs/system/job-api.md`
- Events & pipelines: `docs/system/events.md`, `docs/system/pipelines.md`
- OpenAPI source of truth: `docs/system/openapi.yaml`
- PR preview environments: `docs/plans/pr-preview-environments-plan.md`
- Job git controls: `docs/system/job-git-controls.md`
- Skill: `eve-plan-implementation` (in `https://github.com/eve-horizon/eve-skillpacks`)

## Goals

- Spin up a new repo via `eve init` and keep the starter workflow intact.
- Ship a clean, responsive SPA with project switcher + job board.
- Provide job detail + logs (SSE) + review actions in the UI.
- Support admin features (org/project management, members, system events).
- Provide integrated PR visibility in review flows.
- Keep initial scope realistic: polling every few seconds is OK for v1.

## Non-goals (v1)

- Full real-time push for every resource (SSE/WebSocket for all data).
- A full GitHub/Slack integration console (beyond displaying existing links).
- Replacing the CLI for power-user workflows.
- Deep analytics/metrics dashboards (can follow later).

## Decisions (Locked for v1)

- Auth bootstrap uses CLI token paste (`eve auth token --print`); no refresh token flow.
- Use a single service (starter `apps/api`) as a BFF proxy to avoid CORS.
- Poll jobs every 3-5 seconds; SSE only for logs/streams (no job events SSE in v1).
- PR links come from pipeline step outputs (`create-pr` result_json); no GitHub API.
- No shared component library; keep UI primitives local to the app.
- No Playwright in v1; manual smoke + API client unit tests only.

## Assumptions + Constraints

- Eve API is the single source of truth; do not bypass it.
- Auth is RS256 JWT; no refresh token endpoint exists today.
- Job phases are canonical: `idea → backlog → ready → active → review → done/cancelled`.
- Epic/Story/Task are modeled via `issue_type` + `parent_id`.
- Use existing SSE endpoints for logs and pipeline step logs.

## Execution Model (Eve-Run Development)

We will build the dashboard by running Eve jobs in the staging system using the
`zai` harness. Claude on the dev machine will orchestrate and review, but all
code changes are applied by jobs on a feature branch.

- Project repo: `eve-dashboard` created via `eve init` (starter-based).
- Environment: persistent `staging` env for deploys; per-PR previews per the
  PR preview environments plan.
- Branching: all code-change jobs target `feature/system-dashboard-app`.
- Git controls (recommended defaults for all child jobs):
  - `git.ref: main`, `git.ref_policy: explicit`
  - `git.branch: feature/system-dashboard-app`
  - `git.create_branch: if_missing`
  - `git.commit: required`
  - `git.push: on_success`
- Job structure: one epic root job with child jobs per phase; dependencies enforce
  ordering; each job updates the root summary and contributes to a single PR.

## Architecture Overview

### App Layout

- **Single service** (recommended): keep the starter `apps/api` as the service that
  - Serves the built SPA
  - Proxies Eve API requests (BFF) to avoid CORS headaches
  - Accepts a bearer token from the SPA and forwards it to the Eve API

Alternate:
- **Split services**: `apps/web` (static) + `apps/api` (proxy). More moving parts.

### Data Access

- Generate typed API client from Eve’s OpenAPI (`/openapi.json`).
- Use React Query (or similar) for caching + polling.
- Use SSE endpoints for job/pipeline logs.

### Auth (v1)

- CLI login with `eve auth login`.
- Use `eve auth token --print` to obtain a short-lived access token.
- User pastes token into the dashboard; store in memory + `sessionStorage`.
- SPA sends the token to the BFF on each request; BFF forwards as `Authorization: Bearer`.
- No refresh flow; on 401, prompt to paste a new token.

### Accessing via PR Preview Environments

Reviewers can access the dashboard via PR preview environments without setting up local infrastructure.

**For reviewers:**
1. Get a short-lived access token: `eve auth token`
2. Visit the preview URL (provided in the PR review summary)
3. Paste the token when prompted for authentication

See [PR Preview Environments](../system/pr-preview-environments.md) for detailed instructions.

### Real-time Updates

- Poll `/projects/{id}/jobs` every 3-5 seconds.
- Use `phase` query + client-side diff.
- Show optimistic updates when user actions move jobs.
- SSE only for job logs and pipeline step logs in v1.

## UX / IA (Information Architecture)

Primary nav:
- **Projects** (list + manage)
- **Board** (Kanban)
- **Epics** (Epic drilldown + tree)
- **Jobs** (table + filters)
- **Pipelines** (runs, steps, logs)
- **Environments** (deployments, status)
- **Review** (pending review + PR links)
- **System** (admin-only: orgs, members, system events, secrets)

Key UI flows:
- **Project switcher** (top-left, sticky)
- **Board**: columns per phase, swimlanes by epic, quick status badges
- **Job details drawer**: attempts, logs, result, git metadata, review actions
- **Epic detail**: hierarchy tree + board filtered to epic
- **Review screen**: job list in `review` phase + PR link surface

## API Mapping (Initial)

Auth + identity:
- `GET /auth/me`
- `POST /auth/challenge`
- `POST /auth/verify`

Orgs + members:
- `GET /orgs`
- `GET /orgs/{org_id}`
- `GET /orgs/{org_id}/members`
- `POST /orgs/{org_id}/members`

Projects:
- `GET /projects`
- `POST /projects`
- `PATCH /projects/{project_id}`
- `GET /projects/{project_id}/manifest`

Jobs (board + details):
- `GET /projects/{project_id}/jobs`
- `GET /projects/{project_id}/jobs/ready`
- `GET /projects/{project_id}/jobs/blocked`
- `GET /jobs/{job_id}`
- `PATCH /jobs/{job_id}`
- `GET /jobs/{job_id}/tree`
- `GET /jobs/{job_id}/dependencies`
- `POST /jobs/{job_id}/dependencies`
- `GET /jobs/{job_id}/attempts`
- `GET /jobs/{job_id}/result`
- `GET /jobs/{job_id}/stream` (SSE logs)
- `GET /jobs/{job_id}/attempts/{attempt}/stream` (SSE logs)
- `POST /jobs/{job_id}/submit` / `approve` / `reject`

Pipelines:
- `GET /projects/{id}/pipelines`
- `GET /projects/{id}/pipelines/{name}`
- `POST /projects/{id}/pipelines/{name}/run`
- `GET /projects/{id}/pipelines/{name}/runs`
- `GET /projects/{id}/pipelines/{name}/runs/{runId}`
- `GET /projects/{id}/pipelines/{name}/runs/{runId}/stream` (SSE)

Environments:
- `GET /projects/{id}/envs`
- `GET /projects/{id}/envs/{name}`
- `POST /projects/{id}/envs/{name}/deploy`

Events + system:
- `GET /projects/{id}/events`
- `GET /system/events`
- `GET /harnesses` (auth status)

## Data Model for Kanban + Epics

- **Phase columns**: `idea`, `backlog`, `ready`, `active`, `review`, `done`
  (optionally hide `cancelled` by default).
- **Epic**: `issue_type = epic` with children via `parent_id`.
- **Story/Task**: `issue_type = story | task` with `parent_id` linking to epic.
- **Drilldown**: use `GET /jobs/{id}/tree` for an epic’s subtree.
- **Cross-epic board**: show all jobs and allow filter by `parent_id`.

## Review + PR Integration (v1)

- Surface PR links from pipeline step outputs:
  - `create-pr` step in pipeline run `steps[].output_json` or `result_json`.
- If not present, derive repo URL from project and display:
  - `repo_url` + branch from `job_attempt.git.resolved_branch`.
- No GitHub API integration in v1.

## Job Orchestration (Eve)

Root epic job: **Eve Dashboard App v1** (`issue_type=epic`, `review=human`).
Child jobs mirror phases below. All code-changing jobs use the `zai` harness and
the feature branch git controls described above. Use `--env staging` only for
deploy and smoke-test jobs.

Suggested job template:

```bash
eve job create \
  --project proj_eve_dashboard \
  --description "Phase 1: App foundation" \
  --harness zai \
  --phase backlog \
  --review human \
  --git-ref main \
  --git-ref-policy explicit \
  --git-branch feature/system-dashboard-app \
  --git-create-branch if_missing \
  --git-commit required \
  --git-push on_success
```

Branch + preview flow:
- The staging system opens a PR from `feature/system-dashboard-app` early.
- Every push triggers a PR preview deployment (per PR preview plan).
- The epic job review summary includes the preview URL and `eve auth token --print`
  command for reviewers.

Initial root job description should include: "Use `eve-plan-implementation` to
implement `docs/plans/system-dashboard-app-plan.md`."

## Implementation Plan (Phased)

### Phase 0 — Bootstrap via init flow

1. `eve init eve-dashboard`
2. Run `eve-new-project-setup` skill
3. Ensure project + `staging` env exist and are deployable
4. Wire PR preview pipeline (see PR preview plan)
5. Replace starter todos with dashboard skeleton

### Phase 1 — App foundation

- Convert starter to React + Tailwind SPA
- Add routing + layout shell
- Create API client with auth headers (via BFF)
- Add theme tokens (Tailwind config) and component primitives

### Phase 2 — Auth + session

- Implement token-based login (CLI paste flow)
- Add `/auth/me` check + role gating
- Store token in memory + sessionStorage
- Add logout + token expiry handling

### Phase 3 — Project + org management

- Project switcher and list
- Project detail (manifest, envs, repo info)
- Admin-only org/member views

### Phase 4 — Kanban board (jobs)

- Columns by phase, swimlanes by epic
- Create job modal (maps to `POST /projects/{id}/jobs`)
- Drag/drop to update phase (PATCH job)
- Poll job list every 3–5s

### Phase 5 — Epic drilldown

- Epic list (filter issue_type=epic)
- Epic detail: tree + filtered board
- Dependency visualization (optional simple list)

### Phase 6 — Job details + debugging

- Job detail drawer + attempts list
- SSE log streaming (job + attempt)
- Result viewer + git metadata
- Review actions (submit/approve/reject)

### Phase 7 — Pipelines + PR review

- Pipeline runs list + detail
- Surface create-pr output and link
- Step logs (SSE)
- Inline review panel for related jobs
- Surface PR preview URL from pipeline output

### Phase 8 — Polish + UX

- Empty states, error states, and loading skeletons
- Keyboard shortcuts (project switcher, quick search)
- Theming + typography polish

### Phase 9 — Deploy + ops

- Update manifest to build and deploy dashboard service
- Add CI pipeline (build + deploy to staging)
- Ensure PR preview pipeline is enabled for the repo
- Add integration tests (API client + minimal UI smoke)

## Testing Plan

- **Unit**: API client, data transforms, permission gating.
- **Integration**: dashboards calling Eve API (mocked or local stack).
- **Manual smoke**: staging deploy + login + board + job detail + logs stream.
- **Pipeline smoke**: curl health or root page during PR preview deploy.

## Open Questions

- None for v1 (see Decisions section above).

## Success Criteria

- Users can log in, switch projects, and manage jobs without the CLI.
- Board updates within 3–5 seconds and reflects phase changes.
- Epic drilldown filters jobs correctly.
- Job logs and results visible in-app.
- Admins can manage orgs/projects and see system events.
- PR preview URL and CLI token command are available in review summaries.
