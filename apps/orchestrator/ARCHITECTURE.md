# Orchestrator Architecture

> **What**: The scheduler that claims ready jobs and coordinates execution.
> **Why**: Separating scheduling from execution keeps job policy independent of worker mechanics.

## Overview

The orchestrator watches for jobs in the `ready` phase, claims them, and drives the job lifecycle toward execution.
It owns scheduling policy (priority, dependencies) and uses the database as the system of record.

## Core Responsibilities

- Find jobs eligible for execution.
- Claim/release jobs and manage attempt lifecycle.
- Coordinate with the worker to run tasks.

## Key Decisions (Why)

- **Policy lives here** so workers stay dumb and execution-focused.
- **DB-backed coordination** avoids in-memory coupling between services.

## Navigation

- Job lifecycle: [docs/system/job-api.md](../../docs/system/job-api.md)
- System flow: [docs/system/unified-architecture.md](../../docs/system/unified-architecture.md)
