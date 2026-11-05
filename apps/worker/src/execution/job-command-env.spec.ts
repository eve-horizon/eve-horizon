import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildJobCommandEnv, JOB_COMMAND_INHERITED_ENV_KEYS } from './job-command-env.js';
import { ScriptExecutorService } from '../script-executor/script-executor.service.js';
import { PipelineRunnerService } from '../pipeline-runner/pipeline-runner.service.js';

/** What a worker pod's environment looks like with `envFrom: eve-app` plus cloud wiring. */
const WORKER_SECRETS: Record<string, string> = {
  DATABASE_URL: 'postgres://eve:pw@db/eve',
  EVE_INTERNAL_API_KEY: 'internal-key',
  EVE_SECRETS_MASTER_KEY: 'master-key',
  EVE_AUTH_PRIVATE_KEY: 'signing-key',
  EVE_REGISTRY_SIGNING_KEY: 'registry-key',
  EVE_BOOTSTRAP_TOKEN: 'bootstrap',
  EVE_STORAGE_SECRET_ACCESS_KEY: 'storage-secret',
  EVE_APP_STORAGE_SECRET_ACCESS_KEY: 'app-storage-secret',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  GOOGLE_APPLICATION_CREDENTIALS: '/var/secrets/gcp.json',
  ANTHROPIC_API_KEY: 'llm-key',
  CODEX_AUTH_JSON: 'codex-auth',
  GITHUB_TOKEN: 'gh-token',
  KUBERNETES_SERVICE_HOST: '10.0.0.1',
};

describe('buildJobCommandEnv', () => {
  it('inherits only allowlisted keys from the worker', () => {
    const env = buildJobCommandEnv({}, {
      ...WORKER_SECRETS, PATH: '/usr/bin', HOME: '/home/node', LANG: 'C.UTF-8',
      EVE_API_URL: 'http://eve-api:4701',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/node', LANG: 'C.UTF-8', EVE_API_URL: 'http://eve-api:4701' });
  });

  it('adds job context and a job-scoped HOME', () => {
    const env = buildJobCommandEnv({
      home: '/tmp/ws/home', jobId: 'job_1', projectId: 'proj_1', attemptId: 'att_1', runId: 'run_1',
      envName: 'staging', envNamespace: 'eve-o-p-staging', jobToken: 'job-token',
    }, { ...WORKER_SECRETS, HOME: '/home/node', PATH: '/usr/bin' });
    expect(env).toEqual({
      PATH: '/usr/bin', HOME: '/tmp/ws/home', EVE_JOB_ID: 'job_1', EVE_PROJECT_ID: 'proj_1',
      EVE_ATTEMPT_ID: 'att_1', EVE_RUN_ID: 'run_1', EVE_ENV_NAME: 'staging',
      EVE_ENV_NAMESPACE: 'eve-o-p-staging', EVE_JOB_TOKEN: 'job-token',
    });
  });

  it('never allowlists a credential-bearing key', () => {
    for (const key of JOB_COMMAND_INHERITED_ENV_KEYS) {
      expect(key).not.toMatch(/SECRET|KEY|TOKEN|PASSWORD|DATABASE|CREDENTIAL|AUTH/);
    }
  });
});

describe('in-process job commands', () => {
  const saved: Record<string, string | undefined> = {};
  const workspaces: string[] = [];

  beforeEach(() => {
    for (const [key, value] of Object.entries(WORKER_SECRETS)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function workspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'eve-job-env-'));
    workspaces.push(dir);
    return dir;
  }

  it('script steps cannot see the worker secrets', async () => {
    const service = new ScriptExecutorService(null as never);
    (service as unknown as { appendLog: unknown }).appendLog = vi.fn().mockResolvedValue(undefined);
    const result = await (service as unknown as {
      runScript: (repo: string, cmd: string, timeout: number, ctx: Record<string, unknown>) => Promise<{ success: boolean; stdout?: string }>;
    }).runScript(await workspace(), 'env', 10_000, {
      jobId: 'job_env', projectId: 'proj_env', attemptId: 'att_env', jobToken: 'job-token',
    });
    expect(result.success).toBe(true);
    const names = (result.stdout ?? '').split('\n').map((line) => line.split('=')[0]);
    for (const key of Object.keys(WORKER_SECRETS)) expect(names).not.toContain(key);
    expect(names).toEqual(expect.arrayContaining(['EVE_JOB_ID', 'EVE_JOB_TOKEN', 'PATH']));
  });

  it('legacy pipeline run steps cannot see the worker secrets', async () => {
    const dir = await workspace();
    const updateStepRun = vi.fn().mockResolvedValue(undefined);
    const service = new PipelineRunnerService(vi.fn() as never, {} as never);
    Object.assign(service as unknown as Record<string, unknown>, {
      projects: { findById: vi.fn().mockResolvedValue({ repo_url: 'https://example.invalid/repo.git' }) },
      runs: { updateStepRun },
      appendLog: vi.fn().mockResolvedValue(undefined),
      resolveEnvNamespace: vi.fn().mockResolvedValue('eve-org-proj-test'),
      prepareWorkspace: vi.fn().mockResolvedValue(dir),
      cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
    });
    await (service as unknown as {
      handleRun: (stepId: string, run: Record<string, unknown>, manifest: unknown, action: Record<string, unknown>) => Promise<void>;
    }).handleRun('step_1', { project_id: 'proj_1', git_sha: 'abc', env_name: 'test' }, {}, { command: 'env' });
    const output = updateStepRun.mock.calls[0][1].output_json as { stdout: string };
    const names = output.stdout.split('\n').map((line) => line.split('=')[0]);
    for (const key of Object.keys(WORKER_SECRETS)) expect(names).not.toContain(key);
    expect(names).toEqual(expect.arrayContaining(['EVE_ENV_NAME', 'EVE_ENV_NAMESPACE']));
  });
});
