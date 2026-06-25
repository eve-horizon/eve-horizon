# DB Architecture

> **What**: Database schema, migrations, and access utilities.
> **Why**: A single schema source keeps all services consistent and avoids drift.

## Overview

The database stores orgs, projects, jobs, attempts, and dependencies. Migrations live here so all services evolve
in lockstep with schema changes.

## Key Decisions (Why)

- **Centralized migrations**: reduces schema forks across apps.
- **Job-centric modeling**: aligns with the system's primary unit of work.

## Navigation

- Job model: [docs/system/job-api.md](../../docs/system/job-api.md)
- System overview: [docs/system/unified-architecture.md](../../docs/system/unified-architecture.md)
