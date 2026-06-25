import { resolveClaudeConfigDir } from '../config.js';
import type { HarnessAdapter } from './types.js';
import { mapReasoningEffort } from './reasoning.js';
import { normalizeClaudeCodeModelAlias } from '../model-aliases.js';

export const mclaudeAdapter: HarnessAdapter = {
  name: 'mclaude',
  buildOptions: async (ctx) => {
    const model = normalizeClaudeCodeModelAlias(
      ctx.invocation.harness_options?.model ??
      (ctx.env.CLAUDE_MODEL || 'sonnet'),
    );
    const variant = ctx.invocation.harness_options?.variant ?? ctx.invocation.variant;
    const reasoning = mapReasoningEffort(
      ctx.harness,
      ctx.invocation.harness_options?.reasoning_effort,
    );
    const configDir = resolveClaudeConfigDir('mclaude', variant, {
      repoPath: ctx.repoPath,
      env: ctx.env,
    });
    const auth = await ctx.helpers.resolveMclaudeAuth({ configDir, harness: 'mclaude', variant });
    const effectiveConfigDir = auth.configDir ?? configDir;

    return {
      harness: ctx.harness,
      permission: ctx.permission,
      variant,
      model,
      reasoning,
      env: {
        ...auth.env,
        ANTHROPIC_BASE_URL: ctx.env.ANTHROPIC_BASE_URL,
        CLAUDE_CONFIG_DIR: effectiveConfigDir,
      },
    };
  },
};
