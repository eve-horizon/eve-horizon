# Eve SE Orchestration Skill - Implementation Plan (v2)

> Plan (Active): Near-term implementation blueprint.
> Current default: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> Execution tracking belongs in Beads; this document defines design and implementation steps.

## Goal

Ship a robust and elegant orchestration skill plus the smallest platform changes
needed to support it. The skill must choose between direct execution and child
orchestration, gate dependencies via job relations, and pause parent execution
via a single `waiting` control signal.

## Principles

- Keep the job lifecycle simple: no new phases unless strictly required.
- One control contract: `json-result` with `eve.status` governs orchestration.
- Visibility is derived, not multiplied: compute `waiting/blocked` from relations.
- Minimize calls: one context endpoint for parent, children, relations, feedback.
- Skills are portable: install from a manifest on clone, not from git-tracked
  install directories.

## Scope

In:
- Standard `json-result` envelope and waiting semantics in the orchestrator.
- Requeue helper that sets `ready` without cancelling attempts.
- `/jobs/:id/context` endpoint and `eve job current`.
- Worker env parity: `EVE_ATTEMPT_ID` (optional `EVE_AGENT_ID` if available).
- Skills manifest + install hook + docs.
- New system docs that describe the patterns.

Out:
- New workflow engine or registry.
- Global skill packs or feature flags.
- New job phases (unless an explicit decision changes this).

## Decisions (Current Defaults)

1) No `waiting` phase. `waiting` is an attempt-level control signal that requeues
   a job to `ready` while `waits_for` keeps it blocked.
2) Context endpoint is `/jobs/:id/context`. CLI uses `EVE_JOB_ID` as default.
3) Context response includes latest attempt and latest rejection reason only.
4) Skills are installed from `skills.txt` into `.agents/skills` and `.claude/skills`
   by default; both are gitignored. Source skills live in a tracked directory.

## Design

### Control signal and requeue

- The worker already extracts the last `json-result` block into `result_json`.
- Orchestrator reads `resultJson.eve.status` and maps it to lifecycle actions:
  - `waiting`: complete attempt as `succeeded`, requeue job to `ready`, clear
    assignee, do not submit for review.
  - `success`: existing success flow (submit for review or mark done).
  - `failed`: existing failure flow (cancel job).
- Add a `jobs.requeueReady(jobId, actor, options)` helper that:
  - sets `phase=ready`, `assignee=null`, `updated_at=now()`
  - optionally sets `defer_until` for backoff
  - does not cancel or mutate the attempt
- If `waiting` is returned with no blockers, log a warning and apply a short
  `defer_until` to avoid immediate reschedule loops.

### Derived visibility and context endpoint

Add `/jobs/:id/context` returning:

```
{
  job,
  parent,
  children,
  relations: { dependencies, dependents, blocking },
  latest_attempt: { id, attempt_number, status, result_summary, result_json },
  latest_rejection_reason
}
```

Expose derived fields in the response or CLI output:
- `blocked`: any blocking relations not done
- `waiting`: latest_attempt.result_json.eve.status == "waiting"
- `effective_phase`: `blocked` or `waiting` overrides `job.phase` for display

### CLI

- `eve job current [<job-id>] [--json|--tree]`
  - defaults to `EVE_JOB_ID` when present
  - `--tree` renders parent and children recursively

### Worker env parity

- Add `EVE_ATTEMPT_ID` to the harness and hook environment.
- If a stable agent identifier exists, add `EVE_AGENT_ID` as optional parity.

### Skills manifest and install

- Add `skills.txt` at repo root. Format:
  - one source per line (local path, Git URL, or `org/repo`)
  - `#` starts a comment
- Add `bin/eh skills install`:
  - reads `skills.txt`, skips empty/comment lines
  - runs `skills add <source> -a <agent> -y --all` into `.agents/skills`
  - creates `.claude/skills` symlink to `.agents/skills` when possible
  - fallback: install to `.claude/skills` if symlink fails
- Add `.eve/hooks/on-clone.sh` to call `./bin/eh skills install` (idempotent).
- Move repo-owned skills into a tracked source directory (proposed: `skills/`)
  and list them in `skills.txt`.
- Update `.gitignore` to ignore `.agents/skills/` and `.claude/skills/`.

## Implementation Steps

1) Orchestrator + DB
   - Add `jobs.requeueReady` helper.
   - Update orchestrator to branch on `resultJson.eve.status`.
   - Record `eve.summary` into attempt `result_summary` when present.
2) API + CLI
   - Add `/jobs/:id/context` endpoint and service query.
   - Add `eve job current` CLI with `--json` default and optional `--tree`.
3) Worker
   - Inject `EVE_ATTEMPT_ID` (and optional `EVE_AGENT_ID`) into env and hooks.
4) Skills install
   - Add `skills.txt`.
   - Add `bin/eh skills install` and `on-clone` hook.
   - Update `.gitignore` and migrate repo-owned skills to `skills/`.
5) Docs
   - Add new system docs (see below).
   - Update `docs/system/skills.md`, `docs/system/job-api.md`,
     and `docs/system/extension-points.md` to match new behavior.
   - Update `AGENTS.md` memory with the new skills install approach.

## System Docs to Add (New)

- `docs/system/job-control-signals.md`
  - `json-result` envelope, `eve.status`, waiting semantics, requeue rules.
- `docs/system/job-context.md`
  - `/jobs/:id/context` schema, derived visibility fields, CLI usage.
- `docs/system/skills-manifest.md`
  - `skills.txt` format, install flow, hook behavior, symlink strategy.
- `docs/system/orchestration-skill.md`
  - skill overview, heuristics, and orchestration patterns.

## Tests

- Integration test: parent spawns children, adds `waits_for`, returns `waiting`;
  parent requeues to `ready`, stays blocked until children are done.
- API test: `/jobs/:id/context` returns expected fields and derived status.
- CLI test: `eve job current --json` works with and without explicit job ID.
- Hook smoke test: `on-clone` runs skills install (no sync step).

## Risks and Mitigations

- Thrash on `waiting` without blockers: apply `defer_until` backoff and log.
- Confusion over skill sources vs install targets: document `skills/` vs
  `.agents/skills` and keep install directories gitignored.
- Context endpoint scope creep: keep full attempt history behind existing
  `/jobs/:id/attempts` and expand only when needed.
