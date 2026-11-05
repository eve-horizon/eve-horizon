import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'yaml';
import { verifyRegistryPullCredential } from '@eve/shared';
import { DeployerService } from '../deployer.service.js';

/**
 * The `eve-registry` pull secret written into each app namespace must carry a
 * project-scoped pull credential, never the platform's internal API key.
 */
describe('DeployerService - Eve registry pull secret', () => {
  const applyManifest = vi.fn();
  const bumpRegistryPullEpoch = vi.fn();
  let deployer: DeployerService;

  beforeEach(() => {
    applyManifest.mockReset();
    bumpRegistryPullEpoch.mockReset();
    bumpRegistryPullEpoch.mockResolvedValue(4);
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/eve_test');
    vi.stubEnv('EVE_REGISTRY_HOST', 'registry.eve.example.com');
    vi.stubEnv('EVE_INTERNAL_API_KEY', 'internal-key');
    deployer = new DeployerService(null as any, { applyManifest } as any);
    (deployer as any).environments = { bumpRegistryPullEpoch };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function writtenDockerConfig(): { auths: Record<string, { username: string; password: string; auth: string }> } {
    expect(applyManifest).toHaveBeenCalledTimes(1);
    const [namespace, manifest] = applyManifest.mock.calls[0] as [string, string];
    expect(namespace).toBe('eve-acme-shop-test');
    const secret = yaml.parse(manifest) as { type: string; data: Record<string, string> };
    expect(secret.type).toBe('kubernetes.io/dockerconfigjson');
    return JSON.parse(Buffer.from(secret.data['.dockerconfigjson'], 'base64').toString('utf8'));
  }

  it('writes a credential bound to the environment and a new pull epoch, not the internal key', async () => {
    const name = await (deployer as any).ensureImagePullSecret({
      namespace: 'eve-acme-shop-test',
      projectId: 'proj_shop',
      environmentId: 'env_test',
      manifestYaml: 'registry: eve\n',
    });

    expect(name).toBe('eve-registry');
    const dockerConfig = writtenDockerConfig();
    const entry = dockerConfig.auths['registry.eve.example.com'];
    expect(entry.username).toBe('eve-pull');
    expect(entry.password).not.toContain('internal-key');
    expect(Buffer.from(entry.auth, 'base64').toString('utf8')).not.toContain('internal-key');
    expect(bumpRegistryPullEpoch).toHaveBeenCalledWith('env_test');
    expect(verifyRegistryPullCredential(entry.password, 'internal-key')).toEqual({
      projectId: 'proj_shop',
      environmentId: 'env_test',
      namespace: 'eve-acme-shop-test',
      epoch: 4,
    });
  });

  it('refuses to write a secret for an environment that no longer exists', async () => {
    bumpRegistryPullEpoch.mockResolvedValue(null);
    await expect(
      (deployer as any).ensureImagePullSecret({
        namespace: 'eve-acme-shop-test',
        projectId: 'proj_shop',
        environmentId: 'env_gone',
        manifestYaml: 'registry: eve\n',
      }),
    ).rejects.toThrow(/env_gone/);
    expect(applyManifest).not.toHaveBeenCalled();
  });

  it('writes no secret when the internal key is missing', async () => {
    vi.stubEnv('EVE_INTERNAL_API_KEY', '');
    const name = await (deployer as any).ensureImagePullSecret({
      namespace: 'eve-acme-shop-test',
      projectId: 'proj_shop',
      environmentId: 'env_test',
      manifestYaml: 'registry: eve\n',
    });
    expect(name).toBeNull();
    expect(bumpRegistryPullEpoch).not.toHaveBeenCalled();
    expect(applyManifest).not.toHaveBeenCalled();
  });
});
