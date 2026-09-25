import { describe, expect, it, vi } from 'vitest';
import { ToolchainProvisionError, type HarnessInvocation } from '@eve/shared';

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: mocks.spawn,
}));
vi.mock('@eve/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eve/shared')>()),
  ensureToolchains: vi.fn().mockResolvedValue({ resolved: ['browser'], missing: [], pathPrefix: '', envOverlay: {}, sourceDigests: {} }),
  probeBrowserRuntime: mocks.probe,
  loadConfig: vi.fn().mockReturnValue({ EVE_API_URL: 'http://localhost:4801' }),
  writeCoordinationInbox: vi.fn().mockResolvedValue(undefined),
  writeThreadContext: vi.fn().mockResolvedValue(undefined),
  writeCarryoverContext: vi.fn().mockResolvedValue(undefined),
  createJobUserHome: vi.fn().mockResolvedValue('/tmp/eve-browser-test-home'),
  writeEveCredentials: vi.fn().mockResolvedValue(null),
}));

import { InvokeService } from './invoke.service';

describe('worker runner browser preflight', () => {
  it('stops before harness spawn when the final-env browser probe fails', async () => {
    mocks.probe.mockRejectedValueOnce(new Error('Chromium cannot launch'));
    const db = vi.fn(async () => []);
    const service = new InvokeService(db as never);
    const inner = service as unknown as Record<string, unknown>;
    inner.resolveEveAgentCliCommand = vi.fn().mockResolvedValue({ binary: 'eve-agent-cli', prefixArgs: [] });
    inner.resolveBudgetEnforcementConfig = vi.fn().mockResolvedValue(null);
    inner.logLifecycleEvent = vi.fn().mockResolvedValue(undefined);
    inner.buildCoordinationDb = vi.fn().mockReturnValue({});
    inner.buildCarryoverContextDb = vi.fn().mockReturnValue({});
    (service as unknown as { jobs: unknown }).jobs = { updateRuntimeMeta: vi.fn().mockResolvedValue(undefined) };
    const invocation = { jobId: 'job-test', attemptId: '00000000-0000-0000-0000-000000000001',
      projectId: 'proj-test', text: 'test', toolchains: ['browser'] } as unknown as HarnessInvocation;

    await expect((inner.executeEveAgentCli as Function).call(service, invocation,
      { harness: 'codex', permission: 'default', env: {} }, '/tmp')).rejects.toThrow(/Browser setup failed: Chromium cannot launch/);
    expect(mocks.probe).toHaveBeenCalledOnce();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('classifies a browser setup failure with the requested image and pulled image ID', async () => {
    const imageId = 'docker-pullable://browser@sha256:abc';
    const db = vi.fn(async () => [{ runtime_meta: { toolchains: { image_ids: { browser: imageId } } } }]);
    const service = new InvokeService(db as never);
    const inner = service as unknown as Record<string, unknown>;
    inner.applyManifestDefaults = vi.fn().mockRejectedValue(new ToolchainProvisionError(
      'Chromium cannot launch', 'browser', 'eve-horizon/toolchain-browser:local'));
    const updateRuntimeMeta = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { jobs: unknown }).jobs = { updateRuntimeMeta };
    const invocation = { jobId: 'job-test', attemptId: '00000000-0000-0000-0000-000000000001',
      projectId: 'proj-test', text: 'test', toolchains: ['browser'] } as unknown as HarnessInvocation;

    const result = await service.execute(invocation);
    expect(result).toMatchObject({ success: false, exitCode: 1,
      error: expect.stringContaining('toolchain_unavailable: browser setup failed from eve-horizon/toolchain-browser:local') });
    expect(updateRuntimeMeta).toHaveBeenCalledWith(invocation.attemptId, { toolchains: expect.objectContaining({
      requested: ['browser'], error_code: 'toolchain_unavailable', image_ids: { browser: imageId },
    }) });
  });
});
