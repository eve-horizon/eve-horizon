import type { HarnessAdapter } from './types.js';
import { mapReasoningEffort } from './reasoning.js';

export const piAdapter: HarnessAdapter = {
  name: 'pi',
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
      reasoning: mapReasoningEffort(ctx.harness, ctx.invocation.harness_options?.reasoning_effort),
      env,
    };
  },
};
