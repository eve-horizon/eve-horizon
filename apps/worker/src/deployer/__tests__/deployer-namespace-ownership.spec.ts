import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeployerService } from '../deployer.service.js';
import { K8sService, NamespaceOwnershipError } from '../k8s.service.js';

const LABELS = {
  'eve.org_id': 'org_b',
  'eve.project_id': 'proj_b',
  'eve.env_id': 'env_b',
  'eve.env': 'staging',
};

function k8sError(statusCode: number): Error {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode, response: { statusCode } });
}

describe('K8sService.createNamespace ownership', () => {
  let coreApi: Record<string, ReturnType<typeof vi.fn>>;
  let k8s: K8sService;

  beforeEach(() => {
    coreApi = {
      readNamespace: vi.fn(),
      createNamespace: vi.fn().mockResolvedValue({}),
      replaceNamespace: vi.fn().mockResolvedValue({}),
    };
    k8s = new K8sService();
    Object.assign(k8s as any, { coreApi, available: true });
  });

  const namespace = (labels?: Record<string, string>) => ({ body: { metadata: { name: 'eve-a-web-prod', labels } } });

  it('creates a missing namespace with the env labels', async () => {
    coreApi.readNamespace.mockRejectedValue(k8sError(404));

    await k8s.createNamespace('eve-a-web-prod', LABELS, { ownerLabel: 'eve.env_id' });

    expect(coreApi.createNamespace).toHaveBeenCalledWith({ metadata: { name: 'eve-a-web-prod', labels: LABELS } });
  });

  it('merges labels into a namespace the env already owns', async () => {
    coreApi.readNamespace.mockResolvedValue(namespace({ ...LABELS, 'team': 'x' }));

    await k8s.createNamespace('eve-a-web-prod', LABELS, { ownerLabel: 'eve.env_id' });

    expect(coreApi.replaceNamespace).toHaveBeenCalledWith('eve-a-web-prod', {
      metadata: { name: 'eve-a-web-prod', labels: { ...LABELS, team: 'x' } },
    });
  });

  it('refuses a namespace another environment owns', async () => {
    coreApi.readNamespace.mockResolvedValue(namespace({ ...LABELS, 'eve.env_id': 'env_a' }));

    const result = k8s.createNamespace('eve-a-web-prod', LABELS, { ownerLabel: 'eve.env_id' });

    await expect(result).rejects.toBeInstanceOf(NamespaceOwnershipError);
    await expect(result).rejects.toThrow('belongs to another Eve environment');
    expect(coreApi.replaceNamespace).not.toHaveBeenCalled();
  });

  it('refuses a namespace Eve did not create', async () => {
    coreApi.readNamespace.mockResolvedValue(namespace({ 'kubernetes.io/metadata.name': 'kube-system' }));

    await expect(k8s.createNamespace('kube-system', LABELS, { ownerLabel: 'eve.env_id' }))
      .rejects.toThrow('was not created by Eve for this environment (no eve.env_id label)');
    expect(coreApi.replaceNamespace).not.toHaveBeenCalled();
  });

  it('checks the owner of a namespace created concurrently', async () => {
    coreApi.readNamespace
      .mockRejectedValueOnce(k8sError(404))
      .mockResolvedValueOnce(namespace({ ...LABELS, 'eve.env_id': 'env_a' }));
    coreApi.createNamespace.mockRejectedValue(k8sError(409));

    await expect(k8s.createNamespace('eve-a-web-prod', LABELS, { ownerLabel: 'eve.env_id' }))
      .rejects.toBeInstanceOf(NamespaceOwnershipError);
  });

  it('keeps merging labels when no owner label is requested', async () => {
    coreApi.readNamespace.mockResolvedValue(namespace({ other: 'y' }));

    await k8s.createNamespace('eve-a-web-prod', { a: 'b' });

    expect(coreApi.replaceNamespace).toHaveBeenCalledWith('eve-a-web-prod', {
      metadata: { name: 'eve-a-web-prod', labels: { other: 'y', a: 'b' } },
    });
  });

  it('reports namespace labels, or null when the namespace is absent', async () => {
    coreApi.readNamespace.mockResolvedValueOnce(namespace(LABELS)).mockRejectedValueOnce(k8sError(404));

    await expect(k8s.getNamespaceLabels('eve-a-web-prod')).resolves.toEqual(LABELS);
    await expect(k8s.getNamespaceLabels('gone')).resolves.toBeNull();
  });
});

