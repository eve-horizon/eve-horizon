# Starter Company OrgPack v1 Implementation Plan

> Status: Draft
> Last Updated: 2026-04-08
> Purpose: Deliver the first minimal installable OrgPack with `ceo`, `agent-resources`, and `software-engineer`, goal-driven coordination, an optional fully autonomous self-staffing loop, and an app-building loop for new Eve-compatible projects.
> Depends On:
> - `docs/plans/company-as-intelligence-plan.md`
> - `docs/plans/orgpack-platform-phase-1-plan.md` (Phases 1A, 1C, and 1D must ship before this pack can be installed end-to-end)
>
> Repo location: this plan ships a new sister repo `../starter-company` (github.com/eve-horizon/starter-company or equivalent). It is NOT a subdirectory of eve-horizon. Agents have permission to push to it under the same sister-repo policy documented in CLAUDE.md.
>
> References:
> - `packages/cli/src/lib/sync-project.ts` (unified sync entrypoint)
> - `packages/cli/src/commands/project.ts` (`project sync` subcommand)
> - `packages/cli/src/commands/agents.ts` (`agents sync` deprecated alias)
> - `packages/cli/src/commands/job.ts` (`job create` for staffing jobs)
> - `packages/cli/src/lib/help.ts`
> - `packages/shared/src/schemas/agent-config.ts`
> - `apps/api/src/projects/projects.controller.ts`
> - `apps/worker/src/invoke/invoke.service.ts` (git-controls commit/push behavior)
> - `.agents/skills/eve-read-eve-docs/references/agents-teams.md`
> - `.agents/skills/eve-read-eve-docs/references/jobs.md`
> - `.agents/skills/eve-read-eve-docs/references/skills-system.md`

## 0) Product Shape

`starter-company` is the thinnest credible OrgPack:

1. The installer creates one coordination project and registers it as the org pack.
2. The user sets mission, goals, budgets, repo credentials, and autonomy posture.
3. The pack ships with three durable roles — the minimum set that lets a company both grow itself *and* ship software on Eve:
   1. `ceo` — reads intent, decides when capabilities are missing, delegates execution
   2. `agent-resources` (`ar`) — owns the mechanical lifecycle of pack agents (hire/update/retire/sync)
   3. `software-engineer` (`se`) — builds Eve-compatible apps from a spec: scaffolds projects, writes manifests, deploys, and debugs
4. The pack can remain conservative or run in `full_auto` mode without changing architecture.

This pack is not the rich SaaS opinion. It is the generic, self-growing, self-building base. Everything else is a pack overlay on top.

### Why three roles and not two

Two roles (`ceo` + `agent-resources`) prove the self-modification story: the pack can grow its own org chart. But a growing org chart alone does nothing — the pack still needs someone who can *actually ship software* onto Eve when the CEO identifies a new product capability. The software engineer closes that loop: CEO identifies a capability gap → SE builds the Eve app that delivers it → world model picks up the new capability → policies can use it.

Without the SE, every non-staffing capability gap becomes a human request. With the SE, the pack can scaffold and deploy new Eve-compatible apps end-to-end under the same autonomy posture that governs staffing.

## 1) Goals

1. Install in under one day for a small org.
2. Populate `/operating-model/**` and `/world-model/**` from a minimal starting configuration.
3. Support autonomous staffing of the pack's own roster (`agent-resources` owns this loop).
4. Support autonomous shipping of new Eve-compatible apps (`software-engineer` owns this loop).
5. Use shipped Eve primitives exactly as they exist today:
   1. repo-first config
   2. `eve project sync` as the primary sync entrypoint
   3. project manifests, packs, and agent YAML
   4. jobs + git controls for self-modifying changes
   5. the existing `eve-*` skillpacks (`eve-fullstack-app-design`, `eve-agentic-app-design`, `eve-new-project-setup`, `eve-manifest-authoring`, `eve-pipelines-workflows`, `eve-deploy-debugging`, `eve-local-dev-loop`, `eve-app-cli`, `eve-auth-and-secrets`) as the SE's operating manual

## 2) Non-goals

1. Domain-specific SaaS connectors in v1.
2. Staffing arbitrary non-pack project repos in v1.
3. Free-form "invent any org chart from scratch" behavior with no guardrails.
4. Enterprise governance UX.

## 3) Key Implementation Decision

