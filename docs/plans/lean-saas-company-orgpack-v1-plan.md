# Lean SaaS Company OrgPack v1 Implementation Plan

> Status: Draft
> Last Updated: 2026-04-08
> Purpose: Deliver the first richer vertical OrgPack for developer-tool and API-first startups, built on top of the generic `starter-company` foundation.
> Depends On:
> - `docs/plans/company-as-intelligence-plan.md`
> - `docs/plans/orgpack-platform-phase-1-plan.md`
> - `docs/plans/starter-company-orgpack-v1-plan.md` (must ship first; this pack layers on top)
>
> Repo location: a new sister repo `../lean-saas-company`. It references `starter-company` via `x-eve.packs` in its manifest so the three starter roles (`ceo`, `agent-resources`, `software-engineer`) and their skills come from a single source of truth rather than being duplicated.

## 0) Product Shape

`lean-saas-company` is not the generic on-ramp. It is the first opinionated operating pack for a specific company type:

1. developer-tool startups
2. API-first SaaS teams
3. small companies that care about deploy health, onboarding, support friction, and usage/spend signals

It can be installed two ways:

1. directly as a richer pack
2. incrementally by letting `starter-company` grow into an equivalent org shape over time

## 1) Goals

1. Provide useful specialist roles out of the box.
2. Ship pre-wired signal connectors for the core SaaS operating loops.
3. Materialize a weekly operating review with minimal setup.
4. Provide low-risk policy automation for the most obvious startup reactions.

## 2) Non-goals

1. Generic compatibility with every business model.
2. Marketplace, agency, or enterprise operating models.
3. Broad autonomous action across every high-risk domain on day one.
4. A second architecture separate from `starter-company`.

## 3) Success Bar

This plan is successful when:

1. A SaaS team can install the pack and get a more useful setup than `starter-company` without custom engineering.
2. The pack ships with concrete specialist roles and a company graph that already makes sense for this wedge.
3. The operating review and at least one low-risk policy are functioning end to end.
4. The pack still composes cleanly with `starter-company` rather than replacing it with a different runtime model.

## 4) Execution Checklist

| Status | Area | Item | Acceptance |
| --- | --- | --- | --- |
| - [ ] | Foundation | Reuse `starter-company` core and define the richer pack shape | `lean-saas-company` is clearly an extension, not a forked architecture |
| - [ ] | Agents | Ship specialist roles and harness profiles | The pack has immediate operational value after install |
| - [ ] | Signals | Add core SaaS signal sources and normalization flows | The world model sees product, reliability, and support reality |
| - [ ] | Reviews | Ship weekly operating review output to org threads | Founders can review the business from the pack output alone |
| - [ ] | Policies | Add low-risk query + compose policies | The pack creates useful follow-up work automatically |
| - [ ] | Migration | Document direct install and upgrade-from-starter flows | Users can adopt either path cleanly |
| - [ ] | Verification | Add focused end-to-end checks for connectors, policies, and review | The pack is reproducible, not hand-wavy |

## 5) Phase 1: Compose `lean-saas-company` from `starter-company`

### Reuse mechanism

`lean-saas-company` is a pack repo that overlays `starter-company`. Its `.eve/manifest.yaml` declares `starter-company` as a pack reference:

```yaml
# .eve/manifest.yaml
x-eve:
  packs:
    - id: starter-company
      source: github.com/eve-horizon/starter-company
      ref: main
```

The unified sync in `packages/cli/src/lib/sync-project.ts:resolvePacksAndMerge` already handles pack resolution and merge semantics: this pack's `pack/agents/agents.yaml` adds specialist roles on top of the starter pack's agents, and collision rules in `resolvePacksAndMerge` catch duplicate agent ids.

This gives us:

1. One source of truth for `ceo`, `agent-resources`, and `software-engineer` (the starter pack).
2. Lean-saas-specific roles and skills live only in this repo.
3. The starter pack can evolve independently; this pack picks up changes by bumping `ref`.

### Deliverables

