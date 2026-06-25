# Continuous System Distillation

> Status: Idea
> Last Updated: 2026-02-16
> Purpose: Turn every failure, friction point, and cleanup opportunity into a durable system improvement.
> Scope: `eve-horizon-3`, `../eve-skillpacks`, infra repos (`eve-horizon-infra` template + deployment instances such as `../deployment-instance`), and agent interactions through the Eve CLI.

## The Problem

Three forces degrade velocity and reliability over time:

1. **Failure debt** — Incidents are patched, but root causes remain.
2. **Accretion debt** — New code and workflows add avoidable complexity.
3. **Friction debt** — Agents/operators hit unclear CLI errors, hidden prerequisites, and stale guidance.

If we only fix the local symptom, the same class of issue returns in code, infra, tests, or operator workflows.

The goal: **every interaction with the system (code, CLI, infra ops, testing) leaves it measurably easier to operate and harder to break.**

## Distillation Model

Distillation removes impurities without losing function.

Applied to Eve:

```text
Raw system state (code + CLI UX + infra runbooks + tests)
  -> detect signal (failure, friction, or complexity)
  -> classify surface (code | cli | infra | testing | docs)
  -> run root-cause distillation (5 Whys where required)
  -> implement smallest high-leverage improvement
  -> verify at required safety tier
  -> record evidence in distillation ledger
  -> propagate to skills/docs/guards/tests
  -> measure recurrence and latency
```

## Signal Sources

| Surface | Example Signal | Typical Action |
|---|---|---|
| Code | Duplication, dead code, over-abstraction | Simplify/refactor + tests |
| CLI UX | Agent runs `eve ...` and gets confusing error | Improve error text, add hint, update help/docs |
| Infra/Ops | Deploy/migration failure, wrong context usage, unsafe runbook step | Add guardrails, safer defaults, preflight checks |
| Testing | Flaky scenario, missing integration coverage, brittle manual flow | Stabilize tests, add deterministic checks, document gating |
| Docs/Skills | Operator repeats the same mistake due to missing guidance | Update skill instructions + reference docs |

## Unified Loop: Capture -> Analyze -> Improve -> Verify -> Propagate

```text
Signal arrives
  -> create/update ledger entry
  -> classify: failure | friction | simplification
  -> if failure or CLI friction: run 5 Whys
  -> choose action: suggest | PR autofix | safe direct apply
  -> implement change
  -> verify (unit -> integration -> ops/manual as needed)
  -> record evidence + recurrence signature
  -> propagate to docs/skills/infra templates
  -> track KPI deltas
```

## Mandatory CLI Error Distillation (Required)

When any agent task using the Eve CLI fails, treat it as a product signal, not only a task-level failure.

### Trigger

- Any non-zero `eve` command exit in agent execution.
- Any repeated operator confusion using the same command/help path.

### Required Workflow

1. **Capture context**
   - Command, flags, exit code, stderr/stdout excerpt, environment context.
2. **Run 5 Whys**
   - Why did the command fail?
   - Why was that precondition missing or unclear?
   - Why didn’t the CLI prevent or explain it earlier?
   - Why didn’t help/docs/skill guidance prevent the mistake?
   - Why would this happen again for another agent/operator?
3. **Map to improvement class**
   - Error message clarity
   - Hint/remediation quality
   - Help text/examples
   - Preflight validation/guardrails
   - Defaults/command ergonomics
   - Docs/skill drift
4. **Ship at least one systemic improvement** (unless proven external-only)
   - Improve CLI error copy with concrete remediation steps.
   - Add or update `--help` examples.
   - Add preflight checks (for example, env/auth/context validation).
   - Update relevant docs/skills.
   - Add regression test for the failure mode.
5. **Verify**
   - Reproduce original failure path.
   - Confirm new output is actionable and points to next step.

### Output Contract

A CLI-related ledger entry is incomplete without:

- 5 Whys notes
- User/agent-facing message change (or explicit rationale why none)
- Help/docs update status
- Verification evidence

## Quality Detection

### Deterministic Detection First

| Signal | Detection Method | Threshold |
|---|---|---|
| Dead code | Static analysis (unused exports, unreachable branches) | Any confirmed dead path |
| Duplication | AST similarity | >= 3 near-identical blocks |
| Over-abstraction | Single-caller wrapper analysis | Wrapper + single caller + no boundary justification |
| Type looseness | New `any` in typed internal code | Any new occurrence |
| CLI ambiguity | Error without actionable next step | Any agent-visible occurrence |
| Infra guardrail gap | Incident tied to missing preflight/safety check | Any repeat in 30 days |
| Test fragility | Same flaky test scenario repeats | >= 2 occurrences/week |

### False-Positive Guards

