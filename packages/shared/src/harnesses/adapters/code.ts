import { resolveCodeConfigDir } from '../config.js';
import type { HarnessAdapter } from './types.js';
import { mapReasoningEffort } from './reasoning.js';

export const codeAdapter: HarnessAdapter = {
  name: 'code',
  aliases: ['coder'],
  buildOptions: async (ctx) => {
    const variant = ctx.invocation.harness_options?.variant ?? ctx.invocation.variant;
    const model = ctx.invocation.harness_options?.model;
    const reasoning = mapReasoningEffort(
      ctx.harness,
      ctx.invocation.harness_options?.reasoning_effort,
    );
    const configDir = resolveCodeConfigDir('code', variant, {
      repoPath: ctx.repoPath,
      env: ctx.env,
    });
    const auth = await ctx.helpers.resolveCodeAuth({ configDir });
    return {
      harness: ctx.harness,
      permission: ctx.permission,
      variant,
      model,
      reasoning,
      env: {
        ...auth.env,
        CODEX_HOME: configDir,
      },
    };
  },
};
