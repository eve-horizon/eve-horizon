import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineRunnerService } from './pipeline-runner.service.js';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile,
}));

const WORKER_CREDENTIALS = {
  EVE_STORAGE_ACCESS_KEY_ID: 'worker-access-key',
  EVE_STORAGE_SECRET_ACCESS_KEY: 'worker-secret-key',
  EVE_APP_STORAGE_ACCESS_KEY_ID: 'app-access-key',
  EVE_APP_STORAGE_SECRET_ACCESS_KEY: 'app-secret-key',
  EVE_INTERNAL_API_KEY: 'internal-api-key',
  DATABASE_URL: 'postgres://eve:pw@db/eve',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  GOOGLE_APPLICATION_CREDENTIALS: '/var/run/secrets/gcp.json',
};

describe('PipelineRunnerService run steps', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: 'ok\n', stderr: '' });
    });
    process.env = { PATH: '/usr/bin', HOME: '/home/worker', ...WORKER_CREDENTIALS };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('runs the command without the worker credentials in its environment', async () => {
    const service = new PipelineRunnerService(null as any, null as any) as any;
    Object.assign(service, {
      projects: { findById: vi.fn().mockResolvedValue({ id: 'proj_1', repo_url: 'https://example.com/r.git' }) },
      runs: { updateStepRun: vi.fn().mockResolvedValue(undefined) },
      resolveEnvNamespace: vi.fn().mockResolvedValue('eve-acme-web-staging'),
      prepareWorkspace: vi.fn().mockResolvedValue('/tmp/workspace'),
      cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
      appendLog: vi.fn().mockResolvedValue(undefined),
    });

    await service.handleRun(
      'step_1',
      { project_id: 'proj_1', git_sha: 'abc123', env_name: 'staging' },
      {},
      { command: 'env' },
    );

    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFile.mock.calls[0];
    expect(file).toBe('bash');
    expect(args).toEqual(['-lc', 'env']);
    expect(options.cwd).toBe('/tmp/workspace');
    expect(options.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/worker',
      EVE_ENV_NAME: 'staging',
      EVE_ENV_NAMESPACE: 'eve-acme-web-staging',
    });
  });
});
