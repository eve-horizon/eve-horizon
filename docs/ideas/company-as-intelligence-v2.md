# Company as Intelligence v2: Eve for Lean, High-Leverage Companies

> Status: Proposal
> Last Updated: 2026-04-02
> Extends: `docs/ideas/governance-layer-paperclip-synthesis.md`
> Context: Block's "company as intelligence" thesis, adapted to Eve Horizon's actual customer wedge

## Thesis

Block is pointing at a real end state: replace the information-routing function of hierarchy with a continuously updated company model plus an intelligence layer that composes capabilities into action.

Eve should support that end state, but the first customer is not a 5,000-person company. The first customer is a 3-50 person org that wants to scale output far faster than headcount. These companies do not need an AI org chart first. They need a system that lets a handful of humans operate dozens of agents, capabilities, workflows, and customer loops without turning the founders into permanent routers of context.

For small orgs, the constraint is not middle-management overhead. It is founder bandwidth. Context lives in heads, Slack threads, PR comments, call notes, dashboards, and half-finished docs. People repeat the same goals, tradeoffs, and priorities over and over. Agents start work without enough company context, and humans become the glue.

Eve can become the best platform in the world for this mode of operating:

- small orgs use Eve to scale with very few humans
- mid-sized orgs use Eve to avoid adding coordination layers too early
- Block-like orgs use the same primitives to build a full "company as intelligence"

The wedge is lean-company leverage. The long-term ceiling is post-hierarchical coordination.

## What v1 Got Right

The v1 synthesis remains correct about the structural layer. Eve needs an org-scoped operating model over its execution substrate:

- mission and goals
- governance and approvals
- routines
- budget scopes
- audit
- packable company templates

That is still the skeleton.

## What v1 Still Missed

v1 was mostly a control-plane document. Block's thesis adds the missing dynamic layer:

- not just desired state, but a living world model
- not just reporting lines, but a company graph of humans, agents, capabilities, and outcomes
- not just cron routines, but intelligence policies that observe reality and compose action
- not just board governance, but lean-team leverage defaults
- not just static backlog planning, but demand signals that can propose work directly

The key shift is from "governance layer" to "coordination substrate."

## Product Positioning

Eve should not present this as "replace middle management for large enterprises."

It should present this as:

> Run a company with a very small number of humans because your operating context, coordination, and execution all live on one platform.

That positioning is stronger for Eve because it matches what the platform already does well:

- repo-first execution
- agent runtime plus workflows
- durable knowledge and artifacts
- event-driven automation
- cost accounting and policy enforcement
- chat plus thread-based coordination

The result is not "AI for productivity." It is "AI for company operating leverage."

## Design Rules

### 1. Build for 5 people before 5,000

If a primitive only makes sense once a company has management layers, it is too late in the stack. The first version must help a founder-led team with almost no formal hierarchy.

### 2. Reuse Eve's existing execution substrate

Do not add a second task system, second memory system, or second runtime. Reuse:

- orgs
- projects
- agents and teams
- jobs and workflows
- threads
- org docs and org filesystem
- receipts, usage records, and balances
- events, schedules, and policies

### 3. Replace `reports_to` with a company graph

Traditional reporting lines are too narrow. Eve needs relationships like:

- `owns_outcome`
- `owns_capability`
- `pulls_from`
- `coaches`
- `approves`
- `operates`
- `informed_by`

That works for humans, agents, teams, and services.

### 4. Treat the world model as a materialized synthesis, not magic

The first world model should be structured and boring. Start with synthesized state over known Eve primitives before attempting an open-ended AGI planner.

### 5. Default autonomy should be "observe -> recommend -> approve -> act"

For most companies, trust is the bottleneck. The intelligence layer should begin by proposing work and routing approvals, not silently taking high-risk actions.

### 6. Keep interfaces thin

Chat, dashboard, CLI, and app UIs are delivery surfaces. The intelligence should live in the model, policy, and execution layers, not be trapped in any one UI.

## Eve's Starting Advantage

Eve already has more of this stack than most people realize.

| Need | Eve already has | Why it matters |
| --- | --- | --- |
| Canonical work unit | Jobs, attempts, dependencies, workflows, reviews | The company already has one place where work lives |
| Shared coordination | Project threads, org threads, coordination threads | Conversations can be durable and machine-readable |
| Durable knowledge | Org docs, org filesystem at `/org`, job attachments, resource refs | Company memory can persist outside chat and individual sessions |
| Context carryover | Agent context for memory, docs, parent attachments, coordination inbox | Agents can start with shared context instead of blank prompts |
| Execution substrate | Agent runtime, worker, pipelines, deploys, app CLIs | The intelligence layer can compose real actions, not just tickets |
| Signal spine | Events, schedules, workflows, analytics | Reality can trigger work instead of humans creating everything manually |
| Cost visibility | Attempt receipts, usage records, org balance ledger, per-job budgets | Autonomy can be governed by spend and resource limits |
| Auditability | Audit log, attempt logs, lifecycle events, review flow | Humans can understand what happened and why |

