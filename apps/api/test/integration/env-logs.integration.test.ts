import { describe, it, expect } from 'vitest';
import { EnvLogsService } from '../../src/environments/env-logs.service';

describe('EnvLogsService (integration seam)', () => {
  it('filters log lines with grep', async () => {
    // Pass a stub DB since the test provides namespace explicitly (no DB lookup needed)
    const service = new EnvLogsService({} as any);
    const logs = [
      '2026-01-27T00:00:00Z ok',
      '2026-01-27T00:00:01Z ERROR boom',
      '2026-01-27T00:00:02Z ok',
    ].join('\n');

    const listSpy = async (options: { namespace: string; labelSelector?: string }) => {
      expect(options.namespace).toBe('eve-proj-test-staging');
      expect(options.labelSelector).toBe(
        EnvLogsService.buildLabelSelector('proj_test', 'staging', 'api'),
      );
      return { items: [{ metadata: { name: 'pod-1' } }] };
    };

    (service as any).k8sAvailable = true;
    (service as any).k8sApi = {
      listNamespacedPod: listSpy,
      readNamespacedPodLog: async () => logs,
    };

    const response = await service.getServiceLogs('proj_test', 'staging', 'api', {
      grep: 'ERROR',
      tailLines: 100,
      namespace: 'eve-proj-test-staging',
    });

    expect(response.logs).toHaveLength(1);
    expect(response.logs[0]?.line).toContain('ERROR');
  });

  it('filters parsed JSON log lines by field path', async () => {
    const service = new EnvLogsService({} as any);
    const logs = [
      JSON.stringify({ level: 'info', req_id: 'req_1', req: { path: '/ok' }, status: 200 }),
      JSON.stringify({ level: 'error', req_id: 'req_2', req: { path: '/fail' }, status: 500 }),
      JSON.stringify({ level: 'error', msg: 'req_2 appears in text only', status: 200 }),
    ].join('\n');

    (service as any).k8sAvailable = true;
    (service as any).k8sApi = {
      listNamespacedPod: async () => ({ items: [{ metadata: { name: 'pod-1' } }] }),
      readNamespacedPodLog: async () => logs,
    };

    const response = await service.getServiceLogs('proj_test', 'staging', 'api', {
      filters: { req_id: 'req_2', status: '500', 'req.path': '/fail' },
      namespace: 'eve-proj-test-staging',
    });

    expect(response.logs).toHaveLength(1);
    expect(response.logs[0]?.fields?.req_id).toBe('req_2');
  });

  it('combines grep and structured filters', () => {
    const fields = EnvLogsService.parseJsonFields(JSON.stringify({ level: 'error', ok: true }));
    expect(
      EnvLogsService.matchesLine('{"level":"error","ok":true}', fields, {
        grep: 'level',
        filters: { ok: 'true' },
      }),
    ).toBe(true);
    expect(
      EnvLogsService.matchesLine('{"level":"error","ok":true}', fields, {
        grep: 'missing',
        filters: { ok: 'true' },
      }),
    ).toBe(false);
  });
});