The shipped implementation should prefer `eve project sync` over `eve agents sync`.

Why:

1. `eve project sync` is the current primary CLI entrypoint (both commands delegate to `runUnifiedSync` in `packages/cli/src/lib/sync-project.ts`; `agents sync` already prints a deprecation warning).
2. It syncs manifest + agent config together in a single manifest record.
3. `starter-company` staffing changes may edit both `pack/agents/agents.yaml` and `.eve/manifest.yaml` (for `x-eve.packs` updates or new pack overlays).

`eve agents sync` remains a deprecated alias and should not appear anywhere in `starter-company` documentation or agent prompts.

## 4) Success Bar

This plan is successful when:

1. A new org can install the pack, set goals, and see `ceo`, `agent-resources`, and `software-engineer` running.
2. The pack can create and sync at least one new agent end to end with no human action in `full_auto` mode (the self-staffing loop).
3. The pack can scaffold, build, and deploy at least one new Eve-compatible app end to end with no human action in `full_auto` mode (the software-engineering loop).
4. Both loops are visible in git history, job history, and updates to the company graph / world model.
5. The same pack can also run in approval mode with the same code paths.

## 5) Execution Checklist

| Status | Area | Item | Acceptance |
| --- | --- | --- | --- |
| - [ ] | Repo | Create `starter-company` repo skeleton with manifest, agents, profiles, `.eve-org/`, and skills | Repo syncs cleanly into a coordination project |
| - [ ] | Agents | Define `ceo` and `agent-resources` personas, permissions, and harness profiles | Both agents are runnable and discoverable after sync |
| - [ ] | Agents | Define `software-engineer` persona, permissions, harness profile, and skill stack | SE can scaffold and deploy an Eve app from a spec |
| - [ ] | Docs | Add installation README and autonomy configuration examples | A user can set up the pack without reading internal platform code |
| - [ ] | World model | Produce minimum viable `/operating-model/**` and `/world-model/**` docs | Pack starts with legible state, not an empty shell |
| - [ ] | Staffing loop | Implement repo-mutation -> push -> `eve project sync --ref <branch>` loop | At least one new agent can be added by the pack itself |
| - [ ] | Build loop | Implement spec -> scaffold -> build -> deploy loop for a new Eve app | At least one new Eve app can be shipped by the SE |
| - [ ] | Modes | Support `advise`, `auto_staff`, and `full_auto` (covers both loops) | Same pack behaves differently by config, not by forked code |
| - [ ] | Verification | Add end-to-end verification scenarios for install, staffing, and app-building | CI/manual verification proves the pack actually works |

## 6) Phase 1: Repo Skeleton + Install Flow

### Deliverables

Create a new pack repo with at least:

```text
starter-company/
  .eve/manifest.yaml
  pack/agents/agents.yaml
  pack/agents/profiles/
    ceo.md
    agent-resources.md
    software-engineer.md
  .eve-org/mission.yaml
  .eve-org/outcomes.yaml
  .eve-org/governance.yaml
  .eve-org/company-graph.yaml
  .eve-org/capabilities.yaml
  skills/ceo/SKILL.md
  skills/agent-resources/SKILL.md
  skills/software-engineer/SKILL.md
  README.md
```

### Install contract

Precondition: the user has already cloned or forked the `starter-company` repo and set repo credentials for Eve to access it.

```bash
# 1. Create the coordination project pointing at the starter-company repo
eve project ensure \
  --name "Coordination" \
  --slug coord \
  --repo-url https://github.com/<user>/starter-company \
  --org org_xxx

# 2. Register the project as the org pack (requires Phase 1A)
eve org set-pack org_xxx --project coord

# 3. Sync manifest + agents from HEAD
eve project sync --project proj_coord
```

After step 3:

1. The pack's manifest is registered.
2. `ceo`, `agent-resources`, and `software-engineer` are synced and runnable.
3. `/operating-model/**` and `/world-model/**` docs are empty until the first heartbeat cycle writes them.

### Verification loop

1. Create a temporary org.
2. Fork or clone the starter-company repo skeleton from the fixtures directory.
3. Run steps 1-3 from a clean shell with only the shipped CLI.
4. Assert that sync succeeds with no manual API calls.
5. Assert that all three agents (`ceo`, `agent-resources`, `software-engineer`) are present via `eve agents list --project proj_coord`.
6. Assert that `eve org get-pack org_xxx` returns `proj_coord`.

