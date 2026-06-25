import { normalizeClaudeCodeModelAlias, resolveClaudeConfigDir } from '@eve/shared';
import type { CliHarnessAdapter, CliContext } from './types';

const CLAUDE_ARGS = ['--print', '--verbose', '--output-format', 'stream-json'];

function buildClaudeDirectCommand(
  ctx: CliContext,
): { command: { binary: string; args: string[]; env: Record<string, string | undefined> }; warnings: string[] } {
  const env = { ...ctx.env };
  env.CLAUDE_CONFIG_DIR = resolveClaudeConfigDir('claude', ctx.variant, {
    repoPath: ctx.workspace,
    env,
  });

  const args = [...CLAUDE_ARGS];

  // Sandbox: explicitly restrict tool access to workspace directory only
  // This prevents directory traversal attacks when multiple jobs share a worker
  args.push('--add-dir', ctx.workspace);

  const model = normalizeClaudeCodeModelAlias(ctx.model);
  if (model) {
    args.push('--model', model);
  }

  if (ctx.reasoning) {
    env.MAX_THINKING_TOKENS = ctx.reasoning;
  }

  if (ctx.permission === 'default') {
    args.push('--permission-mode', 'default');
  } else if (ctx.permission === 'auto_edit') {
    args.push('--permission-mode', 'acceptEdits');
  } else if (ctx.permission === 'never') {
    args.push('--permission-mode', 'dontAsk');
  } else if (ctx.permission === 'yolo') {
    args.push('--dangerously-skip-permissions');
  }

  args.push(ctx.prompt);

  return {
    command: {
      binary: 'claude',
      args,
      env,
    },
    warnings: [],
  };
}

export const claudeAdapter: CliHarnessAdapter = {
  name: 'claude',
  buildCommand: buildClaudeDirectCommand,
};
