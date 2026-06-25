import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PipelineExpanderService } from './pipeline-expander.service.js';

/**
 * Verifies the resolveManifestForRun behavior added in Phase 6 of the
 * deploy-error-surfacing plan. The real service owns a wide surface
 * (project lookup, job creation, etc.) — we only probe the private
 * resolver here because its correctness is what drives the whole
 * "deploy the manifest at the ref you asked for" promise.
 */
describe('PipelineExpanderService - manifest resolution by ref', () => {
  const findByProjectAndGitSha = vi.fn();
  const findLatestByProject = vi.fn();

  let service: PipelineExpanderService;

  beforeEach(() => {
    findByProjectAndGitSha.mockReset();
    findLatestByProject.mockReset();

    // We instantiate with a stub DB and swap the queries objects; the private
    // helper under test only touches `manifests`.
    service = new PipelineExpanderService({} as any);
    (service as any).manifests = {
      findByProjectAndGitSha,
      findLatestByProject,
    };
  });

  it('prefers the manifest synced for the requested git_sha', async () => {
    findByProjectAndGitSha.mockResolvedValue({
      id: 'pm_ref',
      manifest_hash: 'hash-for-ref',
    });

    const result = await (service as any).resolveManifestForRun('proj_x', 'abc1234');

    expect(result.manifest_hash).toBe('hash-for-ref');
    expect(findByProjectAndGitSha).toHaveBeenCalledWith('proj_x', 'abc1234');
    expect(findLatestByProject).not.toHaveBeenCalled();
  });

  it('falls back to latest when no manifest is synced for the ref', async () => {
    findByProjectAndGitSha.mockResolvedValue(null);
    findLatestByProject.mockResolvedValue({
      id: 'pm_latest',
      manifest_hash: 'hash-latest',
    });

    const result = await (service as any).resolveManifestForRun('proj_x', 'abc1234');

    expect(result.manifest_hash).toBe('hash-latest');
    expect(findByProjectAndGitSha).toHaveBeenCalledWith('proj_x', 'abc1234');
    expect(findLatestByProject).toHaveBeenCalledWith('proj_x');
  });

  it('uses latest when no git_sha is provided', async () => {
    findLatestByProject.mockResolvedValue({
      id: 'pm_latest',
      manifest_hash: 'hash-latest',
    });

    const result = await (service as any).resolveManifestForRun('proj_x', undefined);

    expect(result.manifest_hash).toBe('hash-latest');
    expect(findByProjectAndGitSha).not.toHaveBeenCalled();
  });

  it('returns null when neither ref-scoped nor latest manifest exists', async () => {
    findByProjectAndGitSha.mockResolvedValue(null);
    findLatestByProject.mockResolvedValue(null);

    const result = await (service as any).resolveManifestForRun('proj_x', 'abc1234');
    expect(result).toBeNull();
  });
});
