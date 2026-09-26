import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptExecutorService } from './script-executor.service.js';

const runner = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../invoke/k8s-runner.js', () => ({ runInvocationInK8s: runner.run }));

const original = {
  runtime: process.env.EVE_RUNTIME,
  enabled: process.env.EVE_SCRIPT_K8S_RUNNER,
  selfTerminate: process.env.EVE_RUNNER_SELF_TERMINATE,
  initMounted: process.env.EVE_TOOLCHAIN_INIT_MOUNTED,
};
afterEach(() => {
  for (const [key, value] of Object.entries({ EVE_RUNTIME: original.runtime,
    EVE_SCRIPT_K8S_RUNNER: original.enabled, EVE_RUNNER_SELF_TERMINATE: original.selfTerminate,
    EVE_TOOLCHAIN_INIT_MOUNTED: original.initMounted })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  runner.run.mockReset();
});

describe('script runner dispatch', () => {
  it('dispatches configured scripts with their declared toolchains and guards the pod', async () => {
    process.env.EVE_RUNTIME = 'k8s';
    process.env.EVE_SCRIPT_K8S_RUNNER = 'true';
    delete process.env.EVE_RUNNER_SELF_TERMINATE;
    const service = new ScriptExecutorService(null as never);
    (service as unknown as { jobs: unknown }).jobs = { findById: vi.fn().mockResolvedValue({
      project_id: 'proj_1', execution_type: 'script', script_command: 'echo test',
      hints: { toolchains: ['python', 'browser'] },
    }), updateRuntimeMeta: vi.fn() };
    runner.run.mockResolvedValue({ success: true, exitCode: 0,
      runnerEventObserved: true, resultJson: { stdout: 'done', stderr: '', exit_code: 0 } });

    const result = await service.execute('job_1', 'att_1');
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job_1', attemptId: 'att_1', projectId: 'proj_1', toolchains: ['python', 'browser'],
    }), expect.any(Function), undefined, { submitPath: 'scripts/execute' });
    expect(result).toMatchObject({ success: true, stdout: 'done', runnerEventEmitted: true });
    runner.run.mockResolvedValueOnce({ success: false, exitCode: 1,
      error: 'toolchain_unavailable: browser init image pull failed' });
    const startupFailure = await service.execute('job_1', 'att_2');
    expect(startupFailure).toMatchObject({ success: false, errorCode: 'toolchain_unavailable',
      runnerEventEmitted: false });
    process.env.EVE_RUNNER_SELF_TERMINATE = '1';
    expect(service.shouldDispatchToRunner()).toBe(false);
  });

  it('keeps pulled init image IDs through script provisioning and failure writes', async () => {
    process.env.EVE_TOOLCHAIN_INIT_MOUNTED = 'true';
    const meta: Record<string, unknown> = { toolchains: { requested: ['browser'],
      image_ids: { browser: 'docker-pullable://browser@sha256:abc' } } };
    const db = vi.fn(async () => [{ runtime_meta: meta }]);
    const service = new ScriptExecutorService(db as never);
    const updateRuntimeMeta = vi.fn(async (_id: string, value: Record<string, unknown>) => Object.assign(meta, value));
    (service as unknown as { jobs: unknown }).jobs = { updateRuntimeMeta };
    const write = (service as unknown as { updateScriptToolchainMeta: (id: string, value: Record<string, unknown>) => Promise<void> }).updateScriptToolchainMeta.bind(service);
    await write('00000000-0000-0000-0000-000000000001', { requested: ['browser'], resolved: ['browser'] });
    await write('00000000-0000-0000-0000-000000000001', { requested: ['browser'],
      error_code: 'toolchain_unavailable', source: 'unavailable' });
    expect(meta.toolchains).toMatchObject({ image_ids: { browser: 'docker-pullable://browser@sha256:abc' },
      error_code: 'toolchain_unavailable' });
  });
});
