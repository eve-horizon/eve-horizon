# Production Agent Infrastructure: Gap Analysis

> Status: Idea
> Last Updated: 2026-03-15
>
> Inputs:
> - Blog post: "The unglamorous infrastructure that determines whether your agent demo becomes a production system"
> - Current platform capabilities audit across all 5 layers
> - `docs/system/pricing-and-billing.md`, `docs/system/agent-runtime.md`, `docs/system/analytics.md`
> - `docs/ideas/agent-memory-platform-features.md` (existing memory roadmap)
> - `packages/shared/src/invoke/` (shared invoke module)
> - `packages/shared/src/pricing/` (cost calculator, budget enforcement)

## Context

A widely-shared blog post identifies five infrastructure layers that separate
agent demos from production systems. Each layer represents 80% of the real work
that teams discover only after the agent itself is built:

1. **Data Engineering** — format normalization, chunking, deduplication, PII
2. **State Management** — working memory, checkpointing, resume-after-failure
3. **Retry & Recovery** — idempotency, partial completion, dead letters
4. **Cost Governance** — per-task attribution, budget breakers, anomaly alerts
5. **Observability** — trace IDs, decision audit, latency breakdown

Eve Horizon was built to be this platform. This document audits where we stand
against each layer, identifies gaps, and proposes features that would let us
credibly claim: "We already solved the 80% problem."

---

## Layer-by-Layer Assessment

### Layer 1: Data Engineering — The Input Problem

**What we have:**

| Capability | Status | How |
|---|---|---|
| File ingestion (any format, up to 500MB) | Done | `eve ingest`, presigned S3 upload, event-driven processing |
| Format-agnostic resource hydration | Done | `ingest://`, `org_docs://`, `job_attachments://` URI schemes |
| MIME-type detection | Done | Set at ingest time, file-extension fallback |
| Recency / lifecycle management | Done | `review_due`, `expires_at`, `lifecycle_status` on org docs |
| Event-driven processing pipeline | Done | `system.doc.ingest` triggers workflow → agent processes file |
| Full-text search across docs | Done | PostgreSQL `tsvector` indexes on org_documents, threads, attachments |

**What's missing:**

| Gap | Impact | Difficulty | Notes |
|---|---|---|---|
| **Centralized format normalizers** | Each agent reimplements PDF/HTML/XML parsing | Medium | Extract shared library in `packages/shared/src/format-normalization/` |
| **Platform chunking library** | Agents chunk ad-hoc; no overlap or semantic awareness | Medium | Recursive character, sentence-boundary, heading-hierarchy splitters |
| **Content deduplication at ingest** | Same file uploaded twice creates two records | Easy | Hash content at confirm time, return existing record if match |
| **PII detection / redaction** | No scrubbing before LLM calls; prompt policy only | Hard | Could be a pre-processing step in the ingest pipeline or a middleware in the LLM proxy |
| **Automatic expiration cleanup** | Expired docs remain readable forever | Easy | Background job: archive or soft-delete where `expires_at < NOW()` |
| **Vector embeddings pipeline** | Schema columns exist but unused | Hard | Async indexer: org_documents → embeddings → semantic search |

**Assessment:** Eve handles the ingest-to-agent pipeline end-to-end. The gaps are
in *pre-processing intelligence* — the platform trusts agents to handle format
variance themselves. For teams building on Eve, this is fine (agents are the
product). For teams wanting turnkey document processing, we'd need the
normalizers and chunking library.

**Recommendation:** The chunking library and content deduplication are low-hanging
fruit that benefit every app. PII redaction is high-value but should wait for
the LLM proxy layer (already planned in agent-harness-secret-hardening Phase 3).

---

### Layer 2: State Management — The Memory Problem

**What we have:**

| Capability | Status | How |
|---|---|---|
| Agent memory (durable, searchable, lifecycle-managed) | Done | `eve memory set/get/list/delete`, org_documents backing store |
| KV store with TTL | Done | `eve kv set/get/mget/delete`, per-agent namespaced |
| Thread persistence (immutable message log) | Done | `eve thread create/post/list`, full-text search |
| Thread distillation into durable memory | Done | `eve thread distill`, extracts decisions/learnings from conversations |
| Carryover context materialization | Done | Declarative `context:` blocks in agent hints → `.eve/context/` files |
| Coordination inbox | Done | Parent job's coordination thread auto-materialized for child jobs |
| Unified search across memory + docs + threads | Done | `eve search --sources memory,docs,threads` |

**What's missing:**

