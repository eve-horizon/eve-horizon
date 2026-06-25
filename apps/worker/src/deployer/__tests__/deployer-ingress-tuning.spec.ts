import { beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'yaml';
import { DeployerService } from '../deployer.service.js';

const defaultConfig = {
  EVE_API_URL: 'http://api.eve.test',
  EVE_DEFAULT_DOMAIN: 'apps.test',
  EVE_DEFAULT_INGRESS_CLASS: 'nginx',
  EVE_DEFAULT_INGRESS_TIMEOUT: '300s',
  EVE_DEFAULT_INGRESS_MAX_BODY_SIZE: '10m',
  EVE_DEFAULT_TLS_CLUSTER_ISSUER: 'letsencrypt-test',
  EVE_DEFAULT_TLS_SECRET: undefined,
  EVE_TCP_INGRESS_PROVIDER: 'none',
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
    mintServiceToken: vi.fn().mockResolvedValue('service-token'),
  };
});

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

function buildManifest(ingress: Record<string, unknown>): string {
  return yaml.stringify({
    services: {
      web: {
        image: 'web:latest',
        ports: ['3000'],
        'x-eve': { ingress },
      },
    },
  });
}

function parseDocuments(manifestYaml: string): any[] {
  return yaml.parseAllDocuments(manifestYaml).map((doc: any) => doc.toJSON());
}

function annotationsFromManifest(manifestYaml: string): Record<string, string> {
  const parsed = yaml.parse(manifestYaml);
  return parsed.metadata.annotations;
}

describe('DeployerService - HTTP ingress tuning', () => {
  let deployer: DeployerService;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    configOverride = { ...defaultConfig };
    deployer = new DeployerService(null as any, null as any);
    warn = vi.fn();
    (deployer as any).logger = {
      warn,
      log: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  });

  function renderManifest(manifestYaml: string) {
    return (deployer as any).renderManifest({ manifestYaml, ...baseParams });
  }

  it('renders nginx annotations for default, custom-domain, and alias ingresses', async () => {
    const result = await renderManifest(buildManifest({
      public: true,
      port: 3000,
      alias: 'portal',
      domains: ['portal.example.com'],
      timeout: '600s',
      max_body_size: '100m',
    }));

    const docs = parseDocuments(result.manifestYaml);
    const defaultIngress = docs.find((doc) => doc.kind === 'Ingress');
    expect(defaultIngress.metadata.annotations).toMatchObject({
      'cert-manager.io/cluster-issuer': 'letsencrypt-test',
      'nginx.ingress.kubernetes.io/proxy-read-timeout': '600',
      'nginx.ingress.kubernetes.io/proxy-send-timeout': '600',
      'nginx.ingress.kubernetes.io/proxy-body-size': '100m',
    });

    expect(result.customDomainIngresses).toHaveLength(1);
    expect(annotationsFromManifest(result.customDomainIngresses[0].ingressManifest)).toMatchObject({
      'nginx.ingress.kubernetes.io/proxy-read-timeout': '600',
      'nginx.ingress.kubernetes.io/proxy-send-timeout': '600',
      'nginx.ingress.kubernetes.io/proxy-body-size': '100m',
    });

    expect(result.aliasIngresses).toHaveLength(1);
    expect(annotationsFromManifest(result.aliasIngresses[0].ingressManifest)).toMatchObject({
      'nginx.ingress.kubernetes.io/proxy-read-timeout': '600',
      'nginx.ingress.kubernetes.io/proxy-send-timeout': '600',
      'nginx.ingress.kubernetes.io/proxy-body-size': '100m',
    });
  });

  it('renders custom-domain ingress candidates from environment service overrides', async () => {
    const result = await renderManifest(yaml.stringify({
      services: {
        web: {
          image: 'web:latest',
          ports: ['3000'],
          'x-eve': {
            ingress: {
              public: true,
              port: 3000,
            },
          },
        },
      },
      environments: {
        test: {
          overrides: {
            services: {
              web: {
                'x-eve': {
                  ingress: {
                    public: true,
                    port: 3000,
                    domains: ['sandbox.example.com'],
                  },
                },
              },
            },
          },
        },
      },
    }));

    expect(result.customDomainIngresses).toHaveLength(1);
    expect(result.customDomainIngresses[0]).toMatchObject({
      hostname: 'sandbox.example.com',
      serviceName: 'web',
    });
  });

  it('applies platform defaults when manifest tuning fields are omitted', async () => {
    const docs = parseDocuments((await renderManifest(buildManifest({
      public: true,
      port: 3000,
    }))).manifestYaml);
    const ingress = docs.find((doc) => doc.kind === 'Ingress');

    expect(ingress.metadata.annotations).toMatchObject({
      'nginx.ingress.kubernetes.io/proxy-read-timeout': '300',
      'nginx.ingress.kubernetes.io/proxy-send-timeout': '300',
      'nginx.ingress.kubernetes.io/proxy-body-size': '10m',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips L7 annotations on Traefik and warns only for explicit tuning', async () => {
    configOverride = { ...defaultConfig, EVE_DEFAULT_INGRESS_CLASS: 'traefik' };

    const docs = parseDocuments((await renderManifest(buildManifest({
      public: true,
      port: 3000,
      timeout: '600s',
    }))).manifestYaml);
    const ingress = docs.find((doc) => doc.kind === 'Ingress');

    expect(ingress.metadata.annotations['cert-manager.io/cluster-issuer']).toBe('letsencrypt-test');
    expect(ingress.metadata.annotations['nginx.ingress.kubernetes.io/proxy-read-timeout']).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();
    await renderManifest(buildManifest({ public: true, port: 3000 }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips L7 annotations when the ingress class is unknown', async () => {
    configOverride = { ...defaultConfig, EVE_DEFAULT_INGRESS_CLASS: undefined };

    const docs = parseDocuments((await renderManifest(buildManifest({
      public: true,
      port: 3000,
      timeout: '600s',
      max_body_size: '100m',
    }))).manifestYaml);
    const ingress = docs.find((doc) => doc.kind === 'Ingress');

    expect(ingress.metadata.annotations['cert-manager.io/cluster-issuer']).toBe('letsencrypt-test');
    expect(ingress.metadata.annotations['nginx.ingress.kubernetes.io/proxy-read-timeout']).toBeUndefined();
    expect(ingress.metadata.annotations['nginx.ingress.kubernetes.io/proxy-body-size']).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects out-of-range manifest values with field path and hint', async () => {
    await expect(renderManifest(buildManifest({
      public: true,
      port: 3000,
      timeout: '3600s',
    }))).rejects.toThrow(/services.web.x-eve.ingress.timeout: timeout must be between 1s and 30m/);
  });
});