## 7) Phase 2: Durable Roles (`ceo`, `agent-resources`, `software-engineer`)

### `ceo`

Responsibilities:

1. Read goals, company graph, and world model.
2. Decide when existing capabilities are enough.
3. Decide when the company needs a new durable role.
4. Delegate execution and staffing work by creating jobs via `eve job create --project <pack-project> --agent-slug agent-resources ...` or via cross-project `eve job create --project <target> ...` (Phase 1C).

Tooling: `ceo` runs on a standard agent harness with the Eve CLI available in its workspace. It does not need bespoke tool integrations beyond the CLI and org-doc read access.

### `agent-resources`

Responsibilities:

1. Own the mechanical lifecycle of pack agents.
2. Load `eve-read-eve-docs` as the operating manual.
3. Edit repo files correctly.
4. Preview, validate, and sync effective config.
5. Open decision threads when the current autonomy posture requires approval.

The AR skill should explicitly teach:

1. `pack/agents/agents.yaml` structure.
2. harness profile placement under `pack/agents/profiles/`.
3. `x-eve.packs` updates in `.eve/manifest.yaml` when adding pack refs.
4. `eve project sync --project <id> --ref <branch>` flow (branch, not SHA — see Phase 4 rationale).
5. The two-job staffing loop with explicit follow-up `eve job create ... --depends-on <this-job-id>`.
6. How to read `.eve-org/governance.yaml` to determine autonomy posture.

### `software-engineer`

Responsibilities:

1. Read a spec from `ceo` (a chat message, a `/operating-model/outcomes/*` entry, or a job hint) describing a new app capability the org needs.
2. Decide whether an existing Eve-compatible app can be extended or whether a new one should be scaffolded.
3. Scaffold a new Eve-compatible app from a known template (`eve-horizon-starter` or a minimal in-repo skeleton), or open a job in an existing app's project.
4. Author the app's `.eve/manifest.yaml`, services, environments, pipelines, and any required agent configs.
5. Register the new project, sync the manifest, build images via the pipeline, and deploy to the first environment.
6. Verify the deployment is healthy via `eve env diagnose` / `eve system health` / `eve pipeline logs`.
7. File a capability entry in `/operating-model/capabilities/<name>` and update `/operating-model/company-graph` so the CEO and world model can see the new app.
8. Loop on failure: read diagnostics, fix, redeploy. Halt after 3 consecutive failures and surface the issue in `/world-model/engineering-log`.

Tooling: `software-engineer` runs on a standard agent harness with the Eve CLI available in its workspace, plus `git` and `gh` (GitHub CLI) for managing app repos. It does not need bespoke tool integrations beyond those.

The SE skill should explicitly teach (load these skillpacks in priority order):

1. `eve-read-eve-docs` — the underlying reference for everything below
2. `eve-fullstack-app-design` — how to architect an Eve-compatible app
3. `eve-agentic-app-design` — how to layer agents onto the app
4. `eve-new-project-setup` — `eve project ensure`, profile defaults, first sync
5. `eve-manifest-authoring` — `.eve/manifest.yaml` structure, x-eve extensions, secret interpolation
6. `eve-pipelines-workflows` — build/release/deploy pipelines
7. `eve-deploy-debugging` — debugging deploy failures via CLI
8. `eve-local-dev-loop` — fast iteration via Docker Compose before deploying
9. `eve-app-cli` — building an agent-friendly CLI for the new app
10. `eve-auth-and-secrets` — secrets management and SSO integration for the new app
11. `eve-job-lifecycle` and `eve-job-debugging` — running work inside the new project
12. `eve-verification-plans` — building agentic verification for the new app

The SE skill file should explicitly walk through the canonical "scaffold → manifest → sync → pipeline → deploy → verify" flow once, end to end, so the agent has a concrete recipe to fall back on when the spec is vague.

### Permissions + runtime contract

All three agents run inside the registered pack project, so their reserved-prefix org-doc/fs writes under `/operating-model/**` and `/world-model/**` come from the Phase 1A pack authorization, not from explicit permission grants on the agent. Explicit, non-pack permissions are declared on each agent via the `access.permissions` field in `pack/agents/agents.yaml`.

**How the platform plumbs this (no platform work needed):**

