import { describe, expect, it, vi } from 'vitest';
import { ActionExecutorService } from './action-executor.service.js';

/**
 * Build reuse must not hand back an image that lives outside where this build
 * would push it, e.g. one pushed before Eve registry images were namespaced
 * per project. Such a build is rebuilt instead.
 */
describe('ActionExecutorService.findReusableBuild', () => {
  function serviceWithArtifacts(imageRef: string) {
    const service = new ActionExecutorService(null as any, {} as any, {} as any);
    (service as any).builds = {
      listSpecs: vi.fn().mockResolvedValue([{ id: 'bld_1', git_sha: 'abc', manifest_hash: 'mh' }]),
      findLatestRunByBuildId: vi.fn().mockResolvedValue({ status: 'succeeded' }),
      listArtifacts: vi.fn().mockResolvedValue([
        { service_name: 'api', image_ref: imageRef, digest: 'sha256:1' },
      ]),
    };
    return service;
  }

  const expected = { api: 'registry.eve.example.com/proj_1/api' };

  it('reuses a build whose image is where this build would push it', async () => {
    const service = serviceWithArtifacts('registry.eve.example.com/proj_1/api');
    await expect(
      (service as any).findReusableBuild('proj_1', 'abc', 'mh', ['api'], expected),
    ).resolves.toEqual({ build_id: 'bld_1', image_digests: { api: 'sha256:1' } });
  });

  it('rebuilds when the earlier image is outside the project prefix', async () => {
    const service = serviceWithArtifacts('registry.eve.example.com/api');
    await expect(
      (service as any).findReusableBuild('proj_1', 'abc', 'mh', ['api'], expected),
    ).resolves.toBeNull();
  });
});
