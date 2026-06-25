# Cache-Aware Budget Enforcement Plan

> **Status**: Drafted (not yet implemented)
> **Last Updated**: 2026-05-20
> **Origin**: ACME rebuild + ACME Portal POC team. ACME gap `009 — max_tokens budget should exclude (or discount) Anthropic cache-read tokens`. Promotes from ACME gap `0001-implementation-workflow-smoke-gaps.md §6`. First observed 2026-04-30 on `acme-b531c233.9.7` (refactor-review-fix, Claude/Opus, 70 LLM calls, BUDGET_EXCEEDED at 7.5M tokens, real billed cost $0.0068).
> **Adjacent plans**: [`resource-management-and-cost-tracking-v2.md`](./resource-management-and-cost-tracking-v2.md), [`agent-runtime-feature-parity-plan.md`](./agent-runtime-feature-parity-plan.md), [`worker-agent-runtime-shared-extraction.md`](./worker-agent-runtime-shared-extraction.md).

## Why

Anthropic's prompt cache prices cache-read input tokens at ~10% of the regular input rate. Multi-turn agent jobs that re-use a large cached prompt (the typical shape: load CLAUDE.md + repo context once, then iterate over many turns) see token *counts* explode while dollar *cost* stays tiny.

Eve's per-job budget caps live on `hints.max_tokens` and `hints.max_cost`. The cost path correctly applies the cache-read rate-card discount in [`packages/shared/src/pricing/cost-calculator.ts:97`](../../packages/shared/src/pricing/cost-calculator.ts). The **token-count cap path** does not: [`packages/shared/src/invoke/budget-enforcement.ts:76-90`](../../packages/shared/src/invoke/budget-enforcement.ts) sums all five token kinds at equal weight:

```ts
function sumTokens(u): number {
  return (
    u.input_tokens +
    u.output_tokens +
    u.cache_read_tokens +
    u.cache_write_tokens +
    u.reasoning_tokens
  );
}
```

Then [`budget-enforcement.ts:314`](../../packages/shared/src/invoke/budget-enforcement.ts):

```ts
if (this.config.max_tokens && state.total_tokens >= this.config.max_tokens) {
  await this.triggerExceeded({ reason: 'max_tokens exceeded', trigger, state });
}
```

Observed close_reason from `acme-b531c233.9.7`:

```text
close_reason: BUDGET_EXCEEDED: max_tokens exceeded
              max_tokens=6000000
              max_cost=usd 40
              est_total=usd 0.006795
total_tokens: 7,553,548
billed_cost:  $0.0068
```

`max_cost` was set to $40, the real cost was $0.0068, and the `max_tokens` proxy still killed the job. The agent-runtime invoke path ([`apps/agent-runtime/src/invoke/invoke.service.ts:1320-1395`](../../apps/agent-runtime/src/invoke/invoke.service.ts)) routes every llm.call through this enforcer, so the issue affects every Claude-using agent job — not a worker-only fluke. The worker still carries a parallel hand-rolled copy of the same logic at [`apps/worker/src/invoke/invoke.service.ts:2086-2217`](../../apps/worker/src/invoke/invoke.service.ts) (`sumTokens`, `estimateBudgetState`, `triggerBudgetExceeded`, `maybeEnforceBudget`); both paths must move together.

For the rebuild this matters because:

1. Every observation-platform satellite that runs Claude agents (review-fix, refactor, eval-suite, ops/incident agents) will hit the same wall on its first multi-turn job.
2. The ACME Portal workaround is `--max-tokens 30000000` on Claude workers and `6000000` on codex — a magic number every new repo copies from `acme-portal/decisions/0006-agentic-planning-workflow.md`. "30M tokens" stops meaning anything once 95% of those tokens are cache reads.
3. The economically-correct cap is on **cost**, which the rate card already differentiates. Token-count is a useful proxy *only* when token kinds price uniformly — and prompt caching broke that assumption.

Per [[platform-gaps-first]] the fix lives in `eve-horizon`, not in every consumer repo's `decisions/` file.

## Decision

1. **Discount only cache-read tokens against `max_tokens`, using the rate-card weight.** Token enforcement keeps today's 1 token = 1 budget token semantics for input, output, reasoning, and cache-write tokens. Only `cache_read_tokens` are multiplied by the model's `cache_read_per_million_usd / input_per_million_usd` ratio when the active rate card says cache reads are cheaper than normal input. For Anthropic Claude models this means `cache_read_tokens` count at ~10% (rate-card-driven, not hard-coded). For OpenAI `gpt-5.5` cache reads also count at ~10%. For non-cache-aware models there is **no discount** (`cache_read_per_million_usd` missing, zero, or not cheaper than input → cache reads count at full weight). This is the **transparent fix** — no caller change required, no new flag, the existing `--max-tokens` hint just stops misfiring.

