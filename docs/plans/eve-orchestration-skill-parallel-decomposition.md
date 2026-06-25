# Eve Orchestration Skill - Parallel Decomposition Guidance

> Plan (Active): Guidance for orchestration behavior.
> Current default: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> This document clarifies how parent and child jobs should coordinate depth and parallel breakdown.

## Purpose

Define the orchestration principle that **each job decides its own decomposition** while inheriting a
target depth from its parent. The goal is to maximize parallel execution without losing clarity or
creating unnecessary levels.

## Core Principles

1. **Parent sets the target depth** and passes it to children (e.g., in child descriptions or metadata).
2. **Each job self-assesses** whether further decomposition is needed, based on scope and complexity.
3. **Parallelize by default** when work can be split without strong ordering constraints.
4. **Use relations** (`waits_for` / `blocks`) to express true dependencies and avoid serial bottlenecks.
5. **Leaf jobs execute**, parent jobs orchestrate and requeue with `eve.status = "waiting"`.

## Orchestration Flow (Per Job)

1. **Fetch context**: `eve job current --json` (or `/jobs/:id/context`).
2. **Determine depth**:
   - Read the inherited `target_depth` from the parent (if provided).
   - Calculate `current_depth` from the job tree.
   - If `current_depth >= target_depth`, execute directly.
3. **Assess decomposition**:
   - If work is sizable or parallelizable, create child jobs.
   - Each child inherits `target_depth` unchanged.
4. **Add relations**:
   - Use `waits_for` for standard gating.
   - Use `blocks` only for strict ordering constraints.
5. **Return waiting signal**:
   - Emit `json-result` with `eve.status = "waiting"` after relations are created.
6. **Resume**:
   - When children are done, re-check context and continue execution or finalize.

## Parallel Decomposition Guidance

- Favor **multiple smaller child jobs** over one large child when the tasks are independent.
- If two tasks can run in parallel, create both and use `waits_for` only on the parent.
- Avoid chaining children with `blocks` unless results must be sequential.
- Each child must repeat the same decision process and may create grandchildren if depth allows.

## Depth Rules (Example Defaults)

- **EPIC**: target depth = 3
  - Root orchestrates children
  - Children may orchestrate grandchildren
  - Grandchildren execute

- **Story**: target depth = 2
  - Root orchestrates children
  - Children execute

## Example Depth Propagation

Parent description snippet to pass to children:

```
Target depth: 3 (EPIC). Current depth: 1. If current depth < target, you may create child jobs and
use waits_for relations to parallelize. Otherwise execute directly.
```

## Knowledge-Work Applicability

This applies to any knowledge work, not just software engineering:

- Research: parallel literature review, data gathering, synthesis
- Writing: outline, draft sections in parallel, consolidate
- Ops: parallel checks (metrics, logs, status), then summary
- Strategy: parallel SWOT, stakeholder analysis, risk assessment

## Review Mechanics (Optional)

- Default: **no review** unless specified by the parent or project settings.
- If review is required, apply at the requested level:
  - Top-level only
  - Every level
  - None

## Control Signal Example

```json-result
{
  "eve": {
    "status": "waiting",
    "summary": "Spawned 3 parallel child jobs; waiting on waits_for relations"
  }
}
```
