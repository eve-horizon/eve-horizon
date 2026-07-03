import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempRoot: string | null = null;
let previousRoot: string | undefined;

beforeEach(() => {
  previousRoot = process.env.EVE_HARNESS_CONFIG_ROOT;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-harness-'));
  process.env.EVE_HARNESS_CONFIG_ROOT = tempRoot;

  fs.mkdirSync(path.join(tempRoot, 'code', 'variants', 'fast'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'mclaude', 'variants', 'plan'), { recursive: true });
});

afterEach(() => {
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  if (previousRoot === undefined) {
    delete process.env.EVE_HARNESS_CONFIG_ROOT;
  } else {
    process.env.EVE_HARNESS_CONFIG_ROOT = previousRoot;
  }
});

describe('harness variants from config root', () => {
  it('lists variants from EVE_HARNESS_CONFIG_ROOT', async () => {
    const shared = await import('@eve/shared');
    const { listHarnessConfigVariants } = await import('@eve/shared/dist/harnesses/config.js');
    const { getHarnessInfo, listHarnessVariants } = shared;
    const env = { ...process.env, EVE_HARNESS_CONFIG_ROOT: tempRoot ?? '' };

    const codeHarness = getHarnessInfo('code');
    expect(codeHarness).toBeTruthy();
    const codeVariants = listHarnessVariants(codeHarness!, { env });
    const codeVariantNames = listHarnessConfigVariants({
      harness: 'code',
      env,
    });
    expect(codeVariants.map((v) => v.name)).toEqual(['default', 'fast']);
    expect(codeVariantNames).toEqual(['fast']);

    const mclaudeHarness = getHarnessInfo('mclaude');
    expect(mclaudeHarness).toBeTruthy();
    const mclaudeVariants = listHarnessVariants(mclaudeHarness!, { env });
    const mclaudeVariantNames = listHarnessConfigVariants({
      harness: 'mclaude',
      env,
    });
    expect(mclaudeVariants.map((v) => v.name)).toEqual(['default', 'plan']);
    expect(mclaudeVariantNames).toEqual(['plan']);
    // 30s: this test cold-imports the large @eve/shared barrel twice; under full-suite
    // parallel load the first dynamic import can exceed the 5s default per-test timeout.
  }, 30000);
});
