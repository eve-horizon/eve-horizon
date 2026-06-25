/**
 * Budget enforcement for harness execution.
 *
 * Extracted from the worker's invoke.service.ts so both worker and
 * agent-runtime can share the same budget logic without duplication.
 *
 * Two entry points:
 *
 * 1. `resolveBudgetEnforcementConfig` — DB-backed resolution of budget
 *    constraints from job hints, org billing config, and system defaults.
 *    Returns null when no budget constraints are set.
 *
 * 2. `BudgetEnforcer` — stateful tracker that aggregates llm.call events
 *    and kills the harness process when a budget limit is exceeded.
 */

import BigNumber from 'bignumber.js';
import {
  DEFAULT_BILLING_DEFAULTS_V1,
  DEFAULT_RATE_CARD_EFFECTIVE_AT,
  DEFAULT_RATE_CARD_NAME,
  DEFAULT_RATE_CARD_V1,
  DEFAULT_RATE_CARD_VERSION,
  DEFAULT_RESOURCE_CLASS_NAME,
  DEFAULT_RESOURCE_CLASSES_V1,
  calculateBilledCost,
  getTokenRate,
  parseResourceClassesV1,
  resolveResourceClassName,
  getResourceClassSpec,
  parseBillingDefaultsV1,
  resolveBillingConfigV1,
  type RateCardV1,
} from '../pricing/index.js';
import type { HarnessInvocation } from '../types/harness.js';
import type { BudgetConfig, BudgetDb, BudgetState, LlmUsageEntry, LogSink } from './types.js';
import { readPositiveInt, readMaxCostHint } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TOKEN_WEIGHT_SCALE = 10_000;

