# Orchestration Skill

> Status: Current
> Last Updated: 2026-01-19

## Purpose

Describe how the orchestration skill decides between direct execution and child orchestration, and how it uses job relations + control signals to pause/resume work.

## Current (Implemented)

- Skills can create **child jobs** and attach relations (`waits_for`, `blocks`, `conditional_blocks`) to gate the parent.
- The parent can return a `json-result` block with `eve.status = "waiting"` to requeue itself to `ready` while remaining blocked by relations.
- The parent resumes automatically once dependencies are complete; no new job phase is introduced.

### Depth Propagation and Parallel Decomposition

- The parent chooses a target depth (EPIC=3, Story=2) and passes it to children.
- Each job decides whether to decompose further, based on scope and current depth.
- Parallelize independent work by creating multiple children and using `waits_for` relations.

### Recommended Flow

1. **Assess** whether the task is better handled as child jobs (parallelizable or specialized work).
2. **Create** child jobs with clear, atomic scopes.
3. **Add relations** from parent → children using `waits_for` (or `blocks` when strict gating is required).
4. **Return** `json-result` with `eve.status = "waiting"` and a short summary.
5. **Resume** when children complete; re-check context and continue.

### Example Control Response

```json-result
{
  "eve": {
    "status": "waiting",
    "summary": "Spawned 2 child jobs and added waits_for relations"
  }
}
```

## Planned (Not Implemented)

- None.

## Legacy / Removed

- None.
