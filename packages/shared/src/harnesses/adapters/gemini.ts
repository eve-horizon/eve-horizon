import type { HarnessAdapter } from './types.js';
import { mapReasoningForMode } from './reasoning.js';

export const geminiAdapter: HarnessAdapter = {
  name: 'gemini',
  description: 'Gemini CLI harness.',
  reasoningMode: 'passthrough',
  capabilities: {
    supports_model: true,
    model_notes: 'Gemini CLI supports --model; thinking settings vary by model family.',
    model_examples: ['gemini-3', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    reasoning: {
      supported: true,
      levels: ['low', 'medium', 'high', 'x-high'],
      mode: 'level',
      notes: 'Gemini 2.5 uses thinkingBudget tokens; Gemini 3 uses thinkingLevel enums.',
    },
  },
  buildOptions: async (ctx) => ({
    harness: ctx.harness,
    permission: ctx.permission,
    variant: ctx.invocation.harness_options?.variant ?? ctx.invocation.variant,
    model: ctx.invocation.harness_options?.model,
    reasoning: mapReasoningForMode(
      'passthrough',
      ctx.invocation.harness_options?.reasoning_effort,
    ),
  }),
};
