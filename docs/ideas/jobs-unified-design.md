# Jobs Unified Design (Idea)

> **Idea / Draft**: This is a brainstorming document and may not reflect current behavior.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

This document captures the **current** Jobs V2 model and sketches future extensions.
All examples below match today’s CLI and job semantics.

---

## Current Job Model (Reference)

- **IDs**: `{slug}-{hash8}` roots; `{parent}.{n}` children (max depth 3)
- **Phases**: `idea → backlog → ready → active → review → done/cancelled`
- **Priority**: 0–4
- **Dependencies**: job relations drive blocking (`blocks`, `waits_for`, etc.)
- **Review**: `submit` → `approve` / `reject`

## CLI Examples (Current)

```bash
# Create and manage jobs
eve job create --description "Add API endpoint" --type task --priority 2
eve job update <job-id> --phase active
eve job close <job-id> --reason "Completed"

# Hierarchy
eve job create --parent <job-id> --description "Implement handler"
eve job tree <job-id>

# Dependencies
eve job dep add <job> <depends-on> --type blocks
eve job dep list <job>

# Review
eve job submit <job-id> --summary "Ready for review"
eve job approve <job-id> --comment "LGTM"
eve job reject <job-id> --reason "Missing tests"
```

## Future Extensions (Conceptual)

- Sync providers that map external issues to Jobs V2
- UI layer for review queues and dependency graphs
- Scheduling policies informed by `hints` and priority

## External Sync (Conceptual)

Future sync should map external issues to Jobs V2 without changing CLI commands:

- Import external issues → create Jobs with matching titles/labels/priority
- Export Jobs → update external issue status based on phase transitions
- Store external IDs in a mapping table; do not alter Job IDs
- Treat external dependencies as Job relations (`blocks`, `waits_for`)

No sync CLI is implemented today; any future sync commands should be additive and explicit.
