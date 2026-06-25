import { describe, expect, it } from 'vitest';
import {
  DeployFailureError,
  classifyFromSnapshot,
  redactExcerpt,
  selectFailingPod,
  type ClusterSnapshot,
  type PodSnapshot,
} from '../deploy-failure.js';
import { K8sOperationError } from '../k8s-error.js';

function pod(partial: Partial<PodSnapshot> & Pick<PodSnapshot, 'name'>): PodSnapshot {
  return {
    name: partial.name,
    namespace: partial.namespace ?? 'eve-x',
    phase: partial.phase ?? 'Running',
    ready: partial.ready ?? false,
    restartCount: partial.restartCount ?? 0,
    service: partial.service ?? null,
    containers: partial.containers ?? [],
  };
}

function snapshot(pods: PodSnapshot[]): ClusterSnapshot {
  return { namespace: 'eve-x', pods, capturedAt: '2026-04-21T00:00:00Z' };
}

describe('selectFailingPod', () => {
  it('prefers pods with CrashLoopBackOff over healthy pods', () => {
    const healthy = pod({ name: 'web-1', ready: true });
    const crashing = pod({
      name: 'api-1',
      ready: false,
      containers: [
        {
          name: 'api',
          ready: false,
          restartCount: 5,
          state: 'waiting',
          waitingReason: 'CrashLoopBackOff',
        },
      ],
    });
    const picked = selectFailingPod(snapshot([healthy, crashing]));
    expect(picked?.name).toBe('api-1');
  });

  it('picks highest-restart pod when multiple are not-ready without bad reason', () => {
    const a = pod({ name: 'a', ready: false, restartCount: 1 });
    const b = pod({ name: 'b', ready: false, restartCount: 7 });
    const picked = selectFailingPod(snapshot([a, b]));
    expect(picked?.name).toBe('b');
  });

  it('returns first pod when all ready', () => {
    const a = pod({ name: 'a', ready: true });
    expect(selectFailingPod(snapshot([a]))?.name).toBe('a');
  });

  it('returns null for empty snapshot', () => {
    expect(selectFailingPod(snapshot([]))).toBeNull();
  });
});

