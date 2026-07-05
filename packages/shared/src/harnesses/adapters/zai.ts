import { resolveClaudeConfigDir } from '../config.js';
import type { HarnessAdapter } from './types.js';
import { mapReasoningForMode } from './reasoning.js';

export const zaiAdapter: HarnessAdapter = {
  name: 'zai',
  description: 'Z.ai via cc-mirror.',
  reasoningMode: 'thinking_tokens',
  capabilities: {
    supports_model: true,
    model_notes: 'Model override supported via ZAI_MODEL or --model.',
    model_examples: ['glm-5', 'glm-5-code', 'glm-4.7'],
    reasoning: {
      supported: true,
      levels: ['low', 'medium', 'high', 'x-high'],
      mode: 'thinking_tokens',
      notes: 'Reasoning effort maps to thinking-token budget in adapter.',
    },
  },
  buildOptions: async (ctx) => {
    const apiKey = ctx.env.Z_AI_API_KEY ?? ctx.env.ZAI_API_KEY;
    if (!apiKey) {
      throw new Error('Zai harness requires Z_AI_API_KEY environment variable');
    }
    const model =
      ctx.invocation.harness_options?.model ??
      (ctx.env.ZAI_MODEL || ctx.env.CLAUDE_MODEL);
    const variant = ctx.invocation.harness_options?.variant ?? ctx.invocation.variant;
    const reasoning = mapReasoningForMode(
      'thinking_tokens',
      ctx.invocation.harness_options?.reasoning_effort,
    );
    const configDir = resolveClaudeConfigDir('zai', variant, {
      repoPath: ctx.repoPath,
      env: ctx.env,
    });
    return {
      harness: ctx.harness,
      permission: ctx.permission,
      variant,
      model,
      reasoning,
      env: {
        Z_AI_API_KEY: apiKey,
        Z_AI_BASE_URL: ctx.env.Z_AI_BASE_URL,
        ANTHROPIC_BASE_URL: ctx.env.ANTHROPIC_BASE_URL ?? ctx.env.Z_AI_BASE_URL,
        // Claude Code reads ANTHROPIC_API_KEY - use Z_AI_API_KEY for zai provider
        ANTHROPIC_API_KEY: apiKey,
        CLAUDE_CONFIG_DIR: configDir,
      },
    };
  },
};