1. `projects.service.ts:794-807` validates declared permissions against the canonical permission catalog in `packages/shared/src/permissions.ts` at sync time. An unknown permission fails `eve project sync` with a clear error.
2. `apps/agent-runtime/src/invoke/invoke.service.ts:677-693` (`resolveAgentPermissions`) reads `agent.access_json.permissions`, merges with `DEFAULT_AGENT_PERMISSIONS`, and passes the combined set into `resolveInvocationJobToken`, which mints a job token with those exact permissions baked into the JWT.
3. All agent jobs route through agent-runtime (not the worker) when `EVE_AGENT_RUNTIME_URL` is set, which is always the case in k3d and staging. So the SE's elevated permissions work today via the existing agent-runtime path.
4. There IS a latent gap in `apps/worker/src/invoke/invoke.service.ts:216-227`: the worker calls `resolveInvocationJobToken(invocation)` without the `permissions` argument, so worker-executed jobs always get `DEFAULT_AGENT_PERMISSIONS` only. This is irrelevant for starter-company because the SE is an agent role and will always route to agent-runtime, but it should be filed as a platform issue for completeness if anyone ever runs the SE as a script/action job.

**Declared permissions per agent (all via `access.permissions`):**

1. `ceo` — `orgs:read`, `orgdocs:read`, `orgfs:read`, `chat:write`. (`jobs:read`, `jobs:write`, `threads:read`, and `threads:write` come from `DEFAULT_AGENT_PERMISSIONS` and do not need to be declared.) The default user-facing agent; handles chat routing.
2. `agent-resources` — `orgs:read`, `orgdocs:read`, `orgfs:read`, and `projects:write` (to trigger manifest/agents sync). Internal by default; not exposed in chat routes unless the operator explicitly wires it up.
3. `software-engineer` — `orgs:read`, `orgdocs:read`, `orgfs:read`, plus the full app-shipping toolbox: `projects:create`, `projects:write`, `envs:read`, `envs:write`, `builds:read`, `builds:write`, `releases:read`, `releases:write`, `pipelines:read`, `pipelines:write`, `agents:read`, `agents:write`, `secrets:read`, `secrets:write`, `workflows:read`, `workflows:write`, `integrations:read`, `integrations:write`. GitHub credentials (for `gh repo create`) come from the standard project repo-credentials flow, not from `access.permissions`.

All listed permissions are present in `packages/shared/src/permissions.ts:ALL_PERMISSIONS` as of today — no platform changes required.

### SE agent entry in `pack/agents/agents.yaml` (verbatim reference)

The Phase 2b skill file should include this snippet verbatim so the permission contract is unambiguous at implementation time:

```yaml
# pack/agents/agents.yaml
version: 1
agents:

  ceo:
    slug: ceo
    skill: starter-company-ceo
    harness_profile: ceo
    description: >
      Reads goals, operating model, and world model. Decides whether
      capability gaps need new durable roles (delegates to agent-resources)
      or new Eve-compatible apps (delegates to software-engineer).
    access:
      permissions:
        - orgs:read
        - orgdocs:read
        - orgfs:read
        - chat:write
    policies:
      permission_policy: auto_edit
      git: { commit: never, push: never }
    context:
      docs:
        - path: /operating-model/
          recursive: true
        - path: /world-model/
          recursive: true

  agent_resources:
    slug: agent-resources
    alias: ar
    skill: starter-company-agent-resources
    harness_profile: agent-resources
    description: >
      Owns the mechanical lifecycle of pack agents. Edits pack/agents/agents.yaml,
      harness profiles, and x-eve.packs. Drives eve project sync. Loads
      eve-read-eve-docs as its operating manual.
    access:
      permissions:
        - orgs:read
        - orgdocs:read
        - orgfs:read
        - projects:write
    policies:
      permission_policy: auto_edit
      git: { commit: auto, push: on_success }
    context:
      docs:
        - path: /operating-model/
          recursive: true
        - path: /world-model/staffing-log

  software_engineer:
    slug: software-engineer
    alias: se
    skill: starter-company-software-engineer
    harness_profile: software-engineer
    description: >
      Builds Eve-compatible apps from a spec: scaffolds projects, writes
      manifests, runs pipelines, deploys environments, and verifies health.
      Loads the full eve-* skill stack (eve-fullstack-app-design,
      eve-new-project-setup, eve-manifest-authoring, eve-pipelines-workflows,
      eve-deploy-debugging, eve-local-dev-loop, eve-app-cli,
      eve-auth-and-secrets, eve-verification-plans) as its operating manual.
    access:
      permissions:
        # ceo's set (except chat:write is optional — SE is internal by default)
        - orgs:read
        - orgdocs:read
        - orgfs:read
        # project lifecycle for new apps
        - projects:create
        - projects:write
        # environment deploy surface
        - envs:read
        - envs:write
        # build + release pipelines
        - builds:read
        - builds:write
        - releases:read
        - releases:write
        - pipelines:read
        - pipelines:write
        # agents in the apps SE ships
        - agents:read
        - agents:write
        # secrets for the apps SE ships
        - secrets:read
        - secrets:write
        # workflows declared in app manifests
        - workflows:read
        - workflows:write
        # integrations (GitHub, Slack, etc.) for the apps SE ships
        - integrations:read
        - integrations:write
    policies:
      permission_policy: auto_edit
      git: { commit: auto, push: on_success }
    context:
      docs:
        - path: /operating-model/capabilities
          recursive: true
        - path: /world-model/engineering-log
```

