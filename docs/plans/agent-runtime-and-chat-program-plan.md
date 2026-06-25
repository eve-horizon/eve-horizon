# Agent Runtime + Chat Program Plan (Master)

> Status: Completed
> Last Updated: 2026-02-04
> Purpose: Top-level orchestration plan that sequences all work for the agent runtime + chat gateway program.

## Scope
This plan coordinates all implementation work for:
- Agent/Team/Thread primitives
- Org-scoped Agent Runtime
- Hosted Slack gateway + identity approvals
- CLI + testware + example repo updates

## Execution Order (Recommended)

1) **Agents + Teams + Threads primitives**
   - Plan: `docs/plans/agents-teams-threads-primitives-plan.md`
   - Why: foundational schema, routing, and sync endpoints

2) **Agent Runtime (org-scoped)**
   - Plan: `docs/plans/agent-runtime-org-plan.md`
   - Why: runtime depends on primitives and job routing

3) **Chat Gateway + Slack integration**
   - Plan: `docs/plans/chat-gateway-slack-plan.md`
   - Why: gateway depends on routing + identity primitives

4) **CLI + Testware**
   - Plan: `docs/plans/cli-agent-ops-and-testware-plan.md`
   - Why: tooling maps to implemented endpoints and manual scenarios

## Cross-Cutting Requirements
- **Sandbox compatibility**: org FS mounted inside workspace (`{workspace}/.org`).
- **Sync safety**: `--ref` required by default; `--local` for dev.
- **Multi-tenant Slack**: map `team_id -> org_id`.

## Milestones
- M1: Primitives + sync endpoint live
- M2: Runtime executes agent jobs in warm pods
- M3: Slack events -> jobs -> replies end-to-end
- M4: CLI + manual scenario validates simulated Slack

## Success Criteria
- Agents/teams/routes can be synced and queried.
- Runtime executes jobs without per-message pod spin-up.
- Slack integration supports admin approvals in-channel.
- Manual scenario 08 passes on local stack.

## Definition of Done (Program)
- All four plans implemented with green integration tests.
- End-to-end flow: Slack message → route → job(s) → runtime → reply.
- Sandbox preserved: org FS only accessible via `{workspace}/.org`.
- Deterministic sync: `--ref` required by default; dirty syncs are non-deployable.
- Multi-tenant isolation enforced by Slack `team_id -> org_id` mapping.

## Completion Notes
- Integration tests: green (full suite).
- Manual Scenario 08 (chat gateway + Slack) validated on k3d.

## Compatibility / Migration
- Legacy `chat.*` config (if present) compiles into new `chat.yaml` routes during sync.
- No breaking changes to existing job/pipeline APIs; new primitives are additive.

## Security Invariants
- All chat-triggered execution requires explicit route permissions.
- External identity must be linked (or approved) before privileged routes run.
- No provider tokens are ever exposed to jobs.
