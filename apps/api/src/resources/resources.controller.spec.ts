import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolveResourcesListResponse } from '@eve/shared';
import { ResourcesController } from './resources.controller';
import type { ResourcesService } from './resources.service';
import type { ScopedAccessService } from '../auth/scoped-access.service';

type ResourcesServiceMock = {
  resolveResources: ReturnType<typeof vi.fn<() => Promise<ResolveResourcesListResponse>>>;
};

type ScopedAccessMock = {
  assert: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

describe('ResourcesController', () => {
  let resources: ResourcesServiceMock;
  let scopedAccess: ScopedAccessMock;
  let controller: ResourcesController;

  beforeEach(() => {
    resources = {
      resolveResources: vi.fn(async () => ({ data: [] })),
    };
    scopedAccess = {
      assert: vi.fn(async () => {}),
    };

    controller = new ResourcesController(
      resources as unknown as ResourcesService,
      scopedAccess as unknown as ScopedAccessService,
    );
  });

  it('applies scoped checks for org docs and attachment resources before resolve', async () => {
    await controller.resolve(
      'org_test',
      {
        uris: [
          'org_docs:/groups/pm/spec.md',
          'job_attachments:/job_123/log.txt',
        ],
        include_content: true,
      },
      {
        user: { user_id: 'user_test' },
        correlationId: 'req_resources_1',
      },
    );

    expect(scopedAccess.assert).toHaveBeenCalledTimes(2);
    expect(scopedAccess.assert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        org_id: 'org_test',
        permission: 'orgdocs:read',
        request_id: 'req_resources_1',
        resource: {
          type: 'orgdocs',
          id: '/groups/pm/spec.md',
          action: 'read',
        },
      }),
    );
    expect(scopedAccess.assert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        org_id: 'org_test',
        permission: 'jobs:read',
        request_id: 'req_resources_1',
      }),
    );
    expect(resources.resolveResources).toHaveBeenCalledWith(
      'org_test',
      expect.objectContaining({
        uris: ['org_docs:/groups/pm/spec.md', 'job_attachments:/job_123/log.txt'],
      }),
      'req_resources_1',
    );
  });
});
