# Execution Receipts: Time + Cost as First-Class Primitives (v3)

> Status: Idea
> Last Updated: 2026-02-09
>
> Supersedes: `observability-time-and-cost.md` (v1), `observability-time-and-cost-v2.md` (v2)
>
> Layer 1 of the Eve resource stack. See [Relationship to Other Docs](#relationship-to-other-docs) for how this fits with the platform resource plane, nostrworld, and Nostr integration.

## The Two Questions

Every person who runs a job on Eve eventually asks:

1. **"Where did the time go?"** — Was it queued? Cloning? Thinking? Waiting for a pod?
2. **"Where did the money go?"** — Which model? How many calls? What compute resources? What did it all cost?

Today, the answers are scattered across lifecycle events buried in an unindexed JSONB log stream, token totals with no model identity, and no cost computation at all. The signals exist — they're just the wrong shape.

## The Primitive: Execution Receipt

A receipt is a structured, self-contained summary of resource consumption for one job attempt. It captures the full lifecycle — where time was spent, which models were called, what each call cost, and the rates used to compute the cost.

Receipts are:
- **Computed deterministically** from the event stream (`execution_logs`)
- **Stored on the attempt record** for instant queries
- **Recomputable** at any time from events (pricing change, bug fix, backfill)
- **Self-contained** — the receipt includes the pricing rates used, not a reference to an external table
- **Composable** — a pipeline receipt is the sum of its step receipts; a project's monthly spend is the sum of all job receipts

```typescript
interface ExecutionReceipt {
  // What this receipt covers
  scope: {
    type: 'attempt' | 'pipeline_run' | 'pipeline_step' | 'chat_message' | 'project';
    id: string;
  };

  // Full lifecycle timing
  phases: {
    lead_time_ms: number | null;       // job.created_at → attempt.execution_started_at
    queue_wait_ms: number | null;      // job.ready_at → attempt.claimed_at
    orchestrator_ms: number | null;    // attempt.claimed_at → attempt.execution_started_at
    workspace_ms: number | null;       // from lifecycle events
    secrets_ms: number | null;
    hooks_ms: number | null;
    harness_ms: number | null;
    runner_ms: number | null;          // K8s only: pod schedule → ready
  };

  // LLM usage with per-model breakdown
  llm: {
    total_calls: number;
    total_input_tokens: number;
    total_output_tokens: number;
    by_model: Array<{
      provider: string;                // anthropic | openai | google | zai
      model: string;                   // actual model used, not config intent
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      reasoning_tokens: number;
    }>;
  };

  // Compute resources consumed (K8s runner pod)
  compute: {
    resource_class: string | null;     // job.c1, job.c2, job.m1 — null if no class assigned
    vcpu_seconds: number;              // requested vCPU × execution duration
    memory_gib_seconds: number;        // requested GiB × execution duration
  };

  // Cost: unified LLM + compute, denomination-agnostic, self-contained
  cost: {
    currency: string;                  // 'usd' | 'sats' | 'credits'
    total: number;
    llm_total: number;
    compute_total: number;

    // Self-contained: the actual rates applied, embedded in the receipt
    llm_rates: Array<{
      provider: string;
      model: string;
      input_rate_per_million: number;
      output_rate_per_million: number;
      cache_read_rate_per_million: number | null;
      cost: number;                    // computed cost for this model
    }>;
    compute_rate: {
      resource_class: string | null;
      rate_per_vcpu_hour: number;
      rate_per_gib_hour: number;
    } | null;

    pricing_version: string;           // e.g. "2026-02-01"
  };

  // Summary
  total_ms: number;
  harness_pct: number;                 // % of wall time in LLM

  // For composed receipts (pipeline runs, chat messages)
  children?: ExecutionReceipt[];
}
```

### Why self-contained costs?

The receipt stores the actual unit prices used — not a foreign key to a pricing table, not a version string that requires a lookup. Any receipt can be read and understood in isolation: what tokens were used, what compute was consumed, at what rates, producing what cost. This means:

- Historical receipts are correct by construction
- No external lookup needed to understand a cost
- Recomputing with new prices is explicit (admin command), not implicit (config change)
- Per-org pricing overrides or negotiated rates are captured in the receipt itself
- The same receipt structure works whether cost is denominated in USD (enterprise), sats (nostrworld), or abstract credits

### Why receipts compose

Receipts are additive with scope-appropriate rules:

| Aggregation | Cost | Tokens | Compute | Duration |
|------------|------|--------|---------|----------|
| Pipeline (sequential steps) | sum | sum | sum | sum |
| Pipeline (parallel branches) | sum | sum | sum | max (critical path) |
| Chat message → jobs | sum | sum | sum | wall-clock of containing message |
| Project over time window | sum | sum | sum | N/A (report total + per-job) |

Pipeline runs and chat messages don't need stored receipts — they're computed by aggregating child receipts. But the type system supports composition from day one so we don't redesign later.

## What Exists Today

| Signal | Captured? | Queryable? | Gap |
|--------|-----------|------------|-----|
| Phase timing (workspace/secrets/hooks/harness/runner) | Yes — `lifecycle_*` events in `execution_logs` | No — trapped in unindexed JSONB | Not materialized |
| Total duration | Yes — `job_attempts.duration_ms` | Yes | No phase breakdown |
| Token totals | Yes — `job_attempts.token_input/output` | Yes | No model identity, no per-call breakdown |
| Per-LLM-call usage | Partially — embedded in assistant message `usage` fields | No — `extractTokenUsage()` sums and discards | No structured event |
| Compute resources (vCPU, memory) | Partially — resource class in job hints, K8s pod spec | No | Not recorded on attempt; no resource class tracking |
| Queue wait | No | No | No `ready_at` or `claimed_at` timestamps |
| Orchestrator overhead | No | No | `started_at` conflates claim time with execution start |
| Cost (LLM) | No | No | No pricing model, no computation |
| Cost (compute) | No | No | No resource class billing rates |
| Harness config (model, variant) | Yes — in `lifecycle_harness_start` meta | Logs only | Not on attempt record |

**The gap is data shape, not data collection.** Most signals exist but are buried in `execution_logs` JSONB. The fix is to extract them into a queryable receipt.

## Architecture

### Four layers within this doc, each building on the last:

```
Layer 4: Budget Enforcement        ← policy on top of receipts
Layer 3: Token Ledger              ← per-call LLM usage events
Layer 2: Compute Accounting        ← resource class + K8s resource tracking
Layer 1: Phase Accounting + Receipt Storage  ← materialized from lifecycle events
         ─────────────────────────
         execution_logs            ← existing event stream (source of truth)
```

Above these four layers sit the **financial ledger** (balances, transactions, payments — see `platform-resource-plane.md`) and the **protocol skin** (Nostr identity, Lightning payments — see `nostrworld-agentic-paas.md`). This doc owns metering and cost visibility; those docs own billing and payments. See [Relationship to Other Docs](#relationship-to-other-docs).

### Layer 1: Phase Accounting + Receipt Storage

**Goal**: Materialize phase timing into a queryable receipt on `job_attempts`.

**Schema changes**:

```sql
-- Accurate lifecycle timestamps on jobs
ALTER TABLE jobs ADD COLUMN ready_at TIMESTAMPTZ;

-- Full attempt lifecycle + receipt storage
ALTER TABLE job_attempts
  ADD COLUMN claimed_at TIMESTAMPTZ,
  ADD COLUMN execution_started_at TIMESTAMPTZ,
  ADD COLUMN receipt JSONB;
```

**What changes in code**:

1. **Orchestrator** (`loop.service.ts`): When a job transitions to `ready` phase, set `jobs.ready_at`. When claiming an attempt, set `attempt.claimed_at` to `NOW()`.

2. **Worker** (`invoke.service.ts`): At the start of the invoke pipeline (before workspace prep), set `attempt.execution_started_at`. This distinguishes claim time from execution start.

3. **Worker** (attempt finalization): After execution completes, compute the receipt from lifecycle events and store it:

```typescript
// Receipt assembly — runs once when attempt finalizes
async function assembleReceipt(attemptId: string, job: Job, attempt: Attempt): Promise<ExecutionReceipt> {
  // 1. Read lifecycle events for this attempt
  const logs = await this.logs.listLogs(attemptId);
  const lifecycleEnds = logs.filter(l => l.type.endsWith('_end'));

  // 2. Extract phase durations
  const phases = {
    lead_time_ms: diffMs(job.created_at, attempt.execution_started_at),
    queue_wait_ms: diffMs(job.ready_at, attempt.claimed_at),
    orchestrator_ms: diffMs(attempt.claimed_at, attempt.execution_started_at),
    workspace_ms: findDuration(lifecycleEnds, 'workspace'),
    secrets_ms: findDuration(lifecycleEnds, 'secrets'),
    hooks_ms: findDuration(lifecycleEnds, 'hook'),
    harness_ms: findDuration(lifecycleEnds, 'harness'),
    runner_ms: findDuration(lifecycleEnds, 'runner'),
  };

  // 3. Aggregate LLM call events (from Layer 3)
  const llmCalls = logs.filter(l => l.type === 'llm.call');
  const llm = aggregateLlmCalls(llmCalls);

  // 4. Compute resource consumption (from Layer 2)
  const resourceClass = job.hints?.resource_class || null;
  const classSpec = resourceClass ? getResourceClassSpec(resourceClass) : null;
  const executionSeconds = (attempt.duration_ms || 0) / 1000;
  const compute = {
    resource_class: resourceClass,
    vcpu_seconds: classSpec ? classSpec.vcpu * executionSeconds : 0,
    memory_gib_seconds: classSpec ? classSpec.memory_gib * executionSeconds : 0,
  };

  // 5. Compute cost: LLM + compute, using pricing config
  const pricingConfig = getPricingConfig();
  const cost = computeUnifiedCost(llm, compute, pricingConfig);

  // 6. Assemble
  return {
    scope: { type: 'attempt', id: attemptId },
    phases,
    llm,
    compute,
    cost,
    total_ms: attempt.duration_ms,
    harness_pct: phases.harness_ms ? Math.round((phases.harness_ms / attempt.duration_ms) * 100) : 0,
  };
}
```

**Receipt recomputation**:

```bash
# Admin command: recompute receipts (e.g., after pricing update or bug fix)
eve admin recompute-receipts --project myproj --since 2026-01-01
eve admin recompute-receipts --attempt <uuid>
```

This reads `execution_logs` for each affected attempt, recomputes the receipt with current pricing, and updates `job_attempts.receipt`. Safe because events are immutable — same inputs always produce the same output (modulo pricing version).

### Layer 2: Compute Accounting

**Goal**: Track the compute resources consumed by each attempt — resource class, vCPU-seconds, memory-GiB-seconds.

**Where the data comes from**:

- **Resource class**: From job hints (`job.hints.resource_class`) or manifest defaults. The resource class maps to K8s resource requests (vCPU, memory) via platform configuration (see `platform-resource-plane.md` §1.2).
- **Duration**: `attempt.duration_ms` (already captured).
- **Compute quantities**: `requested_vcpu × duration_seconds` and `requested_memory_gib × duration_seconds`. Deterministic — bill by requested resources, not actual usage, because K8s requests are the contract.

**What changes in code**:

The worker already knows the resource class (it builds the runner pod spec from it). At receipt assembly time, it looks up the class spec and computes `vcpu_seconds` and `memory_gib_seconds`. No new events needed — this is a pure computation from existing data.

**Why this matters**: Without compute tracking, the receipt only answers "how much did the LLM cost?" In a multi-tenant deployment, compute cost can dominate LLM cost for long-running jobs. The receipt must capture both to be the universal usage record.

**Relationship to `usage_records`**: The platform resource plane doc proposes a `usage_records` table as an append-only ledger. With compute data in the receipt, that table becomes unnecessary for job-scoped resources — the receipt IS the usage record. The `usage_records` table may still be useful for non-job resources (persistent service uptime, PVC storage hours) that don't have an associated attempt. See [Relationship to Other Docs](#relationship-to-other-docs).

### Layer 3: Token Ledger

**Goal**: Capture per-LLM-call usage with full provider detail.

**Where it happens**: Harness-side. The harness is the only place that has the actual provider response — the real model string, the `request_id`, cache token breakdown, stop reason, and per-call latency.

**Harness output contract change** (additive, not breaking):

Eve-agent-cli and harness adapters emit a new event type in their JSON stream:

```json
{
  "type": "llm.call",
  "ts": "2026-02-09T12:34:56.789Z",
  "provider": "anthropic",
  "model": "claude-opus-4-5-20250929",
  "request_id": "req_01ABC...",
  "latency_ms": 3420,
  "input_tokens": 1200,
  "output_tokens": 340,
  "cache_read_tokens": 800,
  "cache_write_tokens": 0,
  "reasoning_tokens": 0,
  "stop_reason": "end_turn",
  "status": "ok"
}
```

This event flows through the existing streaming pipeline:

```
harness (emits llm.call) → worker (reads stdout) → execution_logs (append) → receipt (aggregate)
```

**Worker changes**:

1. When the streaming log processor encounters a `type: "llm.call"` event, write it to `execution_logs` with `type = 'llm.call'`.
2. `extractTokenUsage()` becomes a **fallback** — it still sums from assistant messages for harnesses that don't emit `llm.call` events. For harnesses that do, the `llm.call` events are authoritative.
3. Receipt assembly (Layer 1) aggregates `llm.call` events into the `receipt.llm` and `receipt.cost` fields.

**Harness adapter changes**:

Each harness adapter wraps a provider SDK. The SDK returns usage data in the response. The adapter emits an `llm.call` event for each API call:

| Harness | Provider SDK | Usage source |
|---------|-------------|-------------|
| mclaude | `@anthropic-ai/sdk` | `response.usage` — includes `cache_creation_input_tokens`, `cache_read_input_tokens` |
| zai | Zhipu SDK | `response.usage` — `prompt_tokens`, `completion_tokens` |
| gemini | `@google/generative-ai` | `response.usageMetadata` — `promptTokenCount`, `candidatesTokenCount`, `cachedContentTokenCount` |
| codex / code | OpenAI SDK | `response.usage` — `prompt_tokens`, `completion_tokens`, `reasoning_tokens` |

Each adapter normalizes to the common `llm.call` schema. Provider-specific fields (like Anthropic's cache token breakdown or OpenAI's reasoning tokens) map to the appropriate fields.

### Layer 4: Budget Enforcement

**Goal**: Let users set cost limits and get real-time visibility into spend.

Three enforcement tiers, each building on the receipt:

#### Job-level hard limit

The most immediate value. Worker kills harness when running cost exceeds budget.

Configuration:

```yaml
# In manifest defaults or job hints
hints:
  max_cost: 0.50         # in the rate card's currency (USD, sats, credits)
  max_tokens: 100000
```

Implementation: The worker maintains a running cost total from `llm.call` events as they stream. When the total exceeds the limit:

```typescript
// In the worker's streaming loop
const callCost = computeCallCost(llmCallEvent, pricingConfig);
runningCost += callCost;

if (maxCost && runningCost > maxCost) {
  harnessProcess.kill('SIGTERM');
  await this.logLifecycleEvent(attemptId, 'harness', 'end', {}, {
    success: false,
    error: `Budget exceeded: ${formatCost(runningCost, currency)} > ${formatCost(maxCost, currency)} limit`,
    duration_ms: Date.now() - harnessStartTime,
  });
}
```

#### Project-level soft + hard limits

Configuration:

```yaml
# In manifest or org config
x-eve:
  budgets:
    project:
      monthly: 50.00               # in rate card currency
      alert_at_pct: [50, 80, 100]  # emit alerts at these thresholds
      hard_limit: 75.00            # block new jobs above this
```

Enforcement at orchestrator: Before claiming a job, query project spend from receipts:

```sql
SELECT COALESCE(SUM((receipt->'cost'->>'total')::numeric), 0) AS spend
FROM job_attempts
WHERE job_id IN (SELECT id FROM jobs WHERE project_id = $1)
  AND created_at >= date_trunc('month', NOW())
  AND status IN ('succeeded', 'failed');
```

If spend > soft limit: log warning, emit alert, continue.
If spend > hard limit: hold job in `ready` phase, emit alert, don't claim.

#### Org-level monthly budget

Same pattern as project, aggregated across all projects. The org admin configures it. The orchestrator checks before claiming.

#### Real-time cost streaming

With `llm.call` events in the streaming output, the CLI can show running cost during `eve job follow`:

```
$ eve job follow myproj-a3f2dd12

  [12:34:01] 🤖 Harness started (claude-opus-4-5, yolo)
  [12:34:03]   LLM call #1: 1,200 in → 340 out ($0.012)       [$0.012 total]
  [12:34:08]   LLM call #2: 1,800 in → 520 out ($0.024)       [$0.036 total]
  [12:34:15]   LLM call #3: 2,100 in → 890 out ($0.039)       [$0.075 total]
  [12:34:15] 🤖 Harness completed (14.2s, 3 calls, $0.075)
```

This requires no new infrastructure — the SSE stream already delivers `execution_logs` entries. The CLI just needs to recognize `llm.call` events and format them.

## Pricing Configuration

### Unified rate card

A single YAML config covers both LLM and compute pricing. The `currency` field makes it denomination-agnostic — the same structure works for USD (enterprise), sats (nostrworld), or abstract credits.

```yaml
# packages/shared/src/config/pricing.yaml
version: "2026-02-01"
currency: usd                  # 'usd' | 'sats' | 'credits'

llm:
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
    claude-haiku-4-5:
      input_per_million: 0.80
      output_per_million: 4.00
      cache_read_per_million: 0.08
      cache_write_per_million: 1.00

  openai:
    gpt-4.1:
      input_per_million: 2.00
      output_per_million: 8.00
    gpt-4.1-mini:
      input_per_million: 0.40
      output_per_million: 1.60
    o3:
      input_per_million: 2.00
      output_per_million: 8.00
    o4-mini:
      input_per_million: 1.10
      output_per_million: 4.40

  google:
    gemini-2.5-pro:
      input_per_million: 1.25
      output_per_million: 10.00
    gemini-2.5-flash:
      input_per_million: 0.15
      output_per_million: 0.60

  zai:
    glm-4-plus:
      input_per_million: 0.70
      output_per_million: 0.70

compute:
  job.c1:                        # 1 vCPU, 2 GiB
    vcpu_per_hour: 0.05
    gib_per_hour: 0.01
  job.c2:                        # 2 vCPU, 4 GiB
    vcpu_per_hour: 0.05
    gib_per_hour: 0.01
  job.m1:                        # 2 vCPU, 8 GiB (memory-optimized)
    vcpu_per_hour: 0.05
    gib_per_hour: 0.015

storage:                         # for non-job resources (PVCs, etc.)
  disk.std:
    gb_per_hour: 0.001
```

A nostrworld deployment uses the same structure with `currency: sats` and different rates. The receipt doesn't care — it stores quantities + rates + computed cost in whatever denomination the rate card specifies.

### Override mechanism

Per-org or per-manifest overrides for negotiated rates or deployment-specific pricing:

```yaml
# In manifest
x-eve:
  pricing:
    overrides:
      anthropic/claude-opus-4-5:
        input_per_million: 12.00    # negotiated enterprise rate
      compute/job.c2:
        vcpu_per_hour: 0.04         # volume discount
```

### Model name resolution

Provider SDKs return specific model identifiers (e.g., `claude-opus-4-5-20250929`). The pricing config uses canonical names (e.g., `claude-opus-4-5`). The cost function must resolve dated model strings to canonical names:

```typescript
function resolveModelName(provider: string, rawModel: string): string {
  // Strip date suffixes: "claude-opus-4-5-20250929" → "claude-opus-4-5"
  // Handle aliases: "claude-3-opus" → "claude-opus-4-5" (if aliased)
  // Return rawModel if no match (unknown model → cost = 0 with warning)
}
```

Unknown models produce a receipt with `cost_usd: 0` and a warning flag rather than failing. Cost visibility should never block execution.

## CLI Surfaces

### `eve job receipt <job_id> [--attempt N]`

The primary command. One view for both time and cost.

```
$ eve job receipt myproj-a3f2dd12

  Job: myproj-a3f2dd12  (attempt 1, succeeded)
  Duration: 47.2s

  Phase Breakdown:
    queue wait       2.1s   ▓░░░░░░░░░   4%
    orchestrator     0.2s   ░░░░░░░░░░  <1%
    workspace        5.8s   ▓▓░░░░░░░░  12%
    secrets          0.3s   ░░░░░░░░░░   1%
    hooks            3.2s   ▓░░░░░░░░░   7%
    harness         35.8s   ▓▓▓▓▓▓▓░░░  76%
                            ──────────
                     47.2s              100%

  LLM Usage:
    claude-opus-4-5 (anthropic):  3 calls
      Tokens:   2,150 in → 847 out (+ 1,200 cache read)
      Cost:     $0.038  (in: $0.014, out: $0.024)

  Compute:
    Resource class:  job.c1 (1 vCPU, 2 GiB)
    Duration:        47.2s (47.2 vCPU-sec)
    Cost:            $0.001

  Total Cost:  $0.039  (LLM: $0.038, compute: $0.001)
  Pricing: 2026-02-01 rate card
```

With multiple models:

```
  LLM Usage:
    claude-opus-4-5 (anthropic):   2 calls
      Tokens:   1,800 in → 620 out
      Cost:     $0.031

    claude-sonnet-4-5 (anthropic): 1 call
      Tokens:   350 in → 227 out
      Cost:     $0.004

    Total: 3 calls, 2,150 in → 847 out, $0.035
```

### `eve job receipt <job_id> --json`

Full receipt as JSON for scripting and aggregation.

### `eve job compare <job_a> <job_b>`

Side-by-side diff. Useful for tuning: "did switching to Sonnet make it faster/cheaper?"

```
$ eve job compare myproj-a3f2dd12 myproj-b7e1cc34

                      Job A (opus-4.5)     Job B (sonnet-4.5)    Delta
  Duration:           47.2s                12.8s                 -73%
    queue wait:        2.1s                 1.8s                 -14%
    workspace:         5.8s                 5.6s                  -3%
    harness:          35.8s                 8.1s                 -77%
  Tokens in:          2,150                 1,890                -12%
  Tokens out:           847                   623                -26%
  LLM cost:           $0.038               $0.009               -76%
  Compute cost:       $0.001               $0.000               -73%
  Total cost:         $0.039               $0.009               -77%
```

### `eve project spend [--since 7d] [--group-by model|agent|harness]`

Aggregated cost view over a time window.

```
$ eve project spend --since 7d --group-by model

  Project: chat-gateway  (last 7 days, 66 jobs)

  Model                 Jobs    Tokens (in/out)      LLM       Compute   Total
  claude-opus-4-5         42    89,400 / 34,200      $1.62     $0.03     $1.65
  claude-sonnet-4-5       18    45,100 / 12,800      $0.33     $0.01     $0.34
  glm-4-plus               6     8,200 /  3,100      $0.01     $0.00     $0.01
                          ──    ────────────────      ─────     ─────     ─────
  Total                   66   142,700 / 50,100      $1.96     $0.04     $2.00
```

```
$ eve project spend --since 30d --group-by agent

  Project: chat-gateway  (last 30 days, 284 jobs)

  Agent                       Jobs    LLM       Compute   Total     Avg
  mission-control               45    $2.10     $0.04     $2.14     $0.048
  code-reviewer                112    $1.85     $0.04     $1.89     $0.017
  notes-assistant               89    $0.91     $0.03     $0.94     $0.011
  primary-orchestrator          38    $0.70     $0.02     $0.72     $0.019
                               ───    ─────     ─────     ─────
  Total                        284    $5.56     $0.13     $5.69     $0.020
```

### `eve org spend [--since 30d]`

Org-level spend across all projects. Same aggregation, wider scope.

### Enhanced existing commands

- **`eve job diagnose`**: Include receipt inline — phase breakdown + cost summary appended to the existing diagnostic output.
- **`eve job result`**: Append cost estimate: `Cost: ~$0.038 (claude-opus-4-5, 3 calls)`.
- **`eve job follow`**: Show `llm.call` events with running cost as they stream (see "Real-time cost streaming" above).

## Schema Changes Summary

One migration covers all of Layer 1:

```sql
-- Migration: 000XX_execution_receipts.sql

-- Accurate job lifecycle
ALTER TABLE jobs ADD COLUMN ready_at TIMESTAMPTZ;

-- Full attempt lifecycle + receipt
ALTER TABLE job_attempts
  ADD COLUMN claimed_at TIMESTAMPTZ,
  ADD COLUMN execution_started_at TIMESTAMPTZ,
  ADD COLUMN receipt JSONB;

-- Index for spend queries
CREATE INDEX idx_attempts_receipt_cost ON job_attempts
  USING btree (((receipt->'cost'->>'total')::numeric))
  WHERE receipt IS NOT NULL;

-- Index for time-range spend aggregation
CREATE INDEX idx_attempts_project_created ON job_attempts (job_id, created_at)
  WHERE receipt IS NOT NULL;
```

No new tables. No foreign keys to pricing tables. No span tables. The receipt lives on the attempt — the entity it describes.

## Implementation Phases

### Phase 1: Receipts from existing data

**Scope**: Materialize phase timing + compute resources into receipts. No harness changes yet — token data uses existing `extractTokenUsage()` totals with configured (not actual) model identity.

**Changes**:
- Migration: `ready_at`, `claimed_at`, `execution_started_at`, `receipt` columns
- Orchestrator: set `ready_at` on phase transition, `claimed_at` on claim
- Worker: set `execution_started_at` at invoke start; assemble and store receipt at attempt finalization
- Pricing config: unified YAML file with LLM rates + compute rates
- Worker: include resource class and compute quantities in receipt
- API: `GET /jobs/:id/receipt` endpoint
- CLI: `eve job receipt` command

**What you get**: Phase breakdown + LLM cost estimate + compute cost for every job. `eve job receipt` answers both questions. No harness changes required.

### Phase 2: Per-call token ledger

**Scope**: Harness-side `llm.call` events for accurate per-call usage.

**Changes**:
- Eve-agent-cli: emit `llm.call` events in streaming JSON output
- Harness adapters (mclaude, zai, gemini, codex): normalize provider usage to `llm.call` schema
- Worker: pass `llm.call` events through to `execution_logs`; use them in receipt assembly
- Worker: `extractTokenUsage()` becomes fallback for non-`llm.call` harnesses
- CLI: `eve job follow` shows running cost from `llm.call` events

**What you get**: Accurate per-model cost breakdown. Real-time cost visibility during execution. Multi-model job support.

### Phase 3: Aggregation + comparison

**Scope**: Cross-job queries and comparison tools.

**Changes**:
- API: `GET /projects/:id/spend` endpoint (aggregates receipts)
- API: `GET /orgs/:id/spend` endpoint
- CLI: `eve project spend`, `eve org spend` (showing LLM + compute breakdown)
- CLI: `eve job compare`
- Admin: `eve admin recompute-receipts`

**What you get**: "Top spenders" by model/agent/project. LLM vs compute cost split. Side-by-side job comparison for tuning. Historical recomputation.

### Phase 4: Budget enforcement

**Scope**: Cost limits (LLM + compute combined) and alerts.

**Changes**:
- Worker: real-time budget check from `llm.call` events; kill harness on exceed
- Orchestrator: project/org spend check before claiming (queries receipt totals)
- Manifest: `x-eve.budgets` configuration
- CLI: budget status in `eve project spend` output
- Alerts: webhook/Slack notification at threshold crossings

**What you get**: Runaway cost prevention. Project/org budget governance. Alert-based awareness. This layer provides the admission control that the financial ledger (see `platform-resource-plane.md`) builds payments and balances on top of.

## What We Deliberately Don't Build

### No `telemetry_spans` table

Eve's execution model is a fixed pipeline: queue → workspace → secrets → hooks → harness → result. Every attempt walks the same phases in the same order. A generic spans table with `scope_type`, `component`, `name` is a mini-Jaeger — designed for arbitrary call graphs we don't have. The receipt's `phases` object captures the same information in one read instead of a join across a spans table.

If we ever need arbitrary spans (app-emitted traces, sub-phase granularity), we can add them then. The receipt structure is extensible — adding a `sub_phases` array to any phase is a JSONB change, not a schema change.

### No W3C trace propagation

`x-eve-correlation-id` propagates through 5 hops, all within our codebase: gateway → API → orchestrator → worker → harness. W3C `traceparent`/`tracestate` adds complexity for zero benefit at our current scale. The OTEL auto-instrumentation (already configured) provides HTTP-level traces when an OTEL collector is present. That's sufficient for infrastructure debugging without refactoring internal propagation.

### No LLM Gateway proxy

V1 proposed a reverse proxy for all provider calls. That's a separate product with its own availability, latency, authentication, and operational surface. Eve harnesses already call providers directly and report usage. The receipt captures the same data without adding a network hop or a new failure mode.

If apps want cost visibility, a lighter approach: an SDK that wraps provider clients and emits `llm.call` events to Eve's API. Same data, no proxy, no latency penalty.

### No separate `usage_records` table

The platform resource plane doc (`platform-resource-plane.md` §1.1) proposes an append-only `usage_records` table to track resource consumption. For job-scoped resources (compute time, LLM tokens), the receipt makes this redundant — the receipt IS the usage record, stored on the entity it describes (the attempt), queryable with a single read.

A `usage_records` table may still be needed for non-job resources that don't have an associated attempt: persistent service uptime (deployments running 24/7), PVC storage hours, managed database tiers. Those are metered by periodic sweeps, not by job completion, so they need their own storage. But for the 90% case (job compute + LLM), the receipt is the canonical record.

### No separate pricing table

Pricing changes a few times per year. A YAML config file is simpler than a database table with foreign keys and migration management. The config is versionable in git, auditable, and works locally — the CLI can compute cost without hitting the API. Receipts embed the actual rates used, so historical accuracy doesn't depend on the current config.

## Open Questions

1. **Sub-phase granularity**: The `workspace` phase includes git clone, checkout, branch creation, and ref resolution. Should we break these out as sub-phases in the lifecycle contract, or is "workspace took 5.8s" sufficient for now?

2. **Failed LLM calls**: If a provider call fails (rate limit, timeout), should it appear in the receipt's LLM breakdown? It consumed time but not tokens. Proposed: yes, with `status: "error"` and `tokens: 0`. The time matters for debugging.

3. **Reasoning token pricing**: Some providers charge differently for reasoning/thinking tokens (or don't charge at all). The pricing config needs a `reasoning_per_million` field, defaulting to `output_per_million` if not specified.

4. **Receipt versioning**: As the receipt schema evolves, old receipts may not have new fields. Options: (a) nullable fields + forward-compatible reads, (b) a `receipt_version` field that the reader checks, (c) recompute old receipts on schema change. Proposed: (a) — nullable fields are simplest and JSONB handles missing keys naturally.

5. **Pipeline critical path**: A pipeline receipt's duration should reflect the critical path (longest parallel branch), not the sum of all steps. The aggregation function needs to understand step dependencies — is this worth building before pipelines are heavily used?

6. **Compute cost without resource classes**: Until resource classes are implemented (resource plane Phase 1), jobs don't have explicit compute specs. Should the receipt omit `compute` entirely, or use a default resource class estimate? Proposed: include `compute` with `resource_class: null` and `vcpu_seconds: 0` — the field exists but shows no compute cost until resource classes are live.

7. **Non-job resource metering**: PVC storage hours, persistent service uptime, and managed database tiers don't have attempt receipts. These need the `usage_records` table from the resource plane doc. How do we present these in `eve project spend`? Proposed: the spend command shows two sections — "Job costs (from receipts)" and "Infrastructure costs (from usage records)" — unified into one total.

8. **Currency in mixed deployments**: If a platform migrates from USD to sats (or supports both), can old receipts (denominated in USD) coexist with new receipts (in sats)? Proposed: `receipt.cost.currency` is authoritative. Aggregation converts to the current rate card's currency using an exchange rate at query time. Historical receipts keep their original denomination.

## Relationship to Other Docs

This doc is Layer 1 of a four-layer resource stack. Each layer builds on the one below it, and each is independently useful.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 4: Protocol Skin                                             │
│  Nostr identity, Lightning/Cashu payments, DVM marketplace          │
│  Docs: nostr-integration.md, nostrworld-agentic-paas.md            │
│  Owns: Nostr gateway plugin, payment connectors, DVM bridge        │
│  Consumes: Financial ledger (Layer 3) for balance/payment ops       │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 3: Financial Ledger                                          │
│  Balances, transactions, payments, admission control, suspension    │
│  Doc: platform-resource-plane.md §1.3, §1.5                        │
│  Owns: org_balances, balance_transactions, PaymentProvider iface    │
│  Consumes: Receipts (this doc) for charges + spend queries          │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2: Resource Classes + Infrastructure                         │
│  Named compute SKUs, K8s quotas, namespace isolation, platform      │
│  agents                                                             │
│  Doc: platform-resource-plane.md §1.2, §1.4, §2.x, §3.x           │
│  Owns: Resource class definitions, quota policies, agent taxonomy   │
│  Consumed by: Receipts (this doc) for compute cost calculation      │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 1: Execution Receipts (THIS DOC)                             │
│  Metering + cost visibility: time phases, LLM usage, compute       │
│  resources, unified cost in any denomination                        │
│  Owns: receipt JSONB on job_attempts, pricing config, llm.call      │
│        events, CLI (eve job receipt, eve project spend)              │
│  Consumes: execution_logs (source of truth), resource class specs   │
└─────────────────────────────────────────────────────────────────────┘
```

### Key integration points

**Receipts → Financial Ledger**: When the financial ledger (Layer 3) needs to charge an org, it reads `receipt.cost.total` from the completed attempt. A "charge" is a `balance_transaction` derived from a receipt. No separate metering needed — the receipt IS the meter reading.

**Resource Classes → Receipts**: Resource class definitions live in the platform config (Layer 2). The receipt references the resource class by name and embeds the compute quantities + rates. The receipt doesn't define resource classes — it consumes them.

**Pricing config → Receipts**: The unified pricing config covers both LLM rates and compute rates. The `currency` field makes it denomination-agnostic. A USD deployment and a sats deployment use the same receipt structure with different rate cards.

**`usage_records` table**: The resource plane doc proposes `usage_records` for all resource consumption. For job-scoped resources (LLM + compute), receipts replace this. The `usage_records` table is only needed for non-job resources: persistent service uptime, PVC storage hours, managed database tiers — resources metered by periodic sweeps, not by attempt completion.

**Budget enforcement → Financial Ledger**: This doc's Layer 4 (budget enforcement) provides the admission control logic. The financial ledger adds balances and payment methods on top. In a single-tenant deployment, budget enforcement alone is sufficient. In a multi-tenant deployment (nostrworld), the financial ledger adds prepaid balances and automated payments.

### What each doc should own

| Concern | Owner Doc | Not Duplicated In |
|---------|-----------|-------------------|
| Receipt structure + assembly | This doc | Resource plane |
| LLM pricing rates | This doc (pricing config) | Resource plane |
| Compute pricing rates | This doc (pricing config) | Resource plane |
| Resource class definitions (K8s specs) | Resource plane | This doc |
| `usage_records` for non-job resources | Resource plane | This doc |
| Financial ledger (balances, transactions) | Resource plane | This doc |
| Payment providers (Lightning, Stripe) | Resource plane / nostrworld | This doc |
| Admission control (budget checks) | This doc (enforcement) + resource plane (balance checks) | — |
| Identity extensibility | Resource plane | This doc |
| Gateway plugins | Resource plane | This doc |
| Platform agents | Resource plane | This doc |
| Nostr protocol / DVM bridge | nostr-integration / nostrworld | This doc, resource plane |

## Related (Implementation)

- V1 proposal: `docs/ideas/observability-time-and-cost.md`
- V2 proposal: `docs/ideas/observability-time-and-cost-v2.md`
- Current observability: `docs/system/observability.md`
- Lifecycle events: `packages/shared/src/types/lifecycle.ts`
- Worker invoke pipeline: `apps/worker/src/invoke/invoke.service.ts`
- Token extraction: `apps/worker/src/invoke/invoke.service.ts` (`extractTokenUsage`)
- Execution logs queries: `packages/db/src/queries/execution-logs.ts`
- Job attempts schema: `packages/db/migrations/00001_initial_schema.sql`, `00003_add_job_attempt_results.sql`
- OTEL setup: `packages/shared/src/otel.ts`
- AWS OTEL collector: `k8s/addons/otel-collector-aws.yaml`
