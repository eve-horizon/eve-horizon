# Exponential Compounding Engineering for Eve Horizon

> Status: Idea
> Last Updated: 2026-02-16
> Purpose: Define a practical operating model where every blind alley and mistake becomes reusable engineering leverage.
> Scope: `eve-horizon-3`, `../eve-skillpacks`, and infra repos (`eve-horizon-infra` template + deployment instances such as `../deployment-instance`).

## Why This Matters

Today, we do fix incidents and regressions, but we do not consistently convert every failure into:

1. A reusable fix pattern.
2. A safe auto-apply mechanism.
3. A durable, searchable record.
4. A cross-repo propagation path.

Without that loop, teams repeatedly pay for the same failure class. The goal is to make every mistake increase future velocity and reliability.

## Compounding Principles

1. Every blind alley is a data point.
2. Root cause is mandatory; symptom-only patches are temporary.
3. Fixes must graduate through explicit maturity levels.
4. Auto-apply is allowed only when blast radius is bounded and verification is automatic.
5. Knowledge propagation across repos is default behavior, not optional cleanup.
6. Human override must always exist (kill switch, manual gates).
7. The fix history is a first-class document set, not scattered chat memory.

## Target Loop (Capture -> Distill -> Apply -> Propagate)

```text
Failure signal
  -> classify signature
  -> create/update fix candidate
  -> run root-cause distillation
  -> choose action:
       suggest only | PR autofix | direct safe apply
  -> verify (tests + diagnostics)
  -> promote maturity level
  -> propagate to skills + infra templates
  -> track recurrence delta
```

This loop should run continuously from job failures, pipeline failures, deploy incidents, and operator audits.

## Blind Alley Detection Model

Blind alleys should be detected by rule-based signals first (before model-heavy inference):

1. Same command/tool error repeated `>= 2` times in one attempt.
2. Attempt exits failed with no material file/config change.
3. Multiple backtracks on the same file or manifest field.
4. Repeated failure signatures across jobs/runs in a 7-day window.
5. Explicit agent/operator annotation that a path was a dead end.

### Signature Construction

Use stable, comparable signatures:

```text
signature = hash(
  normalized_error_message +
  failing_component +
  failing_operation +
  key_context_fields
)
```

Normalization strips volatile values (timestamps, IDs, random ports) so the same failure class maps to one signature.

## First-Class Fix Ledger (Required)

Each repo gets a canonical fix record surface:

```text
docs/compounding/
  FIX_LEDGER.md           # Human-readable index of active and historical fixes
  FIX_LEDGER.yaml         # Machine-readable source for automation
  fixes/
    FX-YYYY-NNN.md        # One detailed record per fix
```

### Minimal Entry Schema

| Field | Description |
|---|---|
| `id` | Stable fix ID (`FX-2026-001`) |
| `status` | `observed`, `candidate`, `validated`, `auto_apply`, `retired` |
| `repo_scope` | `eve-horizon`, `eve-skillpacks`, `infra-template`, `infra-instance` |
| `signature` | Deterministic failure signature/hash |
| `trigger` | Event or context that exposed failure |
| `root_cause` | Concise root cause statement |
| `fix_strategy` | Guardrail, code change, workflow change, docs/skill update |
| `auto_apply_mode` | `none`, `suggest`, `pr_only`, `safe_direct` |
| `safety_checks` | Preconditions and verification commands |
| `evidence` | Job IDs, run IDs, PR links, commit links |
| `first_seen` / `last_seen` | ISO timestamps |
| `recurrence_count` | How often signature reappeared |
| `owner` | Team/person/agent owner |

### Maturity Levels

| Level | Meaning |
|---|---|
| `L0 Observed` | Failure captured, no reliable fix yet |
| `L1 Candidate` | Root cause and draft fix documented |
| `L2 Validated` | Fix works in at least one verified run |
| `L3 Guarded Auto` | PR auto-fix with mandatory checks |
| `L4 Defaulted` | Safe direct apply allowed in constrained contexts |

Promotion to `L3+` requires at least two successful, independent validations and zero unresolved safety exceptions.

### Example Entry (Machine-Readable)

```yaml
id: FX-2026-014
status: validated
repo_scope: eve-horizon
signature: sig_8f4d2e1b
trigger: system.pipeline.failed
root_cause: "Deploy workflow used stale image tag resolution when tag input was omitted."
fix_strategy: "Workflow guardrail + deterministic tag resolver"
auto_apply_mode: pr_only
safety_checks:
  - "pnpm build"
  - "pnpm test"
  - "./bin/eh test integration --reset-db"
evidence:
  jobs: ["proj-a3f2dd12"]
  prs: ["#1284"]
first_seen: "2026-02-05T10:14:00Z"
last_seen: "2026-02-12T08:22:00Z"
recurrence_count: 3
owner: "platform-runtime"
```

## Repo-by-Repo Operating Model

### 1) `eve-horizon-3` (Platform + Orchestration)

Primary responsibility: detection, classification, verification, and policy enforcement.

Deliverables:
- Failure signature classifier fed by job/pipeline/deploy events.
- Automated fix-candidate generation job for repeated signatures.
- Policy engine deciding `suggest` vs `pr_only` vs blocked.
- CLI/API visibility for fix records (initially read-only if needed).
- Repo-level `docs/compounding/*` ledger files.