Candidates require all of:

1. Ownership is clear.
2. Safety tier is defined.
3. Expected value is concrete.
4. Exemptions (compatibility seams, boundaries) are documented.

## Verification Tiers

Use the minimum tier that safely validates the change:

| Tier | Scope | Required For |
|---|---|---|
| **Green** | Unit tests / local deterministic checks | Internal simplifications, copy-only CLI improvements |
| **Yellow** | Unit + integration/local stack checks | Behavior-preserving flow rewrites, validation changes |
| **Red** | Full path: unit + integration + ops/manual scenario | Boundary behavior changes, deploy/auth/lifecycle changes |

Before integration or manual checks, run `./bin/eh status` to confirm active environment and correct `EVE_API_URL`.

## Distillation Ledger

Use a dedicated ledger surface for all improvement types:

```text
docs/distillation/
  LEDGER.md
  LEDGER.yaml
  entries/
    FD-YYYY-NNN.md   # Failures/friction/ops/testing improvements
    RF-YYYY-NNN.md   # Refactoring/simplification improvements
```

### Entry Schema (Minimum)

| Field | Description |
|---|---|
| `id` | Stable entry ID (`FD-2026-001`, `RF-2026-001`) |
| `surface` | `code`, `cli`, `infra`, `testing`, `docs` |
| `status` | `detected`, `candidate`, `validated`, `applied`, `propagated` |
| `signal` | What triggered this entry |
| `root_cause` | Concise root-cause statement |
| `five_whys` | Required for failure/CLI friction entries |
| `change_set` | What changed |
| `safety_tier` | `green`, `yellow`, `red` |
| `tests_verified` | Verification run list |
| `user_agent_impact` | Expected usability/operability gain |
| `evidence` | Jobs/PRs/commits/logs |
| `owner` | Responsible team/person/agent |
| `created` / `applied` | ISO timestamps |

## Propagation Requirements

Every validated entry must evaluate downstream updates:

1. **CLI change** -> update help output + relevant docs.
2. **Agent-facing workflow change** -> update `../eve-skillpacks/eve-work/eve-read-eve-docs/references/*`.
3. **Infra/ops change** -> update template/instance runbooks and safety wrappers.
4. **Testing change** -> add or stabilize regression coverage.

No entry is complete until required downstream updates are merged or explicitly waived with rationale.

## KPIs

Track monthly:

1. Recurrence rate of top failure/friction signatures.
2. Median time from detection to validated fix.
3. CLI error-to-improvement lead time.
4. Percentage of agent-visible CLI errors with completed 5 Whys.
5. Infra incident recurrence after guardrail updates.
6. Flaky test recurrence trend.
7. Net complexity delta in touched modules.

## Implementation Plan

### Phase 0: Baseline (Week 1)

1. Create `docs/distillation/` scaffold and entry templates.
2. Define signal taxonomy for `code/cli/infra/testing/docs`.
3. Capture top recurring signals into `detected` entries.

### Phase 1: CLI + 5 Whys Discipline (Weeks 2-3)

1. Require 5 Whys for agent-visible CLI failures.
2. Add checklist to PR template: "If this addressed a CLI failure, did help/docs/error text improve?"
3. Pilot 3 CLI-friction entries through full lifecycle.

### Phase 2: Infra/Ops + Testing Coverage (Weeks 4-6)

1. Add recurring infra incident signatures to the ledger.
2. Add test-fragility signatures and stabilization actions.
3. Add preflight guardrails for common operator mistakes.

### Phase 3: Automation + Propagation (Weeks 7-9)

1. Auto-open ledger candidates for repeated signatures.
2. Enforce propagation checks for docs/skills/help updates.
3. Publish monthly KPI snapshot.

### Phase 4: Feedback into Agent Behavior (Weeks 10-12)

1. Distill repeated agent mistakes into skill guidance.
2. Add positive/negative examples for CLI and ops workflows.
3. Measure reduction in repeated agent/operator errors.

## Governance

1. Hold a weekly Distillation Review across platform, infra, and docs owners.
2. Require evidence-based rationale for all medium/high-risk changes.
3. Require 5 Whys for failure/friction entries (especially CLI-driven).
4. Treat ledger drift as operational debt.

## Immediate Next Steps

1. Approve this proposal as the baseline operating model.
2. Create `docs/distillation/` scaffold with templates.
3. Run a baseline scan and seed initial entries.
4. Pilot with 4 entries:
   - One CLI failure from an agent run (mandatory 5 Whys + help/error update).
   - One infra/ops failure class (guardrail addition).
   - One testing fragility class (stabilization + regression test).
   - One code simplification class (low-risk cleanup).
5. Review pilot outcomes and tighten thresholds.