function clampTokenCount(value: number | undefined | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function positiveRate(value: string | null | undefined): BigNumber | null {
  if (value == null) return null;
  const rate = new BigNumber(value);
  if (!rate.isFinite() || rate.lte(0)) return null;
  return rate;
}

function cacheReadWeightFor(
  rateCard: RateCardV1,
  entry: Pick<LlmUsageEntry, 'provider' | 'model' | 'source'>,
): BigNumber | null {
  const rate = getTokenRate(rateCard, entry);
  const inputRate = positiveRate(rate?.input_per_million_usd);
  const cacheReadRate = positiveRate(rate?.cache_read_per_million_usd);
  if (!inputRate || !cacheReadRate || cacheReadRate.gte(inputRate)) return null;
  return cacheReadRate.div(inputRate);
}

async function getManifestDefaults(
  db: BudgetDb,
  projectId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const manifest = await db.findLatestProjectManifest(projectId);
    return manifest?.parsed_defaults ?? null;
  } catch (err) {
    console.warn(
      `[manifest] Failed to fetch defaults for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function resolveResourceClassForJob(
  db: BudgetDb,
  invocation: HarnessInvocation,
): Promise<{ name: string | null; spec: unknown | null }> {
  const [job, manifestDefaults, setting] = await Promise.all([
    db.findJobById(invocation.jobId),
    getManifestDefaults(db, invocation.projectId),
    db.getSystemSetting('resource_classes'),
  ]);

  const resourceClasses = parseResourceClassesV1(setting?.value) ?? DEFAULT_RESOURCE_CLASSES_V1;
  const name = resolveResourceClassName({
    job_hints: (job?.hints ?? null) as Record<string, unknown> | null,
    manifest_defaults: manifestDefaults,
    fallback: DEFAULT_RESOURCE_CLASS_NAME,
  });
  const spec = getResourceClassSpec(resourceClasses, name);
  return { name, spec };
}

function sumTokensRaw(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
}): number {
  return (
    clampTokenCount(u.input_tokens) +
    clampTokenCount(u.output_tokens) +
    clampTokenCount(u.cache_read_tokens) +
    clampTokenCount(u.cache_write_tokens) +
    clampTokenCount(u.reasoning_tokens)
  );
}

function sumTokensWeighted(
  u: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
  },
  cacheReadWeight: BigNumber | null,
): BigNumber {
  const fullWeightTokens =
    clampTokenCount(u.input_tokens) +
    clampTokenCount(u.output_tokens) +
    clampTokenCount(u.cache_write_tokens) +
    clampTokenCount(u.reasoning_tokens);
  const cacheReadTokens = clampTokenCount(u.cache_read_tokens);
  const weight = cacheReadWeight ?? new BigNumber(1);
  return new BigNumber(fullWeightTokens).plus(weight.times(cacheReadTokens));
}

export function calculateBudgetTokenBreakdown(
  rateCard: RateCardV1,
  entries: LlmUsageEntry[],
): Pick<
  BudgetState,
  | 'total_tokens'
  | 'weighted_tokens'
  | 'cache_read_tokens'
  | 'cache_read_token_weight'
  | 'cache_read_tokens_excluded'
> {
  let totalTokens = 0;
  let cacheReadTokens = 0;
  let weightedTokens = new BigNumber(0);
  const positiveCacheReadWeights = new Set<string>();

  for (const entry of entries) {
    const cacheReadWeight = cacheReadWeightFor(rateCard, entry);
    const rawTokens = sumTokensRaw(entry.usage);
    const entryCacheReadTokens = clampTokenCount(entry.usage.cache_read_tokens);

    totalTokens += rawTokens;
    cacheReadTokens += entryCacheReadTokens;
    weightedTokens = weightedTokens.plus(sumTokensWeighted(entry.usage, cacheReadWeight));

    if (entryCacheReadTokens > 0) {
      const appliedWeight = cacheReadWeight ?? new BigNumber(1);
      positiveCacheReadWeights.add(appliedWeight.decimalPlaces(8).toString());
    }
  }

  const weightedTokenCount = weightedTokens
    .integerValue(BigNumber.ROUND_FLOOR)
    .toNumber();
  const excludedTokens = Math.max(0, totalTokens - weightedTokenCount);
  const [onlyWeight] = Array.from(positiveCacheReadWeights);
  const weight =
    positiveCacheReadWeights.size === 1 && onlyWeight && new BigNumber(onlyWeight).lt(1)
      ? Math.round(new BigNumber(onlyWeight).toNumber() * TOKEN_WEIGHT_SCALE) / TOKEN_WEIGHT_SCALE
      : null;

  return {
    total_tokens: totalTokens,
    weighted_tokens: weightedTokenCount,
    cache_read_tokens: cacheReadTokens,
    cache_read_token_weight: weight,
    cache_read_tokens_excluded: excludedTokens,
  };
}

function formatCacheReadWeight(weight: number | null): string {
  if (weight == null) return 'full/mixed';
  return weight.toFixed(2);
}

// ---------------------------------------------------------------------------
// resolveBudgetEnforcementConfig
// ---------------------------------------------------------------------------

/**
 * Resolve budget enforcement config from job hints + org billing + system defaults.
 * Returns null if no budget constraints are set (no `max_tokens` or `max_cost` hint).
 */
export async function resolveBudgetEnforcementConfig(
  db: BudgetDb,
  invocation: HarnessInvocation,
): Promise<BudgetConfig | null> {
  const job = await db.findJobById(invocation.jobId);
  if (!job) return null;

  const hints = (job.hints ?? {}) as Record<string, unknown>;
  const maxTokens = readPositiveInt(hints.max_tokens);
  const maxCost = readMaxCostHint(hints.max_cost);

  if (!maxTokens && !maxCost) {
    return null;
  }

  // Load org billing config + system defaults.
  const orgRow = await db.getOrgBillingConfig(invocation.projectId);

  const billingDefaultsSetting = await db.getSystemSetting('billing.defaults');
  let systemDefaults = DEFAULT_BILLING_DEFAULTS_V1;
  if (billingDefaultsSetting?.value) {
    try {
      systemDefaults = parseBillingDefaultsV1(billingDefaultsSetting.value);
    } catch (err) {
      console.warn(
        `[budget] Invalid system billing.defaults; falling back: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const billing = resolveBillingConfigV1({
    system_defaults: systemDefaults,
    org_billing_config: orgRow?.billing_config,
  });
  const billingCurrency = (billing.billing_currency ?? 'usd').toLowerCase();
  const enforcementCurrency = (maxCost?.currency ?? billingCurrency).toLowerCase();

  const at = new Date();
  const cardRow = await db.findLatestRateCard(billing.rate_card_name, at);
  const rateCard = cardRow
    ? {
        name: cardRow.name,
        version: cardRow.version,
        effective_at: cardRow.effective_at.toISOString(),
        rates: cardRow.rates_json as unknown as RateCardV1,
      }
    : {
        name: DEFAULT_RATE_CARD_NAME,
        version: DEFAULT_RATE_CARD_VERSION,
        effective_at: DEFAULT_RATE_CARD_EFFECTIVE_AT,
        rates: DEFAULT_RATE_CARD_V1,
      };

  // FX snapshot (USD -> enforcement currency).
  let fx: { rate: string; fetched_at: string; source: string } | null = null;
  if (enforcementCurrency !== 'usd') {
    const fxRow = await db.findLatestExchangeRate('usd', enforcementCurrency);
    if (fxRow) {
      fx = {
        rate: fxRow.rate,
        fetched_at: fxRow.fetched_at.toISOString(),
        source: fxRow.source,
      };
    }
  }

  // Compute sizing for budget estimate (requested resources * elapsed time).
  const resolvedClass = await resolveResourceClassForJob(db, invocation);
  const spec = resolvedClass.spec as { vcpu?: unknown; memory_gib?: unknown } | null;
  const requestedVcpu =
    typeof spec?.vcpu === 'number' && Number.isFinite(spec.vcpu) ? spec.vcpu : null;
  const requestedMem =
    typeof spec?.memory_gib === 'number' && Number.isFinite(spec.memory_gib)
      ? spec.memory_gib
      : null;

  const attemptRow = await db.getAttemptExecutionStart(invocation.attemptId);
  const execStartedAt = attemptRow?.execution_started_at ?? new Date();

  return {
    max_tokens: maxTokens,
    max_cost: maxCost,
    pricing: {
      rate_card: rateCard,
      markup_pct: billing.markup_pct,
      currency: enforcementCurrency,
      fx_usd_to_currency: fx,
    },
    compute: {
      resource_class: resolvedClass.name,
      requested_vcpu: requestedVcpu,
      requested_memory_gib: requestedMem,
      execution_started_at_ms: execStartedAt.getTime(),
    },
  };
}

// ---------------------------------------------------------------------------
// BudgetEnforcer
// ---------------------------------------------------------------------------

/**
 * Tracks LLM usage events during harness execution and enforces budget limits.
 *
 * Usage:
 * 1. Create with `new BudgetEnforcer(config, logs, attemptId, killProcess)`
 * 2. Call `processLlmCall(parsedLine)` on each llm.call event line
 * 3. Call `startPeriodicCheck()` after harness process starts
 * 4. Call `stop()` when harness exits (clears interval)
 * 5. Check `exceeded` and `exceededError` for budget state
 *
 * The `killProcess` callback is responsible for SIGTERM and any escalation
 * to SIGKILL — this class only signals the intent to terminate.
 */
export class BudgetEnforcer {
  private llmUsageAgg = new Map<string, LlmUsageEntry>();
  private killIssued = false;
  private summaryAppended = false;
  private interval: NodeJS.Timeout | null = null;
  private _exceededError: string | null = null;

  constructor(
    private config: BudgetConfig,
    private logs: LogSink,
    private attemptId: string,
    private killProcess: () => void,
  ) {}

  /** Whether the budget has been exceeded and the kill signal issued. */
  get exceeded(): boolean {
    return this.killIssued;
  }

  /** Human-readable error message when budget is exceeded, or null. */
  get exceededError(): string | null {
    return this._exceededError;
  }

  /**
   * Process an llm.call log event for budget tracking.
   * Safe to call for every parsed JSONL line — non-llm.call events are ignored
   * by the caller; this method only handles the token aggregation and enforcement.
   */
  async processLlmCall(parsedLine: Record<string, unknown>): Promise<void> {
    try {
      const provider =
        typeof parsedLine.provider === 'string' ? parsedLine.provider : 'unknown';
      const model = typeof parsedLine.model === 'string' ? parsedLine.model : 'unknown';
      const sourceRaw =
        typeof parsedLine.source === 'string' ? parsedLine.source : 'byok';
      const source: 'byok' | 'managed' = sourceRaw === 'managed' ? 'managed' : 'byok';
      const status =
        typeof parsedLine.status === 'string' ? parsedLine.status : 'ok';
      const ok = status === 'ok';
      const usage = parsedLine.usage as Record<string, unknown> | undefined;

      if (ok && usage) {
        const key = `${source}:${provider}:${model}`;
        const existing = this.llmUsageAgg.get(key) ?? {
          provider,
          model,
          source,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
          },
        };

        existing.usage.input_tokens += Number(usage.input_tokens) || 0;
        existing.usage.output_tokens += Number(usage.output_tokens) || 0;
        existing.usage.cache_read_tokens += Number(usage.cache_read_tokens) || 0;
        existing.usage.cache_write_tokens += Number(usage.cache_write_tokens) || 0;
        existing.usage.reasoning_tokens += Number(usage.reasoning_tokens) || 0;
        this.llmUsageAgg.set(key, existing);
      }

      await this.enforce('llm.call');
    } catch (err) {
      console.warn(
        `[budget] Failed processing llm.call for enforcement: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Start periodic budget check (catches compute-only cost growth between llm.call events). */
  startPeriodicCheck(): void {
    this.interval = setInterval(() => {
      this.enforce('timer').catch((err) => {
        console.warn(
          `[budget] Periodic check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, 2000);
  }

  /** Stop the periodic check. Call on harness exit. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Emit one final budget summary row for observability, even when no limit fired. */
  async appendSummary(trigger: string): Promise<void> {
    if (this.summaryAppended) return;
    this.summaryAppended = true;
    const state = this.estimateState();
    if (!state) return;

    const maxCost = this.config.max_cost ?? null;
    const maxTokens = this.config.max_tokens ?? null;
    try {
      await this.logs.appendLog(this.attemptId, 'budget.summary', {
        trigger,
        max_tokens: maxTokens,
        max_cost: maxCost,
        currency: state.currency,
        estimated_total: state.estimated_total.toFixed(6),
        estimated_byok_total: state.byok_total.toFixed(6),
        estimated_billed_total: state.billed_total.toFixed(6),
        total_tokens: state.total_tokens,
        weighted_tokens: state.weighted_tokens,
        cache_read_tokens: state.cache_read_tokens,
        cache_read_token_weight: state.cache_read_token_weight,
        cache_read_tokens_excluded: state.cache_read_tokens_excluded,
      });
    } catch (err) {
      console.warn(
        `[budget] Failed to append budget.summary log: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async enforce(trigger: string): Promise<void> {
    if (this.killIssued) return;
    const state = this.estimateState();
    if (!state) return;

    if (this.config.max_tokens && state.weighted_tokens >= this.config.max_tokens) {
      await this.triggerExceeded({ reason: 'max_tokens exceeded', trigger, state });
      return;
    }

    if (
      this.config.max_cost &&
      state.currency === this.config.max_cost.currency &&
      state.estimated_total >= this.config.max_cost.amount
    ) {
      await this.triggerExceeded({ reason: 'max_cost exceeded', trigger, state });
    }
  }

  private estimateState(): BudgetState | null {
    const currency = this.config.pricing.currency;
    const fxRate =
      currency === 'usd'
        ? 1
        : Number(this.config.pricing.fx_usd_to_currency?.rate ?? '1');

    const llmUsage = Array.from(this.llmUsageAgg.values()).map((e) => ({
      provider: e.provider,
      model: e.model,
      source: e.source,
      usage: e.usage,
    }));

    const nowMs = Date.now();
    const elapsedSeconds = Math.max(
      0,
      (nowMs - this.config.compute.execution_started_at_ms) / 1000,
    );
    const requestedVcpu = this.config.compute.requested_vcpu ?? 0;
    const requestedMem = this.config.compute.requested_memory_gib ?? 0;
    const computeUsage = {
      resource_class: this.config.compute.resource_class,
      vcpu_seconds: requestedVcpu * elapsedSeconds,
      memory_gib_seconds: requestedMem * elapsedSeconds,
    };

    const costs = calculateBilledCost({
      rate_card: this.config.pricing.rate_card.rates as RateCardV1,
      llm_usage: llmUsage,
      compute_usage: computeUsage,
      markup_pct: this.config.pricing.markup_pct,
      billing_currency: currency,
      fx_usd_to_billing: this.config.pricing.fx_usd_to_currency,
    });

    const billedTotal = Number(costs.billed_cost.total.amount) || 0;
    const byokUsd = Number(costs.base_cost_usd.llm_byok_usd.amount) || 0;
    const byokTotal = byokUsd * fxRate;

    const tokenBreakdown = calculateBudgetTokenBreakdown(
      this.config.pricing.rate_card.rates as RateCardV1,
      Array.from(this.llmUsageAgg.values()),
    );

    return {
      currency,
      ...tokenBreakdown,
      estimated_total: billedTotal + byokTotal,
      byok_total: byokTotal,
      billed_total: billedTotal,
    };
  }

  private async triggerExceeded(input: {
    reason: string;
    trigger: string;
    state: BudgetState;
  }): Promise<void> {
    if (this.killIssued) return;
    this.killIssued = true;

    const maxCost = this.config.max_cost ?? null;
    const maxTokens = this.config.max_tokens ?? null;
    const msgParts = [
      `BUDGET_EXCEEDED: ${input.reason}`,
      maxTokens ? `max_tokens=${maxTokens}` : null,
      maxCost ? `max_cost=${maxCost.currency} ${maxCost.amount}` : null,
      `est_total=${input.state.currency} ${input.state.estimated_total.toFixed(6)}`,
      `weighted_tokens=${input.state.weighted_tokens}`,
      `cache_read=${input.state.cache_read_tokens}(w=${formatCacheReadWeight(input.state.cache_read_token_weight)})`,
    ].filter(Boolean);
    this._exceededError = msgParts.join(' ');

    // Stop the periodic check — no further enforcement needed.
    this.stop();

    // Signal the harness process to terminate.
    this.killProcess();

    try {
      await this.logs.appendLog(this.attemptId, 'budget.exceeded', {
        trigger: input.trigger,
        reason: input.reason,
        max_tokens: maxTokens,
        max_cost: maxCost,
        currency: input.state.currency,
        estimated_total: input.state.estimated_total.toFixed(6),
        estimated_byok_total: input.state.byok_total.toFixed(6),
        estimated_billed_total: input.state.billed_total.toFixed(6),
        total_tokens: input.state.total_tokens,
        weighted_tokens: input.state.weighted_tokens,
        cache_read_tokens: input.state.cache_read_tokens,
        cache_read_token_weight: input.state.cache_read_token_weight,
        cache_read_tokens_excluded: input.state.cache_read_tokens_excluded,
      });
    } catch (err) {
      console.warn(
        `[budget] Failed to append budget.exceeded log: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
