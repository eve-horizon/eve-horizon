import { normalizeClaudeCodeModelAlias, resolveClaudeConfigDir } from '@eve/shared';
import type { CliHarnessAdapter, CliContext, HarnessCommand } from './types';

const CLAUDE_ARGS = ['--print', '--verbose', '--output-format', 'stream-json'];

type ClaudeFamilyOptions = {
  /** Config-dir namespace under .agent/harnesses/<name> and the binary to invoke. */
  name: 'claude' | 'mclaude' | 'zai';
  /**
   * The direct `claude` binary supports interactive '--permission-mode default'.
   * The cc-mirror wrappers (mclaude/zai) run streaming/headless where 'default'
   * cannot prompt, so it falls back to '--dangerously-skip-permissions' (yolo);
   * the sandbox provides security, not permission prompts.
   */
  defaultPermissionToYolo: boolean;
};

function buildClaudeFamilyCommand(
  ctx: CliContext,
  opts: ClaudeFamilyOptions,
): { command: HarnessCommand; warnings: string[] } {
  const env = { ...ctx.env };
  env.CLAUDE_CONFIG_DIR = resolveClaudeConfigDir(opts.name, ctx.variant, {
    repoPath: ctx.workspace,
    env,
  });

  const args = [...CLAUDE_ARGS];

  // Sandbox: explicitly restrict tool access to workspace directory only
  // This prevents directory traversal attacks when multiple jobs share a worker
  args.push('--add-dir', ctx.workspace);

  // zai models (glm-*) must not go through the Claude Code alias normalizer
  const model = opts.name === 'zai' ? ctx.model : normalizeClaudeCodeModelAlias(ctx.model);
  if (model) {
    args.push('--model', model);
  }

  if (ctx.reasoning) {
    env.MAX_THINKING_TOKENS = ctx.reasoning;
  }

  if (ctx.permission === 'auto_edit') {
    args.push('--permission-mode', 'acceptEdits');
  } else if (ctx.permission === 'never') {
    args.push('--permission-mode', 'dontAsk');
  } else if (ctx.permission === 'default' && !opts.defaultPermissionToYolo) {
    args.push('--permission-mode', 'default');
  } else {
    // 'yolo', or 'default' where interactive prompts don't work
    args.push('--dangerously-skip-permissions');
  }

  args.push(ctx.prompt);

  return {
    command: {
      binary: opts.name,
      args,
      env,
    },
    warnings: [],
  };
}

function createClaudeFamilyAdapter(opts: ClaudeFamilyOptions): CliHarnessAdapter {
  return {
    name: opts.name,
    buildCommand: (ctx) => buildClaudeFamilyCommand(ctx, opts),
  };
}

export const claudeAdapter = createClaudeFamilyAdapter({
  name: 'claude',
  defaultPermissionToYolo: false,
});

export const mclaudeAdapter = createClaudeFamilyAdapter({
  name: 'mclaude',
  defaultPermissionToYolo: true,
});

export const zaiAdapter = createClaudeFamilyAdapter({
  name: 'zai',
  defaultPermissionToYolo: true,
});