describe('DeployerService namespace ownership', () => {
  function deployerWith(k8sService: Record<string, unknown>) {
    const deployer = new DeployerService(null as any, k8sService as any);
    Object.assign(deployer as any, {
      environments: {
        findById: vi.fn().mockResolvedValue({
          id: 'env_b',
          project_id: 'proj_b',
          name: 'staging',
          // A user-chosen namespace pointing at another project's env.
          namespace: 'eve-a-web-prod',
          overrides_json: null,
        }),
      },
      releases: {
        findById: vi.fn().mockResolvedValue({ id: 'rel_1', project_id: 'proj_b', manifest_hash: 'h', image_digests_json: null }),
      },
      projects: { findById: vi.fn().mockResolvedValue({ id: 'proj_b', org_id: 'org_b', slug: 'mobile', repo_url: null }) },
      orgs: { findById: vi.fn().mockResolvedValue({ id: 'org_b', slug: 'beta' }) },
      manifests: { findByProjectAndHash: vi.fn().mockResolvedValue({ manifest_yaml: 'name: test\nservices: {}' }) },
    });
    return deployer;
  }

  it('asks for ownership and stops before touching a namespace another env owns', async () => {
    const k8sService = {
      createNamespace: vi.fn().mockRejectedValue(
        new NamespaceOwnershipError('Namespace "eve-a-web-prod" belongs to another Eve environment'),
      ),
      applyManifest: vi.fn(),
    };
    const deployer = deployerWith(k8sService);

    await expect(deployer.deploy('env_b', 'rel_1', { skipPreflight: true }))
      .rejects.toThrow('belongs to another Eve environment');
    expect(k8sService.createNamespace).toHaveBeenCalledWith(
      'eve-a-web-prod',
      expect.objectContaining({ 'eve.env_id': 'env_b' }),
      { ownerLabel: 'eve.env_id' },
    );
    expect(k8sService.applyManifest).not.toHaveBeenCalled();
  });

  it('does not delete a namespace the deleted env does not own', async () => {
    const k8sService = {
      getNamespaceLabels: vi.fn().mockResolvedValue({ 'eve.env_id': 'env_a' }),
      deleteNamespace: vi.fn(),
    };
    const deployer = deployerWith(k8sService);
    (deployer as any).objectStoreProvisioner.removeObjectStoreBinding = vi.fn().mockResolvedValue(undefined);
    (deployer as any).storageBuckets = { deleteByEnv: vi.fn().mockResolvedValue(0) };

    await deployer.deleteEnvironment('env_b');

    expect(k8sService.deleteNamespace).not.toHaveBeenCalled();
  });

  it('deletes the namespace the env owns', async () => {
    const k8sService = {
      getNamespaceLabels: vi.fn().mockResolvedValue({ 'eve.env_id': 'env_b' }),
      deleteNamespace: vi.fn().mockResolvedValue(undefined),
    };
    const deployer = deployerWith(k8sService);
    (deployer as any).objectStoreProvisioner.removeObjectStoreBinding = vi.fn().mockResolvedValue(undefined);
    (deployer as any).storageBuckets = { deleteByEnv: vi.fn().mockResolvedValue(0) };

    await deployer.deleteEnvironment('env_b');

    expect(k8sService.deleteNamespace).toHaveBeenCalledWith('eve-a-web-prod');
  });
});
