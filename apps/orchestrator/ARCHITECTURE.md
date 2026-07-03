# Orchestrator Architecture

> **What**: The scheduler that claims ready jobs and coordinates execution.
> **Why**: Separating scheduling from execution keeps job policy independent of worker mechanics.

## Overview

The orchestrator watches for jobs in the `ready` phase, claims them, and drives the job lifecycle toward execution.
It owns scheduling policy (priority, dependencies) and uses the database as the system of record.

## Core Responsibilities

- Find jobs eligible for execution.
- Claim/release jobs and manage attempt lifecycle.
- **Route by execution type**: agent jobs → agent-runtime (`EVE_AGENT_RUNTIME_URL`, set in every
  shipped environment); action/script/build work → worker. See the CRITICAL routing rule in
  [CLAUDE.md](../../CLAUDE.md).
- Match events to pipeline/workflow triggers (github, cron, system, app, app_link).
- Run platform crons: env health watchdog, managed-DB reconciler/snapshots, cost collectors,
  usage sweeper, budget suspension.

## Key Decisions (Why)

- **Policy lives here** so execution services stay dumb and execution-focused.
- **DB-backed coordination** avoids in-memory coupling between services.

## Navigation

- Job lifecycle: [docs/system/job-api.md](../../docs/system/job-api.md)
- System flow: [docs/system/unified-architecture.md](../../docs/system/unified-architecture.md)
