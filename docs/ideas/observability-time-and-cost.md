# First-Class Observability: Time + LLM Cost

> Status: Idea
> Last Updated: 2026-02-09
>
> Goal: make performance tuning and cost tuning **obvious** from the Eve CLI and API, and make the same capabilities available to Eve-compatible apps.

## Summary

Eve already has the foundation for CLI-first debugging:

- Correlation IDs + structured logs (`x-eve-correlation-id`, JSON logs)
- Optional OTEL export (Node auto-instrumentation)
- Per-attempt log stream (`execution_logs`) with structured lifecycle events (`lifecycle_*`)
- Per-attempt totals (`job_attempts.duration_ms`, `token_input`, `token_output`)

But we do not yet treat **time** and **money** as first-class primitives:

- Time is not presented as a single end-to-end timeline across chat → API → orchestrator → worker/runner → harness.
- Token counts exist, but costs are not modeled, not queryable, and not comparable (per job/pipeline/message).
- Apps deployed via Eve have no standard, low-friction way to participate in the same observability system.

This doc proposes two platform primitives:

1. **Execution Timeline** (performance/timing)
2. **LLM Usage Ledger** (API usage + cost)

Both should work for jobs, pipelines/workflows (job-graphs), and chat-driven executions.

## Goals

- **Single-command answers**:
  - “Where did the time go?” (queue wait vs clone vs build vs LLM vs deploy vs posting response)
  - “Where did the money go?” (which steps/messages/requests)
- **Cross-run comparisons**:
  - p50/p95 duration breakdown by phase for a project/pipeline/harness/model
  - cost distributions and “top spenders”
- **End-to-end correlation** across components:
  - gateway → API → orchestrator → worker → runner → harness
- **Extend to Eve-compatible apps**:
  - apps emit timing and LLM usage into the same system (or a compatible subset)
  - apps can read their own observability data to tune and reduce spend

## Non-Goals (for now)

- Full APM product integration (Datadog/NewRelic/etc) as a hard dependency
- A general log search system (Loki/ELK) as the primary UX
- Capturing full prompt/response content by default (too sensitive + too expensive)

## Current State (Ground Truth)

### Platform observability that exists today

- Correlation header + JSON logs: `docs/system/observability.md`, `packages/shared/src/observability.ts`, `packages/shared/src/logger.ts`
- OTEL bootstrap: `packages/shared/src/otel.ts` (Node auto-instrumentations, OTLP HTTP exporter)
- AWS overlay ships an OTEL collector: `k8s/addons/otel-collector-aws.yaml` (X-Ray traces + EMF metrics)
- Job execution log stream:
  - `execution_logs` table (append-only JSON events)
  - lifecycle events contract: `packages/shared/src/types/lifecycle.ts`
  - worker writes lifecycle events for workspace/hooks/secrets/harness: `apps/worker/src/invoke/invoke.service.ts`
- Attempt-level totals:
  - `job_attempts.duration_ms`, `token_input`, `token_output` (migrations `00001_initial_schema.sql`, `00003_add_job_attempt_results.sql`)
  - tokens derived from harness JSON output: `apps/worker/src/invoke/invoke.service.ts` (`extractTokenUsage`)

### Major gaps

- `trace_id` in logs is currently just the correlation ID, not the OTEL trace ID.
- We lack first-class **queue latency** and **orchestration overhead** metrics:
  - time from `job.phase=ready` to attempt start
  - time in orchestrator loop before worker submission
  - time waiting for runner completion events (poll interval adds jitter)
- Lifecycle events exist but are:
  - not complete (missing git commit/push, action executor phases, build/deploy sub-phases, runner pod scheduling readiness details in a single timeline)
  - not unified across job vs pipeline step vs chat message boundaries
- Token counts exist, but:
  - no provider/model identity recorded per request (only job config intent, not actual usage)
  - no per-request usage (only totals by summing assistant message usage fields)
  - no cost computation or budgeting
