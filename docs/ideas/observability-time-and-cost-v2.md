# Execution Receipts: Time + Cost as First-Class Primitives

> Status: Idea (v2 — supersedes `observability-time-and-cost.md`)
> Last Updated: 2026-02-09
>
> Goal: Answer "where did the time go?" and "where did the money go?" with a single command.

## The Core Insight

V1 of this proposal modeled observability after distributed tracing — span taxonomies, W3C trace propagation, a generic `telemetry_spans` table, an LLM gateway proxy. That's the right model for a microservices mesh where any request can fan out to dozens of services in unpredictable patterns.

Eve is not that. Eve's execution model is a **pipeline**:

```
queue → workspace → secrets → hooks → harness (LLM calls) → result
```

Every job attempt walks the same phases in the same order. The "trace" is not a graph — it's a receipt.

**The receipt is the primitive.** Everything else — timelines, cost breakdowns, budgets, comparisons, aggregates — is a projection of receipts.

## What Exists Today

Eve already captures most of what we need:

| Signal | Where | Queryable? |
|--------|-------|------------|
| Phase timing (workspace/secrets/hooks/harness/runner) | `execution_logs` as `lifecycle_*` events | Only via log streaming — not indexed, not aggregatable |
| Total duration | `job_attempts.duration_ms` | Yes |
| Token totals (input/output) | `job_attempts.token_input/output` | Yes, but no model/provider/cost |
| Per-LLM-call usage | Embedded in harness streaming output (`raw.message.usage`) | No — `extractTokenUsage()` sums and discards |
| Correlation context | `x-eve-correlation-id` header + AsyncLocalStorage | Logs only, not linked to DB artifacts |
| Harness config (model, variant, reasoning) | `lifecycle_harness_start` meta | Logs only |

**The gap is not data collection. It's data shape.** The signals exist but are trapped in an unindexed JSONB log stream. The fix is to extract them into a queryable form — not to build a new telemetry system on top.

## Design Principles

1. **Receipt, not telescope.** Users want a summary they can read, not a dashboard they have to interpret. The default output should be prose, not a chart.

2. **Derive, don't duplicate.** Phase timings already exist in `execution_logs`. Extract and cache them — don't require services to write the same data to a second table.

3. **Cost is a function, not a table.** Pricing changes rarely. A config file + pure function (`f(provider, model, tokens) → cost`) is simpler and more correct than a `llm_pricing` table with foreign keys. Store the price-at-time alongside the usage event for historical accuracy.

4. **Phases are the spans.** Eve already has a phase taxonomy: `workspace`, `secrets`, `hooks`, `harness`, `runner`. Adding `queue_wait` (computed from timestamps) gives us complete coverage. We don't need a 15-name span taxonomy before we have any data.

5. **One new event type, not a new system.** The only signal we're truly missing is per-LLM-call usage with model identity. Everything else can be derived from what we already capture.

## The Execution Receipt

A receipt is a structured summary of resource consumption for one job attempt. It is **computed** from existing data (lifecycle events + harness logs) and **cached** on the attempt record for fast queries.

```typescript
interface ExecutionReceipt {
  // Phase breakdown (derived from lifecycle_* events in execution_logs)
  phases: {
    queue_wait_ms: number | null;   // job.ready_at → attempt.started_at
    workspace_ms: number | null;
    secrets_ms: number | null;
    hooks_ms: number | null;
    harness_ms: number | null;
    runner_ms: number | null;       // K8s only: pod schedule → ready
  };

  // LLM usage (derived from harness output or new llm.call events)
  llm: {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    model: string;                  // actual model used (not config intent)
    provider: string;               // anthropic | openai | google | zai
  };

  // Cost (computed from llm + pricing config)
  cost: {
    input_cost_usd: number;
    output_cost_usd: number;
    total_cost_usd: number;
    pricing_version: string;        // e.g. "2026-02-01" — which rate card
  };

  // Totals
  total_ms: number;
  harness_pct: number;              // % of wall time spent in LLM
}
```

### Why receipts compose

Receipts are additive. A pipeline receipt is the sum of its step receipts. A project's monthly spend is the sum of all job receipts. An org's dashboard is the sum of project receipts. No special aggregation logic needed — just addition.

```
Job Receipt           → sum of phase durations + LLM calls
Pipeline Receipt      → sum of job receipts (with critical path for timing)
Project Monthly       → sum of all job receipts in period
Org Dashboard         → sum of project receipts
```

## Implementation

### Layer 1: Phase Accounting (zero new tables)

**How it works**: The worker already writes `lifecycle_<phase>_end` events with `duration_ms`. We just need to extract these into a queryable form.

**Option A — Compute on read (Phase 0, zero schema changes):**

Add an API endpoint that reads `execution_logs` for an attempt, filters for `lifecycle_*_end` events, and assembles the receipt. Cache aggressively (attempts are immutable once complete).

