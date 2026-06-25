# Tests Architecture

> **What**: E2E test harness and fixtures for system validation.
> **Why**: Tests encode expected workflows and guard against regressions.

## Overview

Tests focus on end-to-end flows (org/project/job lifecycle) using the official CLI and API surface.
Fixtures provide repos, prompts, and stub harnesses for deterministic runs.

## Key Decisions (Why)

- **E2E-first** validates the full system contract, not just units.
- **Fixture repos** make execution deterministic and fast.

## Navigation

- Test workflow: [../AGENTS.md](../AGENTS.md)
