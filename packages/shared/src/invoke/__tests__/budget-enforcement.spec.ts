import { describe, expect, it, vi } from 'vitest';
import {
  BudgetEnforcer,
  calculateBudgetTokenBreakdown,
} from '../budget-enforcement.js';
import type { BudgetConfig, LogSink } from '../types.js';
import { DEFAULT_RATE_CARD_V1 } from '../../pricing/default-rate-card.js';
import type { RateCardV1 } from '../../pricing/types.js';

type LogRecord = {
  attemptId: string;
  type: string;
  content: Record<string, unknown>;
};

class TestLogSink implements LogSink {
  readonly records: LogRecord[] = [];

  async appendLog(attemptId: string, type: string, content: unknown): Promise<void> {
    this.records.push({ attemptId, type, content: content as Record<string, unknown> });
  }

  last(type: string): Record<string, unknown> {
    const record = this.records.findLast((entry) => entry.type === type);
    if (!record) throw new Error(`Missing log record: ${type}`);
    return record.content;
  }
}

function makeConfig(input: {
  maxTokens?: number | null;
  maxCost?: { currency: string; amount: number } | null;
  rateCard?: RateCardV1;
} = {}): BudgetConfig {
  return {
    max_tokens: input.maxTokens ?? 6_000_000,
    max_cost: input.maxCost ?? { currency: 'usd', amount: 40 },
    pricing: {
      rate_card: {
        name: 'default',
        version: 1,
        effective_at: '2026-04-29T00:00:00.000Z',
        rates: input.rateCard ?? DEFAULT_RATE_CARD_V1,
      },
      markup_pct: 0,
      currency: 'usd',
      fx_usd_to_currency: null,
    },
    compute: {
      resource_class: null,
      requested_vcpu: null,
      requested_memory_gib: null,
      execution_started_at_ms: Date.now(),
    },
  };
}

function llmCall(input: {
  provider: string;
  model: string;
  source?: 'byok' | 'managed';
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    reasoning_tokens?: number;
  };
}): Record<string, unknown> {
  return {
    type: 'llm.call',
    status: 'ok',
    provider: input.provider,
    model: input.model,
    source: input.source ?? 'byok',
    usage: input.usage,
  };
}

function makeEnforcer(config: BudgetConfig, logs = new TestLogSink()) {
  const killProcess = vi.fn();
  const enforcer = new BudgetEnforcer(config, logs, 'att_budget_test', killProcess);
  return { enforcer, logs, killProcess };
}

