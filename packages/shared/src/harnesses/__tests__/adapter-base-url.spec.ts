import { describe, expect, it } from 'vitest';
import type { HarnessInvocation } from '../../types/harness.js';
import { claudeAdapter, mclaudeAdapter } from '../adapters/claude.js';
import { zaiAdapter } from '../adapters/zai.js';
import type { HarnessContext } from '../adapters/types.js';

function buildContext(params: {
  harness: HarnessContext['harness'];
  env?: Record<string, string | undefined>;
}): HarnessContext {
  const invocation: HarnessInvocation = {
    attemptId: 'proj_test:1:1',
    jobId: 'proj_test:1',
    projectId: 'proj_test',
    text: 'test',
    workspacePath: '/tmp/workspace',
    harness_options: {},
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

describe('Claude-family adapter base URL passthrough', () => {
  it('mclaude passes through ANTHROPIC_BASE_URL', async () => {
    const options = await mclaudeAdapter.buildOptions(
      buildContext({
        harness: 'mclaude',
        env: { ANTHROPIC_BASE_URL: 'http://bridge.local/v1' },
      }),
    );
    expect(options.env?.ANTHROPIC_BASE_URL).toBe('http://bridge.local/v1');
  });

  it('claude passes through ANTHROPIC_BASE_URL', async () => {
    const options = await claudeAdapter.buildOptions(
      buildContext({
        harness: 'claude',
        env: { ANTHROPIC_BASE_URL: 'http://bridge.local/v1' },
      }),
    );
    expect(options.env?.ANTHROPIC_BASE_URL).toBe('http://bridge.local/v1');
  });

  it('zai prefers ANTHROPIC_BASE_URL over Z_AI_BASE_URL', async () => {
    const options = await zaiAdapter.buildOptions(
      buildContext({
        harness: 'zai',
        env: {
          Z_AI_API_KEY: 'zai-key',
          ANTHROPIC_BASE_URL: 'http://anthropic-bridge.local/v1',
          Z_AI_BASE_URL: 'http://zai.local/v4',
        },
      }),
    );
    expect(options.env?.ANTHROPIC_BASE_URL).toBe('http://anthropic-bridge.local/v1');
    expect(options.env?.Z_AI_BASE_URL).toBe('http://zai.local/v4');
  });

  it('zai falls back to Z_AI_BASE_URL when ANTHROPIC_BASE_URL is absent', async () => {
    const options = await zaiAdapter.buildOptions(
      buildContext({
        harness: 'zai',
        env: {
          Z_AI_API_KEY: 'zai-key',
          Z_AI_BASE_URL: 'http://zai.local/v4',
        },
      }),
    );
    expect(options.env?.ANTHROPIC_BASE_URL).toBe('http://zai.local/v4');
  });
});
