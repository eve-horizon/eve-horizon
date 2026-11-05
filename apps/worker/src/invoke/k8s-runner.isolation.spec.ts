import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessInvocation } from '@eve/shared';
import { buildRunnerManifests } from './k8s-runner.js';

const KEYS = [
  'EVE_RUNNER_IMAGE', 'DATABASE_URL', 'EVE_RUNNER_SERVICE_ACCOUNT', 'EVE_RUNNER_AUTOMOUNT_SERVICE_ACCOUNT_TOKEN',
  'EVE_RUNNER_NODE_SELECTOR_KEY', 'EVE_RUNNER_NODE_SELECTOR_VALUE',
  'EVE_RUNNER_TAINT_KEY', 'EVE_RUNNER_TAINT_VALUE', 'EVE_RUNNER_TAINT_EFFECT',
] as const;
const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
  process.env.EVE_RUNNER_IMAGE = 'worker:test';
  process.env.DATABASE_URL = 'postgres://test';
});
afterEach(() => {
  for (const key of KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

const invocation = { jobId: 'job-test', attemptId: 'attempt-test', projectId: 'project-test',
  text: '', workspacePath: '/tmp/workspace' } as unknown as HarnessInvocation;

function podSpec() {
  const manifest = JSON.parse(buildRunnerManifests(invocation, 'eve', 'workspace', 'runner'));
  return manifest.items.find((item: { kind: string }) => item.kind === 'Pod').spec;
}

describe('worker runner pod isolation', () => {
  it('mounts no service account token and borrows no platform account by default', () => {
    const spec = podSpec();
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(spec).not.toHaveProperty('serviceAccountName');
    expect(spec.containers[0].securityContext).toMatchObject({
      runAsNonRoot: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] },
    });
  });

  it('uses a dedicated service account without its token', () => {
    process.env.EVE_RUNNER_SERVICE_ACCOUNT = 'eve-runner';
    expect(podSpec()).toMatchObject({ serviceAccountName: 'eve-runner', automountServiceAccountToken: false });
  });

  it('keeps the token off for a platform account unless the operator opts in', () => {
    process.env.EVE_RUNNER_SERVICE_ACCOUNT = 'eve-worker';
    expect(podSpec().automountServiceAccountToken).toBe(false);
    process.env.EVE_RUNNER_AUTOMOUNT_SERVICE_ACCOUNT_TOKEN = 'true';
    expect(podSpec().automountServiceAccountToken).toBe(true);
  });

  it('schedules onto the job pool so it can share node-local volumes with agents', () => {
    process.env.EVE_RUNNER_NODE_SELECTOR_KEY = 'pool';
    process.env.EVE_RUNNER_NODE_SELECTOR_VALUE = 'agents';
    process.env.EVE_RUNNER_TAINT_KEY = 'pool';
    process.env.EVE_RUNNER_TAINT_VALUE = 'agents';
    process.env.EVE_RUNNER_TAINT_EFFECT = 'NoSchedule';
    const spec = podSpec();
    expect(spec.nodeSelector).toEqual({ pool: 'agents' });
    expect(spec.tolerations).toEqual([{ key: 'pool', operator: 'Equal', value: 'agents', effect: 'NoSchedule' }]);
  });

  it('refuses to build a pod from half-configured placement', () => {
    process.env.EVE_RUNNER_NODE_SELECTOR_KEY = 'pool';
    expect(() => podSpec()).toThrow(/must be set together/);
  });
});