Key signals to ingest first:
- `system.job.failed`
- `system.pipeline.failed`
- `system.env.deploy.failed` (or equivalent deploy failure events/diagnostics)
- Manual operator annotations from `eve job diagnose` and incident reports

### 2) `../eve-skillpacks` (Knowledge Distillation + Distribution)

Primary responsibility: convert validated fixes into reusable agent behavior.

Deliverables:
- New/updated skill instructions for recurring fix classes.
- Distilled troubleshooting updates in `eve-read-eve-docs/references/*`.
- Sync rules that watch fix-ledger changes from platform docs and map to affected skills.
- Skillpack-level `docs/compounding/*` ledger files for skill-side fixes (stale instructions, missing safeguards, bad defaults).

Rule: any fix at `L2+` with agent behavior impact must generate a skillpack update task.

### 3) Infra Repos (Template + Instances)

Primary responsibility: operational guardrails and infrastructure-safe remediation.

Scope:
- Template repo (`eve-horizon-infra`) for reusable mechanisms.
- Instance repos (for example `../deployment-instance`) for environment-specific records and overrides.

Deliverables:
- Infra fix ledgers tracking deploy, kubeconfig safety, migration, registry, and DNS classes.
- Guardrail scripts for deterministic safety fixes (for example context-safe kubectl wrappers).
- Workflow hooks that create fix candidates from failed deploy/health checks.
- Clear separation between template-level reusable fixes and instance-only fixes.

Rule: no destructive infra mutation qualifies for direct auto-apply; infra auto-remediation is PR-only by default.

## Propagation Contracts

| Fix Source | Mandatory Downstream Action |
|---|---|
| Platform fix (`eve-horizon-3`) | Open/update skillpack task if agent behavior, CLI flow, or docs usage changes |
| Skillpack fix (`../eve-skillpacks`) | Open platform task if fix exposes missing primitive or poor observability |
| Infra-template fix | Open instance-repo task for every active deployment using that path |
| Infra-instance-only fix | Promote to template task if portable and not environment-specific |

A fix is only considered fully compounded when linked downstream actions are merged or explicitly waived with rationale.

## Auto-Apply Safety Policy

| Tier | Allowed Mode | Example | Required Checks |
|---|---|---|---|
| Green | `pr_only` or `safe_direct` | Doc link fix, deterministic config typo fix | Lint/build/tests + signature match |
| Yellow | `pr_only` | Manifest behavior change, workflow branching logic | Full test suite + explicit reviewer |
| Red | `none` (manual only) | Terraform destructive change, secret rotation, DB destructive migration | Human runbook + approval |

Global constraints:
- Never auto-push directly to protected branches.
- Always retain a kill switch per workflow.
- Require reproducible signature match before applying any automated fix.
- Require post-apply verification and automatic rollback path where feasible.

## Implementation Plan

### Phase 0: Baseline Contract (Week 1)

1. Create `docs/compounding/` structure in all three repo families.
2. Agree signature taxonomy and fix schema.
3. Add a single shared fix template (`FX-YYYY-NNN.md`) and owner model.

### Phase 1: Capture + Ledger Discipline (Weeks 2-3)

1. Auto-create/update ledger entries on repeated failure signatures.
2. Require a `Fix ID` link for bug-fix PRs touching recurring signatures.
3. Start weekly recurrence review (top 10 signatures).

### Phase 2: Suggestion Automation (Weeks 4-5)

1. Add automated remediation suggestions that open PRs with linked fix IDs.
2. Add verification bundles (tests + diagnostics) attached to each suggestion.
3. Track suggestion acceptance and false-positive rates.

### Phase 3: Guarded Auto-Apply (Weeks 6-8)

1. Enable `L3` PR automation for stable, deterministic signatures.
2. Allow `L4` direct apply only for green-tier low-risk classes with rollback.
3. Add policy-as-code checks preventing unsafe escalation.

### Phase 4: Cross-Repo Propagation (Weeks 9-10)

1. When platform fix reaches `L2+`, open dependent skillpack and infra tasks automatically.
2. Track propagation lag between platform fix merge and downstream updates.
3. Close loop only when all affected repos have linked fix entries and merged updates.

## Compounding KPIs

Track monthly:

1. Recurrence rate of top failure signatures (target downward trend).
2. Median time from `L0` to `L2` (learning speed).
3. Percentage of recurring failures with ledger entries (coverage).
4. Auto-fix PR success rate (merged without rollback).
5. Cross-repo propagation latency (`eve-horizon` -> `eve-skillpacks` / infra).
6. Regression reopen rate for previously validated fixes.

## Governance

1. Weekly Fix Council (30 min) reviews new `L0/L1` candidates and promotion requests.
2. Any promotion to `L3/L4` requires explicit evidence links and safety checklist completion.
3. Retire obsolete fixes when root signatures disappear or architecture changes invalidate them.
4. Treat fix-ledger drift as a quality issue: stale ledgers indicate broken compounding.

## Immediate Next Steps

1. Approve this proposal as the architecture baseline.
2. Create the `docs/compounding/` scaffold in:
   - `eve-horizon-3`
   - `../eve-skillpacks`
   - infra template and instance repos
3. Pilot with 3 recurring signatures:
   - one platform job failure class
   - one skillpack documentation drift class
   - one infra deploy/safety class
4. After pilot, write an implementation-ready plan in `docs/plans/` with exact workflow and schema changes.
