# Dashboard Architecture

> **What**: Read-only "Horizon" operator UI (React + Vite).
> **Why**: Operators need one place to see jobs, apps, costs, and system health without CLI access.

## Overview

All data comes from the platform API through the `/api` proxy (`src/lib/api.ts`); auth uses
`@eve-horizon/auth-react` (`EveAuthProvider`/`EveLoginGate`). The UI is deliberately read-only —
mutations happen via the CLI/API.

## Routes (`src/app.tsx`)

| Route | Page | Backing APIs |
| --- | --- | --- |
| `/` | Home | org job stats, analytics summary, env health, events, spend, system status |
| `/jobs` | Jobs + detail + log viewer | org/project jobs, attempts, result, review, SSE streams |
| `/apps` | Apps | projects, envs, env health |
| `/apps/project` | Project detail | manifest, agents/teams/threads, pipelines, releases, routes, schedules |
| `/costs` | Costs | org spend, `orgs/:id/cost/apps`, admin cost endpoints (system admin) |
| `/system` | System admin | status, pods, settings, users, events, service logs |

Legacy routes (`/board`, `/project`, `/environments`, `/spending`) redirect to the new IA.

## Key Decisions (Why)

- **Read-only by design** — the dashboard observes; the CLI/API mutate.
- **Dark-first responsive shell** — desktop sidebar, tablet rail, mobile bottom tabs.

## Navigation

- Screenshot harness: `scripts/shoot.mjs`
- Cost attribution: `apps/api/src/billing/app-cost.service.ts`
