import * as fs from 'node:fs';
import * as path from 'node:path';
import { CHECKOUT_SETTINGS_ENV, checkoutSettingsRefusal, resolveCodeConfigDir, strictCodexArgs } from '@eve/shared';
import type { CliHarnessAdapter, CliContext, HarnessCommand } from './types';

export function buildCodeCommand(
  ctx: CliContext,
): { command: HarnessCommand; warnings: string[] } {
  const env = { ...ctx.env };
  const warnings: string[] = [];
  const strictCheckoutSettings = env[CHECKOUT_SETTINGS_ENV] === 'strict';
  if (strictCheckoutSettings && ctx.harness !== 'codex') {
    throw new Error(checkoutSettingsRefusal(`${ctx.harness} has no confirmed way to keep checkout settings from rerouting it`));
  }
  const configDir = ctx.configDirResolved && env.CODEX_HOME
    ? env.CODEX_HOME
    : resolveCodeConfigDir(
      ctx.harness === 'codex' ? 'codex' : 'code',
      ctx.variant,
      { repoPath: ctx.workspace, env },
    );
  env.CODEX_HOME = configDir;

  // Diagnostic: log auth state for debugging
  const authJsonPath = path.join(configDir, 'auth.json');
  const hasAuthJson = fs.existsSync(authJsonPath);
  const hasApiKeyEnv = !!env.OPENAI_API_KEY;
  process.stderr.write(
    `[codex-cli] CODEX_HOME=${configDir} auth.json=${hasAuthJson} OPENAI_API_KEY_env=${hasApiKeyEnv}\n`,
  );
  if (hasAuthJson) {
    try {
      const data = JSON.parse(fs.readFileSync(authJsonPath, 'utf-8'));
      const hasAccess = !!data.tokens?.access_token;
      const hasRefresh = !!data.tokens?.refresh_token;
      process.stderr.write(
        `[codex-cli] auth.json: access_token=${hasAccess} refresh_token=${hasRefresh} last_refresh=${data.last_refresh ?? 'missing'}\n`,
      );
    } catch {
      process.stderr.write(`[codex-cli] auth.json exists but failed to parse\n`);
    }
  } else if (!hasApiKeyEnv) {
    warnings.push('[codex-cli] WARNING: No auth.json at CODEX_HOME and no OPENAI_API_KEY env var — codex will likely fail with 401');
  }

  const args: string[] = [];

  args.push('-C', ctx.workspace);

  // Sandbox & approval policy — choose the most secure option that works for the auth method.
  // With OPENAI_API_KEY env var, codex reads auth from the environment so Landlock sandbox
  // can stay active. With file-based auth (auth.json), Landlock blocks reads in containers
  // (Docker/k3d/k3s), so we must bypass it entirely.
  if (ctx.harness === 'codex' && hasAuthJson && !hasApiKeyEnv) {
    process.stderr.write('[codex-cli] sandbox: bypass (file-based auth requires filesystem access)\n');
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    process.stderr.write(`[codex-cli] sandbox: workspace-write (${hasApiKeyEnv ? 'API key in env' : 'no file-based auth'})\n`);
    args.push('--sandbox', 'workspace-write');
    if (ctx.permission === 'default') {
      args.push('--ask-for-approval', 'on-request');
    } else if (ctx.permission === 'auto_edit') {
      args.push('--ask-for-approval', 'on-failure');
    } else if (ctx.permission === 'never' || ctx.permission === 'yolo') {
      args.push('--ask-for-approval', 'never');
    }
  }

  if (ctx.model) {
    args.push('--model', ctx.model);
  }

  if (ctx.reasoning) {
    if (ctx.harness === 'codex') {
      args.push('-c', `model_reasoning_effort="${ctx.reasoning}"`);
    } else {
      args.push('--reasoning', ctx.reasoning);
    }
  }

  // Rule harness.checkout_settings under strict: pin the built-in provider
  // over any a checkout config (project or config home) chooses.
  if (strictCheckoutSettings) {
    args.push(...strictCodexArgs(ctx.workspace, configDir, ctx.variant));
  }

  if (ctx.variant) {
    args.push('--profile', ctx.variant);
  }

  args.push('exec', '--json', '--skip-git-repo-check');
  // `-` makes `exec` read its instructions from stdin.
  args.push('-');

  // @just-every/code installs as 'coder' binary, not 'code'
  const binary = ctx.harness === 'code' || ctx.harness === 'coder' ? 'coder' : ctx.harness;

  return {
    command: { binary, args, env, stdin: ctx.prompt },
    warnings,
  };
}

export const codeAdapter: CliHarnessAdapter = {
  name: 'code',
  // buildCodeCommand branches on ctx.harness for codex-specific behavior
  // (config dir, sandbox/auth handling, model_reasoning_effort, binary).
  names: ['codex'],
  aliases: ['coder'],
  buildCommand: buildCodeCommand,
};
