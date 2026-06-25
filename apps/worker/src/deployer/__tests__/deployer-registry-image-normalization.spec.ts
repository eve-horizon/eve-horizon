import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeployerService } from '../deployer.service.js';

describe('DeployerService - registry image normalization', () => {
  const getServiceClusterIP = vi.fn();
  let deployer: DeployerService;

  beforeEach(() => {
    getServiceClusterIP.mockReset();
    deployer = new DeployerService(null as any, { getServiceClusterIP } as any);
  });

  it('keeps eve-registry .svc host unchanged for insecure-registry pulls', async () => {
    getServiceClusterIP.mockResolvedValue('10.43.234.46');
    const image = 'eve-registry.eve.svc.cluster.local:5000/evepm/api:v0.1.0';

    const normalized = await (deployer as any).normalizeImageForKubelet(image);

    expect(getServiceClusterIP).not.toHaveBeenCalled();
    expect(normalized).toBe(image);
  });

  it('rewrites non-registry .svc hosts to ClusterIP for kubelet pulls', async () => {
    getServiceClusterIP.mockResolvedValue('10.43.234.46');
    const image = 'custom-registry.eve.svc.cluster.local:5000/evepm/api:v0.1.0';

    const normalized = await (deployer as any).normalizeImageForKubelet(image);

    expect(getServiceClusterIP).toHaveBeenCalledWith('eve', 'custom-registry');
    expect(normalized).toBe('10.43.234.46:5000/evepm/api:v0.1.0');
  });

  it('keeps original image when service ClusterIP cannot be resolved', async () => {
    getServiceClusterIP.mockResolvedValue(null);
    const image = 'eve-registry.eve.svc:5000/evepm/web@sha256:abc123';

    const normalized = await (deployer as any).normalizeImageForKubelet(image);

    expect(getServiceClusterIP).not.toHaveBeenCalled();
    expect(normalized).toBe(image);
  });

  it('leaves external registry images unchanged', async () => {
    const image = 'ghcr.io/eve-horizon/eve-pm-api:v0.1.0';

    const normalized = await (deployer as any).normalizeImageForKubelet(image);

    expect(getServiceClusterIP).not.toHaveBeenCalled();
    expect(normalized).toBe(image);
  });

  it('reuses digest from sibling service with same image repository', () => {
    const services = {
      api: { image: 'eve-registry.eve.svc:5000/evepm/api' },
      migrate: { image: 'eve-registry.eve.svc:5000/evepm/api:v0.1.0' },
    };
    const imageDigests = { api: 'sha256:abc123' };

    const digest = (deployer as any).resolveServiceDigest('migrate', services.migrate, services, imageDigests);

    expect(digest).toBe('sha256:abc123');
  });

  it('prefers direct service digest when available', () => {
    const services = {
      api: { image: 'eve-registry.eve.svc:5000/evepm/api' },
      migrate: { image: 'eve-registry.eve.svc:5000/evepm/api:v0.1.0' },
    };
    const imageDigests = { api: 'sha256:abc123', migrate: 'sha256:def456' };

    const digest = (deployer as any).resolveServiceDigest('migrate', services.migrate, services, imageDigests);

    expect(digest).toBe('sha256:def456');
  });

  it('normalizes bare internal EVE_API_URL for cross-namespace service pods', () => {
    const normalized = (deployer as any).resolveServiceEveApiUrl('http://eve-api:4701');
    expect(normalized).toBe('http://eve-api.eve.svc.cluster.local:4701');
  });

  it('keeps EVE_API_URL unchanged when already fully-qualified', () => {
    const normalized = (deployer as any).resolveServiceEveApiUrl('http://api.eve.lvh.me');
    expect(normalized).toBe('http://api.eve.lvh.me');
  });

  describe('prefixRegistryHost', () => {
    it('prefixes bare image with registry host', () => {
      const result = (deployer as any).prefixRegistryHost('evepm/api', 'eve-registry.eve.svc:5000');
      expect(result).toBe('eve-registry.eve.svc:5000/evepm/api');
    });

    it('prefixes single-segment image with registry host', () => {
      const result = (deployer as any).prefixRegistryHost('myapp', 'ghcr.io');
      expect(result).toBe('ghcr.io/myapp');
    });

    it('leaves image unchanged when it already has a registry (dot in first segment)', () => {
      const result = (deployer as any).prefixRegistryHost('ghcr.io/org/app', 'eve-registry.eve.svc:5000');
      expect(result).toBe('ghcr.io/org/app');
    });

    it('leaves image unchanged when it already has a registry (colon in first segment)', () => {
      const result = (deployer as any).prefixRegistryHost('registry:5000/app', 'eve-registry.eve.svc:5000');
      expect(result).toBe('registry:5000/app');
    });

    it('leaves image unchanged when first segment is localhost', () => {
      const result = (deployer as any).prefixRegistryHost('localhost/myapp', 'eve-registry.eve.svc:5000');
      expect(result).toBe('localhost/myapp');
    });

    it('returns image unchanged when registryHost is null', () => {
      const result = (deployer as any).prefixRegistryHost('evepm/api', null);
      expect(result).toBe('evepm/api');
    });

    it('returns empty string unchanged', () => {
      const result = (deployer as any).prefixRegistryHost('', 'eve-registry.eve.svc:5000');
      expect(result).toBe('');
    });

    it('leaves .svc qualified images unchanged', () => {
      const result = (deployer as any).prefixRegistryHost(
        'eve-registry.eve.svc.cluster.local:5000/evepm/migrate',
        'eve-registry.eve.svc:5000',
      );
      expect(result).toBe('eve-registry.eve.svc.cluster.local:5000/evepm/migrate');
    });
  });
});
