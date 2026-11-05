import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ProjectsService } from './projects.service';

const mocks = vi.hoisted(() => ({
  projectQueries: {
    findById: vi.fn(),
    hardDelete: vi.fn(),
    update: vi.fn(),
  },
  environmentQueries: {
    listByProject: vi.fn(),
    delete: vi.fn(),
  },
  managedDbQueries: {
    listTenantsByEnv: vi.fn(),
  },
}));

vi.mock('@eve/db', () => ({
  projectQueries: vi.fn(() => mocks.projectQueries),
  orgQueries: vi.fn(() => ({})),
  membershipQueries: vi.fn(() => ({})),
  userQueries: vi.fn(() => ({})),
  releaseQueries: vi.fn(() => ({})),
  agentConfigQueries: vi.fn(() => ({})),
  agentQueries: vi.fn(() => ({})),
  teamQueries: vi.fn(() => ({})),
  threadQueries: vi.fn(() => ({})),
  scheduleQueries: vi.fn(() => ({})),
  spendQueries: vi.fn(() => ({})),
  environmentQueries: vi.fn(() => mocks.environmentQueries),
  managedDbQueries: vi.fn(() => mocks.managedDbQueries),
}));

const project = { id: 'proj_1', org_id: 'org_1', deleted_at: null };
const environments = [
  { id: 'env_staging', name: 'staging' },
  { id: 'env_prod', name: 'prod' },
];

describe('ProjectsService.deleteProject', () => {
  let service: ProjectsService;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('EVE_WORKER_URLS', '');
    vi.stubEnv('WORKER_URL', 'http://worker.test');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    mocks.projectQueries.findById.mockResolvedValue(project);
    mocks.projectQueries.hardDelete.mockResolvedValue(true);
    mocks.projectQueries.update.mockResolvedValue({ ...project, deleted_at: new Date() });
    mocks.environmentQueries.listByProject.mockResolvedValue(environments);
    mocks.managedDbQueries.listTenantsByEnv.mockResolvedValue([]);
    service = new ProjectsService({} as never, {} as never, {} as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('hard-deletes with a single project delete after tearing down every environment', async () => {
    await service.deleteProject('proj_1', { hard: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.projectQueries.hardDelete).toHaveBeenCalledWith('proj_1');
    // Environments go with the project's cascade, never one by one beforehand.
    expect(mocks.environmentQueries.delete).not.toHaveBeenCalled();
  });

  it('ignores managed databases that are already destroyed', async () => {
    mocks.managedDbQueries.listTenantsByEnv.mockResolvedValue([
      { id: 'mdbt_old', status: 'deleted', deleted_at: new Date() },
    ]);

    await service.deleteProject('proj_1', { hard: true });

    expect(mocks.projectQueries.hardDelete).toHaveBeenCalledWith('proj_1');
  });

  it('refuses a hard delete that would orphan a live managed database, before any teardown', async () => {
    mocks.managedDbQueries.listTenantsByEnv.mockImplementation(async (envId: string) =>
      envId === 'env_prod' ? [{ id: 'mdbt_1', status: 'ready', deleted_at: null }] : [],
    );

    const attempt = service.deleteProject('proj_1', { hard: true });

    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow(/prod \(mdbt_1, ready\).*eve db destroy/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.projectQueries.hardDelete).not.toHaveBeenCalled();
  });

  it('hard-deletes past a live managed database when forced', async () => {
    mocks.managedDbQueries.listTenantsByEnv.mockResolvedValue([
      { id: 'mdbt_1', status: 'deleting', deleted_at: null },
    ]);

    await service.deleteProject('proj_1', { hard: true, force: true });

    expect(mocks.projectQueries.hardDelete).toHaveBeenCalledWith('proj_1');
  });

  it('soft-deletes without checking managed databases', async () => {
    mocks.managedDbQueries.listTenantsByEnv.mockResolvedValue([
      { id: 'mdbt_1', status: 'ready', deleted_at: null },
    ]);

    await service.deleteProject('proj_1');

    expect(mocks.managedDbQueries.listTenantsByEnv).not.toHaveBeenCalled();
    expect(mocks.projectQueries.update).toHaveBeenCalledWith('proj_1', { deleted: true });
    expect(mocks.projectQueries.hardDelete).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown project', async () => {
    mocks.projectQueries.findById.mockResolvedValue(null);

    await expect(service.deleteProject('proj_missing', { hard: true })).rejects.toBeInstanceOf(NotFoundException);
  });
});
