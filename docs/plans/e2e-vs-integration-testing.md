# Plan: E2E vs Integration Testing (Implemented)

> **Status**: Implemented (2026-01-18)
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is the quick dev loop.
> **Canonical docs**: `docs/system/k8s-local-stack.md`, `docs/system/deployment.md`

## Summary (Current State)

The repo now uses a **two-tier test model**:

1. **Integration tests** (`apps/api/test/integration/`) run against any stack (dev/docker/k8s).
2. **E2E tests** (`tests/e2e/`) are CLI-driven and stack-gated.

This plan is historical and documents the implemented structure.

## Implemented Files

- Integration suite: `apps/api/test/integration/*`
- E2E suite: `tests/e2e/*`
- E2E stack gating: `tests/e2e/helpers/stack-detection.ts`
- Post-clone hook: `.eve/hooks/post-clone.sh`
- Test runner: `bin/eh-commands/test.sh`

## Current Test Inventory (High Level)

- Integration tests validate API + CLI happy paths (org/project/job flow, secrets, harness variants, etc.).
- Client-only E2E validates real job execution on k8s via the public CLI/API.

## Commands (Current)

```
./bin/eh test integration [--env dev|docker|stack]
./bin/eh test e2e [--env dev|docker|stack]  # e2e skips unless k8s
```

## Notes

- E2E tests require `EVE_E2E_ENV=stack` (set by `eh test e2e --env stack`).
- See `docs/system/k8s-local-stack.md` for the full testing matrix and environment details.

## Future Work

- Expand integration coverage for missing happy paths (job review, attempts/results, cancel flow, secrets resolution).
- Add unit tests for critical shared helpers and API validation.
