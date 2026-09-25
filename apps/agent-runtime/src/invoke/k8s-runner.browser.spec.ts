import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessInvocation } from '@eve/shared';
import { buildRunnerManifests, readToolchainInitStatuses } from './k8s-runner.js';
import { InvokeService } from './invoke.service.js';
import { buildToolchainRuntimeMeta } from './toolchains.js';

const previous = { image: process.env.EVE_RUNNER_IMAGE, db: process.env.DATABASE_URL };
afterEach(() => {
  if (previous.image === undefined) delete process.env.EVE_RUNNER_IMAGE;
  else process.env.EVE_RUNNER_IMAGE = previous.image;
  if (previous.db === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previous.db;
});

describe('agent-runtime browser runner manifest', () => {
  it('classifies browser init pull failure before pod readiness', () => {
    expect(() => readToolchainInitStatuses([{ name: 'tc-browser', state: { waiting: { reason: 'ImagePullBackOff', message: 'not found' } } }], ['browser']))
      .toThrow(/toolchain_unavailable: browser init image eve-horizon\/toolchain-browser:local failed/);
    expect(readToolchainInitStatuses([{ name: 'tc-browser', imageID: 'docker-pullable://browser@sha256:abc' }], ['browser']))
      .toEqual({ browser: 'docker-pullable://browser@sha256:abc' });
  });

  it('injects python and browser with non-root runtime settings', () => {
    process.env.EVE_RUNNER_IMAGE = 'agent-runtime:test';
    process.env.DATABASE_URL = 'postgres://test';
    const invocation = { jobId: 'job-test', attemptId: 'attempt-test', projectId: 'project-test',
      text: 'browser test', workspacePath: '/tmp/workspace', toolchains: ['python', 'browser'] } as unknown as HarnessInvocation;
    const manifest = JSON.parse(buildRunnerManifests(invocation, 'eve', 'workspace', 'runner'));
    const pod = manifest.items.find((item: { kind: string }) => item.kind === 'Pod');
    expect(pod.spec.initContainers.map((container: { image: string }) => container.image)).toContain('eve-horizon/toolchain-browser:local');
    expect(pod.spec.containers[0].env).toContainEqual({ name: 'EVE_TOOLCHAIN_INIT_MOUNTED', value: 'true' });
    expect(pod.spec.containers[0].securityContext).toMatchObject({ runAsUser: 1000, allowPrivilegeEscalation: false });
  });

  it('keeps pulled image IDs through provisioning and failure metadata writes', async () => {
    const prior = process.env.EVE_TOOLCHAIN_INIT_MOUNTED;
    process.env.EVE_TOOLCHAIN_INIT_MOUNTED = 'true';
    const imageIds = { browser: 'docker-pullable://browser@sha256:abc' };
    const runtimeMeta: Record<string, unknown> = { toolchains: {
      requested: ['browser'], resolved: ['browser'], image_ids: imageIds,
    } };
    const db = vi.fn(async () => [{ runtime_meta: runtimeMeta }]);
    const service = new InvokeService(db as never);
    const updateRuntimeMeta = vi.fn(async (_id: string, update: Record<string, unknown>) => {
      Object.assign(runtimeMeta, update);
    });
    (service as unknown as { jobs: unknown }).jobs = { updateRuntimeMeta };
    const write = (service as unknown as { updateToolchainRuntimeMeta: (id: string, value: ReturnType<typeof buildToolchainRuntimeMeta>) => Promise<void> }).updateToolchainRuntimeMeta.bind(service);
    try {
      await write('00000000-0000-0000-0000-000000000001', buildToolchainRuntimeMeta({
        executionMode: 'inline', requested: ['browser'], resolved: ['browser'],
      }));
      await write('00000000-0000-0000-0000-000000000001', buildToolchainRuntimeMeta({
        executionMode: 'inline', requested: ['browser'], source: 'unavailable',
        errorCode: 'toolchain_unavailable', error: 'browser launch failed',
      }));
      expect(runtimeMeta.toolchains).toMatchObject({
        image_ids: imageIds, error_code: 'toolchain_unavailable', error: 'browser launch failed',
      });
      expect(updateRuntimeMeta).toHaveBeenCalledTimes(2);
    } finally {
      if (prior === undefined) delete process.env.EVE_TOOLCHAIN_INIT_MOUNTED;
      else process.env.EVE_TOOLCHAIN_INIT_MOUNTED = prior;
    }
  });
});
