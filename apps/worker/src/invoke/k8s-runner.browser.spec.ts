import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessInvocation } from '@eve/shared';
import { buildRunnerManifests, readToolchainInitStatuses, resultFromRunnerEvent } from './k8s-runner.js';

const previous = { image: process.env.EVE_RUNNER_IMAGE, db: process.env.DATABASE_URL };
afterEach(() => {
  if (previous.image === undefined) delete process.env.EVE_RUNNER_IMAGE;
  else process.env.EVE_RUNNER_IMAGE = previous.image;
  if (previous.db === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previous.db;
});

describe('worker browser runner manifest', () => {
  it('classifies browser init pull failure before pod readiness', () => {
    expect(() => readToolchainInitStatuses([{ name: 'tc-browser', state: { waiting: { reason: 'ImagePullBackOff', message: 'not found' } } }], ['browser']))
      .toThrow(/toolchain_unavailable: browser init image eve-horizon\/toolchain-browser:local failed/);
    expect(readToolchainInitStatuses([{ name: 'tc-browser', imageID: 'docker-pullable://browser@sha256:abc' }], ['browser']))
      .toEqual({ browser: 'docker-pullable://browser@sha256:abc' });
  });

  it('injects python and browser with non-root runtime settings', () => {
    process.env.EVE_RUNNER_IMAGE = 'worker:test';
    process.env.DATABASE_URL = 'postgres://test';
    const invocation = { jobId: 'job-test', attemptId: 'attempt-test', projectId: 'project-test',
      text: 'browser test', workspacePath: '/tmp/workspace', toolchains: ['python', 'browser'] } as unknown as HarnessInvocation;
    const manifest = JSON.parse(buildRunnerManifests(invocation, 'eve', 'workspace', 'runner'));
    const pod = manifest.items.find((item: { kind: string }) => item.kind === 'Pod');
    expect(pod.spec.initContainers.map((container: { image: string }) => container.image)).toContain('eve-horizon/toolchain-browser:local');
    expect(pod.spec.containers[0].env).toContainEqual({ name: 'EVE_TOOLCHAIN_INIT_MOUNTED', value: 'true' });
    expect(pod.spec.containers[0].securityContext).toMatchObject({ runAsUser: 1000, allowPrivilegeEscalation: false });
  });

  it('marks both pod terminal event types as already emitted', () => {
    const completed = resultFromRunnerEvent({ id: 'event-1', type: 'runner.completed',
      payload_json: { jobId: 'job', attemptId: 'attempt', result: {
        attemptId: 'attempt', success: true, exitCode: 0,
      } as never } }, 'attempt');
    const failed = resultFromRunnerEvent({ id: 'event-2', type: 'runner.failed',
      payload_json: { jobId: 'job', attemptId: 'attempt', error: 'script failed', exitCode: 1 } }, 'attempt');
    expect(completed).toMatchObject({ success: true, runnerEventObserved: true });
    expect(failed).toMatchObject({ success: false, error: 'script failed', runnerEventObserved: true });
  });
});
