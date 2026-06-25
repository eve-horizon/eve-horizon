import BigNumber from 'bignumber.js';
import type { Money, RateCardV1, TokenRate } from './types.js';
import { normalizeModelName } from './model-normalization.js';

const MILLION = new BigNumber('1000000');
const SECONDS_PER_HOUR = new BigNumber('3600');

function bn(value: string | number | BigNumber): BigNumber {
  return value instanceof BigNumber ? value : new BigNumber(value);
}

function clampNonNegativeInt(value: number | undefined | null): number {
  const n = typeof value === 'number' ? value : 0;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function formatAmount(amount: BigNumber, decimals = 6): string {
  // Keep a stable fixed-decimal representation for deterministic receipts.
  return amount.decimalPlaces(decimals, BigNumber.ROUND_HALF_UP).toFixed(decimals);
}

export function money(currency: string, amount: BigNumber, decimals = 6): Money {
  return { currency, amount: formatAmount(amount, decimals) };
}

export type LlmUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
};

export type LlmUsageByModel = {
  provider: string;
  model: string;
  source: 'byok' | 'managed';
  usage: LlmUsage;
};

export type ComputeUsage = {
  resource_class: string | null;
  vcpu_seconds: number;
  memory_gib_seconds: number;
};

export function getTokenRate(
  rateCard: RateCardV1,
  input: { provider: string; model: string; source: 'byok' | 'managed' },
): TokenRate | null {
  const sourceRates = input.source === 'managed' ? rateCard.llm.managed : rateCard.llm.byok;
  const providerRates = sourceRates[input.provider];
  if (!providerRates) return null;

  const normalizedModel = normalizeModelName(input.provider, input.model);
  return providerRates[normalizedModel] ?? providerRates[input.model] ?? null;
}

export function estimateLlmCostUsd(
  rateCard: RateCardV1,
  entries: LlmUsageByModel[],
): {
  total_usd: BigNumber;
  byok_usd: BigNumber;
  managed_usd: BigNumber;
  by_model: Array<{
    provider: string;
    model: string;
    normalized_model: string;
    source: 'byok' | 'managed';
    usage: Required<LlmUsage>;
    rate: TokenRate | null;
    cost_usd: BigNumber;
  }>;
} {
  let total = new BigNumber(0);
  let byokTotal = new BigNumber(0);
  let managedTotal = new BigNumber(0);

  const byModel = entries.map((entry) => {
    const normalizedModel = normalizeModelName(entry.provider, entry.model);
    const rate = getTokenRate(rateCard, entry);

    const usage: Required<LlmUsage> = {
      input_tokens: clampNonNegativeInt(entry.usage.input_tokens),
      output_tokens: clampNonNegativeInt(entry.usage.output_tokens),
      cache_read_tokens: clampNonNegativeInt(entry.usage.cache_read_tokens),
      cache_write_tokens: clampNonNegativeInt(entry.usage.cache_write_tokens),
      reasoning_tokens: clampNonNegativeInt(entry.usage.reasoning_tokens),
    };

    const cost =
      rate
        ? bn(rate.input_per_million_usd).times(usage.input_tokens).div(MILLION)
          .plus(bn(rate.output_per_million_usd).times(usage.output_tokens).div(MILLION))
          .plus(bn(rate.cache_read_per_million_usd ?? '0').times(usage.cache_read_tokens).div(MILLION))
          .plus(bn(rate.cache_write_per_million_usd ?? '0').times(usage.cache_write_tokens).div(MILLION))
          .plus(
            bn(rate.reasoning_per_million_usd ?? rate.output_per_million_usd)
              .times(usage.reasoning_tokens)
              .div(MILLION),
          )
        : new BigNumber(0);

    total = total.plus(cost);
    if (entry.source === 'managed') {
      managedTotal = managedTotal.plus(cost);
    } else {
      byokTotal = byokTotal.plus(cost);
    }

    return {
      provider: entry.provider,
      model: entry.model,
      normalized_model: normalizedModel,
      source: entry.source,
      usage,
      rate,
      cost_usd: cost,
    };
  });

  return {
    total_usd: total,
    byok_usd: byokTotal,
    managed_usd: managedTotal,
    by_model: byModel,
  };
}

export function estimateComputeCostUsd(
  rateCard: RateCardV1,
  usage: ComputeUsage,
): { compute_rate: { resource_class: string | null; vcpu_hour_usd: string | null; memory_gib_hour_usd: string | null } | null; cost_usd: BigNumber } {
  const resourceClass = usage.resource_class ?? null;
  const rate =
    (resourceClass ? rateCard.compute[resourceClass] : undefined)
    ?? rateCard.compute.default
    ?? null;

  if (!rate) {
    return {
      compute_rate: null,
      cost_usd: new BigNumber(0),
    };
  }

  const vcpuSeconds = Math.max(0, usage.vcpu_seconds);
  const memGibSeconds = Math.max(0, usage.memory_gib_seconds);

  const cost =
    bn(rate.vcpu_hour_usd).times(vcpuSeconds).div(SECONDS_PER_HOUR)
      .plus(bn(rate.memory_gib_hour_usd).times(memGibSeconds).div(SECONDS_PER_HOUR));

  return {
    compute_rate: {
      resource_class: resourceClass,
      vcpu_hour_usd: rate.vcpu_hour_usd,
      memory_gib_hour_usd: rate.memory_gib_hour_usd,
    },
    cost_usd: cost,
  };
}

export function calculateBilledCost(
  input: {
    rate_card: RateCardV1;
    llm_usage: LlmUsageByModel[];
    compute_usage: ComputeUsage | null;
    markup_pct: number;
    billing_currency: string;
    fx_usd_to_billing: { rate: string; fetched_at: string; source: string } | null;
  },
): {
  base_cost_usd: {
    llm_usd: Money;
    llm_byok_usd: Money;
    llm_managed_usd: Money;
    compute_usd: Money;
    total_usd: Money;
  };
  billed_cost: {
    total: Money;
    llm: Money;
    compute: Money;
  };
} {
  const markup = Number.isFinite(input.markup_pct) ? input.markup_pct : 0;
  const markupFactor = bn(1).plus(bn(markup).div(100));

  const llm = estimateLlmCostUsd(input.rate_card, input.llm_usage);
  const compute = input.compute_usage ? estimateComputeCostUsd(input.rate_card, input.compute_usage) : { compute_rate: null, cost_usd: bn(0) };

  const baseTotalUsd = llm.total_usd.plus(compute.cost_usd);
  const chargeableBaseUsd = llm.managed_usd.plus(compute.cost_usd);
  const chargeableWithMarkupUsd = chargeableBaseUsd.times(markupFactor);

  const fxRate = (input.billing_currency.toLowerCase() === 'usd')
    ? bn(1)
    : bn(input.fx_usd_to_billing?.rate ?? '1');

  const billedTotal = chargeableWithMarkupUsd.times(fxRate);
  const billedLlm = llm.managed_usd.times(markupFactor).times(fxRate);
  const billedCompute = compute.cost_usd.times(markupFactor).times(fxRate);

  return {
    base_cost_usd: {
      llm_usd: money('usd', llm.total_usd),
      llm_byok_usd: money('usd', llm.byok_usd),
      llm_managed_usd: money('usd', llm.managed_usd),
      compute_usd: money('usd', compute.cost_usd),
      total_usd: money('usd', baseTotalUsd),
    },
    billed_cost: {
      total: money(input.billing_currency, billedTotal),
      llm: money(input.billing_currency, billedLlm),
      compute: money(input.billing_currency, billedCompute),
    },
  };
}

