# Eve Horizon MVP Design

> **Historical / Deprecated**: This document is historical and may not reflect current behavior.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

> Status: Draft
> Last Updated: 2026-01-12
> Purpose: Define the minimum system needed to dogfood Eve Horizon quickly.

## Goals

- A new developer can be productive in minutes with the local stack.
- Core dogfooding loop works end-to-end: create project -> run tasks -> review -> iterate.
- SkillPack updates are picked up for new tasks without service restarts.

## Non-Goals (Post-MVP)

- Kubernetes deployment
- Marketplace and advanced SkillPack routing
- Dynamic tool installs
- Multi-tenant cloud security hardening

## Concepts (MVP)

- Skill: repo-local OpenSkills folder in `.agents/skills/` (committed)
- Project: container for a single Git repo (`repo_url` + `branch`)
- Repo: a Git repo with product code (most repos are not SkillPacks)
- Job: unit of work bound to a project and description (no skill_packs filter)
- JobWorkspace: per-job working dir that clones repos and owns the harness config directory
- Job Priority: scheduling hint to keep interactive requests responsive

**Terminology note**: "Job" is Eve Horizon's user-facing work unit. "Task" refers to cc-mirror's sub-agent coordination unit (Task* tools). A job may spawn multiple tasks for sub-agent work.

## User Journey (Dogfooding)

1) Clone eve-horizon
2) ./bin/eh start docker
3) Create org/project via CLI
4) Run jobs, review, approve
6) update repo skills (`.agents/skills/`) -> new jobs use updated skills

## Core Components (MVP)

- Web UI: Kanban board, onboarding, review actions
- API Gateway (NestJS): REST API + Clean Architecture
- Orchestrator: task lifecycle, dependency rules
- Skill Pack Resolution (Worker): repo-only skills from `.agents/skills/`
- Worker Service: single container image with all harnesses and tools
- Runtime Containers: Docker Compose (single worker image)
- Data Store: Supabase (single schema + RLS; post-MVP tenancy strategy TBD)
- Observability: logs + artifacts

## MVP Architecture Notes

SkillPack Sources
- Core SkillPacks are loaded from a default root
- Additional SkillPack sources can be added (local folders or repo subdirs)

Execution Flow
- Request -> resolve skill packs -> run harness -> store results
- HITL occurs in In Review state

Agent Harness (MVP)
- Default harness: mclaude (via cc-mirror)
- Harness working dir defaults to the repo inside the JobWorkspace
- All harnesses and sub-harnesses share the same config directory (SkillPacks + AGENTS.md)
- Invoke mclaude with JSONL output for observability (`--output-format stream-json`)
- Permissions via toolset config: PLAN variant blocks write tools, DEFAULT/AUTO allow full access
- Rationale: limit prompt-injection blast radius during exploration while preserving full autonomy for execution

mclaude CLI options (MVP subset)
- `--print` for non-interactive mode
- `--output-format stream-json` for structured JSONL logs
- `--model <model>` for model selection (sonnet, opus, haiku)

Variant permissions via toolset config (not CLI flags):
- Variants map to different `CLAUDE_CONFIG_DIR` paths
- Each config has a `.claude.json` with appropriate toolset
- PLAN variant: blocks Edit, Write, Bash tools
- DEFAULT/AUTO variant: full tool access

Provider switching via environment variables (cc-mirror pattern):
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_BASE_URL` for OpenRouter or custom providers
- `ANTHROPIC_DEFAULT_SONNET_MODEL`, etc. for model mapping

Scheduling Priority (MVP)
- Jobs include a priority (high/normal/low)
- Scheduler selects ready jobs by priority, then FIFO within a priority
- New user-request jobs default to high priority
- Background/batch jobs default to normal or low

Hot Reload (SkillPack Refresh)
- Skill Packs are resolved per job execution
- Running jobs keep the snapshot copied into their workspace
- New jobs use the latest definitions

Note: Project repo sync is separate from Skill Pack resolution. Repo updates change the code under work, not the available skill packs.

Infrastructure
- Supabase containers: Postgres + Auth + Kong only
- Supabase migrations run locally
- pg-boss for queue/cron

Repo Cache Strategy (MVP)
Recommended: bare mirror + per-job full clone
- Mirror is the shared object cache
- Per job: `git clone --reference-if-able <mirror> <job-dir>`
- Optional `--dissociate` for strict isolation
- Pool clean clones and reset/clean between jobs

Alternative: shared project checkout
- One checkout per repo per project
- Jobs use per-job working dirs or sandboxes
- Easiest to ship quickly, higher disk use

Worker Image
- Single image includes: mclaude (via cc-mirror, pre-installed variant)
- Core CLIs: git, gh, aws, supabase
- Worker image is configured via `WORKER_IMAGE` env only

Docker-dependent tests (MVP policy)
- Default: no Docker access from workers
- If enabled, use DinD sidecar per worker
- Avoid host docker.sock mounts unless explicitly trusted

## Minimal Data Model

- Org, User, Project
- Repo
- SkillPack, Workflow, Skill (metadata only)
- Job (status, deps, version snapshot)

## Minimal API Surface

- Create job
- Get job status
- Review action (approve / request changes / reject)

## CLI (MVP)

- Modular CLI mirrors REST API surface
- Stores tokens in user home like other CLIs
- Supports local and remote deployments
- Designed for use inside skills and Claude Code plugins

## Auth Context

- Supabase Auth access + refresh tokens
- API issues and verifies tokens
- Worker receives scoped context for org/project

## Success Criteria

- New developer can run the local flow without manual intervention
- SkillPack refresh verified: updates apply to new jobs
- Core SE app can run skills to build Eve Horizon itself

## Risks and Mitigations

- Hot reload breaks running jobs -> version pinning per job
- Tool/credential mismatch -> standardize base images
- Workflow invalidation -> loader rollback to last known-good
- Repo cloning costs -> shared cache per org/project

## Open Questions

- Should hot reload affect only new jobs or also running jobs at safe checkpoints?
- Repo cache strategy: shared workspace vs per-job clone?
