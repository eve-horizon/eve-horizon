# Eve Horizon Unified Architecture

> Status: Current
> Last Updated: 2026-02-12
> Purpose: Describe the core components and runtime flow for Eve Horizon.

## Overview

Eve Horizon is a job-first platform for running **skills** from repo-local Skill Packs against Git repos. Skills are installed into `.agents/skills/` from `skills.txt` and executed by CLI-based agents inside isolated containers. Automation flows through a central **event spine** in Postgres, which routes triggers into pipelines and workflows.

Eve Horizon is **CLI-first**: humans and AI agents use the CLI as the primary interface. The REST API is the substrate that powers the CLI and any future UI.

Related docs: [api-philosophy.md](./api-philosophy.md), [openapi.md](./openapi.md), [packages/cli/README.md](../../packages/cli/README.md).

**Terminology note**: "Job" is Eve Horizon's user-facing work unit. "Task" refers to cc-mirror's sub-agent coordination unit (Task* tools). A job may spawn multiple tasks for sub-agent work.

## Current (Implemented)

The system is job-first with a single repo per project, an event spine, manifest-defined pipelines/workflows, and agent runtime + chat gateway primitives. Web auth is provided by GoTrue + the SSO broker service; provider registry + pricing feed receipts and budget enforcement.

## Core Components

1) CLI (current)
- Primary interface for humans and AI agents (`@eve/cli`)
- Thin REST wrapper; no DB bypass
- Dev/ops helpers live separately under `./bin/eh`

2) Web UI (planned; not yet implemented)
- Kanban-style job board per project
- Onboarding and project creation (new repo or existing git URL)
- Job review and approval

3) API Gateway (NestJS)
- Clean Architecture service boundary
- Receives job requests
- Manages auth, orgs, projects, and users
- Exposes REST API for all core functionality
- Stores and resolves encrypted secrets at user/org/project scope

3.1) SSO Broker (Web Auth)
- Central browser login/session service for Supabase Auth
- Exchanges Supabase tokens for Eve RS256 tokens

4) Chat Gateway (Slack + WebChat)
- Normalizes external chat events into Eve events
- Maps Slack `team_id -> org_id`
- Routes chat messages into agents/teams/workflows/pipelines

5) Orchestrator / Scheduler
- Claims ready jobs and drives execution
- Routes events via trigger matching (polling the event spine)
- Drives job lifecycle; HITL review states are planned

6) Skills (Repo-Local)
- Skills are read directly from `.agents/skills/` in the cloned repo after install
- No syncing or copying; harness reads skills from workspace at runtime

7) Worker Service (Default + Optional Variants)
- Runs selected harness (mclaude or zai via cc-mirror)
- Executes script and action jobs (build/release/deploy/run/notify)
- Includes core CLIs (git, gh, aws, supabase)
- Applies sandbox and approval policies
- Captures artifacts, logs, and exit status
- Injects resolved secrets into the job environment and runs optional post-clone hooks
- Host env comes from `.env` (optional) plus `system-secrets.env.local` for OAuth tokens

8) Agent Runtime (Org-Scoped Warm Pods)
- Dedicated service for chat-triggered workloads
- Maintains warm pods per org to reduce cold starts
- Receives heartbeat + placement updates from runtime pods

9) Runtime (K8s-first)
- K8s is primary runtime for local + staging + prod
- Docker Compose is a dev convenience (not default)
- Orchestrator routes jobs to workers via `EVE_WORKER_URLS`
- Each job runs in an isolated runner pod

10) Data Store (Postgres)
- Stores orgs, projects, jobs, attempts, events, pipeline runs
- RLS and multi-tenant policies are post-MVP

11) Observability (partial)
- Job logs and execution artifacts
- Execution receipts with cost + timing breakdowns
- CLI-friendly diagnostics for local and remote targets

## Core Concepts (Implemented)

SkillPack
- A folder containing skills, prompts, and references
- Skills are repo-only, sourced from paths listed in `skills.txt` and installed into `.agents/skills/`

Skill
- A single directory with a `SKILL.md` in OpenSkills format
- Namespaced as `<pack>/<skill>` to avoid collisions

Repo
- A Git repo containing the project code (most repos are not SkillPacks)

Job
- Unit of work with dependencies and phase-based lifecycle
- ID: `{slug}-{hash8}` for root jobs, `{parent}.{n}` for children (max depth 3)
- Phases: idea → backlog → ready → active → review → done/cancelled
- Priority: 0-4 (P0=critical, P4=backlog)
- See [job-api.md](./job-api.md) for full API specification

