import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CloudFsController } from './cloud-fs.controller.js';

describe('CloudFsController scoped access', () => {
  function createController() {
    const cloudFsService = {
      listMounts: vi.fn().mockResolvedValue([
        { id: 'mount_a', org_id: 'org_test' },
        { id: 'mount_b', org_id: 'org_test' },
      ]),
      browse: vi.fn().mockResolvedValue({ mount_id: 'mount_a', path: '/', entries: [] }),
      browseMount: vi.fn().mockResolvedValue({ mount_id: 'mount_a', path: '/', entries: [] }),
      search: vi.fn().mockResolvedValue({ mount_id: 'mount_a', entries: [] }),
      getMount: vi.fn().mockResolvedValue({ id: 'mount_a', org_id: 'org_test' }),
    };
    const scopedAccess = {
      assert: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new CloudFsController(cloudFsService as never, scopedAccess as never);
    return { controller, cloudFsService, scopedAccess };
  }

  it('filters mount listing for scoped job tokens', async () => {
    const { controller } = createController();

    const result = await controller.listMounts(
      'org_test',
      {
        user: {
          user_id: 'user_job',
          is_job_token: true,
          scope: { cloud_fs: { allow_mount_ids: ['mount_a'] } },
        },
      },
    );

    expect(result.mounts.map((mount) => mount.id)).toEqual(['mount_a']);
  });

  it('asserts cloud_fs resource access for explicit mount browse', async () => {
    const { controller, scopedAccess } = createController();
    const user = { user_id: 'user_job', is_job_token: true, scope: { cloud_fs: { allow_mount_ids: ['mount_a'] } } };

    await controller.browseMount('org_test', 'mount_a', { user }, { path: '/' });

    expect(scopedAccess.assert).toHaveBeenCalledWith({
      org_id: 'org_test',
      permission: 'cloud_fs:read',
      user,
      project_id: undefined,
      resource: { type: 'cloud_fs', id: 'mount_a', action: 'read' },
    });
  });

  it('uses the first allowed mount for scoped optional-mount browse', async () => {
    const { controller, cloudFsService } = createController();
    const user = { user_id: 'user_job', is_job_token: true, scope: { cloud_fs: { allow_mount_ids: ['mount_b'] } } };

    await controller.browse('org_test', { user }, {});

    expect(cloudFsService.browse).toHaveBeenCalledWith('org_test', 'mount_b', '/', {
      recursive: false,
      pageToken: undefined,
      pageSize: undefined,
      orderBy: undefined,
    });
  });

  it('returns not found when optional-mount browse has no allowed mounts', async () => {
    const { controller } = createController();
    const user = { user_id: 'user_job', is_job_token: true, scope: { cloud_fs: { allow_mount_ids: ['mount_missing'] } } };

    await expect(controller.browse('org_test', { user }, {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('parses browse paging options before calling the service', async () => {
    const { controller, cloudFsService } = createController();

    await controller.browse('org_test', {}, {
      mount_id: 'mount_a',
      path: '/Reports',
      recursive: 'false',
      page_token: 'next',
      page_size: '5000',
      order_by: 'name_desc',
    });

    expect(cloudFsService.browse).toHaveBeenCalledWith('org_test', 'mount_a', '/Reports', {
      recursive: false,
      pageToken: 'next',
      pageSize: 5000,
      orderBy: 'name_desc',
    });
  });

  it('rejects invalid browse booleans as bad requests', async () => {
    const { controller } = createController();

    await expect(controller.browse('org_test', {}, { recursive: 'not-bool' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('preserves omitted per-mount path when browsing by folder id', async () => {
    const { controller, cloudFsService } = createController();

    await controller.browseMount('org_test', 'mount_a', {}, {
      folder_id: 'folder_a',
      page_size: '25',
    });

    expect(cloudFsService.browseMount).toHaveBeenCalledWith('org_test', 'mount_a', 'folder_a', undefined, {
      recursive: false,
      pageToken: undefined,
      pageSize: 25,
      orderBy: undefined,
    });
  });

  it('parses search paging and MIME options before calling the service', async () => {
    const { controller, cloudFsService } = createController();

    await controller.search('org_test', {}, {
      q: 'budget',
      mount_id: 'mount_a',
      mime_type: 'application/pdf',
      page_token: 'search-next',
      page_size: '10',
      order_by: 'modified_desc',
    });

    expect(cloudFsService.search).toHaveBeenCalledWith('org_test', 'mount_a', 'budget', {
      pageToken: 'search-next',
      pageSize: 10,
      orderBy: 'modified_desc',
      mimeType: 'application/pdf',
    });
  });
});
