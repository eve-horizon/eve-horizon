import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareClaudeRuntimeConfig } from '@eve/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCliAdapter } from '../src/harnesses/index';
import type { CliContext, HarnessName } from '../src/harnesses/types';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-cli-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function context(harness: HarnessName, workspace: string): CliContext {
  return {
    harness,
    prompt: 'Summarize the job',
    permission: 'default',
    variant: 'fast',
    env: {},
    workspace,
  };
}

const build = (ctx: CliContext) => resolveCliAdapter(ctx.harness)!.buildCommand(ctx).command;

describe('runtime config handoff', () => {
  it.each(['claude', 'mclaude'] as const)('%s opens the settings from the prepared variant', async (harness) => {
    const workspace = tempDir();
    const sourceConfigDir = path.join(workspace, '.agent', 'harnesses', harness, 'variants', 'fast');
    const settings = JSON.stringify({ includeCoAuthoredBy: false });
    fs.mkdirSync(sourceConfigDir, { recursive: true });
    fs.writeFileSync(path.join(sourceConfigDir, 'settings.json'), settings);
    const prepared = await prepareClaudeRuntimeConfig(workspace, sourceConfigDir, tempDir(), 'attempt', harness, 'fast');

    const command = build({
      ...context(harness, workspace),
      configDirResolved: true,
      env: { CLAUDE_CONFIG_DIR: prepared.configDir },
    });

    expect(command.env.CLAUDE_CONFIG_DIR).toBe(prepared.configDir);
    expect(fs.readFileSync(path.join(command.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8')).toBe(settings);
  });

  it('keeps the resolved Codex home and passes the selected profile', () => {
    const configDir = tempDir();
    const command = build({
      ...context('codex', tempDir()),
      configDirResolved: true,
      env: { CODEX_HOME: configDir },
    });

    expect(command.env.CODEX_HOME).toBe(configDir);
    expect(command.args.slice(command.args.indexOf('--profile'), command.args.indexOf('--profile') + 2))
      .toEqual(['--profile', 'fast']);
  });

  it.each([
    ['claude', 'CLAUDE_CONFIG_DIR'],
    ['codex', 'CODEX_HOME'],
  ] as const)('%s resolves a variant under an override in standalone use', (harness, configKey) => {
    const configDir = tempDir();
    const command = build({
      ...context(harness, tempDir()),
      env: { [configKey]: configDir },
    });

    expect(command.env[configKey]).toBe(path.join(configDir, 'variants', 'fast'));
  });
});
