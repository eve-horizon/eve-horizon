# Agentic Product Management App (Eve PM)

> Status: Idea
> Last Updated: 2026-02-10
>
> Inputs:
> - docs/system/manifest.md, agents.md, chat-gateway.md, integrations.md
> - docs/ideas/automated-software-factory-v3.md (AgentPack pattern)
> - docs/ideas/skills-sh-migration.md (pack distribution)
> - docs/ideas/prd-to-epic-workflow.md (upstream PRD workflow)
> - docs/plans/system-dashboard-app-plan.md (app structure precedent)

## North Star

**A persistent, voice-enabled product management surface that sits upstream of
the software factory — turning fuzzy ideas into code-grounded plans, and
turning live codebases into legible product context for PMs.**

```
PM ──voice/text──► Eve PM App ──agents──► Target Project Codebase
 ▲                     │                         │
 │                     ▼                         ▼
 └─────── Rich UI ◄── PM Database ◄──── Agent Results
                       │
                       ▼
                  Handoff ──► Eve Jobs ──► Software Factory
```

The PM never touches code. The codebase comes to them — pre-digested by agents
into architecture maps, risk assessments, and feasibility reports. Plans are
grounded in reality before a single implementation job fires.

---

## The Core Insight: Two Execution Domains

The PM app has a split personality:

1. **It's an Eve app** — own DB, UI, agents, deployed via Eve
2. **It reaches into other projects** — its agents run inside target project
   workspaces with full code checkout

This maps cleanly onto Eve's existing primitives:

- **PM App** = Eve project with services (DB, API, Web UI) + PM-side agents
- **PM AgentPack** = Installed into target projects via `x-eve.packs`
  - Agents run IN the target project (have code checkout)
  - Agents call PM App API via org-scoped secrets to read/write PM data

This is the same pattern as the Software Factory. The factory is an AgentPack
installed into target projects. Eve PM extends this with a persistent backend
that accumulates product knowledge.

```
┌────────────────────────────────┐      ┌──────────────────────────────┐
│   Eve PM App (Eve Project)     │      │   Target Software Project    │
│                                │      │                              │
│  Services:                     │      │  x-eve.packs:                │
│   - db (Postgres)              │      │   - software-factory         │
│   - api (REST + WebSocket)     │      │   - eve-pm-agents  ◄── ★    │
│   - web (React UI)             │      │                              │
│                                │      │  PM agents execute here:     │
│  PM-side agents:               │      │   - pm-code-recon            │
│   - pm-synthesizer             │      │   - pm-plan-drafter          │
│   - pm-voice-processor         │      │   - pm-plan-reviewer         │
│   - pm-slack-concierge         │      │   - pm-feasibility-check     │
│                                │      │   - pm-handoff               │
│                        ◄── REST ──────┤                              │
│  PM App API                    │      │  (agents call PM API using   │
│     ▲                          │      │   org-scoped PM_API_TOKEN)   │
│     │ Eve API ◄── REST ────────┼──────┤                              │
│     │                          │      │                              │
└─────┼──────────────────────────┘      └──────────────────────────────┘
      │
   PM uses web UI, voice, Slack
```

---

## How It Works (End to End)

### 1. PM Captures an Idea

PM speaks into the web UI or types in Slack. The PM app stores the raw input:

```
PM (voice): "We need to let users export their data as CSV.
             Maybe PDF too. The compliance team is asking."
```

PM-side agent (`pm-synthesizer`) structures this into a proto-feature:

```yaml
feature:
  title: "User data export (CSV + PDF)"
  motivation: "Compliance requirement"
  rough_scope: [csv_export, pdf_export, user_data_selection]
  open_questions:
    - "Which data entities are in scope?"
    - "Does PDF need formatting or raw dump?"
    - "Any rate limiting or async processing needed?"
```

### 2. PM Requests a Code Grounding

PM clicks "Ground in Reality" in the UI. The PM app backend:

