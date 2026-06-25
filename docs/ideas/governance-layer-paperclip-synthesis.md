# Paperclip vs Eve Horizon: Eve-Native Company Operating Model

> Status: Proposal
> Created: 2026-03-31
> Purpose: Capture what Paperclip actually is today, compare it against Eve Horizon, and propose an elegant Eve-native way to offer the same company-level functionality without copying Paperclip's runtime or task model.

## Research Scope

This proposal is based on direct review of the Paperclip repo and docs, including:

- `README.md`
- `doc/GOAL.md`
- `doc/PRODUCT.md`
- `doc/SPEC-implementation.md`
- `doc/DATABASE.md`
- `doc/TASKS.md`
- `doc/spec/agents-runtime.md`
- `doc/spec/agent-runs.md`
- `doc/plugins/PLUGIN_SPEC.md`
- `doc/CLIPHUB.md`
- `docs/api/{companies,agents,issues,approvals,routines}.md`
- key db and service surfaces under `packages/db/src/schema`, `server/src/services`, and `ui/src/pages`

It is also based on direct review of Eve Horizon's current docs and data/query layer, including:

- `README.md`
- `docs/system/{agents,threads,chat-routing,events,pricing-and-billing,agent-runtime,skills,auth,chat-gateway,extension-points,analytics,orchestrator,job-api,workflows,pipelines,unified-architecture}.md`
- `packages/db/src/queries/{agents,agent-configs,teams,jobs,threads,events,org-documents,balance-ledger,usage-records,agent-runtime}.ts`
- `eve-read-eve-docs` references for agents, jobs, observability, storage, workflows, and harnesses

## Thesis

Paperclip and Eve Horizon solve different layers of the same problem.

- Paperclip is a company control plane. It models mission, org chart, approvals, budgets, recurring work, and operator governance for teams of agents.
- Eve Horizon is an execution platform. It runs jobs and agents, routes chat, builds and deploys apps, stores docs and files, enforces auth, tracks receipts, and orchestrates workflows.

The right synthesis is not "port Paperclip into Eve."

The right synthesis is:

1. Keep Eve's existing execution substrate.
2. Add an org-scoped operating model above it.
3. Reuse jobs, threads, docs, receipts, events, and packs instead of adding a second task system, a second runtime, or a second memory system.

Eve should absorb Paperclip's company functionality as a thin governance and operating layer, not as a clone of Paperclip's issue tracker and adapter architecture.

## What Paperclip Actually Is

Paperclip is best understood as a board-level operating system for an AI company.

### Core product shape

Paperclip's implemented or explicitly V1-contracted center of gravity is:

- `companies` as the top-level tenant/business object
- `agents` as employees with adapter config, role, reporting line, budget, and status
- `goals`, `projects`, and `issues` as the work hierarchy
- `issue_comments`, keyed issue documents, and attachments as the primary communication and artifact surface
- `heartbeat_runs` as the runtime loop for agents
- `approvals` for governed actions such as hiring and strategy approval
- `cost_events` with monthly budget rollups and hard-stop auto-pause semantics
- `activity_log` as the immutable audit surface

### Important adjacent surfaces in the current repo

Paperclip has already grown beyond the narrow V1 core and now also contains:

- `routines` with schedule/webhook/api triggers plus concurrency and catch-up policies
- company skills management and project scanning
- execution workspaces and reusable runtime sessions
- import/export of company packages and the ClipHub concept for downloadable companies
- a plugin runtime with UI slots, worker processes, tool contributions, event hooks, and config/state tables

### Design center

Paperclip is deliberately:

- runtime-agnostic: agents run via process/http/local adapters
- task-centric: issues and comments are the main coordination primitive
- board-centric: operator visibility and approvals are first-class
- company-scoped: nearly every business entity is attached to a company

### Deliberate boundaries

Paperclip is also explicit about what it is not:

- not a chat product
- not a deployment platform
- not a CI/CD system
- not an agent framework
- not a PR/review tool

