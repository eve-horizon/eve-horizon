import { describe, expect, it } from 'vitest';
import { resolveRunnerPodIsolation, runnerUsesPlatformServiceAccount } from '../runner-pod.js';

describe('resolveRunnerPodIsolation', () => {
  it('defaults to no token and the namespace default service account', () => {
    expect(resolveRunnerPodIsolation({})).toEqual({ automountServiceAccountToken: false });
  });

  it('keeps the token unmounted for a named service account unless explicitly opted in', () => {
    expect(resolveRunnerPodIsolation({ EVE_RUNNER_SERVICE_ACCOUNT: 'eve-runner' }))
      .toEqual({ serviceAccountName: 'eve-runner', automountServiceAccountToken: false });
    expect(resolveRunnerPodIsolation({
      EVE_RUNNER_SERVICE_ACCOUNT: 'eve-runner', EVE_RUNNER_AUTOMOUNT_SERVICE_ACCOUNT_TOKEN: 'true',
    }).automountServiceAccountToken).toBe(true);
    expect(resolveRunnerPodIsolation({ EVE_RUNNER_AUTOMOUNT_SERVICE_ACCOUNT_TOKEN: 'yes-please' })
      .automountServiceAccountToken).toBe(false);
  });

  it('places runner pods on the configured pool and tolerates its taint', () => {
    expect(resolveRunnerPodIsolation({
      EVE_RUNNER_NODE_SELECTOR_KEY: 'pool', EVE_RUNNER_NODE_SELECTOR_VALUE: 'agents',
      EVE_RUNNER_TAINT_KEY: 'pool', EVE_RUNNER_TAINT_VALUE: 'agents', EVE_RUNNER_TAINT_EFFECT: 'NoSchedule',
    })).toEqual({
      automountServiceAccountToken: false,
      nodeSelector: { pool: 'agents' },
      tolerations: [{ key: 'pool', operator: 'Equal', value: 'agents', effect: 'NoSchedule' }],
    });
  });

  it('tolerates any value of a taint key when no value is given', () => {
    expect(resolveRunnerPodIsolation({ EVE_RUNNER_TAINT_KEY: 'dedicated' }).tolerations)
      .toEqual([{ key: 'dedicated', operator: 'Exists' }]);
  });

  it('co-locates with the pod holding a ReadWriteOnce org filesystem when asked', () => {
    expect(resolveRunnerPodIsolation({}).affinity).toBeUndefined();
    expect(resolveRunnerPodIsolation({
      EVE_RUNNER_POD_AFFINITY_KEY: 'app.kubernetes.io/name', EVE_RUNNER_POD_AFFINITY_VALUE: 'eve-agent-runtime',
    }).affinity).toEqual({
      podAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [{
          labelSelector: { matchLabels: { 'app.kubernetes.io/name': 'eve-agent-runtime' } },
          topologyKey: 'kubernetes.io/hostname',
        }],
      },
    });
  });

  it('fails loudly on half-configured placement', () => {
    expect(() => resolveRunnerPodIsolation({ EVE_RUNNER_NODE_SELECTOR_KEY: 'pool' }))
      .toThrow(/must be set together/);
    expect(() => resolveRunnerPodIsolation({ EVE_RUNNER_NODE_SELECTOR_VALUE: 'agents' }))
      .toThrow(/must be set together/);
    expect(() => resolveRunnerPodIsolation({ EVE_RUNNER_POD_AFFINITY_KEY: 'app.kubernetes.io/name' }))
      .toThrow(/must be set together/);
    expect(() => resolveRunnerPodIsolation({ EVE_RUNNER_TAINT_VALUE: 'agents' }))
      .toThrow(/need EVE_RUNNER_TAINT_KEY/);
    expect(() => resolveRunnerPodIsolation({ EVE_RUNNER_TAINT_KEY: 'pool', EVE_RUNNER_TAINT_EFFECT: 'NoScheduleX' }))
      .toThrow(/must be one of NoSchedule, PreferNoSchedule, NoExecute/);
  });

  it('flags platform service accounts that would hand job code their identity', () => {
    expect(runnerUsesPlatformServiceAccount(resolveRunnerPodIsolation({ EVE_RUNNER_SERVICE_ACCOUNT: 'eve-worker' }))).toBe(true);
    expect(runnerUsesPlatformServiceAccount(resolveRunnerPodIsolation({ EVE_RUNNER_SERVICE_ACCOUNT: 'eve-runner' }))).toBe(false);
    expect(runnerUsesPlatformServiceAccount(resolveRunnerPodIsolation({}))).toBe(false);
  });
});