1. Calls Eve API to create a job in the **target project**
2. Job uses the `pm-code-recon` agent (from PM AgentPack)
3. Agent has the target project's full codebase checked out
4. Agent reads architecture, data models, existing export logic
5. Agent calls PM App API with a structured report:

```yaml
code_insight:
  project: "my-saas-app"
  relevant_modules:
    - path: "src/services/export/"
      description: "Existing CSV export for admin users only"
      complexity: low
    - path: "src/models/user_data.ts"
      description: "User data model with 12 entity types"
      complexity: medium
  existing_patterns:
    - "Background job queue (Bull) for heavy operations"
    - "PDF generation via Puppeteer (already a dependency)"
  risks:
    - "User data model includes PII — export must respect GDPR"
    - "No rate limiting on existing export endpoint"
  feasibility: "High — existing patterns cover CSV and PDF generation"
  estimated_scope: "Medium — extend existing export service + add user-facing UI"
```

### 3. PM Drafts a Grounded Plan

PM reviews the code insight in the UI, refines the feature. Then triggers
a plan draft. The PM app creates a job in the target project using
`pm-plan-drafter`:

- Agent reads: code insight from PM DB + codebase + proto-feature
- Agent produces: a plan that respects actual architecture
- Agent stores plan in PM DB via REST AND optionally commits to repo

### 4. Plan Review + Refinement

PM-side agents or target-project agents review the plan:

- `pm-plan-reviewer` (runs in target project): cross-checks plan vs code
- `pm-feasibility-check`: validates estimates against codebase complexity
- PM reviews in the UI, iterates with agents

### 5. Handoff to Implementation

PM approves the plan. `pm-handoff` agent:

1. Creates an Eve epic job in the target project
2. Decomposes into child jobs per the plan
3. Wires dependencies, git controls, review gates
4. Software factory AgentPack (already installed) picks up the work

The PM app tracks the link: `PM plan → Eve epic job ID`

### 6. Ongoing: Bidirectional Status

- **Code → PM**: Scheduled `pm-code-recon` runs keep code insights fresh
- **Jobs → PM**: PM app polls Eve API for job status on linked epics
- **PM → Devs**: PM can annotate, reprioritize, ask questions via the UI
- **Slack**: `@eve pm-status my-saas-app` → status from PM perspective

---

## PM App Architecture

### Manifest

```yaml
# .eve/manifest.yaml
schema: eve/compose/v1
project: eve-pm

registry:
  host: ghcr.io
  namespace: myorg
  auth:
    username_secret: GHCR_USERNAME
    token_secret: GHCR_TOKEN

services:
  db:
    image: postgres:16
    ports: [5432]
    environment:
      POSTGRES_DB: eve_pm
      POSTGRES_USER: eve_pm
      POSTGRES_PASSWORD: ${secret.DB_PASSWORD}
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "eve_pm"]
      interval: 5s
      timeout: 3s
      retries: 5

  api:
    build:
      context: ./apps/api
    ports: [3000]
    environment:
      DATABASE_URL: postgres://eve_pm:${secret.DB_PASSWORD}@db:5432/eve_pm
      EVE_API_URL: ${EVE_API_URL}
      EVE_SERVICE_TOKEN: ${secret.EVE_SERVICE_TOKEN}
      WHISPER_API_KEY: ${secret.WHISPER_API_KEY}
    depends_on:
      db:
        condition: service_healthy
    x-eve:
      ingress:
        public: true
        port: 3000
      api_spec:
        type: openapi
        spec_url: /openapi.json

  web:
    build:
      context: ./apps/web
    ports: [8080]
    depends_on: [api]
    x-eve:
      ingress:
        public: true
        port: 8080

  migrate:
    image: flyway/flyway:10
    command: >-
      -url=jdbc:postgresql://db:5432/eve_pm
      -user=eve_pm
      -password=${secret.DB_PASSWORD}
      -locations=filesystem:/migrations migrate
    volumes:
      - ./db/migrations:/migrations:ro
    depends_on:
      db:
        condition: service_healthy
    x-eve:
      role: job

environments:
  staging:
    pipeline: deploy
  production:
    pipeline: deploy
    approval: required

x-eve:
  packs:
    - source: eve-horizon/eve-skillpacks
      ref: <sha>

  agents:
    config_path: agents/agents.yaml
    teams_path: agents/teams.yaml

  defaults:
    harness: mclaude
    harness_profile: pm-orchestrator
```

