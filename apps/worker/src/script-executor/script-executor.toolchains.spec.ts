import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ScriptExecutorService } from './script-executor.service.js';
import { ActionExecutorService } from '../action-executor/action-executor.service.js';

const execFileAsync = promisify(execFile);

const sharedMocks = vi.hoisted(() => ({
  applyEnvOverrides: vi.fn(),
  deliverProvisioningError: vi.fn(),
  ensureToolchains: vi.fn(),
  mintAppLinkToken: vi.fn(),
  mintJobToken: vi.fn(),
  resolveProjectSecrets: vi.fn(),
}));

vi.mock('@eve/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eve/shared')>();
  return {
    ...actual,
    applyEnvOverrides: sharedMocks.applyEnvOverrides,
    deliverProvisioningError: sharedMocks.deliverProvisioningError,
    ensureToolchains: sharedMocks.ensureToolchains,
    mintAppLinkToken: sharedMocks.mintAppLinkToken,
    mintJobToken: sharedMocks.mintJobToken,
    resolveProjectSecrets: sharedMocks.resolveProjectSecrets,
  };
});

function secret(key: string, value: string) {
  return {
    key,
    value,
    type: 'plain',
    resolved_at: 'project',
  };
}

describe('worker toolchain execution', () => {
  const workspaces: string[] = [];

  beforeEach(() => {
    sharedMocks.applyEnvOverrides.mockReset();
    sharedMocks.deliverProvisioningError.mockReset();
    sharedMocks.ensureToolchains.mockReset();
    sharedMocks.mintAppLinkToken.mockReset();
    sharedMocks.mintJobToken.mockReset();
    sharedMocks.resolveProjectSecrets.mockReset();
    sharedMocks.applyEnvOverrides.mockImplementation(async ({
      envOverrides,
      resolvedSecrets,
      baseEnv,
      onMissingSecrets,
    }) => {
      const env = { ...baseEnv };
      const appliedKeys: string[] = [];
      const strippedKeys: string[] = [];
      if (!envOverrides || Object.keys(envOverrides).length === 0) {
        return { env, appliedKeys, strippedKeys };
      }

      const missing = new Set<string>();
      const resolved: Record<string, string> = {};
      for (const [key, value] of Object.entries(envOverrides as Record<string, string>)) {
        const secretMatch = value.match(/^\$\{secret\.([^}]+)\}$/);
        if (secretMatch) {
          const secret = (resolvedSecrets as Array<{ key: string; value: string }>).find((item) => item.key === secretMatch[1]);
          if (!secret) {
            missing.add(secretMatch[1]);
            continue;
          }
          resolved[key] = secret.value;
        } else {
          resolved[key] = value;
        }
      }

      if (missing.size > 0) {
        const missingKeys = Array.from(missing);
        await onMissingSecrets?.(missingKeys);
        const error = new Error(`missing_secret_override: ${missingKeys.join(', ')}`) as Error & {
          code: string;
          missing: string[];
        };
        error.code = 'missing_secret_override';
        error.missing = missingKeys;
        throw error;
      }

      for (const [key, value] of Object.entries(resolved)) {
        if (key === 'PATH') {
          strippedKeys.push(key);
          continue;
        }
        env[key] = value;
        appliedKeys.push(key);
      }

      return { env, appliedKeys, strippedKeys };
    });
    sharedMocks.mintJobToken.mockResolvedValue(undefined);
    sharedMocks.mintAppLinkToken.mockResolvedValue({
      access_token: 'app-link-token',
      token_type: 'bearer',
      expires_at: 1_900_000_000,
    });
    sharedMocks.resolveProjectSecrets.mockResolvedValue({ resolved: true, secrets: [] });
  });

  afterEach(async () => {
    for (const workspace of workspaces.splice(0)) {
      await rm(workspace, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  async function tempWorkspace(prefix: string): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), prefix));
    workspaces.push(workspace);
    return workspace;
  }

  async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return await execFileAsync('git', args, { cwd }) as { stdout: string; stderr: string };
  }

  async function createGitFixture(): Promise<{ root: string; source: string; remote: string }> {
    const root = await tempWorkspace('eve-script-git-');
    const remote = join(root, 'remote.git');
    const source = join(root, 'source');

    await git(root, ['init', '--bare', remote]);
    await mkdir(source);
    await git(source, ['init']);
    await git(source, ['config', 'user.name', 'Test User']);
    await git(source, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(source, 'marker.txt'), 'main\n');
    await git(source, ['add', 'marker.txt']);
    await git(source, ['commit', '-m', 'initial']);
    await git(source, ['branch', '-M', 'main']);
    await git(source, ['remote', 'add', 'origin', remote]);
    await git(source, ['push', '-u', 'origin', 'main']);
    await git(source, ['checkout', '-b', 'feature']);
    await writeFile(join(source, 'marker.txt'), 'feature\n');
    await git(source, ['commit', '-am', 'feature marker']);
    await git(source, ['push', '-u', 'origin', 'feature']);
    await git(source, ['checkout', 'main']);

    return { root, source, remote };
  }

  function createScriptService(job: Record<string, unknown>, repoUrl: string) {
    const gitUpdates: unknown[] = [];
    const db = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM projects')) {
        return [{ repo_url: repoUrl, slug: 'proj', org_slug: 'org', branch: 'main' }];
      }
      if (sql.includes('FROM environments')) {
        return [];
      }
      if (sql.includes('FROM releases')) {
        return [];
      }
      if (sql.includes('FROM project_manifests')) {
        return [];
      }
      if (sql.includes('UPDATE job_attempts')) {
        gitUpdates.push(values[0]);
        return [];
      }
      return [];
    }) as any;
    db.json = vi.fn((value: unknown) => value);

    const service = new ScriptExecutorService(db);
    Object.assign(service as any, {
      jobs: {
        findById: vi.fn().mockResolvedValue(job),
        markExecutionStarted: vi.fn().mockResolvedValue(undefined),
      },
      logs: { appendLog: vi.fn().mockResolvedValue(undefined) },
    });

    return { service, gitUpdates };
  }

  function mockToolchainEnv() {
    sharedMocks.ensureToolchains.mockImplementation(async ({ toolchains, baseEnv, logger }) => {
      await logger?.({
        type: 'cache_hit',
        toolchain: toolchains[0],
        image: `eve-horizon/toolchain-${toolchains[0]}:local`,
        root: `/opt/eve/toolchains/${toolchains[0]}`,
      });
      return {
        resolved: toolchains,
        missing: [],
        pathPrefix: `/opt/eve/toolchains/${toolchains[0]}/bin`,
        envOverlay: { TOOLCHAIN_MARKER: 'ready' },
        env: {
          ...baseEnv,
          PATH: `/opt/eve/toolchains/${toolchains[0]}/bin:${baseEnv.PATH ?? ''}`,
          TOOLCHAIN_MARKER: 'ready',
        },
      };
    });
  }

  it('provisions script job toolchains before launching bash', async () => {
    mockToolchainEnv();
    const workspace = await tempWorkspace('eve-script-toolchains-');
    const service = new ScriptExecutorService(null as any);
    const logToolchainEvent = vi.fn().mockResolvedValue(undefined);
    (service as any).appendLog = vi.fn().mockResolvedValue(undefined);

    const result = await (service as any).runScript(
      workspace,
      'printf "%s|%s" "$TOOLCHAIN_MARKER" "$PATH"',
      10_000,
      {
        jobId: 'job_1',
        projectId: 'proj_1',
        attemptId: 'att_1',
        toolchains: ['python'],
        logToolchainEvent,
      },
    );

    expect(sharedMocks.ensureToolchains).toHaveBeenCalledWith(expect.objectContaining({
      toolchains: ['python'],
      baseEnv: expect.objectContaining({
        EVE_JOB_ID: 'job_1',
        EVE_PROJECT_ID: 'proj_1',
        EVE_ATTEMPT_ID: 'att_1',
      }),
      logger: logToolchainEvent,
    }));
    expect(logToolchainEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'cache_hit',
      toolchain: 'python',
    }));
    expect(result).toMatchObject({
      success: true,
      exitCode: 0,
    });
    expect(result.stdout).toContain('ready|/opt/eve/toolchains/python/bin:');
  });

  it('leaves script jobs without toolchains on the existing environment path', async () => {
    const workspace = await tempWorkspace('eve-script-no-toolchains-');
    const service = new ScriptExecutorService(null as any);
    (service as any).appendLog = vi.fn().mockResolvedValue(undefined);

    const result = await (service as any).runScript(
      workspace,
      'printf "%s" "${TOOLCHAIN_MARKER:-missing}"',
      10_000,
      {
        jobId: 'job_2',
        projectId: 'proj_1',
        attemptId: 'att_2',
        toolchains: [],
      },
    );

    expect(sharedMocks.ensureToolchains).not.toHaveBeenCalled();
    expect(result.stdout).toBe('missing');
  });

  it('checks out script jobs at an explicit git ref', async () => {
    const fixture = await createGitFixture();
    const job = {
      id: 'job_git_ref',
      project_id: 'proj_1',
      execution_type: 'script',
      script_command: 'cat marker.txt',
      script_timeout_seconds: 10,
      git_json: {
        ref: 'feature',
        ref_policy: 'explicit',
        commit: 'never',
        push: 'never',
      },
      parent_id: null,
    };
    const { service, gitUpdates } = createScriptService(job, `file://${fixture.source}`);

    const result = await service.execute('job_git_ref', 'att_git_ref');

    expect(result).toMatchObject({ success: true, exitCode: 0, stdout: 'feature\n' });
    expect(gitUpdates).toHaveLength(1);
    expect(gitUpdates[0]).toMatchObject({
      resolved_ref: 'feature',
      resolved_branch: 'feature',
      ref_source: 'explicit',
      pushed: false,
    });
  });

  it('auto-commits and pushes successful script job changes when git controls request it', async () => {
    const fixture = await createGitFixture();
    const job = {
      id: 'job_git_push',
      project_id: 'proj_1',
      execution_type: 'script',
      script_command: 'printf "updated\\n" > script-output.txt',
      script_timeout_seconds: 10,
      git_json: {
        ref: 'main',
        branch: 'job/script-git',
        create_branch: 'always',
        commit: 'auto',
        commit_message: 'test: script git controls',
        push: 'on_success',
        remote: 'origin',
      },
      parent_id: null,
    };
    const { service, gitUpdates } = createScriptService(job, `file://${fixture.source}`);

    const result = await service.execute('job_git_push', 'att_git_push');
    const pushedFile = await execFileAsync('git', [
      '--git-dir',
      fixture.remote,
      'show',
      'refs/heads/job/script-git:script-output.txt',
    ]) as { stdout: string; stderr: string };

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(pushedFile.stdout).toBe('updated\n');
    expect(gitUpdates).toHaveLength(1);
    expect(gitUpdates[0]).toMatchObject({
      resolved_ref: 'main',
      resolved_branch: 'job/script-git',
      ref_source: 'explicit',
      pushed: true,
    });
    expect((gitUpdates[0] as { commits?: string[] }).commits?.length).toBe(1);
  });

  it('kills script commands that exceed their timeout', async () => {
    const workspace = await tempWorkspace('eve-script-timeout-');
    const service = new ScriptExecutorService(null as any);
    const appendLog = vi.fn().mockResolvedValue(undefined);
    (service as any).appendLog = appendLog;

    const result = await (service as any).runScript(
      workspace,
      'sleep 5',
      100,
      {
        jobId: 'job_timeout',
        projectId: 'proj_1',
        attemptId: 'att_timeout',
      },
    );

    expect(result).toMatchObject({
      success: false,
      exitCode: 124,
      errorCode: 'script_timeout',
    });
    expect(result.error).toContain('script_timeout');
    expect(appendLog).toHaveBeenCalledWith('att_timeout', 'error', expect.objectContaining({
      code: 'script_timeout',
    }));
  });

  it('injects literal script env_overrides into bash', async () => {
    const workspace = await tempWorkspace('eve-script-env-overrides-');
    const service = new ScriptExecutorService(null as any);
    const appendLog = vi.fn().mockResolvedValue(undefined);
    (service as any).appendLog = appendLog;

    const result = await (service as any).runScript(
      workspace,
      'printf "%s" "$FOO"',
      10_000,
      {
        jobId: 'job_env_1',
        projectId: 'proj_1',
        attemptId: 'att_env_1',
        envOverrides: { FOO: 'bar' },
        resolvedSecrets: [],
      },
    );

    expect(result).toMatchObject({ success: true, exitCode: 0, stdout: 'bar' });
    expect(appendLog).toHaveBeenCalledWith('att_env_1', 'status', expect.objectContaining({
      message: 'Applied env_overrides: FOO',
    }));
  });

  it('injects resolved secret script env_overrides into bash', async () => {
    const workspace = await tempWorkspace('eve-script-env-secret-');
    const service = new ScriptExecutorService(null as any);
    (service as any).appendLog = vi.fn().mockResolvedValue(undefined);

    const result = await (service as any).runScript(
      workspace,
      'printf "%s" "$TOKEN"',
      10_000,
      {
        jobId: 'job_env_2',
        projectId: 'proj_1',
        attemptId: 'att_env_2',
        envOverrides: { TOKEN: '${secret.X}' },
        resolvedSecrets: [secret('X', 'resolved-token')],
      },
    );

    expect(result).toMatchObject({ success: true, exitCode: 0, stdout: 'resolved-token' });
  });

  it('fails script env_overrides with missing secrets before bash runs', async () => {
    const workspace = await tempWorkspace('eve-script-env-missing-');
    const service = new ScriptExecutorService(null as any);
    (service as any).appendLog = vi.fn().mockResolvedValue(undefined);
    const relayMissingSecrets = vi.fn().mockResolvedValue(undefined);

    await expect((service as any).runScript(
      workspace,
      'printf "should-not-run"',
      10_000,
      {
        jobId: 'job_env_3',
        projectId: 'proj_1',
        attemptId: 'att_env_3',
        envOverrides: { TOKEN: '${secret.MISSING}' },
        resolvedSecrets: [],
        relayMissingSecrets,
      },
    )).rejects.toMatchObject({
      code: 'missing_secret_override',
      missing: ['MISSING'],
    });
    expect(relayMissingSecrets).toHaveBeenCalledWith(['MISSING']);
  });

  it('strips reserved script env_overrides and lets user overrides shadow toolchain env', async () => {
    mockToolchainEnv();
    const workspace = await tempWorkspace('eve-script-env-strip-');
    const service = new ScriptExecutorService(null as any);
    const appendLog = vi.fn().mockResolvedValue(undefined);
    (service as any).appendLog = appendLog;
    sharedMocks.ensureToolchains.mockImplementation(async ({ baseEnv }) => ({
      resolved: ['python'],
      missing: [],
      pathPrefix: '/tool/bin',
      envOverlay: { PYTHONPATH: '/toolchain' },
      env: {
        ...baseEnv,
        PATH: `/tool/bin:${baseEnv.PATH ?? ''}`,
        PYTHONPATH: '/toolchain',
      },
    }));

    const result = await (service as any).runScript(
      workspace,
      'printf "%s|%s" "$PATH" "$PYTHONPATH"',
      10_000,
      {
        jobId: 'job_env_4',
        projectId: 'proj_1',
        attemptId: 'att_env_4',
        toolchains: ['python'],
        envOverrides: { PATH: '/evil', PYTHONPATH: '/custom' },
        resolvedSecrets: [],
      },
    );

    expect(result.stdout).toContain('/tool/bin:');
    expect(result.stdout).toContain('|/custom');
    expect(result.stdout).not.toBe('/evil|/custom');
    expect(appendLog).toHaveBeenCalledWith('att_env_4', 'warning', expect.objectContaining({
      stripped_keys: ['PATH'],
    }));
  });

  it('injects app-link env vars into script bash before env_overrides', async () => {
    const workspace = await tempWorkspace('eve-script-app-link-env-');
    const service = new ScriptExecutorService(null as any);
    const appendLog = vi.fn().mockResolvedValue(undefined);
    (service as any).appendLog = appendLog;

    const result = await (service as any).runScript(
      workspace,
      'printf "%s|%s" "$EVE_APP_LINK_OBSERVATION_API_URL" "${EVE_APP_LINK_OBSERVATION_TOKEN:+token-present}"',
      10_000,
      {
        jobId: 'job_app_link_env',
        projectId: 'proj_1',
        attemptId: 'att_app_link_env',
        appLinkEnv: {
          EVE_APP_LINK_OBSERVATION_API_URL: 'http://observation.svc:3000',
          EVE_APP_LINK_OBSERVATION_TOKEN: 'secret-token',
        },
      },
    );

    expect(result).toMatchObject({
      success: true,
      exitCode: 0,
      stdout: 'http://observation.svc:3000|token-present',
    });
    expect(appendLog).toHaveBeenCalledWith('att_app_link_env', 'status', expect.objectContaining({
      message: 'Injected app-link env vars: EVE_APP_LINK_OBSERVATION_API_URL, EVE_APP_LINK_OBSERVATION_TOKEN',
      injected_keys: ['EVE_APP_LINK_OBSERVATION_API_URL', 'EVE_APP_LINK_OBSERVATION_TOKEN'],
    }));
    expect(JSON.stringify(appendLog.mock.calls)).not.toContain('secret-token');
  });

  it('lets script env_overrides shadow injected app-link env vars', async () => {
    const workspace = await tempWorkspace('eve-script-app-link-override-');
    const service = new ScriptExecutorService(null as any);
    (service as any).appendLog = vi.fn().mockResolvedValue(undefined);

    const result = await (service as any).runScript(
      workspace,
      'printf "%s" "$EVE_APP_LINK_OBSERVATION_API_URL"',
      10_000,
      {
        jobId: 'job_app_link_override',
        projectId: 'proj_1',
        attemptId: 'att_app_link_override',
        appLinkEnv: {
          EVE_APP_LINK_OBSERVATION_API_URL: 'http://observation.svc:3000',
        },
        envOverrides: {
          EVE_APP_LINK_OBSERVATION_API_URL: 'http://override.local',
        },
        resolvedSecrets: [],
      },
    );

    expect(result).toMatchObject({
      success: true,
      exitCode: 0,
      stdout: 'http://override.local',
    });
  });

  it('mints app-link tokens from resolved hints for script jobs', async () => {
    const source = await tempWorkspace('eve-script-app-link-source-');
    await writeFile(join(source, 'package.json'), '{"name":"fixture"}\n');
    const job = {
      id: 'job_app_link',
      project_id: 'proj_1',
      execution_type: 'script',
      script_command: 'printf "%s|%s|%s" "$EVE_APP_LINK_OBSERVATION_API_URL" "${EVE_APP_LINK_OBSERVATION_TOKEN:+token-present}" "$EVE_APP_LINK_OBSERVATION_ENV"',
      script_timeout_seconds: 10,
      env_name: 'sandbox',
      parent_id: null,
      hints: {
        resolved_app_links: [
          {
            name: 'observation-api',
            alias: 'observation',
            subscription_id: 'sub_observation',
            type: 'openapi',
            base_url: 'http://observation.svc:3000',
            scopes: ['observations:read'],
            producer_project_id: 'proj_observation',
            producer_env: 'sandbox',
          },
        ],
      },
    };
    const { service } = createScriptService(job, `file://${source}`);

    const result = await service.execute('job_app_link', 'att_app_link');

    expect(result).toMatchObject({
      success: true,
      exitCode: 0,
      stdout: 'http://observation.svc:3000|token-present|sandbox',
    });
    expect(sharedMocks.mintAppLinkToken).toHaveBeenCalledWith({
      subscriptionId: 'sub_observation',
      consumerPrincipal: 'job:job_app_link',
      consumerEnv: 'sandbox',
      producerEnv: 'sandbox',
      ttlSeconds: 60 * 60,
    });
    const appendLog = (service as any).logs.appendLog;
    expect(appendLog).toHaveBeenCalledWith('att_app_link', 'status', expect.objectContaining({
      message: expect.stringContaining('Injected app-link env vars:'),
      injected_keys: expect.arrayContaining([
        'EVE_APP_LINK_OBSERVATION_API_URL',
        'EVE_APP_LINK_OBSERVATION_TOKEN',
      ]),
    }));
    expect(JSON.stringify(appendLog.mock.calls)).not.toContain('app-link-token');
  });

  it('fails script jobs before bash when an app-link token cannot be minted', async () => {
    sharedMocks.mintAppLinkToken.mockResolvedValueOnce(null);
    const source = await tempWorkspace('eve-script-app-link-fail-source-');
    await writeFile(join(source, 'package.json'), '{"name":"fixture"}\n');
    const job = {
      id: 'job_app_link_fail',
      project_id: 'proj_1',
      execution_type: 'script',
      script_command: 'printf "should-not-run"',
      script_timeout_seconds: 10,
      env_name: 'sandbox',
      parent_id: null,
      hints: {
        resolved_app_links: [
          {
            name: 'observation-api',
            alias: 'observation',
            subscription_id: 'sub_observation',
            type: 'openapi',
            base_url: 'http://observation.svc:3000',
            producer_env: 'sandbox',
          },
        ],
      },
    };
    const { service } = createScriptService(job, `file://${source}`);

    const result = await service.execute('job_app_link_fail', 'att_app_link_fail');

    expect(result).toMatchObject({
      success: false,
      exitCode: 1,
    });
    expect(result.error).toContain('Failed to mint app-link token for "observation" (subscription sub_observation)');
    expect(result.stdout).toBeUndefined();
  });

  it('provisions action-run toolchains before launching bash', async () => {
    mockToolchainEnv();
    const workspace = await tempWorkspace('eve-action-toolchains-');
    const appendLog = vi.fn().mockResolvedValue(undefined);
    const cleanupWorkspace = vi.fn().mockResolvedValue(undefined);
    const service = new ActionExecutorService(null as any, {} as any, {} as any);
    Object.assign(service as any, {
      projects: {
        findById: vi.fn().mockResolvedValue({ repo_url: 'file:///tmp/example.git' }),
      },
      jobs: {
        findById: vi.fn().mockResolvedValue({ hints: { toolchains: ['python'] } }),
      },
      logs: { appendLog },
      prepareWorkspace: vi.fn().mockResolvedValue(workspace),
      cleanupWorkspace,
    });

    const result = await (service as any).handleRun(
      'att_3',
      'job_3',
      'proj_1',
      {
        command: 'printf "%s|%s" "$TOOLCHAIN_MARKER" "$PATH"',
        git_sha: '0123456789abcdef0123456789abcdef01234567',
      },
    );

    expect(sharedMocks.ensureToolchains).toHaveBeenCalledWith(expect.objectContaining({
      toolchains: ['python'],
      baseEnv: expect.objectContaining({
        EVE_JOB_ID: 'job_3',
        EVE_PROJECT_ID: 'proj_1',
        EVE_ATTEMPT_ID: 'att_3',
      }),
    }));
    expect(result).toMatchObject({
      command: 'printf "%s|%s" "$TOOLCHAIN_MARKER" "$PATH"',
      exit_code: 0,
      stdout: expect.stringContaining('ready|/opt/eve/toolchains/python/bin:'),
    });
    expect(appendLog).toHaveBeenCalledWith('att_3', 'status', expect.objectContaining({
      toolchain_event: 'cache_hit',
      toolchain: 'python',
    }));
    expect(cleanupWorkspace).toHaveBeenCalledWith(workspace);
  });

  it('injects literal action-run env_overrides into bash', async () => {
    const workspace = await tempWorkspace('eve-action-env-overrides-');
    const appendLog = vi.fn().mockResolvedValue(undefined);
    const cleanupWorkspace = vi.fn().mockResolvedValue(undefined);
    const service = new ActionExecutorService(null as any, {} as any, {} as any);
    Object.assign(service as any, {
      projects: {
        findById: vi.fn().mockResolvedValue({ repo_url: 'file:///tmp/example.git' }),
      },
      jobs: {
        findById: vi.fn().mockResolvedValue({ hints: {}, env_overrides: { FOO: 'bar' } }),
      },
      logs: { appendLog },
      prepareWorkspace: vi.fn().mockResolvedValue(workspace),
      cleanupWorkspace,
    });

    const result = await (service as any).handleRun(
      'att_action_env_1',
      'job_action_env_1',
      'proj_1',
      {
        command: 'printf "%s" "$FOO"',
        git_sha: '0123456789abcdef0123456789abcdef01234567',
      },
    );

    expect(result).toMatchObject({ exit_code: 0, stdout: 'bar' });
    expect(appendLog).toHaveBeenCalledWith('att_action_env_1', 'status', expect.objectContaining({
      message: 'Applied env_overrides: FOO',
    }));
    expect(cleanupWorkspace).toHaveBeenCalledWith(workspace);
  });

  it('fails action-run env_overrides with missing secrets before bash runs', async () => {
    const workspace = await tempWorkspace('eve-action-env-missing-');
    const cleanupWorkspace = vi.fn().mockResolvedValue(undefined);
    const service = new ActionExecutorService(null as any, {} as any, {} as any);
    Object.assign(service as any, {
      projects: {
        findById: vi.fn().mockResolvedValue({ repo_url: 'file:///tmp/example.git' }),
      },
      jobs: {
        findById: vi.fn().mockResolvedValue({
          hints: {},
          env_overrides: { TOKEN: '${secret.MISSING}' },
          parent_id: 'parent_job',
        }),
      },
      logs: { appendLog: vi.fn().mockResolvedValue(undefined) },
      prepareWorkspace: vi.fn().mockResolvedValue(workspace),
      cleanupWorkspace,
    });

    await expect((service as any).handleRun(
      'att_action_env_2',
      'job_action_env_2',
      'proj_1',
      {
        command: 'printf "should-not-run"',
        git_sha: '0123456789abcdef0123456789abcdef01234567',
      },
    )).rejects.toMatchObject({
      code: 'missing_secret_override',
      missing: ['MISSING'],
    });
    expect(sharedMocks.deliverProvisioningError).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      jobId: 'job_action_env_2',
      parentJobId: 'parent_job',
      errorCode: 'missing_secret_override',
    }));
    expect(cleanupWorkspace).toHaveBeenCalledWith(workspace);
  });

  it('kills action-run commands that exceed their timeout', async () => {
    const workspace = await tempWorkspace('eve-action-timeout-');
    const appendLog = vi.fn().mockResolvedValue(undefined);
    const cleanupWorkspace = vi.fn().mockResolvedValue(undefined);
    const service = new ActionExecutorService(null as any, {} as any, {} as any);
    Object.assign(service as any, {
      projects: {
        findById: vi.fn().mockResolvedValue({ repo_url: 'file:///tmp/example.git' }),
      },
      jobs: {
        findById: vi.fn().mockResolvedValue({ hints: {} }),
      },
      logs: { appendLog },
      prepareWorkspace: vi.fn().mockResolvedValue(workspace),
      cleanupWorkspace,
    });

    await expect((service as any).handleRun(
      'att_action_timeout',
      'job_action_timeout',
      'proj_1',
      {
        command: 'sleep 5',
        git_sha: '0123456789abcdef0123456789abcdef01234567',
        timeout_seconds: 0.1,
      },
    )).rejects.toMatchObject({
      code: 'action_run_timeout',
      message: expect.stringContaining('action_run_timeout'),
    });

    expect(appendLog).toHaveBeenCalledWith('att_action_timeout', 'error', expect.objectContaining({
      code: 'action_run_timeout',
    }));
    expect(cleanupWorkspace).toHaveBeenCalledWith(workspace);
  });
});
