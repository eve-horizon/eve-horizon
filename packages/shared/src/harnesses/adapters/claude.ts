import { resolveClaudeConfigDir } from '../config.js';
import type { HarnessAdapter } from './types.js';
import { mapReasoningForMode } from './reasoning.js';
import { normalizeClaudeCodeModelAlias } from '../model-aliases.js';

/**
 * Factory for the two Claude Code adapters — identical except for the
 * harness name passed to config-dir resolution and auth.
 */
function createClaudeFamilyAdapter(
  name: 'claude' | 'mclaude',
  description: string,
): HarnessAdapter {
  return {
    name,
    description,
    reasoningMode: 'thinking_tokens',
    capabilities: {
      supports_model: true,
      model_notes: 'Model override supported via CLAUDE_MODEL or --model. Opus 4.7 forms such as opus4.7 and opus-4-7 are normalized to Claude Code\'s opus alias.',
      model_examples: ['opus', 'opus4.7', 'opus-4-7', 'sonnet', 'haiku'],
      reasoning: {
        supported: true,
        levels: ['low', 'medium', 'high', 'x-high'],
        mode: 'thinking_tokens',
        notes: 'Reasoning effort maps to thinking-token budget in adapter.',
      },
    },
    buildOptions: async (ctx) => {
      const model = normalizeClaudeCodeModelAlias(
        ctx.invocation.harness_options?.model ??
        (ctx.env.CLAUDE_MODEL || 'sonnet'),
      );
      const variant = ctx.invocation.harness_options?.variant ?? ctx.invocation.variant;
      const reasoning = mapReasoningForMode(
        'thinking_tokens',
        ctx.invocation.harness_options?.reasoning_effort,
      );
      const configDir = resolveClaudeConfigDir(name, variant, {
        repoPath: ctx.repoPath,
        env: ctx.env,
      });
      const auth = await ctx.helpers.resolveMclaudeAuth({ configDir, harness: name, variant });
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
}

export const mclaudeAdapter = createClaudeFamilyAdapter(
  'mclaude',
  'Claude Code via cc-mirror (Anthropic).',
);

export const claudeAdapter = createClaudeFamilyAdapter(
  'claude',
  'Claude Code CLI (direct).',
);
