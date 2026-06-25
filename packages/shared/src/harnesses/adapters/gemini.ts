import type { HarnessAdapter } from './types.js';
import { mapReasoningEffort } from './reasoning.js';

export const geminiAdapter: HarnessAdapter = {
  name: 'gemini',
  buildOptions: async (ctx) => ({
    harness: ctx.harness,
    permission: ctx.permission,
    variant: ctx.invocation.harness_options?.variant ?? ctx.invocation.variant,
    model: ctx.invocation.harness_options?.model,
    reasoning: mapReasoningEffort(
      ctx.harness,
      ctx.invocation.harness_options?.reasoning_effort,
    ),
  }),
};
