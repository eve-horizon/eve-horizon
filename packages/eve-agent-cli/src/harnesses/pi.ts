import type { CliHarnessAdapter, CliContext, HarnessCommand } from './types.js';

export function buildPiCommand(ctx: CliContext): { command: HarnessCommand; warnings: string[] } {
  const warnings: string[] = [];
  const args: string[] = [];
  const env: Record<string, string | undefined> = { ...ctx.env };

  // Non-interactive JSON streaming mode (no session persistence)
  args.push('--mode', 'json');
  args.push('--no-session');

  // Disable extension/skill/theme auto-discovery in containerized env
  args.push('--no-extensions', '--no-themes', '--no-prompt-templates');

  // Model selection — pi uses provider/model prefix: --model openai/gpt-4o
  if (ctx.model) {
    args.push('--model', ctx.model);
  }

  // Thinking/reasoning level (already mapped by shared adapter)
  if (ctx.reasoning) {
    args.push('--thinking', ctx.reasoning);
  }

  // Tool selection — pi defaults to read,bash,edit,write
  args.push('--tools', 'read,bash,edit,write,grep,find,ls');

  // Permission policy — pi runs autonomously (no built-in gates)
  if (ctx.permission !== 'yolo' && ctx.permission !== 'never') {
    warnings.push('pi has no built-in permission gates; running autonomously');
  }

  // Prompt is the last positional argument
  args.push(ctx.prompt);

  return {
    command: {
      binary: 'pi',
      args,
      env,
    },
    warnings,
  };
}

export const piCliAdapter: CliHarnessAdapter = {
  name: 'pi',
  buildCommand: buildPiCommand,
};