### Data Model

```
projects              — linked Eve projects (eve_project_id, eve_org_id, repo metadata)
ideas                 — raw inputs (voice transcripts, text, slack messages)
features              — structured feature concepts derived from ideas
plans                 — implementation plans (versioned, linked to features + code insights)
code_insights         — auto-generated architecture summaries per project
  └─ modules          — code module descriptions within an insight
  └─ risks            — identified risks
discussions           — threaded conversations (PM ↔ agents, PM ↔ PM)
  └─ messages         — individual messages in a discussion
sessions              — voice/meeting capture sessions with transcripts
handoffs              — links between PM plans and Eve jobs (plan_id → eve_job_id)
```

### API Surface

```
# Projects
GET    /api/projects                     — list linked projects
POST   /api/projects                     — link an Eve project
GET    /api/projects/:id                 — project detail + latest code insight

# Ideas
POST   /api/projects/:id/ideas          — capture idea (text, voice transcript)
GET    /api/projects/:id/ideas          — list ideas
PATCH  /api/ideas/:id                   — update/refine idea

# Features
POST   /api/projects/:id/features       — create feature from idea(s)
GET    /api/projects/:id/features       — list features
PATCH  /api/features/:id                — update feature

# Code Insights (written by agents, read by UI)
GET    /api/projects/:id/insights       — latest code insight
GET    /api/projects/:id/insights/:ver  — specific version

# Plans
POST   /api/features/:id/plans          — create plan (triggers agent)
GET    /api/features/:id/plans          — list plan versions
GET    /api/plans/:id                   — plan detail
PATCH  /api/plans/:id                   — update plan (agent or human)
POST   /api/plans/:id/review            — trigger plan review
POST   /api/plans/:id/approve           — approve plan
POST   /api/plans/:id/handoff           — trigger handoff to Eve jobs

# Discussions
POST   /api/features/:id/discussions    — start discussion
POST   /api/discussions/:id/messages    — add message (human or agent)
GET    /api/discussions/:id/messages    — list messages

# Voice
POST   /api/voice/transcribe            — upload audio, get transcript
WS     /api/voice/stream                — real-time voice transcription

# Agent callback (called BY agents running in target projects)
POST   /api/agent/code-insight          — store code insight result
POST   /api/agent/plan-draft            — store plan draft
POST   /api/agent/plan-review           — store plan review result
POST   /api/agent/handoff-result        — store handoff job links
```

---

## PM AgentPack (Distributed to Target Projects)

### Repo Layout

```
eve-pm-agents/
├── skills/
│   ├── pm-code-recon/SKILL.md          — analyze codebase, report to PM API
│   ├── pm-plan-drafter/SKILL.md        — draft plan using code + feature context
│   ├── pm-plan-reviewer/SKILL.md       — review plan against codebase
│   ├── pm-feasibility-check/SKILL.md   — validate scope/complexity estimates
│   └── pm-handoff/SKILL.md             — create Eve jobs from approved plan
├── eve/
│   ├── pack.yaml
│   ├── agents.yaml
│   ├── teams.yaml
│   ├── chat.yaml
│   └── x-eve.yaml
└── README.md
```

### Agent Roster (`eve/agents.yaml`)