- Apps do not have a platform contract to emit:
  - timings that correlate to Eve job/pipeline/chat contexts
  - LLM usage events and costs

## Proposal Overview

Treat **time** and **money** as first-class, queryable resources in Eve:

1. Execution Timeline:
   - A consistent span/event taxonomy
   - End-to-end propagation of trace/correlation context
   - Query + render timelines and breakdowns via CLI/API

2. LLM Usage Ledger:
   - Standard usage events (provider/model/tokens/latency)
   - Deterministic cost computation with pricing snapshots
   - Budgets/limits as policy (project/env/job)

Both should:

- Attach to multiple scopes: job attempt, pipeline run, pipeline step job, workflow invocation, thread message dispatch.
- Be safe by default: no secrets, no prompt content unless explicitly enabled.

## 1) Execution Timeline (Performance / Timing)

### What “first-class timing” means in Eve

For any execution scope (job attempt, pipeline run, chat message), Eve should be able to answer:

- A timeline of **spans** (start/end, duration, status) with consistent names.
- A breakdown by **phase** and by **component** (gateway/API/orchestrator/worker/runner/harness).
- A comparable “shape” across runs (same span names) so we can compute aggregates.

### Span taxonomy (initial)

Start with a deliberately small set that maps to our current architecture:

- `queue.wait` (ready → claimed)
- `api.request` (per inbound request; attach route + status)
- `orchestrator.claim`
- `orchestrator.worker_submit`
- `orchestrator.wait_runner` (polling/wait time to completion event)
- `worker.workspace` (sub-spans: clone/copy, checkout, git-branch, etc)
- `worker.secrets.resolve`
- `worker.hook.<name>`
- `worker.action.<type>` (build/release/deploy/run/job)
- `worker.harness` (overall)
- `harness.llm.request` (per provider request, if available)
- `runner.pod.schedule` / `runner.pod.ready` (k8s)
- `gateway.slack.ingest` / `gateway.slack.dispatch`
- `gateway.slack.post_reply`

Notes:
- We already have lifecycle phases (`workspace`, `hook`, `secrets`, `harness`, `runner`) in `execution_logs`.
- This proposal is to make those phases:
  1) complete and consistent
  2) renderable as a single timeline
  3) exportable as OTEL spans where configured

### Context propagation (critical for end-to-end timelines)

Current:
- `x-eve-correlation-id` is propagated.
- OTEL exists but is not correlated to our logs/DB artifacts in a strict way.

Proposed:
- Adopt W3C trace context propagation (`traceparent`, `tracestate`) in all services.
- Keep `x-eve-correlation-id` as a stable “human handle”, but:
  - ensure logs include the real OTEL `trace_id` + `span_id`
  - attach `correlation_id` as an OTEL span attribute
- Add an Eve context header set for internal calls:
  - `x-eve-job-id`, `x-eve-attempt-id`, `x-eve-thread-id`, `x-eve-event-id`
  - these should be optional and only used where safe/appropriate

### Storage: DB-first, OTEL-export optional

We want CLI-first to remain true even when no collector is configured.

Proposed storage model:

- **Keep** `execution_logs` as the canonical append-only stream for attempt logs.
- Add **query-friendly** tables/materializations for timeline and aggregates:
  - raw spans are great for timeline rendering and percentile aggregates
  - pre-aggregated breakdowns make CLI fast and stable

Example tables (sketch):