```sql
-- Receipt assembly query (fast: scoped to one attempt, ~6 lifecycle events)
SELECT type, content->>'duration_ms' as duration_ms, content->>'success' as success
FROM execution_logs
WHERE attempt_id = $1 AND type LIKE 'lifecycle_%_end'
ORDER BY seq;
```

**Option B — Compute on write (Phase 1, one column):**

When the worker finalizes an attempt, compute the receipt and store it:

```sql
ALTER TABLE job_attempts ADD COLUMN receipt JSONB;
```

The worker already calls `updateAttempt()` with `duration_ms`, `token_input`, `token_output`. Adding `receipt` to that same write is trivial. This makes queries instant and avoids ever reading `execution_logs` for observability.

**Queue wait** is computed from existing timestamps:

```sql
-- queue_wait_ms: time from job becoming ready to attempt starting
SELECT
  EXTRACT(EPOCH FROM (a.started_at - j.updated_at)) * 1000 AS queue_wait_ms
FROM job_attempts a
JOIN jobs j ON j.id = a.job_id
WHERE a.id = $1;
```

(This approximation works because `jobs.updated_at` is set when phase transitions to `ready`. For exact tracking, we could add a `ready_at` timestamp column to `jobs` — one column, not a table.)

### Layer 2: Token Ledger (one new event type)

**The problem**: `extractTokenUsage()` sums all assistant message usage fields and discards the per-call breakdown. We lose:
- Which model was *actually* used (vs. configured)
- Per-call latency
- Cache/reasoning token breakdown
- Call count

**The fix**: Emit a typed `llm.call` event alongside the existing harness output.

Two options for where this happens:

**Option A — Worker-side extraction (simpler, works for all harnesses):**

The worker already streams harness output line by line. When it sees an assistant message with `usage`, instead of just summing tokens, it also appends a typed event to `execution_logs`:

```typescript
// In the streaming log processor, after detecting usage:
if (usage) {
  await this.logs.appendLog(attemptId, 'llm.call', {
    ts: new Date().toISOString(),
    provider: resolvedProvider,     // from harness config
    model: usage.model || configuredModel,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_input_tokens || 0,
    cache_write_tokens: usage.cache_creation_input_tokens || 0,
    // Anthropic-specific: extended thinking
    reasoning_tokens: usage.reasoning_tokens || 0,
    latency_ms: /* computed from last event timestamp */,
  });
}
```

This requires no changes to harnesses or eve-agent-cli. The worker is already parsing this data — it just needs to write it instead of only summing it.

**Option B — Harness-side emission (richer, but requires harness changes):**

Have eve-agent-cli emit `llm.call` events directly in its streaming output. This gives access to the actual provider response (including `request_id`, exact model string, stop reason, etc.). This is better long-term but requires changing the harness output contract.

**Recommendation**: Start with Option A (zero harness changes), graduate to Option B when we want richer data.

### Layer 3: Cost Function (config file, not a table)

Pricing is a lookup table that changes a few times per year. It does not need database storage, foreign keys, or migration management. A config file is simpler, versionable, and auditable.

```yaml
# packages/shared/src/config/llm-pricing.yaml
# Last updated: 2026-02-01
version: "2026-02-01"

anthropic:
  claude-opus-4-5:
    input_per_million: 15.00
    output_per_million: 75.00
    cache_read_per_million: 1.50
    cache_write_per_million: 18.75
  claude-sonnet-4-5:
    input_per_million: 3.00
    output_per_million: 15.00
    cache_read_per_million: 0.30
    cache_write_per_million: 3.75

openai:
  gpt-4.1:
    input_per_million: 2.00
    output_per_million: 8.00
  o3:
    input_per_million: 2.00
    output_per_million: 8.00

google:
  gemini-2.5-pro:
    input_per_million: 1.25
    output_per_million: 10.00

zai:
  glm-4-plus:
    input_per_million: 0.70
    output_per_million: 0.70
```

The cost function:

```typescript
function computeCost(
  provider: string,
  model: string,
  tokens: { input: number; output: number; cache_read?: number; cache_write?: number },
  pricingVersion?: string, // optional: use a specific historical version
): { input_usd: number; output_usd: number; total_usd: number; pricing_version: string } {
  const rates = getPricing(provider, model, pricingVersion);
  const input_usd  = (tokens.input * rates.input_per_million) / 1_000_000;
  const output_usd = (tokens.output * rates.output_per_million) / 1_000_000;
  // cache tokens priced at their respective rates (if available)
  const cache_read_usd  = ((tokens.cache_read || 0) * (rates.cache_read_per_million || rates.input_per_million)) / 1_000_000;
  const cache_write_usd = ((tokens.cache_write || 0) * (rates.cache_write_per_million || rates.input_per_million)) / 1_000_000;
  const total_usd = input_usd + output_usd + cache_read_usd + cache_write_usd;
  return { input_usd, output_usd, total_usd, pricing_version: rates.version };
}
```

