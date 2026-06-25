import { beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'yaml';
import { DeployerService } from '../deployer.service.js';
import { K8sService } from '../k8s.service.js';

const defaultConfig = {
  EVE_API_URL: 'http://api.eve.test',
  EVE_DEFAULT_DOMAIN: '',
  EVE_DEFAULT_INGRESS_CLASS: undefined,
  EVE_DEFAULT_TLS_CLUSTER_ISSUER: undefined,
  EVE_DEFAULT_TLS_SECRET: undefined,
  EVE_TCP_INGRESS_PROVIDER: 'aws-nlb',
  EVE_TCP_INGRESS_HOSTED_ZONE: 'tcp.test',
  EVE_COMPUTE_MODEL: 'k3s',
  EVE_STABLE_EGRESS_NODE_LABEL_KEY: 'eve.io/egress-pool',
  EVE_STABLE_EGRESS_NODE_LABEL_VALUE: 'stable',
  EVE_STABLE_EGRESS_TAINT_KEY: 'eve.io/egress-pool',
  EVE_STABLE_EGRESS_TAINT_VALUE: 'stable',
  EVE_STABLE_EGRESS_TAINT_EFFECT: 'NoSchedule',
};

let configOverride: Record<string, unknown> = { ...defaultConfig };

vi.mock('@eve/shared', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    loadConfig: () => ({ ...defaultConfig, ...configOverride }),
    resolveProjectSecrets: vi.fn().mockResolvedValue({
      resolved: true,
      secrets: [],
      error: null,
    }),
    mintServiceToken: vi.fn().mockResolvedValue(null),
  };
});

function buildManifest(services: Record<string, unknown>): string {
  return yaml.stringify({ services });
}

const baseParams = {
  namespace: 'eve-myorg-myproj-test',
  envId: 'env_123',
  envName: 'test',
  projectSlug: 'myproj',
  projectId: 'proj_123',
  orgId: 'org_456',
  orgSlug: 'myorg',
  releaseId: 'rel_789',
};

