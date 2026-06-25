import { describe, expect, it } from 'vitest';
import type { HarnessInvocation } from '../../types/harness.js';
import { claudeAdapter } from '../adapters/claude.js';
import { mclaudeAdapter } from '../adapters/mclaude.js';
import type { HarnessContext } from '../adapters/types.js';
import { normalizeClaudeCodeModelAlias } from '../model-aliases.js';

function buildContext(params: {
  harness: HarnessContext['harness'];
  model?: string;
  env?: Record<string, string | undefined>;
}): HarnessContext {
  const invocation: HarnessInvocation = {
    attemptId: 'proj_test:1:1',
    jobId: 'proj_test:1',
    projectId: 'proj_test',
    text: 'test',
    workspacePath: '/tmp/workspace',
    harness_options: params.model ? { model: params.model } : {},
  };

  return {
    invocation,
    harness: params.harness,
    permission: 'default',
    repoPath: '/tmp/repo',
    env: params.env ?? {},
    helpers: {
      resolveMclaudeAuth: async () => ({
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      }),
      resolveCodeAuth: async () => ({ env: {} }),
    },
  };
}

describe('Claude Code model aliases', () => {
  it('maps Opus 4.7 forms to the Claude Code opus alias', () => {
    expect(normalizeClaudeCodeModelAlias('opus4.7')).toBe('opus');
    expect(normalizeClaudeCodeModelAlias('opus-4-7')).toBe('opus');
    expect(normalizeClaudeCodeModelAlias('claude-opus-4.7')).toBe('opus');
    expect(normalizeClaudeCodeModelAlias('anthropic/claude-opus-4-7')).toBe('opus');
  });

  it('preserves non-Opus model names', () => {
    expect(normalizeClaudeCodeModelAlias('sonnet')).toBe('sonnet');
    expect(normalizeClaudeCodeModelAlias('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('applies aliases in shared Claude adapters', async () => {
    const direct = await claudeAdapter.buildOptions(buildContext({ harness: 'claude', model: 'opus4.7' }));
    const mirror = await mclaudeAdapter.buildOptions(buildContext({ harness: 'mclaude', model: 'claude-opus-4-7' }));

    expect(direct.model).toBe('opus');
    expect(mirror.model).toBe('opus');
  });
});
