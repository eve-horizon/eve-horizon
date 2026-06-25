import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DeployerService } from '../deployer.service.js';

/**
 * Test the deployer's ownership-aware garbage collection of custom-domain
 * ingresses. These tests poke at the private method directly to keep the
 * surface area small — the full deploy() path is covered elsewhere.
 */
describe('DeployerService - custom domain GC ownership', () => {
  const listCustomDomainIngresses = vi.fn();
  const deleteIngress = vi.fn();
  const findByHostname = vi.fn();
  const updateStatus = vi.fn();

  let deployer: DeployerService;

  beforeEach(() => {
    listCustomDomainIngresses.mockReset();
    deleteIngress.mockReset();
    findByHostname.mockReset();
    updateStatus.mockReset();

    deployer = new DeployerService(
      null as any,
      {
        listCustomDomainIngresses,
        deleteIngress,
      } as any,
    );
    // Monkey-patch customDomains to only the methods we need
    (deployer as any).customDomains = {
      findByHostname,
      updateStatus,
    };
  });

  it('leaves status alone when GCing an ingress for a hostname owned by a sibling env', async () => {
    listCustomDomainIngresses.mockResolvedValue([
      { name: 'stale-ingress', hostname: 'example.com' },
    ]);
    findByHostname.mockResolvedValue({
      hostname: 'example.com',
      environment_id: 'env_other',
      status: 'active',
    });

    await (deployer as any).garbageCollectCustomDomainIngresses(
      'eve-proj-staging',
      [],
      'env_current',
    );

    expect(deleteIngress).toHaveBeenCalledWith('eve-proj-staging', 'stale-ingress');
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('marks status=removed when GCing an ingress for a hostname still owned by current env', async () => {
    listCustomDomainIngresses.mockResolvedValue([
      { name: 'stale-ingress', hostname: 'example.com' },
    ]);
    findByHostname.mockResolvedValue({
      hostname: 'example.com',
      environment_id: 'env_current',
      status: 'active',
    });

    await (deployer as any).garbageCollectCustomDomainIngresses(
      'eve-proj-staging',
      [],
      'env_current',
    );

    expect(deleteIngress).toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith('example.com', 'removed');
  });

  it('leaves status alone when the DB row is already unbound (no env owns it)', async () => {
    listCustomDomainIngresses.mockResolvedValue([
      { name: 'stale-ingress', hostname: 'example.com' },
    ]);
    findByHostname.mockResolvedValue({
      hostname: 'example.com',
      environment_id: null,
      status: 'active',
    });

    await (deployer as any).garbageCollectCustomDomainIngresses(
      'eve-proj-staging',
      [],
      'env_current',
    );

    expect(deleteIngress).toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('does not delete ingresses for hostnames still in desiredHostnames', async () => {
    listCustomDomainIngresses.mockResolvedValue([
      { name: 'current-ingress', hostname: 'example.com' },
      { name: 'stale-ingress', hostname: 'legacy.example.com' },
    ]);
    findByHostname.mockResolvedValue({
      hostname: 'legacy.example.com',
      environment_id: 'env_current',
      status: 'active',
    });

    await (deployer as any).garbageCollectCustomDomainIngresses(
      'eve-proj-staging',
      ['example.com'],
      'env_current',
    );

    expect(deleteIngress).toHaveBeenCalledTimes(1);
    expect(deleteIngress).toHaveBeenCalledWith('eve-proj-staging', 'stale-ingress');
  });

  it('unbinds a custom domain first bound by a deploy when apply later fails', async () => {
    const k8sService = {
      createNamespace: vi.fn().mockResolvedValue(undefined),
      listAliasIngresses: vi.fn().mockResolvedValue([]),
      listCustomDomainIngresses: vi.fn().mockResolvedValue([]),
      applyManifest: vi.fn().mockRejectedValue(new Error('apply failed')),
      listPodsWithLabel: vi.fn().mockResolvedValue([]),
    };
    const unbindDomainsForEnvironment = vi.fn().mockResolvedValue(1);

    deployer = new DeployerService(null as any, k8sService as any);
    (deployer as any).environments = {
      findById: vi.fn().mockResolvedValue({
        id: 'env_current',
        project_id: 'proj_1',
        name: 'staging',
        namespace: 'eve-proj-staging',
        overrides_json: null,
      }),
    };
    (deployer as any).releases = {
      findById: vi.fn().mockResolvedValue({
        id: 'rel_1',
        project_id: 'proj_1',
        manifest_hash: 'hash_1',
        image_digests_json: null,
      }),
    };
    (deployer as any).projects = {
      findById: vi.fn().mockResolvedValue({
        id: 'proj_1',
        org_id: 'org_1',
        slug: 'proj',
        repo_url: null,
      }),
    };
    (deployer as any).orgs = {
      findById: vi.fn().mockResolvedValue({ id: 'org_1', slug: 'org' }),
    };
    (deployer as any).manifests = {
      findByProjectAndHash: vi.fn().mockResolvedValue({
        manifest_yaml: 'name: test\nservices: {}',
      }),
    };
    (deployer as any).ingressAliases = {
      bindToEnvironment: vi.fn(),
      unbindAliasesForEnvironment: vi.fn(),
    };
    (deployer as any).customDomains = {
      claimOrUpdate: vi.fn().mockResolvedValue({
        hostname: 'app.example.com',
        project_id: 'proj_1',
        environment_id: null,
      }),
      bindToEnvironment: vi.fn().mockResolvedValue({
        hostname: 'app.example.com',
        project_id: 'proj_1',
        environment_id: 'env_current',
      }),
      updateStatus: vi.fn().mockResolvedValue(null),
      unbindDomainsForEnvironment,
    };
    (deployer as any).ensureImagePullSecret = vi.fn().mockResolvedValue(null);
    (deployer as any).renderManifest = vi.fn().mockResolvedValue({
      manifestYaml: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n',
      services: {},
      aliasIngresses: [],
      customDomainIngresses: [
        {
          hostname: 'app.example.com',
          serviceName: 'web',
          ingressManifest: 'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: app-cd\n',
          ingressName: 'app-cd',
          certSecretName: 'app-cd-tls',
        },
      ],
    });
    (deployer as any).verifyCustomDomainDns = vi.fn().mockResolvedValue({ ok: true, resolvedTo: 'A 127.0.0.1' });

    await expect(
      deployer.deploy('env_current', 'rel_1', { skipPreflight: true }),
    ).rejects.toThrow('apply failed');

    expect(unbindDomainsForEnvironment).toHaveBeenCalledWith(
      'env_current',
      ['app.example.com'],
    );
    expect((deployer as any).customDomains.claimOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'app.example.com', source: 'manifest' }),
    );
    expect((deployer as any).customDomains.bindToEnvironment).toHaveBeenCalledWith(
      'app.example.com',
      'proj_1',
      'env_current',
      'web',
      'manifest',
    );
  });
});