Project
- ID: TypeID (e.g., `proj_01abc...`)
- Container for a single Git repo
- Stores `repo_url`, `branch`, and `slug`
- `slug` (4-8 chars) is used to generate job IDs

## Planned (Not Implemented)

- Web UI and end‑user onboarding flows.
- Review UI support (workflow is implemented; UI is not).
- Worker registry (beyond env-mapped routing).
- Multi-tenant RLS policies beyond local dev.

## Legacy / Removed

- Multi‑repo project models (removed in simplified config refactor).

Organization
- ID: TypeID (e.g., `org_01xyz...`)
- Container for projects, users, and billing (post-MVP)

JobAttempt (JobWorkspace)
- ID: UUID (internal) + `attempt_number` (1, 2, 3...) per job
- API/CLI reference attempts by job ID + attempt_number
- Per-attempt working directory that clones project repos
- Owns the config directory used by all harnesses and sub-harnesses
- Each new attempt creates a new isolated workspace

Harness Invocation
- Typed envelope describing initial/follow-up/setup/cleanup actions
- Includes optional execution hints (harness, worker_type, permission, timeout)
- Fully replayable for reconstruction after worker recycling

## Skill Loading

- Skills are read directly from `.agents/skills/` in the cloned repo after install
- No syncing or copying to harness config directories
- Harness reads skills from the workspace at runtime
- New jobs see updated skills when the repo is cloned fresh

## Scheduling and Priority (MVP)

Goal: Keep new user-request jobs responsive even when a backlog exists.

Approach:
- Jobs carry a priority level (e.g., high/normal/low)
- Scheduler selects ready jobs by priority first, then FIFO within a priority
- New user-request jobs default to high priority in MVP
- Long-running or batch jobs default to normal/low

Notes:
- Priority only affects selection order; it does not bypass dependencies
- Concurrency is bounded by worker capacity; ready jobs queue in Postgres

## Local Developer Flow (MVP)

1) Clone the repo
2) Run ./bin/eh k8s start (default runtime)
3) Create org + project via CLI (see README quick start)
4) Create jobs and advance phases via CLI

Optional quick dev loop: `./bin/eh start docker` for fast iteration without runner pods.

## CLI Tools and Credentials

See [cli-tools-and-credentials.md](./cli-tools-and-credentials.md) for:
- Single worker image with required tools and harnesses
- Read-only host credential mounts (local)
- Secrets/OAuth for cloud (post-MVP)

## Infrastructure (MVP)

- Supabase: Postgres + Auth + Kong only
- Migrations run as job services in pipelines (no local CLI migrate step)
- Event spine in Postgres for triggers/automation (cron/webhooks/planned schedulers)

## Repo Caching and Reuse

- Workers need fast access to project repos
- Prefer a shared repo cache per project
- Reuse clones across jobs when safe
- Avoid cross-org leakage by scoping cache to org/project

Options (MVP)
Recommended: shared bare mirror + per-job full clone
- Maintain a bare mirror per repo as the object cache
- Per job: full clone with `--reference-if-able` from the mirror
- Optional `--dissociate` for strict isolation
- Pool clean clones for reuse (reset/clean between jobs)

Alternative: shared project checkout + job sandbox
- One checkout per repo per project
- Jobs operate in sandboxed copies or separate work dirs
- Simplest to implement, more disk usage

## Agent Harness Design

See [agent-harness-design.md](./agent-harness-design.md) for:
- Harness invocation contract
- Multi-repo JobWorkspace layout
- SkillPack + AGENTS.md injection
- Session continuity and HITL
- Observability pipeline

## Extension Points

See [extension-points.md](./extension-points.md) for MVP extension points and CLI plugin patterns.

## Auth Context Propagation

- Supabase Auth access + refresh tokens (planned for hosted deployments)
- Tokens passed through API -> worker as scoped context
- CLI stores tokens in user home like other CLIs

## MVP vs Future

MVP
- Docker Compose runtime
- Single-host execution
- Kanban UI and HITL review
- SkillPack refresh (filesystem watch or git pull for repo-sourced SkillPacks)
- Single worker image with all harnesses/tools
- REST API + modular CLI for all core actions

Future
- Kubernetes runtime
- Advanced routing and marketplace
- Dynamic tool installs
