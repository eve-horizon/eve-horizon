import { beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'yaml';
import { DeployerService } from '../deployer.service.js';

const defaultConfig = {
  EVE_API_URL: 'http://eve-api.eve.svc.cluster.local:4701',
  EVE_PUBLIC_API_URL: 'https://api.example.com',
  EVE_REGISTRY_HOST: 'registry.example.com',
  EVE_DEFAULT_DOMAIN: 'apps.example.com',
  EVE_DEFAULT_INGRESS_CLASS: 'nginx',
  EVE_DEFAULT_INGRESS_TIMEOUT: '300s',
  EVE_DEFAULT_INGRESS_MAX_BODY_SIZE: '10m',
  EVE_DEFAULT_TLS_CLUSTER_ISSUER: 'letsencrypt-test',
  EVE_TCP_INGRESS_PROVIDER: 'none',
  EVE_COMPUTE_MODEL: 'k3s',
  EVE_STABLE_EGRESS_NODE_LABEL_KEY: 'eve.io/egress-pool',
  EVE_STABLE_EGRESS_NODE_LABEL_VALUE: 'stable',
  EVE_STABLE_EGRESS_TAINT_KEY: 'eve.io/egress-pool',
  EVE_STABLE_EGRESS_TAINT_VALUE: 'stable',
  EVE_STABLE_EGRESS_TAINT_EFFECT: 'NoSchedule',
};

let configOverride: Record<string, unknown> = {};

vi.mock('@eve/shared', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    loadConfig: () => ({ ...defaultConfig, ...configOverride }),
    resolveProjectSecrets: vi.fn().mockResolvedValue({ resolved: true, secrets: [], error: null }),
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

const domains = [
  'api.example.com',
  'registry.example.com',
  'dashboard.example.com',
  'web.apps.example.com',
  'shop.customer.io',
];

describe('DeployerService - reserved platform domains', () => {
  let deployer: DeployerService;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    configOverride = {};
    deployer = new DeployerService(null as any, null as any);
    warn = vi.fn();
    (deployer as any).logger = { warn, log: vi.fn(), error: vi.fn(), debug: vi.fn() };
  });

  async function renderedHostnames(): Promise<string[]> {
    const manifestYaml = yaml.stringify({
      services: {
        web: { image: 'web:latest', ports: ['3000'], 'x-eve': { ingress: { public: true, port: 3000, domains } } },
      },
    });
    const result = await (deployer as any).renderManifest({ manifestYaml, ...baseParams });
    return result.customDomainIngresses.map((entry: { hostname: string }) => entry.hostname);
  }

  it('never renders an ingress for the platform hosts', async () => {
    expect(await renderedHostnames()).toEqual(['dashboard.example.com', 'shop.customer.io']);
    expect(warn).toHaveBeenCalledWith(
      'Skipping custom domain "api.example.com": reserved for the platform (under "api.example.com")',
    );
    expect(warn).toHaveBeenCalledWith(
      'Skipping custom domain "registry.example.com": reserved for the platform (under "registry.example.com")',
    );
  });

  it('skips every host under EVE_RESERVED_DOMAINS and keeps external domains', async () => {
    configOverride = { EVE_RESERVED_DOMAINS: 'example.com' };

    expect(await renderedHostnames()).toEqual(['shop.customer.io']);
    expect(warn).toHaveBeenCalledWith(
      'Skipping custom domain "dashboard.example.com": reserved for the platform (under "example.com")',
    );
    // Hosts under the default app domain keep their own message.
    expect(warn).toHaveBeenCalledWith(
      'Skipping custom domain "web.apps.example.com": use alias for platform subdomains',
    );
  });
});