```yaml
version: 1
agents:
  pm_code_recon:
    slug: pm-code-recon
    skill: pm-code-recon
    harness_profile: deep-reasoning
    description: >
      Analyzes codebase architecture, patterns, risks.
      Stores structured insight in PM App via REST.
    policies:
      permission_policy: auto_edit
      git: { commit: never, push: never }   # read-only analysis

  pm_plan_drafter:
    slug: pm-plan-drafter
    skill: pm-plan-drafter
    harness_profile: deep-reasoning
    description: >
      Drafts implementation plan grounded in actual code.
      Reads feature + code insight from PM API, writes plan back.
    policies:
      permission_policy: auto_edit
      git: { commit: auto, push: on_success }

  pm_plan_reviewer:
    slug: pm-plan-reviewer
    skill: pm-plan-reviewer
    harness_profile: primary-reviewer
    description: >
      Cross-checks plan against codebase. Flags unrealistic
      assumptions, missing edge cases, architectural conflicts.
    policies:
      permission_policy: auto_edit
      git: { commit: never, push: never }

  pm_feasibility_check:
    slug: pm-feasibility-check
    skill: pm-feasibility-check
    harness_profile: fast-triage
    description: >
      Quick scope/complexity validation against code.
    policies:
      permission_policy: auto_edit

  pm_handoff:
    slug: pm-handoff
    skill: pm-handoff
    harness_profile: deep-reasoning
    description: >
      Creates Eve epic + child jobs from approved plan.
      Wires dependencies, git controls, review gates.
      Links jobs back to PM plan via PM API.
    policies:
      permission_policy: auto_edit
      git: { commit: auto, push: on_success }
```

### Target Project Installation

```yaml
# Target project's .eve/manifest.yaml
x-eve:
  packs:
    - id: software-factory
      source: https://github.com/org/eve-software-factory
      ref: <sha>
      namespace:
        slug_prefix: "${project_slug}-"

    - id: pm-agents
      source: https://github.com/org/eve-pm-agents
      ref: <sha>
      namespace:
        slug_prefix: "${project_slug}-pm-"
```

Org-scoped secrets (set once, available to all projects):

```bash
eve secrets set PM_API_URL "https://pm.myorg.example.com/api" --scope org
eve secrets set PM_API_TOKEN "pm_tok_xxxx" --scope org
```

---

## Agent Skill Mechanics

### How a PM Agent Reads Code AND Writes to PM DB

Example: `pm-code-recon/SKILL.md` (sketch)

````markdown
# PM Code Reconnaissance

You are a code reconnaissance agent. Your job is to analyze the codebase
you're checked out in and produce a structured architecture report.

## Context

- You have the full project codebase in your workspace
- You have access to the PM App API via environment variables:
  - `PM_API_URL` — base URL of the PM App
  - `PM_API_TOKEN` — auth token for the PM App API
- Your job description contains the `pm_project_id` and `feature_id` (if any)

## Steps

1. Read the project structure (package.json, README, docs/, src/)
2. Identify key modules, services, data models, and patterns
3. Assess relevant risks (security, complexity, technical debt)
4. Check recent git history for active areas of change

## Output

Call the PM App API to store your analysis:

```bash
curl -X POST "${PM_API_URL}/agent/code-insight" \
  -H "Authorization: Bearer ${PM_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @- <<EOF
{
  "pm_project_id": "<from job description>",
  "modules": [...],
  "patterns": [...],
  "risks": [...],
  "recent_changes": [...],
  "summary": "..."
}
EOF
```

Also produce a human-readable summary in the job result.
````

### How the PM App Triggers Jobs in Target Projects

The PM App backend calls the Eve API:

```typescript
// PM App backend — trigger code reconnaissance
async function triggerCodeRecon(project: LinkedProject, featureId?: string) {
  const response = await eveApi.post(
    `/projects/${project.eveProjectId}/jobs`,
    {
      description: `PM code reconnaissance for ${project.name}`,
      agent_slug: `${project.slug}-pm-code-recon`,
      hints: {
        pm_project_id: project.id,
        feature_id: featureId,
      },
      git: {
        ref: 'main',
        commit: 'never',
        push: 'never',
      },
    },
    { headers: { Authorization: `Bearer ${serviceToken}` } }
  );

  return response.data.job_id;
}
```

---

