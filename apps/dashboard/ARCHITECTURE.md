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
- **Job and agent text is data, never markup** — log lines render as React text nodes; ANSI colour
  codes and search matches only add classes (`src/lib/ansi.ts`). Nothing renders API text as HTML.
- **Content-Security-Policy on every page** — `server.js` sends it
  (`server/content-security-policy.js`): scripts only from the dashboard's own files (so
  `index.html` keeps no inline script; the pre-paint theme script is `public/theme-init.js`),
  Google Fonts for styles and fonts, and `connect-src` limited to the page itself plus the SSO
  origin. That origin is `EVE_SSO_URL` when set (`k8s/base` sets it); otherwise the server
  learns it from the API's `/auth/config`, the same `sso_url` the browser gets, so it needs no
  extra configuration. Responses never wait on that lookup: it runs in the background (at start,
  every minute, and with backoff after failures), and until it first succeeds the policy allows
  only the page's own origin.

## Navigation

- Screenshot harness: `scripts/shoot.mjs`
- Cost attribution: `apps/api/src/billing/app-cost.service.ts`
