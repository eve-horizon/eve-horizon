# CLI Separation Plan (Historical)

> **Historical / Deprecated**: This document is historical and may not reflect current behavior.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

> Status: Historical plan
> Last Updated: 2026-01-15
> Purpose: Capture the intent of CLI separation while documenting the **current** CLI surface.

This plan is now executed. The current CLI is `@eve/cli` (REST wrapper) and dev/ops helpers live in `./bin/eh`.

## Current CLI Commands (Authoritative)

```bash
# Orgs
eve org ensure "My Org"
eve org list

eve project ensure --name "My Project" --repo-url https://github.com/org/repo --slug MyProj
eve project list

# Jobs
eve job create --description "Fix auth bug" --priority 1
eve job list --phase ready
eve job ready
eve job blocked
eve job show <job-id>
eve job tree <job-id>
eve job update <job-id> --phase active
eve job close <job-id> --reason "Completed"
eve job dep add <job> <depends-on> --type blocks
eve job claim <job-id> --agent agent-123
eve job release <job-id> --reason "Need more info"
eve job attempts <job-id>
eve job logs <job-id> --attempt 1
eve job submit <job-id> --summary "Ready for review"
eve job approve <job-id> --comment "LGTM"
eve job reject <job-id> --reason "Missing tests"
```

## Notes

- CLI commands are singular (`job`, `project`, `org`).
- Job IDs are slug-based hashes (`myproj-a3f2dd12`), with hierarchical children (`.1`, `.2`).
- Execution hints use `--harness`, `--worker-type`, `--permission`, `--timeout`.