describe('classifyFromSnapshot', () => {
  it('classifies CrashLoopBackOff as app_crash_loop with exit code', () => {
    const snap = snapshot([
      pod({
        name: 'api-58dbf9c44b-cljfg',
        service: 'api',
        ready: false,
        restartCount: 5,
        containers: [
          {
            name: 'api',
            ready: false,
            restartCount: 5,
            state: 'waiting',
            waitingReason: 'CrashLoopBackOff',
            lastTerminatedReason: 'Error',
            lastTerminatedExitCode: 1,
          },
        ],
      }),
    ]);

    const failure = classifyFromSnapshot(snap);
    expect(failure?.kind).toBe('app_crash_loop');
    if (failure?.kind === 'app_crash_loop') {
      expect(failure.exitCode).toBe(1);
      expect(failure.service).toBe('api');
      expect(failure.container).toBe('api');
    }
  });

  it('classifies ImagePullBackOff as image_pull_error', () => {
    const snap = snapshot([
      pod({
        name: 'web-1',
        service: 'web',
        ready: false,
        containers: [
          {
            name: 'web',
            ready: false,
            restartCount: 0,
            state: 'waiting',
            waitingReason: 'ImagePullBackOff',
            image: 'ghcr.io/org/web:missing',
          },
        ],
      }),
    ]);

    const failure = classifyFromSnapshot(snap);
    expect(failure?.kind).toBe('image_pull_error');
    if (failure?.kind === 'image_pull_error') {
      expect(failure.image).toBe('ghcr.io/org/web:missing');
    }
  });

  it('classifies current non-zero terminated container state as app_crash_loop', () => {
    const snap = snapshot([
      pod({
        name: 'worker-1',
        service: 'worker',
        ready: false,
        restartCount: 0,
        containers: [
          {
            name: 'worker',
            ready: false,
            restartCount: 0,
            state: 'terminated',
            terminatedReason: 'Error',
            terminatedExitCode: 2,
          },
        ],
      }),
    ]);

    const failure = classifyFromSnapshot(snap);
    expect(failure?.kind).toBe('app_crash_loop');
    if (failure?.kind === 'app_crash_loop') {
      expect(failure.exitCode).toBe(2);
      expect(failure.message).toContain('reason: Error');
    }
  });

  it('classifies K8sOperationError 422 on Ingress with "already defined" as ingress_conflict', () => {
    const k8sErr = new K8sOperationError(
      'K8s replace Ingress/api (422 Invalid): admission webhook denied the request: host "api.limelee.com" and path "/" is already defined in ingress eve-proj-prod/prod-api-cd',
      {
        statusCode: 422,
        reason: 'Invalid',
        operation: 'replace',
        resourceKind: 'Ingress',
        resourceName: 'api',
        namespace: 'eve-proj-staging',
        body: { message: 'already defined in ingress eve-proj-prod/prod-api-cd' },
      },
    );

    const failure = classifyFromSnapshot(null, k8sErr);
    expect(failure?.kind).toBe('ingress_conflict');
    if (failure?.kind === 'ingress_conflict') {
      expect(failure.conflictingIngress).toBe('eve-proj-prod/prod-api-cd');
    }
  });

  it('classifies K8sOperationError 422 on non-Ingress as manifest_invalid', () => {
    const k8sErr = new K8sOperationError(
      'K8s replace Deployment/api (422 Invalid): spec.replicas must be non-negative',
      {
        statusCode: 422,
        operation: 'replace',
        resourceKind: 'Deployment',
        resourceName: 'api',
        body: { message: 'spec.replicas must be non-negative' },
      },
    );

    const failure = classifyFromSnapshot(null, k8sErr);
    expect(failure?.kind).toBe('manifest_invalid');
  });

  it('classifies K8sOperationError 500 as k8s_api_error', () => {
    const k8sErr = new K8sOperationError(
      'K8s read Pod/foo (500 Internal): server error',
      { statusCode: 500, operation: 'read', resourceKind: 'Pod', resourceName: 'foo' },
    );
    const failure = classifyFromSnapshot(null, k8sErr);
    expect(failure?.kind).toBe('k8s_api_error');
  });

  it('classifies not-ready pods without crash as readiness_timeout', () => {
    const snap = snapshot([
      pod({
        name: 'api-1',
        ready: false,
        containers: [{ name: 'api', ready: false, restartCount: 0, state: 'running' }],
      }),
    ]);
    const failure = classifyFromSnapshot(snap);
    expect(failure?.kind).toBe('readiness_timeout');
  });

  it('returns null when everything is healthy and no underlying error', () => {
    const snap = snapshot([
      pod({ name: 'api-1', ready: true, containers: [{ name: 'api', ready: true, restartCount: 0, state: 'running' }] }),
    ]);
    expect(classifyFromSnapshot(snap)).toBeNull();
  });
});

describe('redactExcerpt', () => {
  it('caps at maxLines (default 20)', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const out = redactExcerpt(lines);
    expect(out.length).toBe(20);
    expect(out[0]).toBe('line 30');
  });

  it('redacts long opaque tokens and Bearer headers', () => {
    const lines = [
      'Authorization: Bearer abcd.efgh.ijklmnopqrstuv',
      'token=sk_mock_0123456789abcdef0123456789abcdef',
    ];
    const out = redactExcerpt(lines);
    expect(out.join(' ')).not.toContain('abcd.efgh.ijklmnopqrstuv');
    expect(out.join(' ')).not.toContain('sk_mock_0123456789abcdef0123456789abcdef');
    expect(out.join(' ')).toContain('[REDACTED]');
  });

  it('redacts caller-supplied secrets verbatim', () => {
    const lines = ['DATABASE_URL=postgres://user:supersecretpassword@host/db'];
    const out = redactExcerpt(lines, { secrets: ['supersecretpassword'] });
    expect(out[0]).toContain('[REDACTED]');
    expect(out[0]).not.toContain('supersecretpassword');
  });
});

describe('DeployFailureError', () => {
  it('message starts with [kind] prefix and failure is retrievable', () => {
    const err = new DeployFailureError({
      kind: 'app_crash_loop',
      service: 'api',
      pod: 'api-1',
      container: 'api',
      exitCode: 1,
      message: 'container exited 1',
    });
    expect(err.message).toBe('[app_crash_loop] container exited 1');
    expect(err.failure.kind).toBe('app_crash_loop');
  });

  it('tracks whether the manifest apply was attempted', () => {
    const err = new DeployFailureError(
      { kind: 'readiness_timeout', notReady: [], message: 'not ready' },
      undefined,
      { manifestApplied: true },
    );
    expect(err.manifestApplied).toBe(true);
  });
});
