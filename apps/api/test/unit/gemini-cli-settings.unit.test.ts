import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

import { geminiAdapter } from '../../../../packages/eve-agent-cli/src/harnesses/gemini';

const envBase = { PATH: '/usr/bin' } as Record<string, string | undefined>;

describe('gemini adapter settings', () => {
  beforeEach(() => {
    vi.mocked(mkdtempSync).mockReturnValue('/tmp/eve-gemini-xyz');
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('{}');
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('writes settings and sets env when reasoning + model are provided', () => {
    const { command, warnings } = geminiAdapter.buildCommand({
      harness: 'gemini',
      prompt: 'hello',
      permission: 'default',
      workspace: '/workspace',
      env: { ...envBase },
      model: 'gemini-3-pro',
      reasoning: 'high',
    });

    expect(warnings.length).toBe(0);
    expect(mkdtempSync).toHaveBeenCalled();
    expect(writeFileSync).toHaveBeenCalled();
    expect(command.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBeDefined();
  });

  it('skips settings when reasoning is set but model missing', () => {
    const { warnings } = geminiAdapter.buildCommand({
      harness: 'gemini',
      prompt: 'hello',
      permission: 'default',
      workspace: '/workspace',
      env: { ...envBase },
      reasoning: 'high',
    });

    expect(warnings.some((w) => w.includes('requires --model'))).toBe(true);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('preserves existing settings overrides while replacing model override', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      modelConfigs: {
        overrides: [
          { match: { model: 'gemini-3-pro' }, modelConfig: { generateContentConfig: { thinkingConfig: { thinkingLevel: 'low' } } } },
          { match: { model: 'gemini-2.5-pro' }, modelConfig: { generateContentConfig: { thinkingConfig: { thinkingBudget: 1024 } } } },
        ],
      },
    }));

    geminiAdapter.buildCommand({
      harness: 'gemini',
      prompt: 'hello',
      permission: 'default',
      workspace: '/workspace',
      env: { ...envBase },
      model: 'gemini-3-pro',
      reasoning: 'high',
    });

    expect(writeFileSync).toHaveBeenCalled();
    const payload = vi.mocked(writeFileSync).mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(payload) as { modelConfigs?: { overrides?: Array<{ match: { model: string } }> } };
    const overrides = parsed.modelConfigs?.overrides ?? [];
    const gemini3 = overrides.filter((o) => o.match.model === 'gemini-3-pro');
    const gemini25 = overrides.filter((o) => o.match.model === 'gemini-2.5-pro');
    expect(gemini3.length).toBe(1);
    expect(gemini25.length).toBe(1);
  });
});