## Slack / Claude Code Integration

### Slack Commands

PM agents are accessible via Slack because they have slugs:

```
@eve pm-code-recon          — run code recon on the project bound to this channel
@eve pm-plan-drafter        — draft a plan for the latest feature
@eve pm-status              — get PM-level status (features, plans, handoffs)
```

The PM app also has its own Slack-facing agent (`pm-slack-concierge`) that
runs in the PM app project:

```
@eve pm ask "What's the status of the CSV export feature?"
@eve pm brainstorm "We need better onboarding for enterprise customers"
```

### Claude Code (Developer's Laptop)

Developers can query PM context from their terminal:

```bash
# Check PM plans for this project
eve pm plans --project my-saas-app

# Get the latest code insight
eve pm insight --project my-saas-app

# See feature pipeline
eve pm features --project my-saas-app --status approved
```

This requires a thin CLI extension or wrapper that calls the PM App API.

---

## Voice Input Architecture

### Single-User Voice (PM at Desk)

- **Browser Web Speech API** for quick-and-dirty real-time transcription
- **Whisper API / Deepgram** for higher quality async transcription
- Flow: PM clicks mic → audio captured → sent to PM API → transcribed →
  stored as idea → PM-side agent structures it

### Meeting Capture Mode (Future)

- Longer-form recording with MediaRecorder API
- Upload to transcription service (Deepgram, AssemblyAI) with diarization
- Speaker labels mapped to team members
- PM-side agent produces structured meeting summary → ideas/action items
- Stored in PM DB as a session with linked ideas

### Voice Tech Stack (Recommended)

| Layer | Option | Notes |
|-------|--------|-------|
| Capture | MediaRecorder API | Browser-native, works everywhere |
| Quick transcription | Web Speech API | Free, real-time, lower quality |
| Quality transcription | Deepgram Nova-2 | Best price/quality, real-time streaming |
| Meeting diarization | Deepgram or AssemblyAI | Speaker labels, punctuation |
| Summarization | PM-side agent (Opus) | Structures transcript into ideas |

---

## Gap Analysis

### No Platform Gaps (Works Today)

| Capability | How It Works |
|-----------|-------------|
| PM App deployment | Standard Eve app (services + environments) |
| PM AgentPack distribution | `x-eve.packs` in target projects |
| Agents reading code | Job runs in target project workspace |
| Agents calling PM API | Org-scoped secrets (`PM_API_URL`, `PM_API_TOKEN`) |
| Slack routing to PM agents | Agent slugs + chat gateway |
| Job status tracking | Eve API polling from PM backend |
| Voice transcription | External service + PM API endpoint |

### Minor Gaps (Workarounds Exist)

| Gap | Impact | Workaround | Platform Fix |
|-----|--------|------------|-------------|
| Service-to-service auth | PM backend → Eve API | Use CLI-obtained token or SSH key auth from backend | Service account primitive |
| Cross-project job listing | PM needs job status from many projects | Iterate projects, call Eve API per project | Cross-project query endpoint |
| Webhook notifications | PM app wants push when jobs complete | Agent calls PM API at end of job + polling | Eve webhook/callback on job completion |
| PM CLI extension | `eve pm` commands | Shell wrapper calling PM App API | CLI plugin system |

### Not Gaps (Deferred / External)

| Item | Why It's Not a Gap |
|------|-------------------|
| Voice transcription | External service (Deepgram/Whisper), pure frontend + API work |
| Meeting diarization | External service, future enhancement |
| Real-time UI updates | WebSocket from PM API to web client, standard web dev |
| Multi-project dashboard | PM App aggregates from Eve API, standard app dev |

---

## Relationship to Existing Docs

### vs. Software Factory (v3)

The software factory turns plans into code. Eve PM turns ideas into plans.
They're complementary and sequential:

```
Eve PM ──(approved plan)──► Software Factory ──(code)──► Production
```

Both use the AgentPack distribution model. A target project can have both
installed. The `pm-handoff` agent explicitly creates jobs that the factory
agents execute.

