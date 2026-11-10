import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ProjectsService } from './projects.service';

const mocks = vi.hoisted(() => ({
  projects: {
    findById: vi.fn(),
    findByOrgAndName: vi.fn(),
    findByOrgAndSlug: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  orgs: { findById: vi.fn() },
}));

vi.mock('@eve/db', () => ({
  projectQueries: vi.fn(() => mocks.projects),
  orgQueries: vi.fn(() => mocks.orgs),
  membershipQueries: vi.fn(() => ({})),
  userQueries: vi.fn(() => ({})),
  releaseQueries: vi.fn(() => ({})),
  agentConfigQueries: vi.fn(() => ({})),
  agentQueries: vi.fn(() => ({})),
  teamQueries: vi.fn(() => ({})),
  threadQueries: vi.fn(() => ({})),
  scheduleQueries: vi.fn(() => ({})),
  spendQueries: vi.fn(() => ({})),
  environmentQueries: vi.fn(() => ({})),
  managedDbQueries: vi.fn(() => ({})),
}));

const row = (repoUrl: string) => ({
  id: 'proj_1',
  org_id: 'org_1',
  name: 'Shop',
  slug: 'shop',
  repo_url: repoUrl,
  branch: 'main',
  deleted_at: null,
  created_at: new Date('2026-11-10T00:00:00Z'),
  updated_at: new Date('2026-11-10T00:00:00Z'),
});

describe('file:// repo URLs need the local development setting', () => {
  let service: ProjectsService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('EVE_ALLOW_FILE_REPO_URLS', '');
    mocks.orgs.findById.mockResolvedValue({ id: 'org_1', slug: 'acme' });
    mocks.projects.findByOrgAndName.mockResolvedValue(null);
    mocks.projects.findByOrgAndSlug.mockResolvedValue(null);
    mocks.projects.findById.mockResolvedValue(row('https://github.com/acme/shop'));
    mocks.projects.create.mockImplementation(async (data: { repo_url: string }) => row(data.repo_url));
    mocks.projects.update.mockImplementation(async (_id: string, data: { repo_url?: string }) => row(data.repo_url ?? ''));
    service = new ProjectsService({} as never, {} as never, {} as never);
    (service as any).assignOwner = vi.fn(async () => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const fileUrl = 'file:///';

  it('refuses create, ensure and update with a file:// URL by default', async () => {
    await expect(service.create({ org_id: 'org_1', name: 'Shop', repo_url: fileUrl, branch: 'main' }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.ensure({ org_id: 'org_1', name: 'Shop', repo_url: fileUrl, branch: 'main' }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update('proj_1', { repo_url: fileUrl }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.projects.create).not.toHaveBeenCalled();
    expect(mocks.projects.update).not.toHaveBeenCalled();
  });

  it('accepts a file:// URL when EVE_ALLOW_FILE_REPO_URLS is on', async () => {
    vi.stubEnv('EVE_ALLOW_FILE_REPO_URLS', 'true');

    await expect(service.create({ org_id: 'org_1', name: 'Shop', repo_url: 'file:///work/shop', branch: 'main' }))
      .resolves.toMatchObject({ repo_url: 'file:///work/shop' });
  });

  it('accepts https URLs either way', async () => {
    await expect(service.create({ org_id: 'org_1', name: 'Shop', repo_url: 'https://github.com/acme/shop', branch: 'main' }))
      .resolves.toMatchObject({ repo_url: 'https://github.com/acme/shop' });
  });
});