1. Reference `starter-company` as an `x-eve.packs` entry so the core three starter roles and their skills come from one place.
2. Predefine a richer initial roster in `pack/agents/agents.yaml` (overlays the starter pack's agents map).
3. Ship lean-saas-specific `.eve-org/` templates that layer on top of starter:
   1. `.eve-org/signals.yaml` — signal source definitions
   2. `.eve-org/intelligence.yaml` — policy definitions
   3. `.eve-org/capabilities.yaml` — richer initial capability catalog
4. Publish install docs that explain direct install vs grow-from-starter.

### Initial specialist roles (in addition to those from `starter-company`)

At minimum:

1. `world-model` — synthesis agent (from umbrella plan Section 4)
2. `operating-review` — weekly synthesis + org thread writer
3. `signal-watcher` — external signal ingest
4. `policy-engine` — evaluates `.eve-org/intelligence.yaml`
5. `deploy-runtime` (or `infra-agent`) — deployment/runtime reliability
6. `docs-agent` — docs and release communication
7. `support-triage` — thread-backed support ingest

(`ceo`, `agent-resources`, and `software-engineer` are inherited from `starter-company` and should NOT be redefined here.)

The pack should ship with opinionated coverage of:

1. deployment/runtime reliability
2. developer onboarding
3. support friction
4. docs and release communication

### Verification loop

1. Sync the pack into a fresh org.
2. Verify the starter agents (`ceo`, `agent-resources`, `software-engineer`) come in via the `x-eve.packs` reference.
3. Verify the seven lean-saas specialists are present immediately after install.
4. Confirm the initial company graph and capabilities docs mention all roles.
5. Confirm that bumping the `starter-company` pack ref propagates role changes on next sync.

## 6) Phase 2: Signal Connectors + Normalization

### Mechanism

Each signal source is a scheduled agent defined in `pack/agents/agents.yaml` with a dedicated skill under `pack/agents/skills/signals/<name>/SKILL.md`. The skill tells the agent:

1. How to fetch data from its provider (CLI, REST API, or existing Eve integration).
2. How to normalize the response into a YAML snapshot.
3. Where to write the snapshot (`/world-model/signals/<name>` in org docs).

Signal agents are plain Eve agents — no platform special case. The `signal-watcher` role in Phase 1 is an umbrella agent that delegates to per-source skills, OR each source is its own agent. Pick "one agent per source" for clearer failure isolation and independent schedules.

### Deliverables

Ship signal connectors for:

1. **GitHub** — via the existing `eve-horizon` GitHub integration; writes PR/issue/deploy health snapshots.
2. **Sentry** — via Sentry REST API; writes error rate snapshots.
3. **Stripe** — via Stripe REST API; writes revenue and churn snapshots.
4. **PostHog** — via PostHog REST API; writes activation and onboarding snapshots.
5. **Org threads** — reads `GET /orgs/:org_id/threads?scope=org&key_prefix=support` and writes a support-volume snapshot. No external call needed.

### Credentials and graceful degradation

1. Each connector reads credentials from org secrets (e.g., `SENTRY_TOKEN`). Missing credentials log a clear warning and skip the run instead of crashing the agent.
2. Each connector writes its snapshot atomically — the world-model agent never sees partial updates.
3. Each snapshot includes a `source`, `fetched_at`, `status` (`ok` / `skipped` / `error`), and the normalized payload.

### Verification loop

1. Use a `FakeSignalProvider` skill that reads from a static YAML file under `tests/fixtures/signals/*.yaml`. Each real connector has a fake twin for tests.
2. Run the signal agents against fake fixtures and confirm each produces `/world-model/signals/<name>` with the expected shape.
3. Confirm the world-model agent incorporates those snapshots into the next synthesis cycle.
4. Remove the fake credentials and confirm each connector logs a clear "skipped: missing credentials" message instead of erroring.

## 7) Phase 3: Operating Review

### Deliverables

1. Weekly operating review routine (`operating-review` agent, cron `0 9 * * 1`).
2. Dedicated org thread with key `weekly-operating-review` (stable key so messages accumulate there across weeks).
3. Each weekly message follows a fixed structured template:

```markdown
# Weekly Operating Review — <ISO week>

## Outcomes
- first-deploy: on_track | at_risk | off_track (trend)
- reduce-churn: ...

## Signals
- deploy health: <value> (trend)
- onboarding TTFD: <value> (trend)
- production error rate: <value> (trend)
- support volume: <value> (trend)
- spend 7d: $X (trend)

## Attention Needed
- [linked_job_id | linked_world_model_path] — <one-line rationale>

## Follow-ups Created
- <job_id> — <title>
```

4. Create follow-up jobs only when:
   1. A signal crosses a threshold defined in `.eve-org/intelligence.yaml`, OR
   2. The world-model state has `attention_needed` entries that have been open for >48 hours without a linked job.
5. Every follow-up job is logged in the review message so the human sees what the pack acted on.

### Design notes

1. The operating review is opinionated and startup-relevant.
2. It should be legible enough that a founder could rely on it instead of manually checking multiple systems.
3. This is a pack-level routine, not a platform feature.
4. Use the thread key `weekly-operating-review` verbatim so operators can bookmark it.

### Verification loop

1. Seed signal inputs via fake connectors (from Phase 2).
2. Run the operating-review routine manually (`eve job create --agent-slug operating-review ...`).
3. Verify a message lands in the `weekly-operating-review` org thread with the structured template.
4. Verify follow-up jobs are created only when threshold or attention rules fire.
5. Re-run with no attention triggers and verify the review still runs and posts a message with "no attention needed".

## 8) Phase 4: Low-Risk Policies

### Deliverables

Add low-risk query + compose policies such as:

1. onboarding-regression review
2. repeated docs failure investigation
3. support volume spike triage
4. deploy reliability investigation

### Design notes

1. Start with policies that create investigation jobs, not irreversible actions.
2. Keep medium-risk actions in approval mode until there is enough confidence.
3. Preserve compatibility with `full_auto` posture for orgs that want it, but do not make high-risk automation the v1 center of gravity.

### Verification loop

1. Trigger each policy with deterministic fixture data.
2. Verify the expected target job is created with the right attached context.
3. Verify approval-mode policies open typed decision threads when configured to do so.

## 8.5) Phase 4.5: Budget Attribution (stretch)

### Deliverables

1. Daily budget attribution job that reads `GET /orgs/:org_id/spend?group_by=project` and `?group_by=agent_slug` (Phase 1 spend upgrades).
2. Writes attribution summaries to:
   1. `/operating-model/budgets/by-outcome/<outcome>` (joined through capability ownership)
   2. `/operating-model/budgets/by-capability/<capability>`
   3. `/operating-model/budgets/by-agent/<agent_slug>`
3. Flags capabilities whose 7-day cost exceeds their declared budget in `.eve-org/capabilities.yaml`.

### Design notes

1. This is a stretch deliverable for v1 — useful but not blocking.
2. Depends on capability docs having `budget_usd_7d` in their metadata.
3. Output should feed directly into the weekly operating review (Phase 3) as an "over budget" attention signal.

### Verification loop

1. Seed capability budgets and inject fake spend via the billing/usage API.
2. Run the attribution job and confirm summaries are written.
3. Push spend over a declared budget and verify the weekly review picks it up as an attention signal.

## 9) Phase 5: Install, Migration, and Distribution

### Deliverables

Document two adoption paths:

1. direct install of `lean-saas-company`
2. upgrade path from `starter-company`

The migration path should explain:

1. how to add the richer pack refs
2. how to preserve existing goals and company graph docs
3. how to remove or override agents if the pack defaults are too opinionated

### Verification loop

1. Install `lean-saas-company` into a fresh org.
2. Upgrade an org that already runs `starter-company`.
3. Confirm both paths produce a coherent final pack state.

## 10) End-to-End Acceptance Scenario

The canonical scenario should be:

1. install `lean-saas-company`
2. connect core startup signals
3. let the world model build an initial state
4. run the weekly operating review
5. trigger at least one low-risk policy automatically
6. verify the resulting jobs and review thread are useful without human glue work

## 11) Milestone Acceptance

`lean-saas-company` v1 is done when:

1. It is meaningfully more useful than `starter-company` on day one for SaaS teams.
2. It remains an OrgPack layered on the same platform primitives.
3. Its operating review and low-risk policies work end to end.
4. Teams can either install it directly or grow into it from the starter pack.
