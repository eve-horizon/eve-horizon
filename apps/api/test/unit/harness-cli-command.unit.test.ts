import { describe, expect, it } from 'vitest';

import { claudeAdapter } from '../../../../packages/eve-agent-cli/src/harnesses/claude-direct';
import { buildClaudeCommand } from '../../../../packages/eve-agent-cli/src/harnesses/claude';
import { buildCodeCommand } from '../../../../packages/eve-agent-cli/src/harnesses/code';

const envBase = { PATH: '/usr/bin' } as Record<string, string | undefined>;

describe('harness CLI command construction', () => {
  it('passes Codex reasoning with the installed Codex CLI config override', () => {
    const { command } = buildCodeCommand({
      harness: 'codex',
      prompt: 'hello',
      permission: 'auto_edit',
      workspace: '/workspace',
      env: { ...envBase, OPENAI_API_KEY: 'sk-test' },
      model: 'gpt-5.5',
      reasoning: 'low',
    });

    expect(command.binary).toBe('codex');
    expect(command.args).toContain('-c');
    expect(command.args).toContain('model_reasoning_effort="low"');
    expect(command.args).not.toContain('--reasoning');
    expect(command.args).not.toContain('--reasoning-effort');
  });

  it('normalizes Claude Opus 4.7 model aliases and passes thinking tokens', () => {
    const { command } = claudeAdapter.buildCommand({
      harness: 'claude',
      prompt: 'hello',
      permission: 'yolo',
      workspace: '/workspace',
      env: { ...envBase },
      model: 'opus4.7',
      reasoning: '32000',
    });

    expect(command.binary).toBe('claude');
    expect(command.args).toContain('--model');
    expect(command.args).toContain('opus');
    expect(command.args).not.toContain('opus4.7');
    expect(command.env.MAX_THINKING_TOKENS).toBe('32000');
  });

  it('normalizes Opus aliases for cc-mirror Claude but not Z.ai', () => {
    const mclaude = buildClaudeCommand({
      harness: 'mclaude',
      prompt: 'hello',
      permission: 'yolo',
      workspace: '/workspace',
      env: { ...envBase },
      model: 'claude-opus-4-7',
      reasoning: '16000',
    });
    const zai = buildClaudeCommand({
      harness: 'zai',
      prompt: 'hello',
      permission: 'yolo',
      workspace: '/workspace',
      env: { ...envBase },
      model: 'claude-opus-4-7',
    });

    expect(mclaude.command.args).toContain('opus');
    expect(mclaude.command.args).not.toContain('claude-opus-4-7');
    expect(mclaude.command.env.MAX_THINKING_TOKENS).toBe('16000');
    expect(zai.command.args).toContain('claude-opus-4-7');
  });
});
