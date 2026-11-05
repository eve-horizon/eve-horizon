import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { CustomDomainsService } from './custom-domains.service';

const mocks = vi.hoisted(() => ({
  customDomains: {
    findByHostname: vi.fn(),
    countByProject: vi.fn(),
    claimOrUpdate: vi.fn(),
  },
}));

vi.mock('@eve/db', () => ({
  customDomainQueries: vi.fn(() => mocks.customDomains),
  environmentQueries: vi.fn(() => ({})),
  projectManifestQueries: vi.fn(() => ({})),
}));

describe('CustomDomainsService.register platform host protection', () => {
  let service: CustomDomainsService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DATABASE_URL', 'postgres://localhost/eve_test');
    vi.stubEnv('EVE_DEFAULT_DOMAIN', 'apps.example.com');
    vi.stubEnv('EVE_API_URL', 'https://api.example.com');
    vi.stubEnv('EVE_SSO_URL', 'https://sso.example.com');
    vi.stubEnv('SUPABASE_AUTH_EXTERNAL_URL', 'https://auth.example.com');
    vi.stubEnv('EVE_REGISTRY_HOST', 'registry.example.com');
    vi.stubEnv('EVE_PLATFORM_INGRESS_HOSTNAME', 'ingress.example.com');
    vi.stubEnv('EVE_RESERVED_DOMAINS', '');
    mocks.customDomains.findByHostname.mockResolvedValue(null);
    mocks.customDomains.countByProject.mockResolvedValue(0);
    mocks.customDomains.claimOrUpdate.mockImplementation(async (row: Record<string, unknown>) => ({
      ...row,
      environment_id: null,
      status: 'pending_dns',
      verified_at: null,
      ingress_name: null,
      created_at: new Date(),
      updated_at: new Date(),
    }));
    service = new CustomDomainsService({} as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['api.example.com', 'registry.example.com', 'sso.example.com', 'auth.example.com', 'ingress.example.com'])(
    'refuses the platform host %s',
    async (hostname) => {
      await expect(service.register('proj_1', { hostname, service_name: 'web' })).rejects.toThrow(
        new BadRequestException(
          `"${hostname}" is reserved for the platform (under "${hostname}") and cannot be a custom domain`,
        ),
      );
      expect(mocks.customDomains.claimOrUpdate).not.toHaveBeenCalled();
    },
  );

  it('refuses any host under a reserved parent domain', async () => {
    vi.stubEnv('EVE_RESERVED_DOMAINS', 'example.com');

    await expect(service.register('proj_1', { hostname: 'Dashboard.Example.com', service_name: 'web' })).rejects.toThrow(
      'is reserved for the platform (under "example.com")',
    );
    expect(mocks.customDomains.claimOrUpdate).not.toHaveBeenCalled();
  });

  it('keeps the ingress-alias message for hosts under the default app domain', async () => {
    vi.stubEnv('EVE_RESERVED_DOMAINS', 'example.com');

    await expect(service.register('proj_1', { hostname: 'shop.apps.example.com', service_name: 'web' })).rejects.toThrow(
      'is under the platform domain — use ingress alias instead',
    );
  });

  it.each(['www.customer.io', 'shop.example.org', 'api.example.com.customer.io'])(
    'registers the external domain %s',
    async (hostname) => {
      vi.stubEnv('EVE_RESERVED_DOMAINS', 'example.com');

      const result = await service.register('proj_1', { hostname, service_name: 'web' });

      expect(result.hostname).toBe(hostname);
      expect(mocks.customDomains.claimOrUpdate).toHaveBeenCalledWith(expect.objectContaining({ hostname }));
    },
  );
});