Notes on the schema:

1. The field is `access.permissions` per `packages/shared/src/schemas/agent-config.ts:AgentAccessSchema`. It is NOT `x-eve.permissions`.
2. `DEFAULT_AGENT_PERMISSIONS` (`jobs:read`, `jobs:write`, `projects:read`, `threads:read`, `threads:write`, `envdb:read`, `secrets:read`, `builds:read`, `pipelines:read`) is added automatically by `resolveAgentPermissions` and does NOT need to be re-declared. The lists above intentionally omit these defaults.
3. Reserved-prefix writes to `/operating-model/**` and `/world-model/**` do NOT require `orgdocs:write` — they come from Phase 1A pack authorization. The agents only need `orgdocs:read` to read existing docs; writes under reserved prefixes flow through the `ScopedAccessService` reserved-prefix override.
4. `chat:write` is only required for agents that post outbound chat messages. `ceo` is the default user-facing agent and needs it; `agent-resources` and `software-engineer` are internal by default and do not.

### Verification loop

1. Sync the pack and inspect merged config — all three agents appear.
2. Run one job against each agent and verify prompt/context shape is correct.
3. Confirm `agent-resources` can modify the pack repo in a job workspace and has the required credentials available.
4. Confirm `software-engineer` can run `eve project ensure --name <test-app> ...` against a clean repo without manual credential setup.
5. Confirm the SE's permission set is the superset declared above and that it cannot write outside its declared scope (e.g. no direct DB access).

## 8) Phase 3: Minimal Operating Model + World Model

### Deliverables

At minimum, the pack should materialize:

1. `/operating-model/mission`
2. `/operating-model/outcomes/*`
3. `/operating-model/company-graph`
4. `/world-model/state`

The world model can start simple:

1. current goals
2. current known agents/capabilities
3. active and blocked work
4. recent staffing changes

### Design notes

1. The v1 world model does not need sophisticated forecasting.
2. The staffing loop should update the company graph and world model as part of normal operation.
3. Good enough is a maintained materialized summary, not magic.

### Verification loop

1. Install the pack in a clean org.
2. Confirm the expected docs exist after the initial sync/heartbeat cycle.
3. Confirm a staffing change updates the relevant operating-model/world-model docs.

## 9) Phase 4: Autonomous Self-Staffing Loop

This is the critical phase.

### Default implementation shape

Use a two-job loop as the reliable default:

1. **Staffing change job** (created by `ceo` or kicked off by a chat/goal trigger)
   1. `agent-resources` edits repo files on a job branch.
   2. Before exiting, `agent-resources` creates the follow-up apply job explicitly via `eve job create` with:
      1. `title: "Apply staffing change: <role-name>"`
      2. `agent_slug: agent-resources`
      3. `depends_on: [<this job's id>]` so the orchestrator waits for the current job's commit/push to complete
      4. `hints.staffing_branch: <branch-name>` — the apply job resolves the branch tip at run time rather than pinning a SHA here (the commit/push happens after this job returns, so the SHA is not yet knowable).
   3. The agent then exits normally. The worker's git controls commit and push the branch.