### vs. PRD-to-Epic Workflow

The PRD workflow (`prd-to-epic-workflow.md`) describes the execution side:
take a PRD, review it, decompose it, execute it. Eve PM is the **authoring
side**: help the PM create that PRD in the first place, grounded in code
reality. Eve PM's `pm-handoff` agent would trigger the PRD workflow.

### vs. System Dashboard

The dashboard (`system-dashboard-app-plan.md`) is an engineering tool — job
boards, logs, debugging. Eve PM is a product tool — ideas, features, plans,
voice capture. They could share UI components and both call the Eve API,
but serve different personas and have different data models.

---

## Phased Delivery

### Phase 1: PM App Shell + Code Recon

1. Bootstrap PM app from starter (`eve init eve-pm`)
2. Build API + DB with projects, ideas, code_insights tables
3. Build minimal web UI (project list, idea capture, insight viewer)
4. Build `pm-code-recon` skill + agent
5. Create PM AgentPack repo with code-recon agent
6. Install into a test target project, run code recon, verify round-trip
7. Deploy PM app to Eve staging

**Validates**: cross-project agent execution + PM API callback pattern

### Phase 2: Feature + Plan Drafting

1. Add features, plans tables to PM DB
2. Build plan drafting UI (feature → plan flow)
3. Build `pm-plan-drafter` + `pm-plan-reviewer` skills
4. Wire plan draft → review → refine cycle in UI
5. Add voice input (Web Speech API for quick, Deepgram for quality)

**Validates**: full ideation → grounded plan flow

### Phase 3: Handoff to Implementation

1. Build `pm-handoff` skill (creates Eve jobs from approved plan)
2. Add handoffs table, link PM plans to Eve job IDs
3. Build status tracking (poll Eve API for linked job progress)
4. Integrate with Software Factory (handoff creates factory-compatible epic)

**Validates**: PM → implementation pipeline end-to-end

### Phase 4: Slack + Claude Code Integration

1. Add `pm-slack-concierge` agent to PM app project
2. Wire Slack commands for PM queries and brainstorming
3. Build `eve pm` CLI wrapper for developer-side queries
4. Add Slack notifications for plan updates, handoff status

### Phase 5: Meeting Capture + Rich Voice

1. Add meeting capture mode (MediaRecorder + diarization service)
2. Build session model with speaker labels and linked ideas
3. Add real-time transcription streaming via WebSocket
4. PM-side agent summarizes meetings into structured outputs

### Phase 6: Multi-Project Intelligence

1. Scheduled code-recon runs across all linked projects
2. Cross-project feature dependencies and impact analysis
3. Portfolio-level planning views
4. Trend detection (code velocity, risk accumulation, technical debt)

---

## Open Questions

1. **Auth model for PM App API**: Should PM agents use a simple API token,
   or should the PM app issue scoped tokens per project? Token-per-project
   is more secure but more operational overhead.

2. **Plan storage**: Should plans live only in the PM DB, only in the target
   repo (as markdown), or both? Repo storage gives version control and
   developer visibility. DB storage gives rich querying and UI. Probably both
   with the DB as primary and repo as optional commit.

3. **Who triggers code-recon?** On-demand only? Scheduled? On every push to
   main? Scheduled (daily) + on-demand seems right for v1. Push-triggered
   might be noisy.

4. **Should the PM AgentPack be a separate repo or part of the PM app repo?**
   Separate repo follows the factory pattern. Part of the PM app repo keeps
   things together. Lean toward separate — it's what gets installed into
   target projects and should have its own versioning.

5. **Multi-org support**: If the PM app serves multiple orgs, secrets and
   auth need per-org scoping. The Eve API already handles this, but the PM
   app's own auth model needs to account for it.

6. **Relationship to the dashboard**: Should Eve PM and the system dashboard
   be the same app with different views, or separate apps? Separate is
   cleaner (different personas, different data models) but shared auth and
   UI primitives would reduce duplication.