| Gap | Impact | Difficulty | Notes |
|---|---|---|---|
| **Vector/semantic search** | Full-text misses semantic matches; "retry logic" won't find "backoff strategy" | Hard | pgvector extension + embedding pipeline |
| **Task checkpointing / mid-job resume** | Long-running jobs can't pause and resume | Hard | New `checkpointed` phase, checkpoint serialization, `.eve/checkpoint/` materialization |
| **Working memory (per-job transient state)** | Agents can't persist mid-reasoning state across tool calls without using durable memory | Medium | Agent-local KV with job-scoped lifetime, auto-cleaned on completion |
| **Team-scoped memory** | Memory is agent-scoped or shared; no team-level namespace | Easy | Add `/teams/{team-slug}/memory/` path pattern |
| **Memory garbage collection** | Expired entries accumulate | Easy | Background cleanup job |

**Assessment:** This is our strongest layer. The memory + KV + threads + carryover
context system covers 90% of what the blog post describes. The main gap is
*checkpoint/resume for long-running tasks* — the legal discovery scenario
(50,000 documents over 6 hours) would currently require the agent to manage its
own progress tracking via KV entries rather than having platform-level
checkpointing.

**Recommendation:** Working memory (per-job transient KV) is the highest-value
addition. Checkpointing is architecturally significant but less urgent because
Eve's job decomposition model (parent → children) naturally handles long tasks
by breaking them into smaller units.

---

### Layer 3: Retry & Recovery — The Failure Problem

**What we have:**

| Capability | Status | How |
|---|---|---|
| Attempt tracking (number, status, timing, results) | Done | `attempts` table, per-job attempt history |
| Idempotency keys on job creation | Done | `idempotency_key` field prevents duplicate job creation |
| Timeout detection (configurable grace period) | Done | Orchestrator `evaluateRunningAttemptHealth()` with stale/idle detection |
| Stale attempt recovery | Done | Watchdog loops auto-fail stale running/idle attempts |
| Orphaned job recovery (on orchestrator restart) | Done | Startup recovery resets orphaned active jobs |
| Error classification with actionable hints | Done | 8 error codes (auth, clone, build, timeout, resource, registry, deploy, unknown) |
| Webhook retry with exponential backoff | Done | 1m, 5m, 30m, 2h, 12h schedule; auto-disable after 10 failures |

**What's missing:**

| Gap | Impact | Difficulty | Notes |
|---|---|---|---|
| **Automatic job retry on transient failure** | Failed jobs require manual intervention; no auto-requeue | Medium | Configurable retry policy: `max_retries`, `backoff_strategy`, `retryable_error_codes` |
| **Per-tool timeout budgets** | Single timeout per job; can't set 30s for API calls, 5m for git clone, 30m for LLM | Medium | Timeout categories in job hints, enforced by harness lifecycle |
| **Dead letter queue** | Failed-after-max-retries jobs stay in `active` phase with no resolution path | Easy | Move to `failed` phase with `dead_letter: true` flag; CLI: `eve job dead-letters` |
| **Partial completion detection** | No state machine tracking which tool calls succeeded before failure | Hard | Would require harness-level instrumentation of tool call outcomes |
| **Configurable retry policies per job** | Users can't specify retry count or backoff per job/workflow | Medium | Manifest-level `retry:` block in workflow step definitions |
| **Error escalation rules** | No "fail after N retries → escalate to human" | Medium | Integrate with existing HITL review mechanism |
| **Carryover state between retries** | Previous attempt's partial work (git commits, intermediate files) not preserved for next attempt | Hard | Workspace persistence between attempts (currently each attempt starts fresh) |

**Assessment:** The foundational retry infrastructure exists (attempts, timeouts,
recovery loops, error codes). What's missing is *automatic retry with
intelligence* — the system detects failures but doesn't autonomously recover from
transient ones. The travel booking horror story from the blog post would not
happen on Eve (errors are classified and logged), but a network blip would
still require manual re-run.

**Recommendation:** Automatic retry with configurable policies is the clear
priority. It's a natural extension of the existing attempt model. The manifest
integration point is already designed (workflow steps have `retry:` in the
schema draft). Dead letter handling is trivial to add alongside.

---

### Layer 4: Cost Governance — The Economics Problem

**What we have:**

| Capability | Status | How |
|---|---|---|
| Per-attempt cost attribution | Done | `cost-calculator.ts` with BigNumber precision, receipts per attempt |
| Budget circuit breakers (token + cost limits) | Done | `BudgetEnforcer` kills harness on max_tokens or max_cost breach |
| Provider registry with rate cards | Done | Versioned rate cards, per-model pricing, effective-at timestamps |
| Org balance ledger | Done | Immutable transaction log with credits/debits |
| Usage metering (non-job resources) | Done | PVCs, managed databases, services metered against balance |
| Environment suspension on low balance | Done | Blocks deploys and job creation |
| Receipt comparison across attempts | Done | `eve job compare <id> 1 2 --receipt` |
| Exchange rate snapshots | Done | FX conversion for org billing currency |

