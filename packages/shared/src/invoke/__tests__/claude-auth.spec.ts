import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { SecretResolveItem } from '../../schemas/secret.js';
import {
  classifyClaudeToken,
  detectClaudeAuthFailure,
  materializeClaudeCredentials,
  prepareClaudeRuntimeConfig,
  redactAuthDecision,
  scrubClaudeAuthEnv,
  selectClaudeAuth,
} from '../claude-auth.js';

function secret(
  key: string,
  value: string,
  scope_type?: SecretResolveItem['scope_type'],
  scope_id?: string,
): SecretResolveItem {
  return {
    key,
    value,
    type: 'env_var',
    scope_type,
    scope_id,
  };
}

describe('Claude auth selection', () => {
  it('classifies setup-tokens, OAuth tokens, and API keys', () => {
    expect(classifyClaudeToken('sk-ant-oat01-token')).toBe('setup-token');
    expect(classifyClaudeToken('sk-ant-api03-token')).toBe('api-key');
    expect(classifyClaudeToken('sk-ant-short-token')).toBe('oauth');
    expect(classifyClaudeToken('anything', 'ANTHROPIC_API_KEY')).toBe('api-key');
  });

  it('prefers more-specific scope over broader API keys', () => {
    const decision = selectClaudeAuth([
      secret('ANTHROPIC_API_KEY', 'org-api-key', 'org', 'org_1'),
      secret('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-project-token', 'project', 'proj_1'),
    ]);

    expect(decision).toMatchObject({
      secretKey: 'CLAUDE_CODE_OAUTH_TOKEN',
      scopeType: 'project',
      scopeId: 'proj_1',
      tokenClass: 'setup-token',
      env: {},
    });
  });

  it('prefers API keys only within the same scope', () => {
    const decision = selectClaudeAuth([
      secret('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-org-token', 'org', 'org_1'),
      secret('ANTHROPIC_API_KEY', 'org-api-key', 'org', 'org_1'),
    ]);

    expect(decision).toMatchObject({
      secretKey: 'ANTHROPIC_API_KEY',
      scopeType: 'org',
      tokenClass: 'api-key',
      env: { ANTHROPIC_API_KEY: 'org-api-key' },
    });
  });

  it('drops empty auth secrets and returns a redacted diagnostic without token bytes', () => {
    const decision = selectClaudeAuth([
      secret('CLAUDE_CODE_OAUTH_TOKEN', '   ', 'project', 'proj_1'),
      secret('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-real-token', 'org', 'org_1'),
    ]);
    const redacted = redactAuthDecision(decision);

    expect(decision?.scopeType).toBe('org');
    expect(JSON.stringify(redacted)).not.toContain('sk-ant');
    expect(redacted).toMatchObject({
      selected: true,
      secret_key: 'CLAUDE_CODE_OAUTH_TOKEN',
      token_class: 'setup-token',
      token_length: 'sk-ant-oat01-real-token'.length,
    });
    expect(redacted.token_fingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  it('scrubs conflicting auth after env overrides', () => {
    const decision = selectClaudeAuth([
      secret('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-project-token', 'project', 'proj_1'),
    ]);
    const env = {
      ANTHROPIC_API_KEY: 'override-api-key',
      ANTHROPIC_AUTH_TOKEN: 'legacy-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-project-token',
      CLAUDE_OAUTH_EXPIRES_AT: '123',
      ANTHROPIC_BASE_URL: 'https://example.invalid',
      EMPTY_AUTH: '',
    };

    const { scrubbedKeys } = scrubClaudeAuthEnv(env, decision);

    expect(scrubbedKeys).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_OAUTH_EXPIRES_AT',
    ]);
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: 'https://example.invalid',
      EMPTY_AUTH: '',
    });
  });
});