That boundary matters. Many Paperclip design choices exist because it does not own execution, deployment, or app runtime.

## Differential Analysis

### High-level contrast

| Concern | Paperclip Today | Eve Today | Implication |
| --- | --- | --- | --- |
| Business boundary | `company` | `org` | Eve already has the right top-level object; do not add a parallel `company` entity |
| Work unit | `issue` | `job` | Eve should keep jobs as the canonical work object |
| Agent execution | heartbeats + adapters | jobs + harnesses + worker + agent runtime | Eve should not import Paperclip's adapter model |
| Conversation | issue comments and approval comments | threads, chat routing, thread messages | Eve should reuse threads everywhere |
| Knowledge/artifacts | issue docs, attachments, company skills | org docs, org fs, cloud fs, job attachments, AgentPacks | Eve already has the stronger memory/artifact layer |
| Recurring work | routines | schedules, events, workflows, cron triggers | Eve needs a thin routine object, not a new scheduler |
| Budgeting | company/agent monthly budgets, hard-stop auto-pause | receipts, usage records, org balance ledger, per-job caps | Eve needs governance policies and budget scopes, not new cost plumbing |
| Org chart | strict `reports_to` tree | org-wide agent directory but no reporting graph | Eve needs an accountability graph |
| Governance | generic approvals + activity log | job review + some auth/admin flows | Eve needs a generalized approval and audit layer |
| Templates | company import/export + ClipHub | AgentPacks and marketplace direction | Eve should package operating models as packs, not company DB dumps |
| Plugins | plugin worker runtime | lighter extension points today | not required for functional parity with Paperclip's core value |

### Where Paperclip is stronger today

Paperclip is ahead of Eve in six specific ways:

1. It has a first-class company operating model.
2. It has an explicit goal tree linking work to mission.
3. It has a strict reporting graph between agents.
4. It has generic approvals beyond task review.
5. It has recurring work as a first-class object with useful concurrency semantics.
6. It has an operator-facing audit vocabulary for "who changed what."

### Where Eve is already stronger

Eve is materially stronger than Paperclip in the execution substrate:

- chat gateway and threaded inbound/outbound comms
- warm agent runtime and worker/runner execution
- repo-aware workspaces, git controls, and toolchains
- pipelines, workflows, deploys, releases, builds, environments
- org docs, org filesystem, cloud fs, and resource hydration
- richer auth and RBAC
- receipts, pricing, balance ledger, usage metering, and analytics
- event spine and webhook delivery

That means Eve does not need Paperclip's runtime architecture. It only needs the governance and operating abstractions.

## Design Rules for Eve

Any Eve-native answer should follow these rules.

### 1. Org is the company boundary

Do not introduce `company` as a second top-level tenant object. Eve `orgs` already carry the right semantics for isolation, billing, auth, docs, and agent directory.

### 2. Jobs remain the canonical work object

Do not add a Paperclip-style parallel issue system. Eve jobs already have:

- hierarchy
- dependencies
- attempts
- review
- receipts
- git/workspace controls
- workflow and pipeline expansion

Paperclip's issue semantics should map onto jobs plus richer metadata, not onto a second database table.

### 3. Threads remain the conversation primitive

Do not create separate comment tables for every governed object if Eve already has threads.

Approvals, goals, routines, and board discussions should attach to `threads` and `thread_messages`, not reinvent issue comments or approval comments.

### 4. Desired state stays repo-first

Paperclip stores most of its company model directly in the database. Eve should not.

Eve's strength is repo-first sync. The desired-state representation for governance should live in a control repo or pack, then sync into the API with raw YAML plus parsed state plus git metadata.

### 5. Runtime state stays in the database

The database should still own operational state:

- approvals
- audit events
- spend counters
- pause overlays
- routine run history
- live job and thread activity

In other words:

- desired state in Git
- control state in Postgres
- execution state in Postgres plus workspaces plus object storage

### 6. Reuse existing Eve primitives before inventing new ones

The goal is to add the thinnest possible new layer over:

