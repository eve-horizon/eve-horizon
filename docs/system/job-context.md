# Job Context Endpoint

> Status: Current
> Last Updated: 2026-01-19

## Purpose

Define the `/jobs/:id/context` API contract and the derived visibility fields used by orchestration skills and the CLI.

## Current (Implemented)

- **Endpoint**: `GET /jobs/:job_id/context`
- **CLI**: `eve job current [<job-id>] [--json|--tree]`
  - Defaults to `EVE_JOB_ID` when no job ID is provided.
  - `--tree` renders the hierarchy (parent + children) via the tree endpoint.

### Response Shape

```
{
  job,
  parent,
  children,
  relations: { dependencies, dependents, blocking },
  latest_attempt,
  latest_rejection_reason,
  blocked,
  waiting,
  effective_phase
}
```

### Derived Fields

- `blocked`: true when the job has unresolved blocking relations.
- `waiting`: true when the latest attempt returned `result_json.eve.status == "waiting"`.
- `effective_phase`: `blocked` → `waiting` → `job.phase` (for display and orchestration heuristics).

## Planned (Not Implemented)

- None.

## Legacy / Removed

- None.