```sql
-- Generic spans for multiple scopes.
-- scope_type: 'attempt' | 'pipeline_run' | 'thread_message' | 'build_run' | ...
CREATE TABLE telemetry_spans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT,
  project_id TEXT,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  component TEXT NOT NULL,         -- api|orchestrator|worker|runner|gateway|app
  status TEXT NOT NULL,            -- ok|error|cancelled
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_ms INTEGER,
  attrs JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optional fast-path “summary row” per attempt.
CREATE TABLE attempt_observability (
  attempt_id UUID PRIMARY KEY,
  queue_wait_ms INTEGER,
  workspace_ms INTEGER,
  secrets_ms INTEGER,
  hooks_ms INTEGER,
  harness_ms INTEGER,
  runner_ms INTEGER,
  total_ms INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Implementation note:
- We can materialize `telemetry_spans` from `execution_logs` lifecycle events (and orchestrator/gateway events) to avoid large refactors.
- Alternatively, services can write spans directly if we prefer (but then we must solve batching and resilience).

### CLI surfaces

Add “time-first” commands (all backed by API):

- `eve job timeline <job_id> [--attempt N]`:
  - prints spans (start/end/duration) and a summary breakdown
  - includes queue wait + orchestration overhead
- `eve pipeline timeline <pipeline> <run_id>`:
  - step breakdown + critical path
  - aggregates token/cost per step if available
- `eve thread timeline <thread_id> [--since 1h]`:
  - message-by-message end-to-end latency (ingest → reply posted)
- Extend `eve job diagnose` to always include:
  - queue wait, workspace/hook/secrets/harness/runner durations
  - the slowest spans and their meta

## 2) LLM Usage Ledger (Usage + Cost)

### What “first-class cost” means

For any execution scope (job attempt, pipeline step job, chat message), Eve should be able to answer:

- LLM usage totals:
  - input/output tokens (and cache/reasoning tokens if available)
  - request count
  - p50/p95 LLM latency
- Estimated or actual cost (by provider/model/pricing snapshot)
- Comparisons across runs and configuration changes

### Standard usage event schema

We should define one “golden” event schema that:

- is emitted by harnesses (via `eve-agent-cli` output) and optionally apps (SDK/proxy)
- is stored in DB and can be exported to OTEL

Sketch:

```json
{
  "ts": "2026-02-09T12:34:56.789Z",
  "type": "llm.usage",
  "provider": "anthropic|openai|google|zai",
  "model": "opus-4.5",
  "request_id": "prov_req_...",
  "latency_ms": 1234,
  "input_tokens": 123,
  "output_tokens": 456,
  "cache_read_tokens": 0,
  "cache_write_tokens": 0,
  "reasoning_tokens": 0,
  "status": "ok|error",
  "error": null,
  "meta": {
    "harness": "mclaude",
    "job_id": "myproj-a3f2dd12",
    "attempt_id": "..."
  }
}
```

Key rule: **do not** store prompts/responses by default. If we ever sample content, it must be:
- opt-in per env/project
- aggressively redacted
- stored with short TTL

### Cost computation and pricing snapshots

To make costs useful (and stable over time), we need pricing snapshots:

Option A (simple): compute estimated cost at read-time using “current” pricing.
- Pros: minimal schema.
- Cons: historical costs drift when pricing changes.

Option B (recommended): store:
- raw usage (tokens)
- pricing snapshot reference (or explicit unit prices)
- computed `cost_usd_micros` at ingestion time

Sketch:

```sql
CREATE TABLE llm_pricing (
  id TEXT PRIMARY KEY,                     -- price_...
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_usd_per_million NUMERIC NOT NULL,
  output_usd_per_million NUMERIC NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE llm_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT,
  project_id TEXT,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  request_id TEXT,
  latency_ms INTEGER,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  pricing_id TEXT REFERENCES llm_pricing(id),
  cost_usd_micros BIGINT,
  status TEXT NOT NULL,
  error TEXT,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Budgets / limits (policy)

Costs only become “tunable” when budgets exist. We should support:

- per org budget (daily/monthly)
- per project budget
- per environment (e.g., staging unlimited, prod strict)
- per job limit (`max_cost_usd`, `max_tokens`)

Integrations:

- manifest defaults: `x-eve.defaults.cost`
- job hints override: `job.hints.max_cost_usd`, `job.hints.max_tokens`
- enforcement points:
  - worker/harness: stop execution when threshold reached
  - orchestrator: prevent claiming or requeue with “budget exceeded”

## Extending To Eve-Compatible Apps

We want apps to participate with minimal friction and without forcing a specific stack.

### A. Timing/Tracing for apps (OTEL-first)

Mechanism:

- Provide an OTEL collector endpoint per environment (or per cluster) and inject:
  - `OTEL_ENABLED=true`
  - `OTEL_EXPORTER_OTLP_ENDPOINT=...`
  - resource attributes for org/project/env/service
- Define a minimal Eve convention for resource attributes:
  - `eve.org_id`, `eve.project_id`, `eve.env_name`, `eve.service`
- Encourage apps to use standard OTEL SDKs in any language.

Manifest idea:

```yaml
services:
  api:
    x-eve:
      observability:
        otel: true           # inject OTEL env vars
        traces: true
        metrics: true
        logs: false
```

### B. LLM costs for apps (proxy-first)

Token/cost observability is hard to get from generic HTTP spans. A pragmatic approach:

- Ship an in-env **Eve LLM Gateway** (reverse proxy/router) that:
  - accepts an “Eve identity” (service-to-service auth)
  - forwards to providers (Anthropic/OpenAI/etc)
  - captures usage and cost (since providers return `usage`)
  - emits `llm.usage` events into Eve

Apps opt-in by setting provider base URLs to the gateway:

- `OPENAI_BASE_URL=http://eve-llm-gateway...`
- `ANTHROPIC_BASE_URL=http://eve-llm-gateway...`

This also unlocks:
- caching policies
- rate limiting
- centralized budgets and per-project enforcement

## Rollout Plan (Incremental)

### Phase 0: Make existing signals visible (CLI-only)

- Add `eve job timeline` that renders existing `lifecycle_*` logs and attempt totals.
- Add “queue wait” computed from job/attempt timestamps (no schema changes).
- Add `eve job cost` that shows `token_input/output` and a rough “estimate” if pricing config exists locally.

### Phase 1: Standardize span + usage events

- Ensure every execution type emits complete lifecycle spans:
  - action executor build/release/deploy sub-phases
  - git commit/push timing
  - runner pod schedule/ready timings (k8s)
- Update `eve-agent-cli`/harness adapters to emit `llm.usage` events consistently across harnesses.

### Phase 2: First-class storage + APIs

- Add `telemetry_spans` + `llm_usage_events` tables (or materialized views).
- Add API endpoints:
  - `GET /jobs/:id/timeline`
  - `GET /jobs/:id/cost`
  - `GET /pipeline-runs/:id/timeline`
  - `GET /threads/:id/timeline`
- Add “top spans / top costs” query endpoints per project.

### Phase 3: App integration

- Ship OTEL collector in all environments (local + staging + prod).
- Add manifest `x-eve.observability` (opt-out supported).
- Add Eve LLM Gateway (opt-in, then default for Eve-native apps).

## Open Questions

- Pricing source-of-truth:
  - static config checked in?
  - admin-managed table updated via CLI?
  - remote fetch with version pinning?
- Token accounting across providers (cache/reasoning tokens differ).
- Data volume + retention:
  - how long do we keep per-request usage events?
  - what’s the default TTL for raw spans vs aggregates?
- How do we correlate “chat message → job → reply” when replies are posted asynchronously or by multiple agents?

## Related

- Current observability doc: `docs/system/observability.md`
- Existing lifecycle event plan (implemented pattern): `docs/plans/job-execution-observability-v2.md`
- Build/deploy debugging plan: `docs/plans/build-deploy-observability-plan.md`
- Worker lifecycle logging implementation: `packages/shared/src/types/lifecycle.ts`, `apps/worker/src/invoke/invoke.service.ts`
- OTEL collector (AWS): `k8s/addons/otel-collector-aws.yaml`