2. **Promote `max_cost` to the documented primary cap; keep `max_tokens` as a secondary guardrail.** Both are still honoured (lower of the two wins, today's semantics), but docs and `eve job create --help` lead with `--max-cost` and call `--max-tokens` a coarse safety net. The `--max-tokens` default in the ACME Portal orchestrator overrides can drop to a value sized for *weighted* tokens.

3. **Surface the weighted breakdown in budget execution logs and close_reason metadata.** The `budget.exceeded` log already carries `total_tokens`. Add `weighted_tokens`, `cache_read_tokens`, `cache_read_token_weight`, and `cache_read_tokens_excluded` (the unweighted minus weighted delta). Also emit a final `budget.summary` log for every budget-configured attempt, including successful attempts, so operators can verify "raw tokens exceeded the old cap but weighted tokens did not" without needing a failure. These rows are visible through `eve job logs <id> --json` and `eve job diagnose <id> --json`; this plan does **not** add a synthesized `attempts[-1].budget_breakdown` field to `eve job show --json`. The text close_reason for exceeded jobs gains a trailing fragment: `weighted_tokens=… cache_read=…(w=0.10)`.

4. **Leave the rate card alone.** Pricing/billing already accounts for cache reads correctly; this plan only fixes the *enforcement proxy*. The fix derives the weight from the same `RateCardV1` row used for billing — single source of truth.

5. **No `max_cost` semantic change.** This is a separate plan if/when we want to demote `max_tokens` further. Today's `max_tokens` callers keep working; their values become economically meaningful again.

### Why discount, not exclude

Three shapes were on the table (see spec §"Required behaviour"):

- **A. Discount (recommended).** Single semantic change inside token aggregation. Existing flags unchanged. The token count once again tracks dollar cost for cache-heavy runs.
- **B. Cost-first, demote `max_tokens`.** Larger blast radius (every job that omits `--max-cost` and relies on `--max-tokens` as the only cap changes meaning). Also doesn't help callers who genuinely want a token cap.
- **C. New `--max-billable-tokens` flag.** Forces every operator to learn a new flag and migrate. Doesn't help today's installed base (every ACME Portal orchestrator, every CLAUDE.md cookbook) until they're rewritten.

Option A is the smallest semantic change with the largest correctness improvement. The other two are non-goals unless A proves insufficient.

### Why rate-card-driven, not hard-coded 0.1

Hard-coding 0.1 leaks Anthropic's current pricing into the platform. When Anthropic adjusts cache-read pricing (they have, multiple times), the platform's enforcement and billing would drift. Reading the weight from the same `RateCardV1` row that already feeds `estimateLlmCostUsd` keeps them aligned automatically.

When the rate row lacks `cache_read_per_million_usd` (e.g. OpenAI `o3`, platform `llama-3.3-70b`), or when the cache-read rate is not lower than the input rate, there is no discount: cache-read tokens count at full weight. This is conservative — if we don't know a real discount, we don't apply one. The fallback is **not** "drop cache_read entirely"; that would be hidden behaviour.

## Today's behaviour (call sites)

| # | Site | File | Lines | Today |
|---|---|---|---|---|
| 1 | `sumTokens` (shared) | `packages/shared/src/invoke/budget-enforcement.ts` | 76-90 | Sums all five token kinds at equal weight. **Primary target.** |
| 2 | `BudgetEnforcer.estimateState` | `packages/shared/src/invoke/budget-enforcement.ts` | 328-380 | Calls `sumTokens` per entry and reports `total_tokens` on `BudgetState`. |
| 3 | `BudgetEnforcer.enforce` | `packages/shared/src/invoke/budget-enforcement.ts` | 309-326 | Compares `state.total_tokens >= max_tokens`. |
| 4 | `BudgetEnforcer.triggerExceeded` | `packages/shared/src/invoke/budget-enforcement.ts` | 382-423 | Emits `BUDGET_EXCEEDED: …` text + `budget.exceeded` log row. |
| 5 | `LlmUsageEntry` shape | `packages/shared/src/invoke/types.ts` | 76-87 | Per-key totals (`input_tokens`, `output_tokens`, `cache_read_tokens`, …) live here. |
| 6 | `BudgetState` shape | `packages/shared/src/invoke/types.ts` | 89-95 | `total_tokens: number`. Only the unweighted total today. |
| 7 | Worker hand-rolled copy | `apps/worker/src/invoke/invoke.service.ts` | 2086-2217 | `sumTokens`, `estimateBudgetState`, `maybeEnforceBudget`, `triggerBudgetExceeded` duplicated inline. |
| 8 | Agent-runtime call site | `apps/agent-runtime/src/invoke/invoke.service.ts` | 1320, 1364-1395, 1460-1475 | Constructs `BudgetEnforcer` and forwards `llm.call` events. Pure consumer; no logic change. |
| 9 | Rate-card lookup | `packages/shared/src/pricing/cost-calculator.ts` | 49-58 (`getTokenRate`) | Already resolves `TokenRate` per `provider/model/source` from the active `RateCardV1`. Reused here. |
| 10 | Rate-card values | `packages/shared/src/pricing/default-rate-card.ts` | 17-67 | Per-model `input_per_million_usd` + `cache_read_per_million_usd`. |
| 11 | CLI flag parse | `packages/cli/src/commands/job.ts` | 489-506 | Accepts `--max-tokens`, `--max-cost`, `--max-cost-currency`. No help-text change required; doc only. |
| 12 | CLI help block | `packages/cli/src/lib/help.ts` | 370-429 (`job create`) | Doesn't currently list `--max-tokens` / `--max-cost`. **Gap to fix in this plan.** |
| 13 | API integration test | `apps/api/test/integration/budget-enforcement.integration.test.ts` | 79-210 | Existing suite is `describe.skip` because budget enforcement races the stub harness. Do **not** add required coverage there unless the suite is first made deterministic and unskipped. |
| 14 | Pricing & billing doc | `docs/system/pricing-and-billing.md` | 64-75 | Documents `hints.max_cost` / `hints.max_tokens`. **Add discount note.** |
| 15 | Skillpack references | `../eve-skillpacks/eve-work/eve-read-eve-docs/references/cli-jobs.md`, `references/jobs.md`, `references/cli.md` | `cli-jobs.md:42`, nearby job/budget sections | Show `--max-tokens` / `--max-cost` and job inspection behaviour. **Add discount note + lead with `--max-cost`; document `budget.summary` / `budget.exceeded` fields.** |

The worker's duplicate enforcement flow is a known migration debt (see `worker-agent-runtime-shared-extraction.md`). The decision here is **not** to delete the whole flow — that's a separate refactor — but to remove the riskiest drift point by sharing the token-breakdown helper and using it from both paths in the same commit.

## Required behaviour

- A Claude/Opus agent job running 50+ turns over a repo-sized cached prompt, billing under $0.10 actual cost, does not trip `BUDGET_EXCEEDED` under default ACME Portal settings (`--max-tokens 6000000 --max-cost 'usd 40'`).
- `eve job logs <id> --json` and `eve job diagnose <id> --json` expose `budget.summary` and, when enforcement fires, `budget.exceeded` log rows with these top-level fields:
  - `total_tokens` — unweighted sum (today's value, retained for backward compat).
  - `weighted_tokens` — cache-read-discounted sum used for enforcement.
  - `cache_read_tokens` — total cache-read tokens across all model entries.
  - `cache_read_token_weight` — the effective uniform discount weight (`0.1` for Anthropic Claude under the default rate card). `null` means no discounted cache reads, mixed weights, or no known discount; inspect `cache_read_tokens_excluded` to distinguish no-op from mixed-discount runs.
  - `cache_read_tokens_excluded` — `max(0, total_tokens - weighted_tokens)`, sign convention "how many tokens were discounted".
- ACME Portal's `--max-tokens 30000000` override on Claude review-fix / refactor workers can be removed; the standard `6000000` cap covers them.
- Codex / non-cache-aware harnesses are unaffected. `o3`, `llama-3.3-70b`, etc. have no `cache_read_per_million_usd`; the weight resolves to `null` and `sumTokens` continues to count cache-read at full weight. (In practice these models rarely emit non-zero `cache_read_tokens`, so it's a no-op.)
- Existing `--max-cost` semantics unchanged.
- `BUDGET_EXCEEDED` text close_reason gains a trailing `weighted_tokens=… cache_read=N(w=W)` fragment for operator visibility. Existing parsers that key on the prefix are unaffected.
- `pnpm --filter @eve/shared test` adds a unit suite for cache-discount behaviour, including the rate-card-missing fallback (no discount).

## Behaviour matrix

| Scenario | Provider/model | `max_tokens` | `cache_read_tokens` raw | Today | After |
|---|---|---|---|---|---|
| Anthropic Opus, 70-turn cached prompt | anthropic / claude-opus-4-7 | 6,000,000 | 7,000,000 (rest ~500k) | **BUDGET_EXCEEDED** at 7.5M | weighted = 0.5M + 0.1·7M = 1.2M → **no trigger** |
| Anthropic Sonnet, 50-turn cached prompt | anthropic / claude-sonnet-4-6 | 6,000,000 | 6,500,000 (rest ~400k) | **BUDGET_EXCEEDED** at 6.9M | weighted = 0.4M + 0.1·6.5M = 1.05M → **no trigger** |
| Genuinely runaway Anthropic job | anthropic / claude-opus-4-7 | 6,000,000 | 5M | 30M unweighted output | weighted = 30M + 0.1·5M = 30.5M → **trigger** (output dominates) |
| Codex/OpenAI o3, 50-turn | openai / o3 | 6,000,000 | 0 (no caching) | unchanged | unchanged (no cache, no discount) |
| OpenAI gpt-5.5, 50-turn | openai / gpt-5.5 | 6,000,000 | 4M | trips at 4M+ | weighted = 0.1·4M = 400k → **no trigger** (gpt-5.5 has cache_read rate ~0.5/5 = 10%) |
| Managed deepseek-r1 cached | platform / deepseek-r1 | 6,000,000 | 4M | trips at 4M+ | weighted = 0.14/0.55 ≈ 0.255 · 4M = 1.02M → no trigger (rate-card-derived) |
| Managed llama-3.3-70b | platform / llama-3.3-70b | 6,000,000 | 0 | unchanged | unchanged (no cache_read rate) |

The "genuinely runaway" row is the safety check: the cap still fires when the *real* cost of the run exceeds the budget proxy. The fix narrows the false-positive rate, it doesn't disable the cap.

## Implementation

| # | File | Lines | Change |
|---|---|---|---|
| 1 | `packages/shared/src/invoke/types.ts` | 89-95 | Add `weighted_tokens: number`, `cache_read_tokens: number`, `cache_read_tokens_excluded: number`, `cache_read_token_weight: number \| null` to `BudgetState`. Keep `total_tokens` for backward compat. |
| 2 | `packages/shared/src/invoke/budget-enforcement.ts` | new helper near 76 | Import `getTokenRate` from the pricing barrel and `BigNumber` directly from `bignumber.js` (the local `bn` helper in `cost-calculator.ts` is not exported). Add `cacheReadWeightFor(rateCard, entry)`: returns a numeric weight only when `cache_read_per_million_usd > 0`, `input_per_million_usd > 0`, and cache-read is cheaper than input. Otherwise returns `null` (full-weight cache reads). |
| 3 | `packages/shared/src/invoke/budget-enforcement.ts` | 76-90 | Rename existing `sumTokens` to `sumTokensRaw`. Add `sumTokensWeighted(u, weight)` that returns `input + output + reasoning + cache_write + cache_read * (weight ?? 1)`. Cache-write is intentionally **not discounted**; it keeps the old one-token-counts-as-one-budget-token behaviour even though dollar pricing can differ by model. |
| 4 | `packages/shared/src/invoke/budget-enforcement.ts` | new exported helper | Add `calculateBudgetTokenBreakdown(rateCard, entries)` that returns `{ total_tokens, weighted_tokens, cache_read_tokens, cache_read_token_weight, cache_read_tokens_excluded }`. It performs per-entry weighting, floors the final weighted token count once, clamps excluded tokens non-negative, and returns `cache_read_token_weight: null` when weights are mixed or no discounted cache reads are present. |
| 5 | `packages/shared/src/invoke/budget-enforcement.ts` | 328-380 (`estimateState`) | Build the `llmUsage` entries as today, call `calculateBudgetTokenBreakdown`, and merge the result into `BudgetState`. |
| 6 | `packages/shared/src/invoke/budget-enforcement.ts` | 309-326 (`enforce`) | Change cap check to `if (max_tokens && state.weighted_tokens >= max_tokens)`. Use `weighted_tokens`, not `total_tokens`. |
| 7 | `packages/shared/src/invoke/budget-enforcement.ts` | 382-423 (`triggerExceeded`) | Add to `msgParts`: `weighted_tokens=${state.weighted_tokens}` and `cache_read=${state.cache_read_tokens}(w=${state.cache_read_token_weight ?? 'full/mixed'})`. Add the four new fields to the `budget.exceeded` log row. Keep existing `total_tokens` field. |
| 8 | `packages/shared/src/invoke/budget-enforcement.ts` + `apps/agent-runtime/src/invoke/invoke.service.ts` | agent-runtime close handler around 1445-1463 | Add `BudgetEnforcer.appendSummary(trigger)` (or equivalent) that emits a single `budget.summary` row with the same token fields. Call it after stdout log processing drains and before result extraction/final lifecycle logging. |
| 9 | `packages/shared/src/invoke/index.ts` | budget exports | Export `calculateBudgetTokenBreakdown` so the worker can reuse the exact same token math instead of duplicating helpers. |
| 10 | `apps/worker/src/invoke/invoke.service.ts` | 2086-2217 and exit handler 2328-2391 | Use `calculateBudgetTokenBreakdown` for token aggregation, change the cap comparison to weighted, extend `budget.exceeded`, and append `budget.summary` in the exit handler after `await logChain`. Do not create a second local implementation of the weight math. |
| 11 | `apps/agent-runtime/src/invoke/invoke.service.ts` | 1320-1475 | No enforcement logic change — pure consumer except for the new final `budget.summary` call. Verify the new close_reason fragment propagates through `budgetEnforcer.exceededError`. |
| 12 | `packages/shared/src/invoke/__tests__/budget-enforcement.spec.ts` | new | Unit tests directly instantiate `BudgetEnforcer` with a hand-built `BudgetConfig` rooted in `DEFAULT_RATE_CARD_V1` and a stub `LogSink`/kill callback. No real DB or harness process. See "Test coverage" below. |
| 13 | `apps/api/test/integration/budget-enforcement.integration.test.ts` | 79-210 | Leave the skipped integration suite alone unless the timing race is fixed in the same change. Required coverage for this plan is the shared unit suite; an unskipped deterministic integration smoke can be a follow-up. |
| 14 | `packages/cli/src/lib/help.ts` | 370-429 (`job create` options) | Add three lines under "Scheduling hints (used by scheduler when claiming):": `--max-cost <amount>` (lead), `--max-cost-currency <ccy>` (defaults `usd`), `--max-tokens <n>` (coarse guardrail; cache-aware). One-line note in the examples block: `# --max-cost is the authoritative budget; --max-tokens discounts cache reads by rate-card weight.` |
| 15 | `docs/system/pricing-and-billing.md` | 64-75 (Budgets + Enforcement) | Replace the paragraph after the bullets with: "Token counting against `max_tokens` is **cache-aware**: cache-read tokens are weighted by the model's cache-read share of its input price when the active rate card defines a cheaper cache-read rate. `max_cost` is the economically correct cap; `max_tokens` is a coarse guardrail. The `budget.summary` / `budget.exceeded` log rows carry `weighted_tokens`, `cache_read_tokens`, `cache_read_token_weight`, and `cache_read_tokens_excluded` for visibility." |
| 16 | `../eve-skillpacks/eve-work/eve-read-eve-docs/references/cli-jobs.md` + `references/jobs.md` | `cli-jobs.md:42` + budget/log sections | Reorder to lead with `--max-cost 5.00` and add a line: "Prefer `--max-cost` over `--max-tokens`. Token counting discounts cache-read tokens by rate-card weight when the model has a cheaper cache-read rate, but the cost cap is the authoritative budget." |
| 17 | `../eve-skillpacks/eve-work/eve-read-eve-docs/references/cli.md` | job logs / diagnose section | Document the new `budget.summary` and `budget.exceeded` log row fields (`weighted_tokens`, `cache_read_tokens`, `cache_read_token_weight`, `cache_read_tokens_excluded`) under job log / diagnose behaviour. |
| 18 | `CLAUDE.md` | Update Log | One-line entry on the release date describing the cache-aware budget enforcement. |

Estimated change: ~120 LOC TypeScript across shared budget enforcement plus worker/agent-runtime summary calls, ~150 LOC of tests, doc edits.

## Test coverage

`packages/shared/src/invoke/__tests__/budget-enforcement.spec.ts` (new) drives `BudgetEnforcer` directly with a hand-built `BudgetConfig` rooted in `DEFAULT_RATE_CARD_V1`. Each case asserts on either the kill-signal path or the resulting `budget.exceeded` / `budget.summary` log content via a stub `LogSink`.

| # | Case | Setup | Expectation |
|---|---|---|---|
| 1 | Anthropic cached prompt under cost cap doesn't trigger | provider=`anthropic`, model=`claude-opus-4-7`, max_tokens=6_000_000, max_cost=usd 40, usage 0.5M input + 7M cache_read | killProcess not called; weighted ≈ 1.2M < 6M; total raw 7.5M; cache_read_token_weight=0.1 |
| 2 | Anthropic runaway output still triggers | model=opus, max_tokens=6_000_000, usage 30M output + 5M cache_read | killProcess called; reason=`max_tokens exceeded`; weighted ≈ 30.5M; close_reason contains `weighted_tokens=` |
| 3 | OpenAI o3 unaffected | provider=`openai`, model=`o3` (no cache_read rate), max_tokens=6M, usage 7M cache_read (synthetic) | weight resolves to null → no discount → triggers; behaviour unchanged from today |
| 4 | OpenAI gpt-5.5 discounted (10%) | provider=`openai`, model=`gpt-5.5`, max_tokens=6M, 4M cache_read | weighted=400k → no trigger; cache_read_token_weight≈0.1 |
| 5 | Mixed-model run with different weights | two entries: anthropic Opus and openai o3, both with cache_read | weight resolves to `null` at the BudgetState level (mixed); enforcement still uses per-entry weighted accumulation; ensures we don't accidentally apply one model's weight to another |
| 6 | Cache-write counts at full budget weight | anthropic Opus, usage 10M cache_write only, max_tokens=6M | triggers; cache_write is not discounted (this plan only fixes cache-read false positives) |
| 7 | Backward-compat: max_cost still wins when lower | max_tokens=10M (well above weighted total), max_cost=usd 0.01, $0.50 of actual usage | triggers with reason=`max_cost exceeded`; no change in cost path |
| 8 | Log row fields present | trigger case 2 | `appendLog('budget.exceeded', …)` receives `weighted_tokens`, `cache_read_tokens`, `cache_read_token_weight`, `cache_read_tokens_excluded`, AND retains existing `total_tokens` |
| 9 | Final summary fields present | non-trigger case 1 | `appendLog('budget.summary', …)` receives the same token breakdown fields so production smoke tests can inspect weighted totals without forcing a failure |
| 10 | Empty usage no-ops | no llm.call ever sent | enforce() does not trigger; budget summary weighted_tokens=0, total_tokens=0 |
| 11 | Rate card missing the provider entirely | provider=`mystery`, model=`anon`, 4M cache_read | weight=null; counts at full weight; behaviour unchanged from today |

Loop time: <1s per `pnpm --filter @eve/shared test` run.

## Verification loop — local (fast)

```bash
# From repo root.
pnpm install
pnpm --filter @eve/shared build
pnpm --filter @eve/shared test
pnpm --filter @eve/worker build           # confirms the worker path still type-checks
pnpm --filter @eve/agent-runtime build    # confirms agent-runtime still type-checks
```

The new `budget-enforcement.spec.ts` is pure-Node: no DB, no harness process, no kill side effects (the `killProcess` callback is a stub).

### Local end-to-end smoke (k8s stack)

Reproduces the smoke evidence from `acme-portal/eve-platform-gaps/0001-implementation-workflow-smoke-gaps.md §6`.

```bash
./bin/eh status
./bin/eh k8s start && ./bin/eh k8s deploy
export EVE_API_URL=http://api.eve.lvh.me
eve profile use local

# Use the existing manual-test-org fixture.
eve org ensure "manual-test-org" --slug manual-test-org --json
eve secrets import --org org_manualtestorg --file manual-tests.secrets

# Create a job whose prompt forces Claude into multi-turn cached usage.
eve job create \
  --description "Run a 50-turn refactor against the repo CLAUDE.md. Re-read CLAUDE.md every turn." \
  --harness mclaude --variant heavy --model claude-opus-4-7 \
  --max-tokens 6000000 --max-cost 40 --max-cost-currency usd \
  --resource-class job.c2 \
  --claim

JOB_ID=<from output>
eve job follow $JOB_ID
eve job logs $JOB_ID --json | jq '
  .logs[]
  | select(.type == "budget.summary" or .type == "budget.exceeded")
  | {type, total_tokens: .line.total_tokens, weighted_tokens: .line.weighted_tokens, cache_read_tokens: .line.cache_read_tokens, weight: .line.cache_read_token_weight}'
# Expect: close_reason DOES NOT contain BUDGET_EXCEEDED.
# Expect: weighted_tokens < 6_000_000 even when total_tokens > 6_000_000.

# Negative control: same shape with --max-tokens 100000 (intentionally tight) MUST still trigger.
eve job create … --max-tokens 100000 --max-cost 40 …
# Expect: BUDGET_EXCEEDED: max_tokens exceeded weighted_tokens=… cache_read=…(w=0.10)
```

## Verification loop — ACME Portal satellite (authoritative)

Real proof runs on the repo where the friction was first observed.

### Preconditions

- `acme-portal` checked out next to `eve-horizon-2`.
- Local k3d stack OR staging access (recommend k3d; staging adds turnaround time for image rebuild).
- ACME Portal satellite repo already synced once today.

### Step 1 — Establish failing baseline (pre-fix CLI)

```bash
cd ../acme-portal/acme-refactor-review-fix
git checkout pre-009-baseline-2026-04-30   # tag from the smoke run, or recreate manually
eve project sync --dir . --local

# Re-run the smoke that produced acme-b531c233.9.7.
eve job create \
  --description "Refactor review/fix: replay the 70-turn ACME Portal case." \
  --harness mclaude --model claude-opus-4-7 \
  --max-tokens 6000000 --max-cost 40 --claim
eve job follow <id>
# Expected today: BUDGET_EXCEEDED at ~7.5M total_tokens, $0.0068 actual.
```

### Step 2 — Cut a CLI + image version with the fix

The fix lives in the shared package and the worker image. CLI changes are doc-only; new image is required.

```bash
# From eve-horizon-2.
pnpm install
pnpm build
pnpm test

# Bump the staging release tag.
LAST=$(git tag --list 'release-v*' --sort=-version:refname | head -1)
NEXT="release-v$(echo $LAST | sed -E 's/release-v//' | awk -F. '{print $1"."$2"."$3+1}')"
git tag "$NEXT" && git push origin "$NEXT"
gh run watch --exit-status              # publish-images.yml then deployment-instance-repo deploy

# If iterating against k3d instead:
./bin/eh k8s-image push
./bin/eh k8s deploy
```

CLI publish is optional — only the help text changed. Bump independently:

```bash
LAST_CLI=$(git tag --list 'cli-v*' --sort=-version:refname | head -1)
NEXT_CLI="cli-v$(echo $LAST_CLI | sed -E 's/cli-v//' | awk -F. '{print $1"."$2"."$3+1}')"
git tag "$NEXT_CLI" && git push origin "$NEXT_CLI"
```

### Step 3 — Re-run the offending job against the fix

```bash
cd ../acme-portal/acme-refactor-review-fix
eve job create \
  --description "Refactor review/fix: replay the 70-turn ACME Portal case." \
  --harness mclaude --model claude-opus-4-7 \
  --max-tokens 6000000 --max-cost 40 --claim

eve job follow <id>
eve job logs <id> --json | jq '
  .logs[]
  | select(.type == "budget.summary" or .type == "budget.exceeded")
  | { type,
      total_tokens: .line.total_tokens,
      weighted_tokens: .line.weighted_tokens,
      cache_read_tokens: .line.cache_read_tokens,
      weight: .line.cache_read_token_weight }'
# Expect:
#   close_reason: (no BUDGET_EXCEEDED — job completes or hits another normal terminator)
#   total_tokens:   ~7_500_000
#   weighted_tokens: <  1_500_000
#   cache_read_tokens: ~7_000_000
#   weight: 0.1
```

### Step 4 — Drop the ACME Portal override

```bash
cd ../acme-portal
grep -rn "max-tokens 30000000\|max_tokens.*30000000" .
# Expect: hits in decisions/0006-agentic-planning-workflow.md and orchestrator code.
# After validating Step 3, open a PR there that drops the override back to 6M.
```

### Step 5 — Intent test: runaway job still trips

```bash
eve job create \
  --description "Synthetic runaway: write a 200KB output every turn for 50 turns." \
  --harness mclaude --model claude-opus-4-7 \
  --max-tokens 6000000 --max-cost 40 --claim
# Expect: BUDGET_EXCEEDED: max_tokens exceeded weighted_tokens=… cache_read=…(w=0.10)
# Confirms the cap still fires when actual usage justifies it.
```

### Step 6 — Cross-mesh sweep

After Steps 3-5 pass on `acme-refactor-review-fix`, sweep the remaining satellites that use Claude:

```bash
for repo in ../acme-portal/acme-*; do
  [ -d "$repo/.eve" ] || continue
  # Trigger the standard ready-list job on each.
  ( cd "$repo" && eve job ready --limit 1 --json | jq '.[0].id' )
done
# For each ID, confirm no false-positive BUDGET_EXCEEDED in logs.
```

### Step 7 — Rollback rehearsal

```bash
# Re-deploy the previous release tag; confirm the old behaviour returns.
git checkout release-v0.1.<prev>
./bin/eh k8s-image push && ./bin/eh k8s deploy
eve job create … --max-tokens 6000000 --max-cost 40 --claim
# Expect: BUDGET_EXCEEDED returns. Then re-roll forward.
git checkout release-v0.1.<new>
./bin/eh k8s-image push && ./bin/eh k8s deploy
```

## Acceptance criteria

- A Claude/Opus agent job running 50+ turns over a repo-sized cached prompt, billing under $0.10 actual cost, does **not** trip `BUDGET_EXCEEDED` under `--max-tokens 6000000 --max-cost 'usd 40'`.
- A job that actually consumes >6M *output* tokens still trips `BUDGET_EXCEEDED: max_tokens exceeded` — the discount narrows false positives but does not disable the cap.
- `eve job logs <id> --json` / `eve job diagnose <id> --json` expose `budget.summary` / `budget.exceeded` rows with `weighted_tokens`, `cache_read_tokens`, `cache_read_token_weight`, `cache_read_tokens_excluded` alongside the existing `total_tokens`, and the text `close_reason` for exceeded jobs carries a trailing `weighted_tokens=… cache_read=N(w=W)` fragment.
- ACME Portal's `--max-tokens 30000000` override on Claude workers can be removed; standard `6000000` works.
- Codex/OpenAI o3 and managed-llama jobs see no behaviour change.
- `pnpm --filter @eve/shared test`, `pnpm --filter @eve/worker build`, and `pnpm --filter @eve/agent-runtime build` pass, including the new shared budget cases.
- Docs updated: `pricing-and-billing.md`, `references/cli-jobs.md`, `references/jobs.md`, `references/cli.md`, `CLAUDE.md` update-log entry. Help text for `eve job create` lists `--max-cost` and `--max-tokens`.

## Non-goals

- **Per-provider cache-read weights as a system setting.** The rate card already differentiates; reading from there is enough. We are not introducing a new `system_settings` key.
- **Refunding or reweighting cache-write tokens.** Cache writes are not part of the false-positive pattern here; they keep the current full token-count weight in the budget proxy. Dollar billing remains governed by the rate card and can price cache writes differently from normal input.
- **Changing the rate card / billing path.** Billing already accounts correctly. This spec only fixes the *budget enforcement* path. No `cost-calculator.ts` change beyond exposing `getTokenRate` to the enforcer (already exported).
- **Demoting `max_tokens` to optional.** Today's callers keep their token cap; only the semantics of counting change.
- **Adding a new `--max-billable-tokens` flag.** Option C in the spec. Considered and rejected for the same reason as demoting `max_tokens`: more migration surface, less correctness gain.
- **Migrating the worker off its hand-rolled enforcement flow.** Tracked in `worker-agent-runtime-shared-extraction.md`. This plan shares token math to prevent budget drift, but it does not replace the worker's local process-control and logging flow with `BudgetEnforcer`.
- **Refactoring `BudgetState` field names.** `total_tokens` stays for backward compat with downstream consumers (receipts, analytics). The new `weighted_tokens` field is additive.

## Risks and follow-ups

- **Quiet behaviour change.** Operators who calibrated `--max-tokens` against actual observed cache-read-heavy usage will see their cap fire less often. Documented in `pricing-and-billing.md` and the `CLAUDE.md` update log; `budget.summary` plus the `weighted_tokens=` close_reason fragment on exceeded jobs make the discount visible. Suggested follow-up: an analytics counter that surfaces "would have tripped under old semantics" so we can quantify the false-positive rate retroactively.
- **Mixed-model jobs.** A single attempt that mixes Anthropic + OpenAI usage gets `cache_read_token_weight: null` in the BudgetState summary (multiple weights applied). The enforcement is still correct (per-entry weighting), but the summary field is less informative. Acceptable — mixed-model jobs are rare and the budget log rows can carry a `by_model` breakdown in a follow-up.
- **Worker drift.** The full worker enforcement flow still lives locally. Sharing `calculateBudgetTokenBreakdown` removes the token-math drift; a future consolidation should replace the remaining local flow with `BudgetEnforcer`.
- **Rate-card weight changes silently.** When the rate card is updated (e.g. Anthropic adjusts cache pricing), the enforcement weight moves automatically. This is the intended design but means a deploy of just `rate_cards.rates_json` changes enforcement semantics with no code change. The `cache_read_token_weight` field in `budget.summary` / `budget.exceeded` makes the active weight inspectable.
- **No discount when rate is null.** If a future model emits cache reads but the rate card omits `cache_read_per_million_usd`, the budget proxy stays conservative (full weight). This is the safe default but means a rate-card-update PR is the unblocker — flagged so the rate-card update workflow knows to include the field.

## Docs to update

- `docs/system/pricing-and-billing.md` — Budgets + Enforcement section: document cache-aware counting, the new `budget.summary` / `budget.exceeded` fields, and the recommendation to lead with `--max-cost`.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/cli-jobs.md` — `eve job create` example block: reorder to lead with `--max-cost`, add the cache-discount note.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/jobs.md` — budget/logging section: document `budget.summary` and `budget.exceeded` fields.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/cli.md` — job logs / diagnose section: document where to inspect the new budget fields.
- `CLAUDE.md` — Update Log: one-line entry on the release date.
- `packages/cli/src/lib/help.ts` — `job create` options list: add `--max-cost` (lead), `--max-cost-currency`, `--max-tokens` with the cache-aware note.

## See also

- `packages/shared/src/invoke/budget-enforcement.ts:76-90` — `sumTokens` (the bug).
- `packages/shared/src/invoke/budget-enforcement.ts:309-326` — `enforce` cap check.
- `packages/shared/src/invoke/budget-enforcement.ts:328-380` — `estimateState` token aggregation.
- `packages/shared/src/invoke/budget-enforcement.ts:382-423` — `triggerExceeded` close_reason + log.
- `packages/shared/src/invoke/types.ts:76-95` — `LlmUsageEntry`, `BudgetState`.
- `packages/shared/src/pricing/cost-calculator.ts:49-58` — `getTokenRate` (rate-card resolver, reused by this plan).
- `packages/shared/src/pricing/cost-calculator.ts:93-103` — current correct cache-read pricing in the cost path (the asymmetry this plan closes).
- `packages/shared/src/pricing/default-rate-card.ts:17-67` — Anthropic cache-read rates (10% of input).
- `apps/worker/src/invoke/invoke.service.ts:2086-2217` — worker's hand-rolled copy of the budget logic (mirror change required).
- `apps/agent-runtime/src/invoke/invoke.service.ts:1320-1475` — agent-runtime call site (pure consumer except final `budget.summary` emission).
- `apps/api/test/integration/budget-enforcement.integration.test.ts:79-210` — existing skipped budget integration test (do not rely on it for required coverage unless unskipped/fixed).
- `packages/cli/src/commands/job.ts:489-506` — CLI flag parsing for `--max-tokens` / `--max-cost`.
- `packages/cli/src/lib/help.ts:370-429` — `eve job create` help (currently missing the budget flags).
- `docs/system/pricing-and-billing.md:64-75` — Budgets + Enforcement documentation.
- ACME gap `009 — max_tokens budget should exclude (or discount) Anthropic cache-read tokens` — origin spec.
- ACME gap `0001-implementation-workflow-smoke-gaps.md §6` — original observation (`acme-b531c233.9.7`).
- `acme-portal/decisions/0006-agentic-planning-workflow.md` — where the 30M-token workaround is recorded.
- [Anthropic prompt caching pricing](https://www.anthropic.com/news/prompt-caching) — source for the 10% cache-read weight.