- orgs
- agents
- teams
- jobs
- threads
- events
- org docs/fs
- receipts and ledgers
- AgentPacks

## Proposed Eve-Native Solution

The elegant answer is a new org-scoped primitive: the **Org Operating Model**.

## Org Operating Model

An **Org Operating Model** is the missing Eve layer above project manifests and below the board UI.

It is an org-scoped, repo-synced description of:

- mission
- goal graph
- accountability graph
- governance policies
- budget policies
- routines
- pack references for shared company knowledge and role templates

This is the Eve-native analog of Paperclip's company configuration.

### Shape

Conceptually:

```text
Org
  -> Operating Model (desired state)
       -> Mission
       -> Goals
       -> Accountability graph
       -> Governance policies
       -> Budget scopes
       -> Routines
       -> Shared pack refs / org knowledge refs

  -> Existing Eve execution layer
       -> Projects
       -> Agents
       -> Teams
       -> Jobs
       -> Threads
       -> Events
       -> Docs / FS
       -> Receipts / balances
```

### Why this is the right abstraction

It lets Eve represent the same thing Paperclip represents, but in Eve terms:

- company mission becomes org mission
- org chart becomes accountability metadata over Eve's agent directory
- issues become jobs
- comments become threads
- company skills become AgentPacks plus org docs
- recurring work becomes routines that compile into events/jobs/workflows
- operator governance becomes policy and approval objects over the existing API

## The New Thin Primitives

### 1. Operating Model Sync

Add an org-scoped sync flow analogous to `eve agents sync`, but for governance and operating state.

Possible layout:

```text
.eve-org/
  model.yaml
  goals.yaml
  routines.yaml
  governance.yaml
  docs/
```

Stored in the API as:

- raw YAML
- parsed objects
- git SHA / ref / branch
- pack refs

This becomes the source of truth for company-level intent.

The key point is scope:

- project manifests remain project-scoped
- org operating model is org-scoped

Do not wedge org-wide governance into one random project's `.eve/manifest.yaml`.

### 2. Goal Graph

Paperclip's goal hierarchy is worth importing, but it should bind to Eve jobs and workflows.

Add first-class org-scoped goals with:

- `id`
- `org_id`
- `parent_id`
- `title`
- `description`
- `owner_agent_slug`
- `status`
- optional target dates and metadata

Then let the existing Eve work layer attach to goals:

- jobs
- workflows
- pipeline runs
- org docs
- spend records and receipts

What this unlocks:

- "why" context injection into jobs
- spend by goal and by goal subtree
- better board views than a flat job list
- direct mapping from mission -> objective -> execution

This should integrate with existing resource hydration and carryover context. A job tied to a goal should see:

- goal ancestry
- linked goal brief docs
- linked board/approval thread context when relevant

### 3. Accountability Graph

Paperclip's strict reporting tree should become an org-scoped **accountability graph** over Eve's agent directory.

Use Eve's existing org-wide agent directory and org-unique slugs. Add org-level relationship metadata:

- `reports_to`
- title / functional role
- capability tags
- delegation authority
- budget authority
- optional scope constraints

This should not replace `teams`. Teams remain operational dispatch groups. The accountability graph answers a different question:

- teams: who works together on execution
- accountability graph: who may delegate, approve, or own outcomes

This distinction is important. Paperclip blends org chart and execution together because it is task-centric. Eve can separate them cleanly.

### 4. Policy Engine + General Approvals

Paperclip's generalized approvals are the most important missing governance primitive in Eve.

Add a typed approval object with:

- `type`
- `org_id`
- `status`
- `requestor`
- `payload`
- `thread_id`
- optional `job_id`
- optional `goal_id`
- decision metadata

Use it for:

- hire/change/retire agent proposals
- budget overrides
- production deploy approvals
- goal changes
- routine activation
- custom policy-gated actions

The elegant Eve-native move is to make approvals **thread-backed**.

Instead of separate approval comment tables:

- every approval gets an org thread
- discussion happens through existing thread messages
- related jobs can post status into the same thread