That means Eve does not need to invent "company as intelligence" from scratch. It needs to add the thinnest possible operating layer over primitives it already owns.

## The Eve Stack for Company-as-Intelligence

### 1. Execution Substrate (existing)

This is the base layer Eve already ships:

- jobs, attempts, review, dependencies
- agents and teams
- workflows, pipelines, schedules
- agent runtime and worker
- chat gateway and threads
- app APIs and app CLIs

This is the layer that makes composed action possible.

### 2. Memory Substrate (mostly existing)

Eve already has the raw memory plane:

- org docs for versioned, queryable text knowledge
- org filesystem for shared files and durable artifacts
- job attachments for structured handoff between jobs
- thread history for conversational continuity
- carryover context so agents can see memory, docs, parent artifacts, and coordination messages at runtime

This is the layer that makes context reusable instead of repeatedly re-explained.

### 3. Control Substrate (mostly existing)

Eve already has core governance ingredients:

- receipts per attempt
- non-job usage records
- org balance ledger
- per-job budgets and budget blocking
- auth, RBAC, scoped tokens
- audit log and lifecycle visibility

This is the layer that makes autonomy governable.

### 4. Operating Model (new)

This is the repo-synced description of company intent:

- mission
- goals and outcomes
- capabilities
- company graph
- governance policies
- intelligence policies
- routines
- signal feeds
- operating packs

This is the layer v1 correctly identified.

### 5. World Model (new)

This is the continuously updated company picture synthesized from Eve's raw signals:

- what matters now
- what is blocked
- what outcomes are off target
- which capabilities are overloaded
- which routines are failing
- where budget is going
- what demand signals are rising

This is what replaces founders re-explaining the company in every loop.

### 6. Intelligence Layer (new)

This is the policy engine that turns the world model into action:

- observe signals
- determine whether a response is needed
- compose jobs, workflows, and agent invocations
- request approval where required
- attach the right context
- route spend and attribution

This is the thing Block is describing when it says the company becomes an intelligence.

### 7. Interfaces (existing/thin)

CLI, dashboard, chat, and app UIs remain important, but they are not the core differentiation. They surface the output of the model and the intelligence layer.

## Small-Org Wedge

A 6-person startup does not need "AI middle management." It needs:

- one place to store mission, goals, and current priorities
- explicit ownership of outcomes and capabilities
- agents that can read shared company context before acting
- real signals from product, support, sales, incidents, and revenue
- automatic creation of follow-up work when those signals cross thresholds
- cheap, explicit approvals for risky actions
- visibility into where agent time and model spend are going

That is enough to let six people operate like a much larger company without actually becoming one.

The right mental model is not "replace the VP layer."

It is:

> Make a small company legible enough, and executable enough, that software can do most of the coordination work.

For Eve, that is a much better first market.

## The New Primitives Eve Should Add

### 1. Org Operating Model Sync

Create an org-scoped, repo-first sync flow for company operating state.

Possible layout:

```text
.eve-org/
  mission.yaml
  outcomes.yaml
  capabilities.yaml
  company-graph.yaml
  signals.yaml
  intelligence.yaml
  governance.yaml
  routines.yaml
  packs.yaml
```

Rules:

- desired state lives in Git
- parsed state lives in Postgres
- live overlays stay in Postgres
- this is org-scoped, not buried in one project's manifest

This becomes the canonical source of company intent.

### 2. Capability Registry

Block's model starts with capabilities. Eve should make them explicit.

A capability is not just a service. It is any reusable building block the company can compose:

- a deployed service or API
- a workflow
- a pipeline
- an app CLI
- an agent or team
- a data feed
- a runbook-backed operating procedure

Each capability should declare:

- owner
- interface surface
- dependencies
- SLO or reliability expectations
- cost profile
- approval class
- linked docs and runbooks

For small orgs, this is how knowledge stops depending on one engineer remembering how something works. For large orgs, this is how the intelligence layer knows what it can compose.

### 3. Company Graph

Replace a narrow accountability tree with a richer graph.

Nodes:

- humans
- agents
- teams
- capabilities
- outcomes
- routines

Edges:

- `owns_capability`
- `owns_outcome`
- `pulls_from`
- `coaches`
- `approves`
- `operates`
- `informed_by`

