import { describe, expect, it } from 'vitest';
import { calculateBilledCost } from '../cost-calculator.js';
import { DEFAULT_RATE_CARD_V1 } from '../default-rate-card.js';

describe('pricing cost calculator', () => {
  it('computes base USD totals and billed totals (managed-only) with markup', () => {
    const out = calculateBilledCost({
      rate_card: DEFAULT_RATE_CARD_V1,
      llm_usage: [
        {
          provider: 'anthropic',
          model: 'claude-opus-4-5-20250929', // should normalize to claude-opus-4-5
          source: 'byok',
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        },
        {
          provider: 'platform',
          model: 'llama-3.3-70b',
          source: 'managed',
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        },
      ],
      compute_usage: null,
      markup_pct: 20,
      billing_currency: 'usd',
      fx_usd_to_billing: null,
    });

    // Base: 30.00 (byok: $5 input + $25 output) + 0.80 (managed)
    expect(out.base_cost_usd.llm_usd.amount).toBe('30.800000');
    expect(out.base_cost_usd.llm_byok_usd.amount).toBe('30.000000');
    expect(out.base_cost_usd.llm_managed_usd.amount).toBe('0.800000');
    expect(out.base_cost_usd.total_usd.amount).toBe('30.800000');

    // Billed: managed-only * 1.2
    expect(out.billed_cost.total.currency).toBe('usd');
    expect(out.billed_cost.total.amount).toBe('0.960000');
    expect(out.billed_cost.llm.amount).toBe('0.960000');
    expect(out.billed_cost.compute.amount).toBe('0.000000');
  });

  it('includes compute usage and applies FX conversion', () => {
    const out = calculateBilledCost({
      rate_card: DEFAULT_RATE_CARD_V1,
      llm_usage: [
        {
          provider: 'platform',
          model: 'llama-3.3-70b',
          source: 'managed',
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        },
      ],
      compute_usage: {
        resource_class: 'job.c1',
        vcpu_seconds: 3600,
        memory_gib_seconds: 7200, // 2 GiB * 1 hour
      },
      markup_pct: 20,
      billing_currency: 'eur',
      fx_usd_to_billing: {
        rate: '0.9',
        fetched_at: new Date('2026-02-09T00:00:00.000Z').toISOString(),
        source: 'manual',
      },
    });

    // Managed LLM: 0.80 USD
    expect(out.base_cost_usd.llm_managed_usd.amount).toBe('0.800000');
    // Compute: 0.04 * 1h + 0.01 * 2 GiB*h = 0.06 USD
    expect(out.base_cost_usd.compute_usd.amount).toBe('0.060000');
    expect(out.base_cost_usd.total_usd.amount).toBe('0.860000');

    // Chargeable base = 0.86, markup 20% => 1.032 USD, FX 0.9 => 0.9288 EUR
    expect(out.billed_cost.total.currency).toBe('eur');
    expect(out.billed_cost.total.amount).toBe('0.928800');
  });
});