That gives Eve a better approval surface than Paperclip with less duplication.

### 5. Repo-First Change Proposals for Agent Lifecycle

Paperclip mutates live agent definitions in the database. Eve should keep agent desired state repo-first.

That means "hire an agent" should usually mean:

1. create a structured change proposal against the owning repo or org control repo
2. open an approval object
3. on approval, apply the desired-state change
4. sync agents / operating model

Operational overlays still live in DB:

- paused
- budget-exceeded
- temporarily disabled
- runtime health
- monthly spend counters

So the model becomes:

- Git owns the intended org chart and agent roster
- DB owns the live overlay state

This is substantially more Eve-native than copying Paperclip's mutable agent CRUD.

### 6. Budget Scopes and Cost Attribution

Paperclip's monthly company/agent budget model is valuable, but Eve already has the underlying cost machinery:

- execution receipts
- `llm.call` usage events
- org balance ledger
- usage records
- per-job caps

What is missing is the policy layer and the attribution layer.

Add budget policies scoped to:

- org
- accountability node
- goal
- routine
- optionally agent or team

Each policy should support:

- `track_only`
- `warn`
- `hard_stop`

And each execution should carry attribution tags such as:

- `goal_id`
- `delegated_by_agent_slug`
- `routine_id`
- `budget_scope_id`

That makes it possible to answer the questions Paperclip is good at:

- what is this company spending on
- who is burning budget
- which goal is worth the cost
- where should the board intervene

### 7. Routines as a Thin Layer over Events and Jobs

Paperclip's routines are worth adopting almost verbatim at the semantic level, but not as a separate execution plane.

In Eve:

- a routine is an org-scoped recurring work object
- its triggers compile into existing events
- its execution target is an agent, team, workflow, or pipeline
- its run history is stored as a control-plane object

The important Paperclip behaviors to preserve are:

- schedule/webhook/manual trigger kinds
- concurrency policies:
  - `coalesce_if_active`
  - `skip_if_active`
  - `always_enqueue`
- catch-up policies for missed ticks

Eve already has cron, workflows, and event routing. What it lacks is a first-class object joining them together in a board-readable way.

### 8. Audit Ledger

Eve's event spine is not the same thing as a governance audit log.

Add an immutable audit ledger with actor-attributed entries for:

- approval created / decided
- governance policy changed
- routine created / paused / resumed
- agent overlay paused / resumed
- goal created / updated / cancelled
- budget threshold crossed
- board override performed

This should remain distinct from the event spine:

- event spine is for orchestration
- audit ledger is for accountability and operator review

### 9. OperatingPacks

Paperclip's import/export and ClipHub concepts are strong. Eve should absorb them as a pack problem, not as a database export problem.

Add a future **OperatingPack** concept:

- exportable org operating model
- goal templates
- org chart overlays
- routine definitions
- linked AgentPack refs
- starter docs and board playbooks

This is a cleaner fit for Eve than "download a company database dump."

It also aligns with Eve's existing pack and marketplace direction.

## Paperclip Capability Coverage in Eve Terms

| Paperclip Capability | Eve-Native Answer |
| --- | --- |
| company | org + org operating model |
| agent employee | existing project agent + org accountability metadata |
| issue | job |
| issue comments | thread messages |
| issue documents | org docs or job attachments |
| issue attachments | job attachments or object store |
| heartbeat | existing job/agent-runtime execution |
| agent runtime state | existing attempts, workspaces, runtime overlays |
| generic approval | approval object + thread + optional linked job |
| company skill | AgentPacks + org docs + org fs/cloud fs |
| recurring routine | routine -> event -> job/workflow/pipeline |
| company budget | org budget scopes over receipts and ledger |
| per-agent monthly spend | attribution and runtime overlays over receipts |
| activity log | audit ledger |
| company import/export | OperatingPack export/import |
| ClipHub | future Eve marketplace for OperatingPacks |
| execution workspace | existing Eve workspace and git controls |
| runtime adapter | existing harness profile and worker/agent runtime |

