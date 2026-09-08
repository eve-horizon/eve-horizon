import { describe, expect, it } from 'vitest';
import {
  calculateBilledCost,
  estimateLlmCostUsd,
  getTokenRate,
  type LlmUsageByModel,
} from '../cost-calculator.js';
import { DEFAULT_RATE_CARD_V1 } from '../default-rate-card.js';

/**
 * A model missing from the rate card resolves to a `null` rate, which prices its
 * usage at $0. That silently disables `max_cost` budget enforcement, so the
 * models the harnesses actually run must stay listed.
 *
 * These cases use the model strings as harnesses report them on `llm.call`
 * events — including the dated and provider-prefixed forms that only reach a
 * rate card entry after normalization.
 */

const MILLION = 1_000_000;

/** One million of every billable token category, so each rate column is exercised. */
const FULL_USAGE = {
  input_tokens: MILLION,
  output_tokens: MILLION,
  cache_read_tokens: MILLION,
  cache_write_tokens: MILLION,
};

type RateCase = {
  name: string;
  provider: string;
  /** Model string exactly as the harness reports it. */
  reported_model: string;
  normalized_model: string;
  expected_llm_usd: string;
};

const CURRENT_GENERATION: RateCase[] = [
  {
    name: 'Claude Code reporting a dated Fable 5.1 id',
    provider: 'anthropic',
    reported_model: 'claude-fable-5-1-20260115',
    normalized_model: 'claude-fable-5-1',
    // 10.00 input + 50.00 output + 0.25 cache read + 12.50 cache write
    expected_llm_usd: '72.750000',
  },
  {
    name: 'Claude Code reporting a bare Fable 5.1 id',
    provider: 'anthropic',
    reported_model: 'claude-fable-5-1',
    normalized_model: 'claude-fable-5-1',
    expected_llm_usd: '72.750000',
  },
  {
    name: 'Claude Code reporting a dated Fable 5 id',
    provider: 'anthropic',
    reported_model: 'claude-fable-5-20260115',
    normalized_model: 'claude-fable-5',
    // 10.00 input + 50.00 output + 1.00 cache read + 12.50 cache write
    expected_llm_usd: '73.500000',
  },
  {
    name: 'Claude Code reporting a bare Fable 5 id',
    provider: 'anthropic',
    reported_model: 'claude-fable-5',
    normalized_model: 'claude-fable-5',
    expected_llm_usd: '73.500000',
  },
  {
    name: 'Codex reporting GPT-6 Astra',
    provider: 'openai',
    reported_model: 'gpt-6-astra',
    normalized_model: 'gpt-6-astra',
    // 10.00 input + 50.00 output + 1.00 cache read + 12.50 cache write
    expected_llm_usd: '73.500000',
  },
  {
    name: 'a provider-prefixed Fable 5.1 id',
    provider: 'anthropic',
    reported_model: 'anthropic/claude-fable-5-1',
    normalized_model: 'claude-fable-5-1',
    expected_llm_usd: '72.750000',
  },
];

describe('default rate card — current-generation harness models', () => {
  it.each(CURRENT_GENERATION)(
    'prices $name at a non-zero rate',
    ({ provider, reported_model, normalized_model, expected_llm_usd }) => {
      const entry: LlmUsageByModel = {
        provider,
        model: reported_model,
        source: 'byok',
        usage: FULL_USAGE,
      };

      // The rate must resolve; a null rate is what silently zeroes out cost.
      expect(getTokenRate(DEFAULT_RATE_CARD_V1, entry)).not.toBeNull();

      const estimate = estimateLlmCostUsd(DEFAULT_RATE_CARD_V1, [entry]);
      expect(estimate.by_model[0]?.normalized_model).toBe(normalized_model);
      expect(estimate.by_model[0]?.rate).not.toBeNull();
      expect(estimate.total_usd.isGreaterThan(0)).toBe(true);

      const billed = calculateBilledCost({
        rate_card: DEFAULT_RATE_CARD_V1,
        llm_usage: [entry],
        compute_usage: null,
        markup_pct: 20,
        billing_currency: 'usd',
        fx_usd_to_billing: null,
      });

      expect(billed.base_cost_usd.llm_usd.amount).toBe(expected_llm_usd);
      expect(billed.base_cost_usd.llm_byok_usd.amount).toBe(expected_llm_usd);
    },
  );

  it('prices reasoning tokens reported by Codex at the output rate', () => {
    const estimate = estimateLlmCostUsd(DEFAULT_RATE_CARD_V1, [
      {
        provider: 'openai',
        model: 'gpt-6-astra',
        source: 'byok',
        usage: { reasoning_tokens: MILLION },
      },
    ]);

    expect(estimate.total_usd.toFixed(2)).toBe('50.00');
  });

  it('prices an unlisted model at zero — the failure mode these entries prevent', () => {
    const estimate = estimateLlmCostUsd(DEFAULT_RATE_CARD_V1, [
      {
        provider: 'anthropic',
        model: 'claude-absent-from-rate-card',
        source: 'byok',
        usage: FULL_USAGE,
      },
    ]);

    expect(estimate.by_model[0]?.rate).toBeNull();
    expect(estimate.total_usd.toFixed(6)).toBe('0.000000');
  });
});
