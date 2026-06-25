import type { BillingDefaultsV1, RateCardV1 } from './types.js';

export const DEFAULT_RATE_CARD_NAME = 'default';
export const DEFAULT_RATE_CARD_VERSION = 1;
export const DEFAULT_RATE_CARD_EFFECTIVE_AT = '2026-04-29T00:00:00.000Z';

export const DEFAULT_BILLING_DEFAULTS_V1: BillingDefaultsV1 = {
  billing_currency: 'usd',
  markup_pct: 20,
  rate_card_name: DEFAULT_RATE_CARD_NAME,
};

export const DEFAULT_RATE_CARD_V1: RateCardV1 = {
  llm: {
    byok: {
      anthropic: {
        'claude-opus-4-7': {
          input_per_million_usd: '5.00',
          output_per_million_usd: '25.00',
          cache_read_per_million_usd: '0.50',
          cache_write_per_million_usd: '6.25',
          reasoning_per_million_usd: null,
        },
        'claude-opus-4-6': {
          input_per_million_usd: '5.00',
          output_per_million_usd: '25.00',
          cache_read_per_million_usd: '0.50',
          cache_write_per_million_usd: '6.25',
          reasoning_per_million_usd: null,
        },
        'claude-sonnet-4-6': {
          input_per_million_usd: '3.00',
          output_per_million_usd: '15.00',
          cache_read_per_million_usd: '0.30',
          cache_write_per_million_usd: '3.75',
          reasoning_per_million_usd: null,
        },
        'claude-opus-4-5': {
          input_per_million_usd: '5.00',
          output_per_million_usd: '25.00',
          cache_read_per_million_usd: '0.50',
          cache_write_per_million_usd: '6.25',
          reasoning_per_million_usd: null,
        },
        'claude-sonnet-4-5': {
          input_per_million_usd: '3.00',
          output_per_million_usd: '15.00',
          cache_read_per_million_usd: '0.30',
          cache_write_per_million_usd: '3.75',
          reasoning_per_million_usd: null,
        },
        'claude-haiku-4-5': {
          input_per_million_usd: '1.00',
          output_per_million_usd: '5.00',
          cache_read_per_million_usd: '0.10',
          cache_write_per_million_usd: '1.25',
          reasoning_per_million_usd: null,
        },
        'claude-sonnet-4': {
          input_per_million_usd: '3.00',
          output_per_million_usd: '15.00',
          cache_read_per_million_usd: '0.30',
          cache_write_per_million_usd: '3.75',
          reasoning_per_million_usd: null,
        },
      },
      zai: {
        'glm-5': {
          input_per_million_usd: '1.00',
          output_per_million_usd: '3.20',
          cache_read_per_million_usd: '0.20',
          cache_write_per_million_usd: null,
          reasoning_per_million_usd: null,
        },
        'glm-5-code': {
          input_per_million_usd: '1.20',
          output_per_million_usd: '5.00',
          cache_read_per_million_usd: '0.30',
          cache_write_per_million_usd: null,
          reasoning_per_million_usd: null,
        },
      },
      openai: {
        'gpt-5.5': {
          input_per_million_usd: '5.00',
          output_per_million_usd: '30.00',
          cache_read_per_million_usd: '0.50',
          cache_write_per_million_usd: null,
          reasoning_per_million_usd: '30.00',
        },
        o3: {
          input_per_million_usd: '2.00',
          output_per_million_usd: '8.00',
          cache_read_per_million_usd: null,
          cache_write_per_million_usd: null,
          reasoning_per_million_usd: '8.00',
        },
      },
    },
    managed: {
      platform: {
        'llama-3.3-70b': {
          input_per_million_usd: '0.40',
          output_per_million_usd: '0.40',
          cache_read_per_million_usd: null,
          cache_write_per_million_usd: null,
          reasoning_per_million_usd: null,
        },
        'deepseek-r1': {
          input_per_million_usd: '0.55',
          output_per_million_usd: '2.19',
          cache_read_per_million_usd: '0.14',
          cache_write_per_million_usd: null,
          reasoning_per_million_usd: '2.19',
        },
      },
    },
  },
  compute: {
    'job.c1': { vcpu_hour_usd: '0.04', memory_gib_hour_usd: '0.01' },
    'job.c2': { vcpu_hour_usd: '0.06', memory_gib_hour_usd: '0.015' },
    default: { vcpu_hour_usd: '0.05', memory_gib_hour_usd: '0.012' },
  },
  storage: {
    'disk.std': { gb_hour_usd: '0.0005' },
  },
};