**For historical accuracy**: When the receipt is computed (Layer 1, Option B), the `pricing_version` used is stored in the receipt. If pricing changes, old receipts keep their original cost. Recomputation is possible by replaying `llm.call` events against the new pricing config.

## CLI Surfaces

### `eve job receipt <job_id> [--attempt N]`

The primary command. Shows the receipt as a human-readable summary.

```
$ eve job receipt myproj-a3f2dd12

  Job: myproj-a3f2dd12  (attempt 1, succeeded)
  Duration: 47.2s

  Phase Breakdown:
    queue wait     2.1s   ▓░░░░░░░░░  4%
    workspace      5.8s   ▓▓░░░░░░░░ 12%
    secrets        0.3s   ░░░░░░░░░░  1%
    hooks          3.2s   ▓░░░░░░░░░  7%
    harness       35.8s   ▓▓▓▓▓▓▓░░░ 76%
                          ──────────
                   47.2s             100%

  LLM Usage:
    Model:    claude-opus-4-5 (anthropic)
    Calls:    3
    Tokens:   2,150 in → 847 out (+ 1,200 cache read)
    Cost:     $0.038  ($0.014 in + $0.024 out)

  Pricing: 2026-02-01 rate card
```

### `eve job receipt <job_id> --json`

Machine-readable receipt for scripting and aggregation.

### `eve job compare <job_a> <job_b>`

Side-by-side comparison. Useful for tuning: "did switching to Sonnet make it faster/cheaper?"

```
$ eve job compare myproj-a3f2dd12 myproj-b7e1cc34

                    Job A (opus-4.5)     Job B (sonnet-4.5)
  Duration:         47.2s                12.8s               -73%
  Harness time:     35.8s                 8.1s               -77%
  Tokens in:        2,150                 1,890              -12%
  Tokens out:         847                   623              -26%
  Cost:             $0.038               $0.009              -76%
```

### `eve project spend [--since 7d] [--group-by model|agent|job-type]`

Aggregated cost view. Sums receipts for all jobs in a project over a time window.

```
$ eve project spend --since 7d --group-by model

  Project: chat-gateway  (last 7 days)

  Model               Jobs    Tokens (in/out)     Cost      Avg/job
  claude-opus-4-5       42    89,400 / 34,200     $1.62     $0.039
  claude-sonnet-4-5     18    45,100 / 12,800     $0.33     $0.018
  glm-4-plus             6     8,200 / 3,100      $0.01     $0.002
                        ──    ─────────────────    ─────
  Total                 66    142,700 / 50,100     $1.96
```

### `eve project spend --group-by agent`

Same aggregation, grouped by agent identity. Answers "which agent is most expensive?"

### Enhance existing commands

- **`eve job diagnose`**: Include the receipt inline (phase breakdown + cost). Already shows logs — now also shows the structured summary.
- **`eve job result`**: Append cost estimate to the existing output (duration, tokens → + cost).
- **`eve job logs`**: No changes needed (receipt is a separate view, not a log filter).

## Budget Enforcement

Budgets are the natural policy layer on top of receipts.

### Job-level limits (immediate value)

Add to job hints:

```yaml
hints:
  max_cost_usd: 0.50
  max_tokens: 100000    # total input + output
```

**Enforcement**: The worker already streams harness output and counts tokens (`extractTokenUsage`). With the Layer 2 `llm.call` events, the worker can maintain a running total and kill the harness process when the budget is exceeded.

Implementation is ~20 lines in the worker's streaming loop:

```typescript
if (runningCostUsd > maxCostUsd) {
  harnessProcess.kill('SIGTERM');
  await this.logLifecycleEvent(attemptId, 'harness', 'end', {}, {
    success: false,
    error: `Budget exceeded: $${runningCostUsd.toFixed(3)} > $${maxCostUsd} limit`,
  });
}
```

### Project/org limits (later)

Once `eve project spend` works, we can add policy:

```yaml
# In manifest or org config
x-eve:
  budgets:
    monthly_usd: 50.00
    alert_at_pct: 80      # warn at 80% of budget
```

Enforcement at the orchestrator level: before claiming a job, check project spend against budget. If over, hold the job in `ready` and emit an alert. This is simple because receipts make spend queryable.

## What We Deliberately Don't Build

### No `telemetry_spans` table

V1 proposed a generic spans table with `scope_type`, `component`, `name`, etc. This is a mini-Jaeger. Eve doesn't need it because:
- The execution model is a fixed pipeline, not an arbitrary call graph
- Phases are the natural unit of decomposition — they're already named and ordered
- A JSONB `receipt` column on `job_attempts` gives us everything a spans table would, in one read instead of a join