## What Eve Should Explicitly Not Copy

### 1. Do not add a second task system

No `issues` table beside `jobs`.

That would split routing, attempts, receipts, review, dependencies, and UI into two worlds for no benefit.

### 2. Do not add a second runtime abstraction

No Paperclip-style adapter framework as the main path for agent execution.

Eve already has:

- harnesses
- worker
- agent runtime
- toolchains
- git/workspace controls

That is the right substrate.

### 3. Do not regress to comment-centric coordination

Paperclip uses issue comments because it lacks a stronger conversation primitive.

Eve already has threads. Use them.

### 4. Do not create a plugin runtime just to reach parity

Paperclip's plugin runtime solves extension problems in Paperclip's architecture. It is not required for Eve to gain company governance.

Packs, manifests, events, APIs, and future marketplace work are enough for the overlapping problem.

### 5. Do not make one project repo the source of truth for org governance

This is the biggest architectural trap.

Org-wide governance must be synced from an org-scoped control repo or pack, not buried in one app repo's manifest.

## Example Shape

Illustrative only:

```yaml
version: 1

mission:
  title: "Ship Eve Horizon V1 with a credible self-serve developer experience"
  summary: "Everything should reduce time-to-first-deploy and keep the platform governable."

goals:
  launch-v1:
    title: "Launch V1"
    owner: founder
    children:
      platform-stability:
        title: "Stable local + staging operation"
        owner: cto
      self-serve-onboarding:
        title: "Developers deploy in under 5 minutes"
        owner: product-lead

accountability:
  founder:
    ref: founder
    title: "Founder / Board"
    capabilities: [strategy, approvals]
  cto:
    ref: cto
    reports_to: founder
    title: "CTO"
    capabilities: [architecture, delegation, hiring]
    budget_scope: cto-monthly
  product-lead:
    ref: product-lead
    reports_to: founder
    title: "Product Lead"
    capabilities: [product, docs, onboarding]

governance:
  approvals:
    agent_change: required
    budget_override: required
    production_deploy: required
  budgets:
    default_policy: warn
    scopes:
      cto-monthly:
        limit:
          currency: USD
          amount: 300
        action: hard_stop
      launch-v1:
        goal: launch-v1
        limit:
          currency: USD
          amount: 2000
        action: warn

routines:
  monday-board-review:
    trigger:
      cron: "0 9 * * 1"
      timezone: Europe/London
    target:
      agent: founder
    create:
      workflow: weekly-board-review
      goal: launch-v1
    concurrency: coalesce_if_active
    catch_up: skip_missed

packs:
  - source: github.com/eve-horizon/eve-operating-packs/founder-board
    ref: v0.1.0
```

## Rollout Sequence

### Phase 1: org operating model, goals, approvals, audit

Ship the minimum control-plane layer:

- org operating model sync
- goal graph
- approval object
- audit ledger
- thread-backed discussions for approvals and goals

This is enough to make Eve legible as a company operating system.

### Phase 2: accountability graph, budget scopes, routines

Then add the policy and recurring-work layer:

- org accountability graph
- budget scopes with warn/hard-stop policies
- routine object with concurrency/catch-up semantics
- spend by goal / accountability node / routine

### Phase 3: board UI and OperatingPack export/import

Only after the primitives exist:

- org board dashboard
- approval inbox
- goal tree and spend views
- routine health views
- OperatingPack export/import
- future marketplace integration

## Summary

Paperclip's core insight is correct: once many agents are working in parallel, you need a company operating model, not just a runtime.

Eve already owns the harder layer:

- execution
- workspaces
- chat
- files and docs
- workflows
- deployments
- auth
- cost accounting

So Eve should not copy Paperclip's issue tracker or adapter runtime.

It should add a thin, org-scoped operating model that gives Eve:

- mission and goals
- accountability and delegation
- approvals and audit
- recurring board-readable work
- governance-aware budget scopes
- exportable operating packs

That delivers the functionality Paperclip is aiming at, but in a form that fits Eve's architecture instead of fighting it.
