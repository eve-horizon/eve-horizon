import { normalizeClaudeCodeModelAlias, resolveClaudeConfigDir } from '@eve/shared';
import type { CliContext } from './types';

const CLAUDE_ARGS = ['--print', '--verbose', '--output-format', 'stream-json'];

export function buildClaudeCommand(
  ctx: CliContext,
): { command: { binary: string; args: string[]; env: Record<string, string | undefined> }; warnings: string[] } {
  const env = { ...ctx.env };
  const configDir = resolveClaudeConfigDir(
    ctx.harness === 'zai' ? 'zai' : 'mclaude',
    ctx.variant,
    { repoPath: ctx.workspace, env },
  );
  env.CLAUDE_CONFIG_DIR = configDir;

  const args = [...CLAUDE_ARGS];

  // Sandbox: explicitly restrict tool access to workspace directory only
  // This prevents directory traversal attacks when multiple jobs share a worker
  args.push('--add-dir', ctx.workspace);

  const model = ctx.harness === 'zai' ? ctx.model : normalizeClaudeCodeModelAlias(ctx.model);
  if (model) {
    args.push('--model', model);
  }

  if (ctx.reasoning) {
    env.MAX_THINKING_TOKENS = ctx.reasoning;
  }

  // Permission modes for streaming/headless execution
  // Note: 'default' mode requires interactive prompts which don't work in streaming mode,
  // so we treat it as 'yolo' (the sandbox provides security, not permission prompts)
  if (ctx.permission === 'auto_edit') {
    args.push('--permission-mode', 'acceptEdits');
  } else if (ctx.permission === 'never') {
    args.push('--permission-mode', 'dontAsk');
  } else {
    // 'yolo' or 'default' (default doesn't work in streaming mode)
    args.push('--dangerously-skip-permissions');
  }

  args.push(ctx.prompt);

  return {
    command: {
      binary: ctx.harness,
      args,
      env,
    },
    warnings: [],
  };
}