2. **Staffing apply job** (runs after the change job completes and the push lands)
   1. Reads `hints.staffing_branch` from its own job record.
   2. Runs `eve project sync --project <orgpack-project> --ref <branch>` — the CLI resolves the branch tip server-side.
   3. Queries the project's agent config to verify the new agent is present.
   4. Writes a result summary to `/world-model/staffing-log` in org docs.

This two-job shape is preferred over a single job because the worker's automatic commit/push happens after the agent exits. A follow-up sync job that depends on the change job is simpler and more reliable than trying to synchronize inside the same job.

### Why `depends_on` and not `hints.sha`

The change job cannot return a SHA that has already been pushed because the push has not happened yet when the agent writes its result. Resolving the branch tip at apply time via the CLI is the smallest change to existing primitives; it requires the apply job to have `projects:read` to look up the project repo (which default agent tokens already carry) and `jobs:write` to create follow-up jobs (also default).

### Platform gap note

If the orchestrator runs the apply job before the push finalizes, the sync will race. If this becomes a flake, the fix belongs in the platform — not in pack code. Likely fix: `worker` emits `system.job.git.pushed` after the commit/push step and the orchestrator treats it as a phase gate for downstream jobs. File a platform issue if observed.

### Files AR may change

1. `pack/agents/agents.yaml`
2. `pack/agents/profiles/*.md`
3. `.eve/manifest.yaml`
4. `.eve-org/company-graph.yaml`
5. `.eve-org/capabilities.yaml`
6. skill files for newly introduced internal roles when needed

### First staffing scenario

Use one deterministic first hire in verification:

1. add `researcher` or `docs-agent`
2. sync pack
3. verify capability discovery sees it
4. assign it a follow-up job

### Verification loop

1. Run the staffing change job in a test org.
2. Run the staffing apply job automatically.
3. Assert that the new agent appears in synced project config.
4. Assert that the `ceo` can create a follow-up job targeting the new agent.
5. Assert that git history, job history, and world model all reflect the change.

## 10) Phase 5: Autonomy Modes + Safeguards

### Configuration location

Autonomy posture is a pack-level setting stored in `.eve-org/governance.yaml`:

```yaml
# .eve-org/governance.yaml
autonomy_posture: full_auto   # advise | auto_staff | full_auto
staffing:
  max_new_agents_per_day: 3
  max_new_agents_per_week: 10
  pause: false                # set true to halt staffing mid-session
budgets:
  monthly_usd_cap: 500
```

This file is synced into org docs at `/operating-model/governance` by the pack's normal sync path. Both `ceo` and `agent-resources` read it on every job start and respect the current value (mutable between jobs — no restart required).

### Modes

Support the same pack across three modes with identical architecture:

1. `advise` — `ceo` proposes staffing changes; `agent-resources` opens a decision thread via the Phase 1D typed-decision surface and waits for human approval before creating the change job.
2. `auto_staff` — `ceo` and `agent-resources` may change the pack's own agent roster without human approval, but high-risk actions (delete, rename of an existing agent) still require a decision thread.
3. `full_auto` — the pack may change its own staffing and operate policy-driven execution loops without human interaction. Decision threads become audit records rather than gates.

### Minimum safeguards

1. Per-pack staffing rate limits enforced in `agent-resources` logic (reads `.eve-org/governance.yaml`).
2. Budget caps checked against `GET /orgs/:org_id/spend?since=<month-start>` before creating staffing jobs.
3. `pause: true` in `.eve-org/governance.yaml` halts autonomous staffing immediately at the next job start.
4. Every self-modification emits a pack-level event logged to `/world-model/staffing-log` (append-only org doc).
5. If the staffing loop fails 3 consecutive times, `agent-resources` writes a failure record to `/world-model/staffing-log`, sets a pack-local `staffing_halted: true` flag in `/operating-model/governance-state`, and refuses further staffing jobs until a human clears the flag.

### Design notes

1. A human gate is a policy choice, not a hard platform requirement.
2. `full_auto` should still be auditable and easy to pause.
3. If a staffing loop repeatedly fails, the pack should stop mutating itself and surface the failure in the world model.
4. All three modes share the same two-job loop shape from Phase 4. The only difference is whether `agent-resources` waits on a decision thread before proceeding.

### Verification loop

