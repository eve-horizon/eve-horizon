import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No kubeconfig is read and no cluster is contacted.
vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromDefault() {
      throw new Error('no kubeconfig in tests');
    }
  },
  CoreV1Api: class {},
  AppsV1Api: class {},
}));

const db = vi.hoisted(() => ({
  orgs: { findById: vi.fn(), findBySlug: vi.fn() },
  endpoints: { findByNameAndOrg: vi.fn(), updateStatus: vi.fn() },
}));

vi.mock('@eve/db', () => ({
  orgQueries: vi.fn(() => db.orgs),
  privateEndpointQueries: vi.fn(() => db.endpoints),
}));

import { PrivateEndpointsService } from './private-endpoints.service';

function endpoint(healthPath: string | null) {
  return {
    id: 'pe_1',
    name: 'llm',
    org_id: 'org_1',
    provider: 'tailscale',
    hostname: 'gpu-box',
    port: 8080,
    protocol: 'http',
    status: 'ready',
    status_msg: null,
    k8s_svc_name: 'acme-llm',
    k8s_namespace: 'eve-tunnels',
    k8s_dns: 'acme-llm.eve-tunnels.svc.cluster.local',
    health_path: healthPath,
    created_at: new Date('2026-11-10T00:00:00Z'),
    updated_at: new Date('2026-11-10T00:00:00Z'),
  };
}

describe('private endpoint health probe', () => {
  const fetchMock = vi.fn();
  let service: PrivateEndpointsService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    db.orgs.findById.mockResolvedValue({ id: 'org_1', slug: 'acme' });
    db.endpoints.updateStatus.mockResolvedValue(undefined);
    service = new PrivateEndpointsService({} as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('probes a plain path on the endpoint\'s own cluster URL', async () => {
    db.endpoints.findByNameAndOrg.mockResolvedValue(endpoint('/v1/models'));

    const result = await service.healthCheck('org_1', 'llm');

    expect(result.health.reachable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://acme-llm.eve-tunnels.svc.cluster.local:8080/v1/models');
  });

  it.each([
    '@169.254.169.254/latest/meta-data/',
    '//169.254.169.254/latest/meta-data/',
    'http://169.254.169.254/latest/meta-data/',
    '\\\\169.254.169.254\\latest',
  ])('does not probe a stored health_path that is not a plain path (%s)', async (healthPath) => {
    db.endpoints.findByNameAndOrg.mockResolvedValue(endpoint(healthPath));

    const result = await service.healthCheck('org_1', 'llm');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.health.reachable).toBe(false);
    expect(result.health.error).toMatch(/health_path/);
  });
  it('does not follow a redirect and reports it as unhealthy', async () => {
    db.endpoints.findByNameAndOrg.mockResolvedValue(endpoint('/v1/models'));
    // Like the real fetch: follows a redirect unless told not to.
    const visited: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      visited.push(String(url));
      if (String(url).endsWith('/v1/models')) {
        if ((init?.redirect ?? 'follow') === 'follow') {
          visited.push('http://169.254.169.254/latest/meta-data/');
          return new Response('ok', { status: 200 });
        }
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
      }
      return new Response('ok', { status: 200 });
    });

    const result = await service.healthCheck('org_1', 'llm');

    expect(visited).toEqual(['http://acme-llm.eve-tunnels.svc.cluster.local:8080/v1/models']);
    expect(result.health.reachable).toBe(false);
    expect(result.health.http_status).toBe(302);
  });
});
