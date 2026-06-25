# Configuration Model (Current)

> Status: Current
> Last Updated: 2026-01-15
> Purpose: Document the simplified configuration model (single repo per project, repo-only skills, job hints).

## Overview

Eve Horizon uses a simplified configuration model focused on a single repo per project and repo-only skills. The goal is to keep setup and execution predictable with minimal moving parts.

Key points:
- **Single repo per project** (`repo_url` + `branch`)
- **Repo-only skills** sourced from paths listed in `skills.txt` and installed into `.agents/skills/`
- **Jobs are phase-based** and use slug-based hierarchical IDs
- **Scheduling hints** (harness, worker_type, permission, timeout) are optional

## Projects (Schema Summary)

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,           -- TypeID format: proj_xxx
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  slug VARCHAR(8) NOT NULL,       -- 4-8 chars, used in job IDs

  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,

  UNIQUE(org_id, name),
  UNIQUE(org_id, slug)
);
```

## Jobs (Schema Summary)

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,           -- {slug}-{hash8} or {parent}.{n}
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_id TEXT REFERENCES jobs(id),
  depth SMALLINT NOT NULL DEFAULT 0,

  title TEXT NOT NULL,
  description TEXT NOT NULL,
  issue_type TEXT NOT NULL DEFAULT 'task',
  labels TEXT[] DEFAULT '{}',

  phase TEXT NOT NULL DEFAULT 'ready',
  priority SMALLINT NOT NULL DEFAULT 2,
  assignee TEXT,

  review_required TEXT DEFAULT 'none',
  review_status TEXT,
  reviewer TEXT,

  defer_until TIMESTAMPTZ,
  due_at TIMESTAMPTZ,

  hints JSONB DEFAULT '{}'::jsonb,
  content_hash TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  closed_at TIMESTAMPTZ,
  close_reason TEXT
);
```

## Attempts (Schema Summary)

```sql
CREATE TABLE job_attempts (
  id UUID PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt_number INTEGER NOT NULL,

  status TEXT NOT NULL DEFAULT 'running',
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  harness TEXT,
  agent_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  result_summary TEXT,
  runtime_meta JSONB DEFAULT '{}'::jsonb,

  UNIQUE(job_id, attempt_number)
);
```

## Skills (Repo-Only)

- Skills live in repo-local paths listed in `skills.txt` and install into `.agents/skills/` on clone
- Read directly from `.agents/skills/` at runtime (no syncing to harness config)
- No system skill pack roots and no `.eve/config.yaml`

## Job Creation (API Example)

```json
{
  "description": "Fix the authentication bug in src/auth.ts",
  "harness": "mclaude",
  "harness_options": {
    "variant": "fast",
    "model": "opus-4.5",
    "reasoning_effort": "high"
  },
  "hints": {
    "worker_type": "default",
    "permission_policy": "auto_edit",
    "timeout_seconds": 3600
  }
}
```

## CLI Mapping

- `--description` → `description`
- `--harness` → `harness`
- `--profile` → `harness_profile`
- `--variant` → `harness_options.variant`
- `--model` → `harness_options.model`
- `--reasoning` → `harness_options.reasoning_effort`
- `--worker-type` → `hints.worker_type`
- `--permission` → `hints.permission_policy`
- `--timeout` → `hints.timeout_seconds`

See [job-api.md](./job-api.md) for the full request/response shape and endpoints.