describe('BudgetEnforcer cache-aware token accounting', () => {
  it('does not trigger for an Anthropic cached prompt under the weighted token cap', async () => {
    const { enforcer, logs, killProcess } = makeEnforcer(makeConfig());

    await enforcer.processLlmCall(llmCall({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      usage: { input_tokens: 500_000, cache_read_tokens: 7_000_000 },
    }));
    await enforcer.appendSummary('final');

    expect(killProcess).not.toHaveBeenCalled();
    expect(enforcer.exceeded).toBe(false);
    expect(logs.last('budget.summary')).toMatchObject({
      total_tokens: 7_500_000,
      weighted_tokens: 1_200_000,
      cache_read_tokens: 7_000_000,
      cache_read_token_weight: 0.1,
      cache_read_tokens_excluded: 6_300_000,
    });
  });

  it('still triggers when runaway output dominates weighted usage', async () => {
    const { enforcer, logs, killProcess } = makeEnforcer(makeConfig());

    await enforcer.processLlmCall(llmCall({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      usage: { output_tokens: 30_000_000, cache_read_tokens: 5_000_000 },
    }));

    expect(killProcess).toHaveBeenCalledOnce();
    expect(enforcer.exceededError).toContain('BUDGET_EXCEEDED: max_tokens exceeded');
    expect(enforcer.exceededError).toContain('weighted_tokens=30500000');
    expect(enforcer.exceededError).toContain('cache_read=5000000(w=0.10)');
    expect(logs.last('budget.exceeded')).toMatchObject({
      reason: 'max_tokens exceeded',
      total_tokens: 35_000_000,
      weighted_tokens: 30_500_000,
      cache_read_tokens: 5_000_000,
      cache_read_token_weight: 0.1,
      cache_read_tokens_excluded: 4_500_000,
    });
  });

  it('keeps OpenAI o3 cache-read tokens at full weight when the rate card has no cache-read rate', async () => {
    const { enforcer, logs, killProcess } = makeEnforcer(makeConfig());

    await enforcer.processLlmCall(llmCall({
      provider: 'openai',
      model: 'o3',
      usage: { cache_read_tokens: 7_000_000 },
    }));

    expect(killProcess).toHaveBeenCalledOnce();
    expect(logs.last('budget.exceeded')).toMatchObject({
      total_tokens: 7_000_000,
      weighted_tokens: 7_000_000,
      cache_read_tokens: 7_000_000,
      cache_read_token_weight: null,
      cache_read_tokens_excluded: 0,
    });
  });

  it('discounts OpenAI gpt-5.5 cache-read tokens from the rate card', async () => {
    const { enforcer, logs, killProcess } = makeEnforcer(makeConfig());

    await enforcer.processLlmCall(llmCall({
      provider: 'openai',
      model: 'gpt-5.5',
      usage: { cache_read_tokens: 4_000_000 },
    }));
    await enforcer.appendSummary('final');

    expect(killProcess).not.toHaveBeenCalled();
    expect(logs.last('budget.summary')).toMatchObject({
      total_tokens: 4_000_000,
      weighted_tokens: 400_000,
      cache_read_tokens: 4_000_000,
      cache_read_token_weight: 0.1,
      cache_read_tokens_excluded: 3_600_000,
    });
  });

  it('uses per-entry weights while reporting null for mixed cache-read weights', () => {
    const breakdown = calculateBudgetTokenBreakdown(DEFAULT_RATE_CARD_V1, [
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        source: 'byok',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 1_000_000,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
        },
      },
      {
        provider: 'openai',
        model: 'o3',
        source: 'byok',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 1_000_000,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
        },
      },
    ]);

    expect(breakdown).toEqual({
      total_tokens: 2_000_000,
      weighted_tokens: 1_100_000,
      cache_read_tokens: 2_000_000,
      cache_read_token_weight: null,
      cache_read_tokens_excluded: 900_000,
    });
  });

  it('counts cache-write tokens at full budget weight', async () => {
    const { enforcer, logs, killProcess } = makeEnforcer(makeConfig());

    await enforcer.processLlmCall(llmCall({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      usage: { cache_write_tokens: 10_000_000 },
    }));

    expect(killProcess).toHaveBeenCalledOnce();
    expect(logs.last('budget.exceeded')).toMatchObject({
      total_tokens: 10_000_000,
      weighted_tokens: 10_000_000,
      cache_read_tokens: 0,
      cache_read_token_weight: null,
      cache_read_tokens_excluded: 0,
    });
  });

  it('keeps max_cost enforcement unchanged when cost is the lower cap', async () => {
    const { enforcer, logs, killProcess } = makeEnforcer(makeConfig({
      maxTokens: 10_000_000,
      maxCost: { currency: 'usd', amount: 0.01 },
    }));

    await enforcer.processLlmCall(llmCall({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      usage: { input_tokens: 100_000 },
    }));

    expect(killProcess).toHaveBeenCalledOnce();
    expect(enforcer.exceededError).toContain('BUDGET_EXCEEDED: max_cost exceeded');
    expect(logs.last('budget.exceeded')).toMatchObject({
      reason: 'max_cost exceeded',
      total_tokens: 100_000,
      weighted_tokens: 100_000,
    });
  });

  it('includes the new token fields on budget.exceeded logs', async () => {
    const { enforcer, logs } = makeEnforcer(makeConfig({ maxTokens: 100_000 }));

    await enforcer.processLlmCall(llmCall({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      usage: { input_tokens: 200_000, cache_read_tokens: 100_000 },
    }));

    const exceeded = logs.last('budget.exceeded');
    expect(exceeded).toHaveProperty('total_tokens');
    expect(exceeded).toHaveProperty('weighted_tokens');
    expect(exceeded).toHaveProperty('cache_read_tokens');
    expect(exceeded).toHaveProperty('cache_read_token_weight');
    expect(exceeded).toHaveProperty('cache_read_tokens_excluded');
  });

  it('includes the new token fields on final budget.summary logs', async () => {
    const { enforcer, logs } = makeEnforcer(makeConfig());

    await enforcer.processLlmCall(llmCall({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      usage: { input_tokens: 10_000, cache_read_tokens: 50_000 },
    }));
    await enforcer.appendSummary('final');

    const summary = logs.last('budget.summary');
    expect(summary).toHaveProperty('total_tokens');
    expect(summary).toHaveProperty('weighted_tokens');
    expect(summary).toHaveProperty('cache_read_tokens');
    expect(summary).toHaveProperty('cache_read_token_weight');
    expect(summary).toHaveProperty('cache_read_tokens_excluded');
  });

  it('emits a zero-token summary when no llm.call usage was observed', async () => {
    const { enforcer, logs, killProcess } = makeEnforcer(makeConfig());

    await enforcer.appendSummary('final');

    expect(killProcess).not.toHaveBeenCalled();
    expect(logs.last('budget.summary')).toMatchObject({
      total_tokens: 0,
      weighted_tokens: 0,
      cache_read_tokens: 0,
      cache_read_token_weight: null,
      cache_read_tokens_excluded: 0,
    });
  });

  it('counts cache-read tokens at full weight when the provider is missing from the rate card', async () => {
    const { enforcer, logs, killProcess } = makeEnforcer(makeConfig({ maxTokens: 1_000_000 }));

    await enforcer.processLlmCall(llmCall({
      provider: 'mystery',
      model: 'anon',
      usage: { cache_read_tokens: 4_000_000 },
    }));

    expect(killProcess).toHaveBeenCalledOnce();
    expect(logs.last('budget.exceeded')).toMatchObject({
      total_tokens: 4_000_000,
      weighted_tokens: 4_000_000,
      cache_read_tokens: 4_000_000,
      cache_read_token_weight: null,
      cache_read_tokens_excluded: 0,
    });
  });
});
