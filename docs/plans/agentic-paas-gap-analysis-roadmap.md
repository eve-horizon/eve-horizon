# Agentic PaaS Gap Analysis Roadmap

> Status: Draft
> Last Updated: 2026-01-22
> Purpose: Prioritized gaps and roadmap sizing to complete an agent‑native PaaS.

This plan captures missing capabilities for a production‑grade agentic PaaS, with
priorities, phase sequencing, and rough sizing. It focuses on three pillars:
**Auth & Governance**, **Triggers & Automation**, and **Agentic Remediation & Improvement**.

## Assumptions

- Event spine exists but does **not** yet launch pipelines/workflows from triggers.
- Auth is HS256 JWT with `EVE_AUTH_ENABLED` and minimal `/auth/me` only.
- Cron scheduler is a placeholder; manifest‑driven schedules are not implemented.
- Self‑healing/self‑improvement means **agentic workflows** that are:
  - **Error‑triggered** (pipeline/job failures, log monitoring)
  - **Cron‑driven** (scheduled analysis of usage/logs)
  - **PR‑producing** (patches land as pull requests for human approval)

## Eve Primitive Mapping

These flows are built from existing primitives whenever possible:

| Primitive | Role |
| --- | --- |
| **Event** (`system.*`, `github.*`, `cron.tick`) | Trigger input | 
| **Trigger** (manifest `pipelines.*.trigger` / `workflows.*.trigger`) | Event → automation routing |
| **Pipeline/Workflow** | Orchestrate remediation or improvement | 
| **Job** (agent/script/action) | Execution unit | 
| **Action** (`create-pr`, future) | Create PR from agent output | 

**Error‑triggered flow:**

```
event (system.job.failed) → trigger match → remediation pipeline/workflow → agent job → create-pr action → PR for review
```

**Cron‑driven flow:**

```
cron.tick → trigger match → improvement workflow → agent job → create-pr action → PR for review
```

## Dependencies (High Level)

- **RBAC** depends on a user/org/project membership model.
- **Trigger→Job execution** depends on stable pipeline/workflow definitions + event router changes.
- **Agentic remediation** depends on observability (metrics, correlation IDs, error taxonomy).
- **Error events** depend on a normalized error taxonomy and event emission from job/pipeline failures.
- **PR workflows** depend on git auth + repo write access + review gates.
- **SSO/OIDC** depends on a chosen identity strategy (Supabase‑first vs multi‑IdP).

## Priority Summary (P0/P1/P2)

### P0 (Critical for production launch)

**Auth & Governance**
- User + membership model (org/project) — **Size: L** (2–4 weeks)
- RBAC enforcement across API — **Size: L** (2–4 weeks)

**Triggers & Automation**
- Event router → pipeline/workflow job creation — **Size: L** (2–3 weeks)
- Webhook signature verification (GitHub) — **Size: S** (2–4 days)

**Agentic Remediation Core**
- Observability foundation (metrics + correlation IDs + error taxonomy) — **Size: L** (2–3 weeks)
- Error→event mapping (pipeline/job/log monitoring) — **Size: M** (1–2 weeks)
- PR‑producing remediation workflow (event → workflow → patch → PR) — **Size: L** (2–3 weeks)

### P1 (Required for multi‑tenant robustness)

**Auth & Governance**
- API keys + scoped tokens + revocation — **Size: M** (1–2 weeks)
- Security audit events (auth, secret access, permission changes) — **Size: M** (1–2 weeks)

**Triggers & Automation**
- Manifest‑driven cron scheduling + event emission — **Size: M** (1–2 weeks)
- Event dedupe/idempotency enforcement — **Size: M** (1–2 weeks)

**Agentic Remediation Mechanics**
- Retry/backoff policy engine + circuit breaker — **Size: L** (2–3 weeks)
- Error‑specific remediation handlers — **Size: M** (1–2 weeks)
- Cron‑driven improvement workflows (usage/logs → analysis → PR) — **Size: L** (2–3 weeks)

### P2 (Production hardening + quality)

**Auth & Governance**
- SSO/OIDC integration — **Size: L** (2–4 weeks)
- Session management + revoke — **Size: M** (1–2 weeks)
- Rate limiting (auth + org‑level) — **Size: M** (1–2 weeks)

**Triggers & Automation**
- Trigger schema validation + versioning — **Size: M** (1–2 weeks)
- Step‑level status/log consistency (jobs vs pipeline steps) — **Size: M** (1–2 weeks)

**Agentic Improvement**
- Post‑execution validation hooks + quality scoring — **Size: M** (1–2 weeks)
- Feedback loop (user ratings + skill effectiveness) — **Size: M** (1–2 weeks)
- PR approval gates integrated into pipelines/workflows — **Size: M** (1–2 weeks)

## Roadmap Phases

### Phase 1 — Production Baseline (P0)

- Implement user/org/project membership + RBAC
- Add event router job creation for pipeline/workflow triggers
- Add webhook signature verification
- Add observability foundation (metrics + correlation + error taxonomy)
- Map errors → events (pipeline/job/log) and trigger remediation workflows
- Implement PR‑producing remediation workflow (patch + PR for review)

### Phase 2 — Multi‑Tenant Robustness (P1)

- Add API keys and security audit events
- Implement cron scheduling + event idempotency
- Add retry/backoff + circuit breaker + remediation handlers
- Implement cron‑driven improvement workflows (scheduled analysis → PR)

### Phase 3 — Hardening + Quality (P2)

- Add SSO/OIDC + sessions + rate limiting
- Validate trigger schemas and normalize step logging
- Add quality gates + feedback loop
- Add PR approval gates across pipelines/workflows (where not already covered)

## Notes / Open Decisions

1. **Identity strategy**: Supabase‑first vs multi‑IdP abstraction.
2. **Authorization model**: RBAC only vs RBAC + ABAC (post‑P2).
3. **Autonomy model**: approval‑required vs auto‑remediation thresholding.
4. **PR surface**: single‑file fixes vs multi‑file refactors.
5. **Retry vs remediate**: when to retry vs trigger an agentic pipeline.

## Suggested Tracking

Break each item into a Beads task once approved; link to owning service(s):

- API (auth, RBAC, events, pipeline/workflow trigger execution)
- Orchestrator (event routing, retries, circuit breaker, trigger matching)
- Worker (error classification, retryable failure codes, create‑PR action)
- Shared (error taxonomy, PR action schema, feedback event types)
