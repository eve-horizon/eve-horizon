import { resolveCodeConfigDir } from '../config.js';
import type { HarnessAdapter, HarnessContext } from './types.js';
import { mapReasoningForMode } from './reasoning.js';

/**
 * Factory for the codex-family adapters (`code` fork and upstream `codex`)
 * — identical except for the harness name passed to config-dir resolution
 * plus registry metadata.
 */
function createCodexFamilyAdapter(params: {
  name: 'code' | 'codex';
  aliases?: HarnessAdapter['aliases'];
  description: string;
  reasoningNotes: string;
}): HarnessAdapter {
  return {
    name: params.name,
    ...(params.aliases ? { aliases: params.aliases } : {}),
    description: params.description,
    reasoningMode: 'effort',
    capabilities: {
      supports_model: true,
      model_notes: 'Model override supported via --model.',
      model_examples: ['gpt-5.5', 'gpt-5.2-codex', 'gpt-4.1'],
      reasoning: {
        supported: true,
        levels: ['low', 'medium', 'high', 'x-high'],
        mode: 'effort',
        notes: params.reasoningNotes,
      },
    },
    buildOptions: async (ctx: HarnessContext) => {
      const variant = ctx.invocation.harness_options?.variant ?? ctx.invocation.variant;
      const model = ctx.invocation.harness_options?.model;
      const reasoning = mapReasoningForMode(
        'effort',
        ctx.invocation.harness_options?.reasoning_effort,
      );
      const configDir = resolveCodeConfigDir(params.name, variant, {
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
}

export const codeAdapter = createCodexFamilyAdapter({
  name: 'code',
  aliases: ['coder'],
  description: 'just-every/code fork of codex.',
  reasoningNotes: 'Mapped directly to Code reasoning effort flag.',
});

export const codexAdapter = createCodexFamilyAdapter({
  name: 'codex',
  description: 'OpenAI Codex CLI harness.',
  reasoningNotes: 'Mapped to Codex model_reasoning_effort config override.',
});