describe('Claude auth failure detection', () => {
  it('does not fire when "api key" appears in a successful assistant event', () => {
    expect(detectClaudeAuthFailure({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Set your ANTHROPIC api key in the env.' }] },
    })).toBeNull();
  });

  it('does not fire when "api key" appears in a wrapped successful assistant event', () => {
    expect(detectClaudeAuthFailure({
      seq: 1,
      kind: 'assistant',
      raw: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Set your ANTHROPIC api key in the env.' }] },
      },
    })).toBeNull();
  });

  it('does not fire on the injected app-API context init event', () => {
    expect(detectClaudeAuthFailure({
      type: 'system',
      subtype: 'init',
      apiKeySource: 'user',
      context: 'Available App APIs may include api key guidance.',
    })).toBeNull();
  });

  it('does not fire on a successful result mentioning api key', () => {
    expect(detectClaudeAuthFailure({
      type: 'result',
      is_error: false,
      result: 'Configured the api key.',
    })).toBeNull();
  });

  it('does not fire when tool content mentions invalid api key as ordinary text', () => {
    expect(detectClaudeAuthFailure({
      type: 'tool_result',
      content: 'The document says: invalid api key is a common setup mistake.',
    })).toBeNull();
  });

  it('does not scan non-JSON stdout lines from successful output', () => {
    expect(detectClaudeAuthFailure(
      'The document says: invalid api key is a common setup mistake.',
      { stream: 'stdout' },
    )).toBeNull();
  });

  it('fires on apiKeySource=none as a structured signal', () => {
    expect(detectClaudeAuthFailure({
      type: 'system',
      subtype: 'init',
      apiKeySource: 'none',
    })).toEqual({ reason: 'apiKeySource=none', apiKeySource: 'none' });
  });

  it('fires on wrapped apiKeySource=none as a structured signal', () => {
    expect(detectClaudeAuthFailure({
      seq: 2,
      kind: 'system',
      raw: {
        type: 'system',
        subtype: 'init',
        apiKeySource: 'none',
      },
    })).toEqual({ reason: 'apiKeySource=none', apiKeySource: 'none' });
  });

  it('fires on a 401 error result', () => {
    expect(detectClaudeAuthFailure({
      type: 'result',
      is_error: true,
      result: 'Request failed: 401 Unauthorized',
    })?.reason).toBe('claude_auth_error_text');
  });

  it('fires on a wrapped 401 error result', () => {
    expect(detectClaudeAuthFailure({
      seq: 3,
      kind: 'system',
      raw: {
        type: 'result',
        is_error: true,
        result: 'Request failed: 401 Unauthorized',
      },
    })?.reason).toBe('claude_auth_error_text');
  });

  it('fires on an Anthropic authentication_error envelope', () => {
    expect(detectClaudeAuthFailure({
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
    })?.reason).toBe('claude_auth_error_text');
  });

  it('fires on a stderr auth line', () => {
    expect(detectClaudeAuthFailure('error: invalid api key', { stream: 'stderr' })?.reason)
      .toBe('claude_auth_error_text');
  });
});

describe('Claude runtime config materialization', () => {
  it('copies non-secret config and writes setup-token credentials outside repoPath', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'eve-claude-auth-'));
    const repoPath = path.join(tempRoot, 'repo');
    const sourceConfigDir = path.join(repoPath, '.agent', 'harnesses', 'claude');
    const jobUserHome = path.join(tempRoot, 'home');

    try {
      await mkdir(sourceConfigDir, { recursive: true });
      await writeFile(path.join(sourceConfigDir, 'settings.json'), '{"ok":true}');
      await writeFile(path.join(sourceConfigDir, '.credentials.json'), '{"secret":true}');

      const runtime = await prepareClaudeRuntimeConfig(
        repoPath,
        sourceConfigDir,
        jobUserHome,
        'attempt_1',
        'claude',
      );
      const decision = selectClaudeAuth([
        secret('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-project-token', 'project', 'proj_1'),
      ]);
      const materialized = await materializeClaudeCredentials(runtime.configDir, decision, new Date('2026-06-04T00:00:00.000Z'));

      expect(runtime.configDir.startsWith(repoPath)).toBe(false);
      expect(await readFile(path.join(runtime.configDir, 'settings.json'), 'utf8')).toBe('{"ok":true}');
      await expect(readFile(path.join(runtime.configDir, 'credentials.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(materialized.written).toBe(true);
      expect(materialized.path).toBe(runtime.credentialsPath);

      const raw = await readFile(runtime.credentialsPath, 'utf8');
      const parsed = JSON.parse(raw) as { claudeAiOauth: { accessToken: string; expiresAt: number; scopes: string[]; subscriptionType: string } };
      expect(parsed.claudeAiOauth.accessToken).toBe('sk-ant-oat01-project-token');
      expect(parsed.claudeAiOauth.scopes).toEqual(['user:inference']);
      expect(parsed.claudeAiOauth.subscriptionType).toBe('unknown');
      expect(parsed.claudeAiOauth.expiresAt).toBe(new Date('2027-06-04T00:00:00.000Z').getTime());

      const mode = (await stat(runtime.credentialsPath)).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects config dirs under repoPath', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'eve-claude-auth-'));
    try {
      await expect(prepareClaudeRuntimeConfig(
        tempRoot,
        path.join(tempRoot, '.agent', 'harnesses', 'claude'),
        path.join(tempRoot, 'nested-home'),
        'attempt_1',
        'claude',
      )).rejects.toThrow(/outside repoPath/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
