import type { HarnessAdapter } from './types.js';
import { mapReasoningForMode } from './reasoning.js';

export const piAdapter: HarnessAdapter = {
  name: 'pi',
  description: 'pi coding agent — multi-provider, extensible.',
  reasoningMode: 'effort',
  capabilities: {
    supports_model: true,
    model_notes: 'Use provider/model format (e.g., anthropic/claude-sonnet-4).',
    model_examples: [
      'anthropic/claude-opus-4-7',
      'anthropic/claude-sonnet-4',
      'openai/gpt-5.5',
      'openai/gpt-4o',
      'google/gemini-2.5-pro',
    ],
    reasoning: {
      supported: true,
      levels: ['low', 'medium', 'high', 'x-high'],
      mode: 'level',
      notes: 'pi maps x-high to xhigh internally.',
    },
  },
  buildOptions: async (ctx) => {
    const env: Record<string, string | undefined> = {};

    // Forward any provider-specific API keys from resolved secrets
    const providerKeys = [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'Z_AI_API_KEY',
      'ZAI_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'MISTRAL_API_KEY',
      'XAI_API_KEY',
      'GROQ_API_KEY',
      'OPENROUTER_API_KEY',
    ];
    for (const key of providerKeys) {
      if (ctx.env[key]) env[key] = ctx.env[key];
    }

    // Phase 2: managed model routing via models.json
    if (ctx.env.PI_MODELS_JSON_B64) {
      env.PI_MODELS_JSON_B64 = ctx.env.PI_MODELS_JSON_B64;
    }

    return {
      harness: ctx.harness,
      permission: ctx.permission,
      variant: ctx.invocation.harness_options?.variant ?? ctx.invocation.variant,
      model: ctx.invocation.harness_options?.model,
      reasoning: mapReasoningForMode('effort', ctx.invocation.harness_options?.reasoning_effort),
      env,
    };
  },
};