describe('DeployerService - TCP ingress', () => {
  let deployer: DeployerService;

  beforeEach(() => {
    configOverride = { ...defaultConfig };
    deployer = new DeployerService(null as any, null as any);
  });

  function renderManifest(manifestYaml: string) {
    return (deployer as any).renderManifest({ manifestYaml, ...baseParams });
  }

  function parseDocuments(manifestYaml: string): any[] {
    return yaml.parseAllDocuments(manifestYaml).map((doc: any) => doc.toJSON());
  }

  function tcpService(docs: any[]): any {
    return docs.find((doc) => doc.kind === 'Service' && doc.metadata?.labels?.['eve.tcp_ingress'] === 'true');
  }

  it('renders an AWS NLB LoadBalancer Service and app env vars', async () => {
    const manifest = buildManifest({
      'device-edge': {
        image: 'device-edge:latest',
        ports: ['33334', '33400'],
        'x-eve': {
          tcp_ingress: {
            hostname: 'trackers',
            allow_cidrs: ['203.0.113.0/24'],
            listeners: [
              { name: 'bd-starlink', port: 33334 },
              { name: 'a1-gt06', port: 33400 },
            ],
          },
        },
      },
    });

    const result = await renderManifest(manifest);
    const docs = parseDocuments(result.manifestYaml);
    const lb = tcpService(docs);
    const clusterIp = docs.find((doc) => doc.kind === 'Service' && doc.spec?.type === 'ClusterIP');
    const deployment = docs.find((doc) => doc.kind === 'Deployment');

    expect(clusterIp).toBeDefined();
    expect(lb.metadata.name).toBe('test-device-edge-tcp');
    expect(lb.spec.type).toBe('LoadBalancer');
    expect(lb.spec.externalTrafficPolicy).toBe('Local');
    expect(lb.spec.loadBalancerSourceRanges).toEqual(['203.0.113.0/24']);
    expect(lb.spec.ports).toEqual([
      { name: 'bd-starlink', protocol: 'TCP', port: 33334, targetPort: 33334 },
      { name: 'a1-gt06', protocol: 'TCP', port: 33400, targetPort: 33400 },
    ]);
    expect(lb.metadata.annotations).toMatchObject({
      'service.beta.kubernetes.io/aws-load-balancer-type': 'external',
      'service.beta.kubernetes.io/aws-load-balancer-healthcheck-protocol': 'HTTP',
      'service.beta.kubernetes.io/aws-load-balancer-healthcheck-path': '/healthz',
      'eve.io/tcp-ingress-host': 'trackers.tcp.test',
      'eve.io/tcp-ingress-provider': 'aws-nlb',
    });
    expect(lb.metadata.annotations['service.beta.kubernetes.io/aws-load-balancer-healthcheck-protocol']).not.toBe('TCP');

    const env = deployment.spec.template.spec.containers[0].env;
    expect(env).toContainEqual({ name: 'EVE_TCP_PUBLIC_HOST', value: 'trackers.tcp.test' });
    expect(env).toContainEqual({ name: 'EVE_TCP_LISTENER_BD_STARLINK_PORT', value: '33334' });
    expect(env).toContainEqual({ name: 'EVE_TCP_LISTENER_BD_STARLINK_HOST', value: 'trackers.tcp.test' });
  });

  it('renders klipper LoadBalancer Services without AWS annotations', async () => {
    configOverride = { ...defaultConfig, EVE_TCP_INGRESS_PROVIDER: 'klipper' };
    const manifest = buildManifest({
      edge: {
        image: 'edge:latest',
        ports: ['33334'],
        'x-eve': { tcp_ingress: { listeners: [{ name: 'raw', port: 33334 }] } },
      },
    });

    const docs = parseDocuments((await renderManifest(manifest)).manifestYaml);
    const lb = tcpService(docs);

    expect(lb.spec.type).toBe('LoadBalancer');
    expect(lb.metadata.annotations['service.beta.kubernetes.io/aws-load-balancer-type']).toBeUndefined();
    expect(lb.metadata.annotations['eve.io/tcp-ingress-provider']).toBe('klipper');
  });

  it('renders no LoadBalancer Service when provider is none', async () => {
    configOverride = { ...defaultConfig, EVE_TCP_INGRESS_PROVIDER: 'none' };
    const manifest = buildManifest({
      edge: {
        image: 'edge:latest',
        ports: ['33334'],
        'x-eve': { tcp_ingress: { listeners: [{ name: 'raw', port: 33334 }] } },
      },
    });

    const docs = parseDocuments((await renderManifest(manifest)).manifestYaml);
    const deployment = docs.find((doc) => doc.kind === 'Deployment');
    expect(tcpService(docs)).toBeUndefined();
    expect((deployment.spec.template.spec.containers[0].env ?? []).some((env: any) => env.name === 'EVE_TCP_PUBLIC_HOST')).toBe(false);
  });

  it('validates TCP ingress declarations when provider is none', async () => {
    configOverride = { ...defaultConfig, EVE_TCP_INGRESS_PROVIDER: 'none' };
    await expect(renderManifest(buildManifest({
      edge: {
        image: 'edge:latest',
        ports: ['33334'],
        'x-eve': { tcp_ingress: { listeners: [{ name: 'raw', port: 33400 }] } },
      },
    }))).rejects.toThrow(/not declared/);
  });

  it('rejects duplicate listener ports, undeclared ports, invalid CIDRs, and NodePort-range app ports', async () => {
    await expect(renderManifest(buildManifest({
      edge: {
        image: 'edge:latest',
        ports: ['33334'],
        'x-eve': {
          tcp_ingress: {
            listeners: [
              { name: 'a', port: 33334 },
              { name: 'b', port: 33334 },
            ],
          },
        },
      },
    }))).rejects.toThrow(/duplicate listener port 33334/);

    await expect(renderManifest(buildManifest({
      edge: {
        image: 'edge:latest',
        ports: ['33334'],
        'x-eve': { tcp_ingress: { listeners: [{ name: 'raw', port: 33400 }] } },
      },
    }))).rejects.toThrow(/not declared/);

    await expect(renderManifest(buildManifest({
      edge: {
        image: 'edge:latest',
        ports: ['33334'],
        'x-eve': {
          tcp_ingress: {
            allow_cidrs: ['not-a-cidr'],
            listeners: [{ name: 'raw', port: 33334 }],
          },
        },
      },
    }))).rejects.toThrow(/invalid CIDR/);

    await expect(renderManifest(buildManifest({
      edge: {
        image: 'edge:latest',
        ports: ['30001'],
        'x-eve': { tcp_ingress: { listeners: [{ name: 'raw', port: 30001 }] } },
      },
    }))).rejects.toThrow(/NodePort range/);
  });

  it('keeps HTTP ingress rendering when both HTTP and TCP ingress are declared', async () => {
    configOverride = {
      ...defaultConfig,
      EVE_TCP_INGRESS_PROVIDER: 'klipper',
      EVE_DEFAULT_DOMAIN: 'lvh.me',
    };
    const manifest = buildManifest({
      api: {
        image: 'api:latest',
        ports: ['8080', '33334'],
        'x-eve': {
          ingress: { public: true, port: 8080 },
          tcp_ingress: { listeners: [{ name: 'raw', port: 33334 }] },
        },
      },
    });

    const docs = parseDocuments((await renderManifest(manifest)).manifestYaml);
    expect(docs.find((doc) => doc.kind === 'Ingress')).toBeDefined();
    expect(tcpService(docs)).toBeDefined();
  });

  it('garbage-collects stale TCP ingress Services', async () => {
    const listTcpIngressServices = vi.fn().mockResolvedValue([
      { name: 'test-edge-tcp', component: 'edge' },
      { name: 'test-old-tcp', component: 'old' },
    ]);
    const deleteService = vi.fn().mockResolvedValue(undefined);
    deployer = new DeployerService(null as any, { listTcpIngressServices, deleteService } as any);

    await (deployer as any).garbageCollectTcpIngressServices('eve-test', ['test-edge-tcp']);

    expect(deleteService).toHaveBeenCalledTimes(1);
    expect(deleteService).toHaveBeenCalledWith('eve-test', 'test-old-tcp');
  });

  it('preserves allocated nodePort values while editing LoadBalancer ports', () => {
    const service = Object.create(K8sService.prototype) as K8sService;
    const desired = {
      ports: [
        { name: 'bd-starlink', protocol: 'TCP', port: 33334, targetPort: 33334 },
        { name: 'a1-gt06', protocol: 'TCP', port: 33400, targetPort: 33400 },
      ],
    };
    const existing = {
      ports: [
        { name: 'bd-starlink', protocol: 'TCP', port: 33334, targetPort: 33334, nodePort: 31001 },
        { name: 'legacy-name', protocol: 'TCP', port: 33400, targetPort: 33400, nodePort: 31002 },
      ],
    };

    (service as any).preserveServiceNodePorts(desired, existing);

    expect(desired.ports).toEqual([
      { name: 'bd-starlink', protocol: 'TCP', port: 33334, targetPort: 33334, nodePort: 31001 },
      { name: 'a1-gt06', protocol: 'TCP', port: 33400, targetPort: 33400, nodePort: 31002 },
    ]);
  });
});