**What's missing:**

| Gap | Impact | Difficulty | Notes |
|---|---|---|---|
| **Cost anomaly alerts** | A runaway job consumes 10x normal tokens with no alert | Medium | Alert when `current_cost > N * rolling_avg` for the agent/workflow |
| **Per-agent / per-team budget caps** | Budget enforcement is org-wide + per-job; can't limit a specific agent's monthly spend | Medium | New table: `agent_budget_limits` with period + amount + enforcement action |
| **Cost breakdown by agent/team/workflow** | Analytics show org-wide totals; can't answer "which agent costs the most?" | Easy | Group receipts by agent_slug, team, workflow in analytics queries |
| **Cost forecasting / burn rate** | No projection of monthly spend; CFO can't budget | Medium | Extrapolate from trailing 7d/30d receipt data |
| **Model routing recommendations** | No guidance on "use cheaper model for classification, expensive for synthesis" | Hard | Would need task-type classification + model benchmarking |
| **Context window optimization hints** | No automatic prompt compression or caching suggestions | Hard | Token counting on context materialization; suggest trimming when over budget |

**Assessment:** This is Eve's second-strongest layer. The RFP response scenario
from the blog post is directly handled: budget circuit breakers would halt
execution at the per-task limit, and the org balance ledger tracks cumulative
spend. The gaps are in *proactive governance* — alerting before costs spike
rather than just enforcing hard limits.

**Recommendation:** Cost anomaly alerts and per-agent budget caps are the
highest-value additions. They turn cost governance from reactive (circuit
breakers) to proactive (alerts + caps). The analytics grouping is a trivial
query change with outsized value for cost conversations with leadership.

---

### Layer 5: Observability — The Accountability Problem

**What we have:**

| Capability | Status | How |
|---|---|---|
| Trace ID propagation across services | Done | `CorrelationContext` via AsyncLocalStorage + HTTP headers |
| OpenTelemetry integration | Done | Optional OTLP exporter with auto-instrumentation |
| JSONL streaming logs (real-time + historical) | Done | Per-attempt execution logs, SSE streaming via `eve job follow` |
| Result extraction (text, JSON, tokens, errors) | Done | `result-extraction.ts` parses harness output |
| Lifecycle event logging | Done | Phase tracking (acquire, provision, checkout, invoke, release) with duration/success |
| Job diagnostics | Done | `eve job diagnose <id>` with routing metadata, error messages, logs |
| Org-wide analytics | Done | Summary metrics with windowed queries (1d, 7d, 30d, 90d) |
| Webhooks with CloudEvents envelope | Done | Event subscriptions, delivery log, HMAC-SHA256 signatures, replay |
| Human review audit | Partial | Job review status/reviewer tracked; RBAC approval/rejection recorded |

**What's missing:**

| Gap | Impact | Difficulty | Notes |
|---|---|---|---|
| **Per-phase latency breakdown** | Can't distinguish "slow because LLM" vs "slow because git clone" | Easy | Already have lifecycle events; surface in `eve job diagnose` output |
| **Decision attribution for routing** | Can't explain "why did this job go to agent-runtime vs worker?" | Easy | Log routing decision in orchestrator with reason code |
| **Per-tool-call audit trail** | Harness tool calls (bash, file edit, API) not individually logged | Hard | Would need harness-level instrumentation; significant data volume |
| **Cost-by-decision attribution** | Can't answer "what did the routing decision cost us?" | Medium | Cross-reference routing log with final receipt |
| **User attribution (created_by)** | Jobs track assignee but not who created them | Easy | Add `created_by` to job model, populate from auth context |
| **Exception / stack traces** | Only error messages captured, not full stack context | Medium | Capture stderr more aggressively from harness process |
| **Cost trends over time** | Analytics show snapshots, not trends | Medium | Time-series aggregation on receipts table |
| **Compliance audit log** | No "who accessed what job/data at what time" | Hard | Requires request-level audit logging middleware |

**Assessment:** Strong operational observability (you can debug any job via CLI).
The gaps are in *accountability and compliance* — proving to a regulator or
auditor exactly which inputs led to which outputs, who saw the results, and what
decisions were made along the way. The latency breakdown and routing attribution
are easy wins hiding in data we already collect.