1. Run the same staffing scenario in `advise` mode and assert a decision thread is produced instead of auto-apply.
2. Run it in `full_auto` and assert it completes with no human input.
3. Force a bad staffing config and verify the pack halts after 3 failures with `staffing_halted: true` in governance state.
4. Toggle `pause: true` mid-scenario and verify the next scheduled staffing job exits early.

## 11) End-to-End Acceptance Scenarios

Two scenarios must pass for `starter-company` v1 to be considered shipped. Both run in `full_auto` mode with no human intervention after the initial trigger.

### Scenario A — Self-staffing loop (exercises `ceo` + `agent-resources`)

1. Install `starter-company` via the install contract above.
2. Seed `.eve-org/mission.yaml` and `.eve-org/outcomes.yaml` with one goal that references a `researcher` capability that does not yet exist.
3. Set `.eve-org/governance.yaml: autonomy_posture: full_auto`.
4. Send `ceo` a chat message: "Look at our outcomes and tell me what's missing from the roster. If you think we need a researcher, hire one."
5. `ceo` reads the goals, observes the missing capability, and creates a staffing job for `agent-resources`.
6. `agent-resources` adds the `researcher` agent to `pack/agents/agents.yaml` and pushes the branch, then creates the apply job with `depends_on: [<change-job-id>]` and `hints.staffing_branch`.
7. The apply job runs `eve project sync --project proj_coord --ref <branch>` and verifies the new agent exists.
8. `ceo` assigns the `researcher` a trivial first task (e.g., "Summarize our current mission in one sentence to `/world-model/research-log`"). The task runs green.
9. Verify git history, job history, `/world-model/staffing-log`, and `/operating-model/company-graph` all reflect the new hire.

### Scenario B — Software engineering loop (exercises `ceo` + `software-engineer`)

1. Reuse the same pack install from Scenario A (or run in a clean org).
2. Seed `.eve-org/outcomes.yaml` with a goal that describes a needed product capability, e.g.:
   ```yaml
   ingest-support-threads:
     title: "Ingest Slack support threads into org docs for triage"
     owner: founder
     requires_app: support-ingest
   ```
3. Confirm `autonomy_posture: full_auto`.
4. Send `ceo` a chat message: "We need an app that ingests support threads and writes a normalized summary to `/world-model/support/`. Get the software engineer to build it."
5. `ceo` observes that the `support-ingest` app does not exist in the capability registry (Phase 1B capability discovery), and creates a job for `software-engineer` with the outcome text as its spec.
6. `software-engineer` reads the spec, loads `eve-fullstack-app-design` and `eve-new-project-setup`, and:
   1. Creates a new GitHub repo (`gh repo create`) and scaffolds it from `eve-horizon-starter`.
   2. Authors `.eve/manifest.yaml` with the right services, environments, and a single scheduled agent that polls Slack.
   3. Runs `eve project ensure ... --repo-url <new-repo>` to register the app with Eve.
   4. Runs `eve project sync` to install the manifest and agents.
   5. Triggers the build pipeline and waits for green.
   6. Runs `eve env deploy proj_xxx dev` to deploy the first environment.
   7. Runs `eve env diagnose` and `eve job follow` to confirm the agent is running.
7. SE writes `/operating-model/capabilities/support-ingest` describing the new capability and updates `/operating-model/company-graph` with the new `support-ingest-agent` actor and its `owns_capability` edge.
8. The world model picks up the new capability on its next synthesis cycle. `ceo` can now reference `support-ingest` in future delegations.
9. Verify git history, job history, pipeline runs, environment health, and the operating-model docs all reflect the new app.

### Pass bar for v1

If both scenarios work end-to-end without human intervention after the initial chat message, the pack is real. Scenario A proves the pack can grow itself; Scenario B proves the pack can ship software. Together they cover the complete "intent → agent → execution → world-model update" loop.

## 12) Milestone Acceptance

`starter-company` v1 is done when:

1. A small org can install it from a fresh repo with no bespoke setup beyond normal Eve credentials and GitHub token.
2. The pack can run conservatively or fully autonomously by config.
3. **Scenario A** (self-staffing loop with `ceo` + `agent-resources`) works end to end against current Eve primitives.
4. **Scenario B** (software engineering loop with `ceo` + `software-engineer` scaffolding and deploying a new Eve-compatible app) works end to end against current Eve primitives.
5. The pack is legible: goals, staffing changes, app builds, and current state are visible in docs / jobs / git history / pipeline runs / environment health.
