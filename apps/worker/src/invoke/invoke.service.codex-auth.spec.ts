import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { HarnessInvocation, SecretResolveItem } from '@eve/shared';
import { InvokeService } from './invoke.service';

const invocation = {
  attemptId: 'att_1',
  jobId: 'job_1',
  projectId: 'proj_1',
  text: '',
  workspacePath: '/tmp/eve-ws',
} as HarnessInvocation;

function secret(
  key: string,
  value: string,
  scope_type?: SecretResolveItem['scope_type'],
  scope_id?: string,
): SecretResolveItem {
  return { key, value, type: 'env_var', scope_type, scope_id };
}

function makeService() {
  const service = new InvokeService(null as never);
  const appendLog = vi.fn().mockResolvedValue(undefined);
  (service as unknown as { logs: unknown }).logs = { appendLog };
  const resolveCodeAuth = (
    secrets: SecretResolveItem[],
    options: { configDir?: string; env: NodeJS.ProcessEnv },
  ): Promise<{ env: Record<string, string | undefined> }> =>
    (service as unknown as {
      resolveCodeAuth: (
        invocation: HarnessInvocation,
        harness: string,
        secrets: SecretResolveItem[],
        options: { configDir?: string; env: NodeJS.ProcessEnv },
      ) => Promise<{ env: Record<string, string | undefined> }>;
    }).resolveCodeAuth(invocation, 'codex', secrets, options);
  return { appendLog, resolveCodeAuth };
}

function logsOfType(appendLog: ReturnType<typeof vi.fn>, type: string): Record<string, unknown>[] {
  return appendLog.mock.calls
    .filter(([, logType]) => logType === type)
    .map(([, , content]) => content as Record<string, unknown>);
}

describe('worker codex auth provenance', () => {
  const originalHome = process.env.HOME;
  let home: string;
  let configDir: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-codex-provenance-'));
    process.env.HOME = home;
    configDir = path.join(home, 'codex-config');
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  it('logs api_key with the scope of the matching resolved secret', async () => {
    const { appendLog, resolveCodeAuth } = makeService();

    const result = await resolveCodeAuth(
      [secret('OPENAI_API_KEY', 'sk-live-secret', 'project', 'proj_1')],
      { configDir, env: { OPENAI_API_KEY: 'sk-live-secret', CODEX_AUTH_JSON_B64: 'e30=' } },
    );

    expect(result.env.OPENAI_API_KEY).toBe('sk-live-secret');
    expect(appendLog).toHaveBeenCalledWith('att_1', 'codex_auth_selected', {
      event: 'codex_auth_selected',
      harness: 'codex',
      source: 'api_key',
      secret_key: 'OPENAI_API_KEY',
      scope_type: 'project',
      scope_id: 'proj_1',
    });
    const [lifecycle] = logsOfType(appendLog, 'lifecycle_secrets_log');
    expect(lifecycle?.meta).toMatchObject({ kind: 'codex_auth_selected', source: 'api_key' });
    expect(JSON.stringify(appendLog.mock.calls)).not.toContain('sk-live-secret');
  });

  it('logs the source and key name alone when the env value has no resolved secret', async () => {
    const { appendLog, resolveCodeAuth } = makeService();

    await resolveCodeAuth([], { configDir, env: { OPENAI_API_KEY: 'sk-from-env' } });

    expect(logsOfType(appendLog, 'codex_auth_selected')).toEqual([{
      event: 'codex_auth_selected',
      harness: 'codex',
      source: 'api_key',
      secret_key: 'OPENAI_API_KEY',
    }]);
  });

  it('logs auth_json when CODEX_AUTH_JSON_B64 is the highest-priority env value', async () => {
    const { appendLog, resolveCodeAuth } = makeService();
    const authJson = JSON.stringify({ tokens: { access_token: 'tok-secret', refresh_token: 'rt-secret' } });
    const b64 = Buffer.from(authJson).toString('base64');

    const result = await resolveCodeAuth(
      [secret('CODEX_AUTH_JSON_B64', b64, 'org', 'org_1')],
      { configDir, env: { CODEX_AUTH_JSON_B64: b64, CODEX_OAUTH_ACCESS_TOKEN: 'oauth-secret' } },
    );

    expect(result.env).toEqual({});
    await expect(fs.readFile(path.join(configDir, 'auth.json'), 'utf-8')).resolves.toBe(authJson);
    expect(logsOfType(appendLog, 'codex_auth_selected')).toEqual([{
      event: 'codex_auth_selected',
      harness: 'codex',
      source: 'auth_json',
      secret_key: 'CODEX_AUTH_JSON_B64',
      scope_type: 'org',
      scope_id: 'org_1',
    }]);
    expect(JSON.stringify(appendLog.mock.calls)).not.toContain('tok-secret');
  });

  it('logs oauth_access_token when only CODEX_OAUTH_ACCESS_TOKEN is set', async () => {
    const { appendLog, resolveCodeAuth } = makeService();

    const result = await resolveCodeAuth(
      [secret('CODEX_OAUTH_ACCESS_TOKEN', 'oauth-secret', 'user', 'user_1')],
      { configDir, env: { CODEX_OAUTH_ACCESS_TOKEN: 'oauth-secret' } },
    );

    expect(result.env.OPENAI_API_KEY).toBe('oauth-secret');
    expect(logsOfType(appendLog, 'codex_auth_selected')).toEqual([{
      event: 'codex_auth_selected',
      harness: 'codex',
      source: 'oauth_access_token',
      secret_key: 'CODEX_OAUTH_ACCESS_TOKEN',
      scope_type: 'user',
      scope_id: 'user_1',
    }]);
    expect(JSON.stringify(appendLog.mock.calls)).not.toContain('oauth-secret');
  });

  it('logs preexisting without key or scope when a pre-existing auth.json is used', async () => {
    const { appendLog, resolveCodeAuth } = makeService();
    await fs.mkdir(path.join(home, '.codex'), { recursive: true });
    await fs.writeFile(
      path.join(home, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'file-secret' } }),
    );

    const result = await resolveCodeAuth([], { configDir, env: {} });

    expect(result.env).toEqual({});
    expect(logsOfType(appendLog, 'codex_auth_selected')).toEqual([{
      event: 'codex_auth_selected',
      harness: 'codex',
      source: 'preexisting',
    }]);
    expect(JSON.stringify(appendLog.mock.calls)).not.toContain('file-secret');
  });

  it('logs no selection when no codex credential can be found', async () => {
    const { appendLog, resolveCodeAuth } = makeService();

    await expect(resolveCodeAuth([], { configDir, env: {} })).rejects.toThrow(/Missing code auth/);

    expect(logsOfType(appendLog, 'codex_auth_selected')).toEqual([]);
  });
});