Role vocabulary should be lightweight and explicit:

- `ic` owns capabilities
- `dri` owns outcomes
- `player_coach` owns craft quality and development

One human can hold all three roles in a small company. An AI agent can be an IC. A human can be a DRI who pulls from both humans and agents. This is a better fit than pretending everything is a conventional org chart.

### 4. World Model Service or AgentPack

The world model should start as a structured synthesis layer built on existing Eve primitives.

Inputs:

- jobs, attempts, receipts, reviews
- workflows, schedules, deployments
- thread traffic
- org docs and org filesystem changes
- analytics and event streams
- external integrations and app-level signals

Outputs:

- current outcome health
- blocked work summaries
- capability load and failure hotspots
- top demand signals
- recommended next actions
- context packs for agent invocation

Implementation path:

- first version can be an Eve-native AgentPack plus background jobs
- long-term it may deserve a dedicated service
- initially prefer materialized summaries and deterministic queries over open-ended prose synthesis

This is the primitive that removes founder and manager context-broadcasting from the critical path.

### 5. Signal Feeds and Domain Model Spec

Block's thesis depends on "honest signal." For Block that is transaction data. For Eve customers, the signal is more varied.

For a lean software company, useful signals may be:

- activation and conversion metrics
- product usage drops
- support thread volume
- production incidents
- pipeline breakage
- sales call themes
- churn reasons
- revenue and payment failures
- code review latency
- unresolved security findings

Eve should let orgs declare these as signal feeds in the operating model:

- where they come from
- how often they refresh
- how they map to outcomes and capabilities
- what policies can react to them

This is how "customer reality generates backlog" without requiring every company to build its own internal platform first.

### 6. Intelligence Policies

Add a declarative way to say:

- when the world model observes X
- and the risk level is Y
- then create or update Z
- under these approval and budget constraints

Examples:

- if onboarding time-to-first-deploy worsens for seven days, create an outcome review job for the onboarding DRI
- if support threads mention the same failure mode three times in 24 hours, create a bug investigation job and attach relevant threads
- if an outcome is overspending relative to progress, trigger a budget review
- if a capability is unhealthy and the fix is low-risk, run a diagnostic workflow automatically

These should compile into existing Eve jobs, workflows, schedules, and events. This is not a second automation engine.

### 7. Typed Governance Gates

General approvals from v1 become more important in the v2 model because the intelligence layer is now originating work.

Eve should support typed approvals with:

- risk class
- request payload
- linked outcome or capability
- linked thread for discussion
- optional linked job or workflow
- decision record and rationale

Use cases:

- deploy approval
- budget override
- goal creation
- capability retirement
- agent lifecycle changes
- customer-impacting policy changes

The system should make it easy to move from:

- observe only
- observe and recommend
- observe and request approval
- observe and act automatically

That progression is the trust adoption path.

### 8. Budget Scopes and Attribution

Current receipts and usage records already provide the plumbing. Eve needs better attribution and policy surfaces.

Budget scopes should attach to:

- outcome
- capability
- routine
- agent or team
- optionally signal feed or experiment

Every execution should be attributable to:

- who initiated it
- what it served
- what policy triggered it
- what budget it consumed

This is what allows a small company to operate many agents without losing control of spend, and what allows a large company to understand whether the intelligence layer is actually allocating resources well.

### 9. Operating Packs

The endgame is not just primitives. It is distribution.

An OperatingPack should bundle:

- operating model templates
- company graph templates
- capability patterns
- signal feed definitions
- intelligence policies
- governance defaults
- linked AgentPacks and docs

This lets Eve ship opinionated starting points such as:

- `lean-saas-company`
- `agency-operator`
- `marketplace-operator`
- `platform-company`
- eventually, more Block-like multi-surface operating models

That is how Eve turns a hard internal capability into a platform advantage.

## Example Shape

Illustrative only:

