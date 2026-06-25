# Harness Integration Refactor Plan (Historical)

> **Historical / Deprecated**: This document is historical and may not reflect current behavior.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

> Status: Historical plan
> Last Updated: 2026-01-15
> Purpose: Preserve harness refactor intent while reflecting current skills and hints model.

## Current Execution Model

- Skills are repo-only (`.agents/skills/`), optional `.claude/skills/` overrides
- Job execution preferences are captured as `hints` (harness, worker_type, permission, timeout)
- Workers invoke `eve-agent-cli` with the job description as the prompt

## Current Harness Invocation (Summary)

```text
eve-agent-cli --harness <name> --permission <policy> --workspace <path> --prompt "<job description>"
```