**Recommendation:** Per-phase latency breakdown and routing decision logging are
trivial to add and immediately useful for debugging. The compliance audit log
is the most valuable gap for enterprise customers but is a significant
architectural addition.

---

## Synthesis: What Should We Build?

### Things We Already Solve (Our Moat)

Eve Horizon **already solves** the core thesis of the blog post. Teams building on
Eve do not spend a quarter building the platform — it's already there:

1. **Data in → Agent processes → Results out** (ingest + resource hydration + event-driven workflows)
2. **Agent memory that persists across sessions** (memory + KV + threads + carryover context)
3. **Failures are visible and classified** (error codes, attempt tracking, diagnostics)
4. **Costs are tracked and enforced** (receipts, budget circuit breakers, balance ledger)
5. **Everything is observable** (JSONL logs, trace IDs, lifecycle events, webhooks)

The blog post's horror stories — silent failures, unbounded costs, context window
amnesia — cannot happen on Eve as built today.

### Priority Gaps (Highest Impact, Ordered)

These are the features that would close the remaining gaps between "platform that
works" and "platform that's obviously better than building it yourself":

#### Tier 1: Quick Wins (days, not weeks)

| # | Feature | Layer | Why Now |
|---|---------|-------|---------|
| 1 | **Content deduplication at ingest** | L1 | Hash-based, trivial to add at confirm time |
| 2 | **Dead letter handling** | L3 | Flag on failed phase + CLI query; 50 lines of code |
| 3 | **Per-phase latency breakdown in diagnostics** | L5 | Data already exists in lifecycle events; surface it |
| 4 | **Routing decision logging** | L5 | One log line in orchestrator explaining the routing choice |
| 5 | **Cost breakdown by agent/team** | L4 | GROUP BY on existing receipts table |
| 6 | **`created_by` on jobs** | L5 | Add column, populate from auth context |
| 7 | **Automatic doc expiration cleanup** | L1 | Background job, `WHERE expires_at < NOW()` |

#### Tier 2: High-Value Features (1-2 weeks each)

| # | Feature | Layer | Why Now |
|---|---------|-------|---------|
| 8 | **Automatic retry with configurable policies** | L3 | Natural extension of attempt model; manifest `retry:` block |
| 9 | **Cost anomaly alerts** | L4 | Alert when job cost > Nx rolling average; webhook delivery |
| 10 | **Per-agent budget caps** | L4 | New table + enforcement in budget module |
| 11 | **Working memory (per-job transient KV)** | L2 | Job-scoped KV that auto-cleans on completion |
| 12 | **Chunking library** | L1 | Shared utility in `packages/shared/`; used by agent skills |
| 13 | **Cost forecasting / burn rate** | L4 | Trailing-window extrapolation on receipts |

#### Tier 3: Strategic Features (multi-week)

| # | Feature | Layer | Why Now |
|---|---------|-------|---------|
| 14 | **PII detection / redaction pipeline** | L1 | Critical for enterprise; ties into LLM proxy (Phase 3 of secret hardening) |
| 15 | **Task checkpointing / mid-job resume** | L2 | Enables legal-discovery-scale workflows |
| 16 | **Vector embeddings + semantic search** | L1/L2 | Schema ready; needs embedding pipeline + pgvector |
| 17 | **Compliance audit log** | L5 | Request-level access logging for regulated industries |
| 18 | **Per-tool-call audit trail** | L5 | Harness-level instrumentation; significant data volume |

### What We Should NOT Build

- **Format normalizers as a platform service.** Agent skills already handle
  format-specific logic. A platform normalizer adds a rigid abstraction layer
  that fights the grain of how agents work (they adapt to formats via prompts).
  The chunking library is different — it's a utility, not a service.

- **Distributed memory backends (Redis, etc.).** PostgreSQL handles our scale.
  Adding Redis adds operational complexity for no measurable benefit at current
  volumes. Revisit when a customer has >10M memory entries.

- **Model routing recommendations.** This requires task-type benchmarking data
  we don't have. Let users choose models; give them cost data to decide.

---

## The Positioning Opportunity

The blog post's thesis is: "The agent is the interface. The 80% is the engine."

Eve Horizon IS the engine. The positioning should be direct:

> Every team building AI agents discovers the same five infrastructure layers
> they need: data engineering, state management, retry logic, cost governance,
> and observability. Eve Horizon ships all five. Your agents get memory,
> budgets, diagnostics, and recovery out of the box. You build the agent.
> We built the platform.

The Tier 1 quick wins (dedup, dead letters, latency breakdown, cost-by-agent)
would let us make this claim without caveats. The Tier 2 features (auto-retry,
anomaly alerts, agent budget caps) would make it airtight.