If we ever need arbitrary spans (e.g., app-emitted traces), we can add them then. YAGNI now.

### No W3C trace propagation

`x-eve-correlation-id` is sufficient for Eve's architecture. The "trace" is:

```
gateway → API → orchestrator → worker → harness
```

That's 5 hops, all within our codebase, all sharing the same correlation ID via header propagation. W3C `traceparent`/`tracestate` would add complexity for zero benefit until we integrate with external services that require it.

Keep OTEL export for APM integration (it's already built). Don't refactor internal propagation.

### No LLM Gateway proxy

V1 proposed an in-environment reverse proxy for all LLM calls. That's a separate product with its own availability, latency, auth, and ops story. It's also unnecessary: harnesses already call providers directly and report usage. The receipt captures the same data without adding a network hop.

If apps want cost visibility, a lighter approach: ship an SDK that wraps provider clients and emits `llm.call` events to Eve's API. Same data, no proxy.

### No span taxonomy (yet)

V1 defined 15+ span names. We need exactly 6 (the existing lifecycle phases) + `queue_wait` (computed). If we later want sub-phase granularity (e.g., "git clone" vs "git checkout" within `workspace`), we can add sub-phases to the lifecycle contract without building a new system.

## Schema Changes Summary

**Phase 0** (zero migrations):
- Compute receipt from existing `execution_logs` in a new API endpoint
- Add `eve job receipt` CLI command
- Add cost computation using pricing config file

**Phase 1** (one migration):
```sql
ALTER TABLE job_attempts ADD COLUMN receipt JSONB;
-- Optional: add ready_at to jobs for accurate queue wait
ALTER TABLE jobs ADD COLUMN ready_at TIMESTAMPTZ;
```

**Phase 2** (worker changes only):
- Worker emits `llm.call` events to `execution_logs` during streaming
- Worker computes and stores receipt on attempt finalization
- Token ledger queryable via receipt or raw `llm.call` events

**Phase 3** (policy):
- Budget enforcement in worker (job-level)
- Budget queries via receipt aggregation (project/org-level)
- Alerting when approaching limits

## Comparison with V1

| Concern | V1 | V2 |
|---------|----|----|
| New tables | 4 (`telemetry_spans`, `attempt_observability`, `llm_pricing`, `llm_usage_events`) | 0-1 (one JSONB column on existing table) |
| New event types | Full span taxonomy (15+ names) | 1 (`llm.call` in existing `execution_logs`) |
| Trace propagation | W3C `traceparent`/`tracestate` overhaul | Keep existing `x-eve-correlation-id` |
| Pricing storage | Database table with FK references | Config file + pure function |
| Cost computation | At ingestion time, stored with pricing FK | At receipt time, pricing version recorded |
| App integration | OTEL collector + LLM Gateway proxy | Lightweight SDK or direct API emit |
| Phase 0 effort | Moderate (new commands + timeline rendering) | Minimal (one query + one CLI command) |
| CLI model | Separate `timeline` and `cost` commands | One `receipt` command (time + cost unified) |

## Open Questions

1. **Receipt staleness**: If we store receipts on `job_attempts`, how do we handle recomputation when pricing changes? Options: (a) don't — old receipts keep old prices, (b) add a `recompute-receipts` admin command, (c) always compute cost on read (but cache phase timing).

2. **Multi-model jobs**: A job might use different models across LLM calls (e.g., tool-use calls vs. main reasoning). The receipt should support per-model breakdowns, but the simple `llm.model` field may need to become an array.

3. **Pipeline receipts**: A pipeline run's receipt is the sum of its step receipts, but the *duration* is the critical path, not the sum. Need a `pipeline_receipt` that captures both total cost (sum) and wall-clock duration (max of parallel paths).

4. **Chat message receipts**: A chat message dispatches to one or more agents (jobs). The message's receipt is the sum of agent receipts. The `thread_messages` table may need a `receipt` column too, or we compute it by joining through `jobs`.

5. **Workspace reuse savings**: When a workspace is reused, `workspace_ms` drops dramatically. Should the receipt capture "savings from reuse" (compared to a cold start baseline)?

## Related

- V1 proposal: `docs/ideas/observability-time-and-cost.md`
- Current observability: `docs/system/observability.md`
- Lifecycle events (implemented): `packages/shared/src/types/lifecycle.ts`
- Worker invoke pipeline: `apps/worker/src/invoke/invoke.service.ts`
- Token extraction: `apps/worker/src/invoke/invoke.service.ts` (`extractTokenUsage`)
- Execution logs: `packages/db/src/queries/execution-logs.ts`
- Job attempts schema: `packages/db/migrations/00001_initial_schema.sql`, `00003_add_job_attempt_results.sql`