```yaml
version: 2

mission:
  title: "Ship a self-serve developer platform that feels instant"

outcomes:
  first-deploy:
    title: "New developers deploy in under 5 minutes"
    owner: founder
    measures:
      - metric: onboarding.time_to_first_deploy
        target: "< 5m"

capabilities:
  deploy-runtime:
    owner: infra-agent
    interfaces:
      - type: workflow
        ref: deploy
      - type: cli
        ref: eve env deploy
    slos:
      - "deploy success > 99%"
      - "median deploy < 5m"

company_graph:
  actors:
    founder:
      kind: human
      roles: [dri, player_coach]
    infra-agent:
      kind: agent
      roles: [ic]
    docs-agent:
      kind: agent
      roles: [ic]
  edges:
    - { type: owns_outcome, from: founder, to: first-deploy }
    - { type: owns_capability, from: infra-agent, to: deploy-runtime }
    - { type: pulls_from, from: founder, to: infra-agent }
    - { type: coaches, from: founder, to: docs-agent }

signals:
  onboarding.time_to_first_deploy:
    source: analytics
    query: onboarding_ttfd_7d
  support.onboarding-friction:
    source: org_threads
    query: "deploy OR onboarding OR stuck"

intelligence:
  policies:
    onboarding-regression:
      when:
        all:
          - metric: onboarding.time_to_first_deploy
            op: ">"
            value: "10m"
          - trend: worsening_7d
      then:
        create_job:
          workflow: onboarding-regression-review
          owner: founder
          attach_world_model: true
      approval: none

governance:
  approvals:
    production_deploy: required
    budget_override: required
    new_goal: required
  budgets:
    first-deploy:
      scope: outcome:first-deploy
      action: warn
```

## How This Looks in a Lean Company

A seven-person SaaS company on Eve might run like this:

- humans own mission, a handful of outcomes, and final approvals
- agents own capabilities such as deploy/runtime, docs, support triage, pricing analysis, and release operations
- the world model watches activation, incidents, support friction, spend, and code health
- intelligence policies create work when those signals move
- weekly operating review is just a routine that distills the world model into an org thread plus follow-up jobs
- no one spends their day routing status across chat, docs, dashboards, and tickets

That company still has human leadership, taste, and judgment. It just does not need proportional growth in coordination headcount.

## How This Scales Up to a Block-Like Company

The same primitives extend upward:

- the company graph becomes multi-layered and cross-functional
- capabilities include regulated systems, data products, and interface surfaces
- signal feeds become richer and more domain-specific
- DRIs can own large cross-cutting outcomes over fixed time horizons
- approvals and budget scopes get more sophisticated
- the world model becomes more than a summary layer and begins to support forecasting and simulation

The important point is that Eve does not need one architecture for startups and another for Block. It needs one architecture whose first default works for startups.

## What Eve Should Not Copy

- no second issue tracker beside jobs
- no separate comment system beside threads
- no separate runtime abstraction beside jobs, workflows, agent runtime, and worker
- no database-only mutable company config that bypasses repo-first sync
- no assumption that every company wants or needs a literal org chart
- no fully autonomous high-risk actions by default

## Rollout Sequence

### Phase 1: Lean Operating Model

Ship the minimum that helps small orgs immediately:

- org operating model sync
- outcomes and capability registry
- company graph
- typed approvals
- budget scopes
- operating packs
- weekly operating review routine template

This is enough to make a small company legible and governable on Eve.

### Phase 2: World Model

Add the synthesis layer:

- world model agent or service
- outcome health summaries
- blocked-work and capability-load views
- context injection from world model into agent jobs
- signal feed ingestion and normalization

This is enough to remove founder-as-router from many loops.

### Phase 3: Intelligence Policies

Add declarative composition:

- observe -> recommend policies
- observe -> request approval policies
- selective observe -> act policies for low-risk domains
- automatic goal proposals from demand signals
- spend attribution by outcome, capability, and policy

This is enough to make the company operate more like an intelligence than a hierarchy.

### Phase 4: Block-Scale Extensions

Only after the lean-company path works:

- richer domain model tooling
- simulation and forecasting over the world model
- more advanced board and portfolio views
- marketplace distribution of operating packs
- large-company multi-entity coordination patterns

## Honest Constraints

### The world model is only as good as the artifacts

Companies that do not generate machine-readable work will not get much value. Eve is best suited to remote-first, artifact-heavy organizations.

### Signal quality matters more than AI sophistication

A bad signal feed produces bad coordination. For many small orgs, the first job is not better reasoning. It is getting support, product, revenue, and operational signals into Eve in a usable form.

### Trust adoption will be gradual

Most companies will not let the intelligence layer act broadly on day one. That is fine. Eve should optimize the transition path, not force the end state.

## Summary

Block's thesis is directionally right: hierarchy is an information-routing workaround, and AI creates a new option.

Eve should support that future, but its immediate opportunity is smaller and better: help lean organizations scale with very few humans by making company context durable, machine-readable, and executable.

That requires a stack above today's execution substrate:

- an org operating model
- a capability registry
- a company graph
- a world model
- signal feeds
- intelligence policies
- governance gates
- budget attribution
- operating packs

If Eve builds those layers on top of the primitives it already has, it can be the best platform in the world for companies that want Jack's vision without first needing Block's size, talent density, or internal tooling budget.
