# Ideas Docs (Drafts)

This folder contains speculative or forward-looking designs. These are not authoritative.
If an idea diverges from current direction, it should be deleted or clearly marked.

Note: Most ideas predate the v2 manifest rollout. For current manifest format and
CLI usage, see `docs/system/manifest.md` and `docs/system/pipelines.md`.

## Keep and Reference

- `db-migrate-direct-and-reset.md` - (superseded) consolidated into `docs/plans/deploy-recovery-and-db-reset-plan.md`
- `activity-based-job-timeouts.md` - activity-based stuck detection instead of hard timeouts
- `observability-time-and-cost.md` - first-class execution timing + LLM usage/cost (jobs/pipelines/chat) with an extension path for Eve-compatible apps
- `exponential-compounding-engineering.md` - cross-repo model for capturing failures, promoting reusable fixes, and running guarded auto-remediation with a first-class fix ledger
- `continuous-codebase-distillation.md` - unifies failure compounding with proactive refactoring into a continuous loop that detects AI slop, dead code, and accretion debt, then safely distills the codebase using the test pyramid as a safety gate
- `agent-native-design.md` - generic guide that informs platform design
- `governance-layer-paperclip-synthesis.md` - differential analysis of Paperclip vs Eve Horizon, with an Eve-native operating-model proposal for mission, governance, approvals, routines, budgets, and exportable operating packs
- `company-as-intelligence-v2.md` - v2 synthesis extending the Paperclip analysis with Block's "company as intelligence" thesis, anchored in Eve's real wedge: small orgs scaling with very few humans — **promoted to design plan**: see `docs/plans/company-as-intelligence-plan.md`
- `agentic-pm-native-app-platform-gap-analysis.md` - architecture + gap analysis + primitive roadmap for a native PM app that works across org projects
- `agentic-pm-gap-closure-sketch.md` - (superseded) original closure sketch — see `docs/plans/agentic-pm-gap-closure-plan.md` for the implementation-ready design
- `agentic-app-platform-primitives-roadmap.md` - (consolidated) security-first ordered primitive backlog for agentic apps — consolidated into three parallel plans below
- `native-agentic-app-primitives-roadmap.md` - (consolidated) value-first phased roadmap for native agentic app primitives — consolidated into three parallel plans: `docs/plans/agentic-app-identity-auth-access-plan.md`, `docs/plans/agentic-app-context-intelligence-plan.md`, `docs/plans/agentic-app-infra-provisioning-plan.md`
- `app-role-permissions-mapping-and-ops.md` - CLI-first model for app-specific role->permission mapping, bindings, and policy-as-code sync
- `eve-app-marketplace.md` - discovery, install/upgrade, private distribution, licensing, and billing model for Eve-compatible apps
- `platform-primitives-for-agentic-apps.md` - detailed catalog of 8 platform primitives with schemas, API designs, and pros/cons for each
- `pm-app-agentic-product-management.md` - full design for a native PM app as the reference agentic Eve-compatible app
- `agent-team-coordination-gap-analysis-v2.md` - coordination threads + wake subscriptions + council/relay dispatch templates for multi-agent work
- `daily-health-summary-env-costs.md` - options for adding monthly per-environment costs to the Platform Sentinel daily Slack summary; recommends OpenCost estimates plus AWS CUR reconciliation
- `daily-health-summary-cluster-cost-truth.md` - verifies the Slack cost summary under-reports AWS usage, confirms the full operator account bill must not be shown as Eve cluster cost, and recommends Cost Explorer filtering plus infra tag propagation
- `agent-harness-secret-hardening.md` - plan to remove secrets from agent processes via capability broker
- `skills-sh-migration.md` - migrate from OpenSkills to skills.sh and add Eve AgentPacks (skills + agents/chat/harness metadata with overlays)
- `chat-client-integrations.md` - chat client integrations via the event spine
- `nostr-integration.md` - Nostr protocol integration: sovereign agents, DVMs, Lightning payments, open agent economy
- `nostrworld-agentic-paas.md` - nostrworld.com vision: Eve-on-GKE agentic PaaS for agents with Nostr keys + Bitcoin-native metering
- `object-store.md` - (superseded) S3-compatible object store design exploration — see `docs/plans/object-store-and-fs-plan.md` for the implementation plan that unifies object store with org filesystem
- `platform-resource-plane.md` - base platform gaps for multi-tenancy: usage metering, resource classes, budgets, identity extensibility, gateway plugins, and self-managing platform agents

- `platform-web-auth-supabase.md` - (superseded) pure JWT per-app approach — see `docs/plans/platform-web-auth-plan.md` for unified plan
- `platform-web-auth-supabase-sso.md` - (superseded) portable SSO approach — see `docs/plans/platform-web-auth-plan.md` for unified plan
- `channel-integrations-unified-plan-v2.md` - unified v2 plan for channels + multi-agent mission control
- `channel-integrations-unified-plan-v3.md` - fresh, elegant v3 plan for channels + agent runtime
- `channel-integrations-gap-analysis.md` - gap analysis + permissioned chat routing for any channel
- `clawdbot-personal-assistant-proposal.md` - proposal for personal assistant mode + chat gateway
- `cli-local-k3d-stack.md` - `eve local` commands: one-prerequisite local k3d stack for app developers and coding agents
- `eve-horizon-starter.md` - starter repo plan for onboarding and local-first setup
- `starter-cicd-self-healing.md` - CI/CD + remediation automation plan for the starter repo
- `open-decisions.md` - open decisions and TODOs with options/pros/cons
- `persistent-environments-platform.md` - platform vision for environments
- `persistent-runner-pools.md` - warm runner pools for fast swarm jobs
- `env-workers-first-class.md` - env-scoped workers for fast job execution
- `pipelines-vs-workflows.md` - separation of deterministic pipelines vs agent workflows
- `prd-to-epic-workflow.md` - PRD-driven workflow for design, planning, and parallel execution
- `cd-pipelines.md` - detailed CD pipeline design
- `workflows-as-skills.md` - workflow model for agent-native execution
- `self-service-deploy-recovery.md` - (superseded) consolidated into `docs/plans/deploy-recovery-and-db-reset-plan.md`

- `agent-team-coordination-gap-analysis.md` - gap analysis mapping Eve's coordination primitives against Claude Code's agent teams; proposes extensions via coordination threads, stay-alive supervision, sibling context, and council/relay topologies
- `document-ingestion-agent-packs.md` - agent-driven document ingestion as a composable platform pattern: thin ingest spine (upload → event → agent pack → org docs), Slack file download, org-fs watch paths, default Claude/Opus pack, app-specific overlays

- `automated-software-factory.md` - (v1, superseded) autonomous software factory vision with OpenSpec integration and agent pack primitive
- `automated-software-factory-v2.md` - (v2, superseded) software factory grounded in existing primitives: skillpack + agent config template, zero platform changes for MVP, multi-model review via team fanout, self-healing via system events
- `automated-software-factory-v3.md` - (v3, current) software factory as an Eve AgentPack: one-entry install via x-eve.packs, overlay-based customization, slug namespacing, phased roadmap from v2 primitives to AgentPack distribution

## Consolidated

- Runtime design consolidated into `runtime-core-design.md`
- Job model consolidated into `jobs-unified-design.md`
- Testing guidance consolidated into `integration-testing-strategy.md`
