import { BadRequestException, ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentsService } from './environments.service';

describe('EnvironmentsService user-chosen namespaces', () => {
  let service: EnvironmentsService;
  let environments: Record<string, ReturnType<typeof vi.fn>>;

  const env = (id: string, name: string, namespace: string | null = null) => ({
    id,
    project_id: 'proj_1',
    name,
    type: 'persistent',
    kind: 'standard',
    namespace,
  });

  beforeEach(() => {
    service = new EnvironmentsService(null as any, {} as any, {} as any, {} as any);
    environments = {
      findByProjectAndName: vi.fn().mockResolvedValue(null),
      listByNamespace: vi.fn().mockResolvedValue([]),
      listByProject: vi.fn().mockResolvedValue([env('env_test', 'test')]),
      create: vi.fn(async (input) => ({ ...input, created_at: new Date(), updated_at: new Date() })),
      update: vi.fn(async (id, input) => ({ ...env(id, 'staging'), ...input, created_at: new Date(), updated_at: new Date() })),
    };
    Object.assign(service as any, {
      environments,
      projects: { findById: vi.fn().mockResolvedValue({ id: 'proj_1', org_id: 'org_1', slug: 'web' }) },
      orgs: { findById: vi.fn().mockResolvedValue({ id: 'org_1', slug: 'acme' }) },
      toEnvironmentResponse: (row: unknown) => row,
    });
  });

  it.each([
    ['kube-system'],
    ['eve'],
    ['default'],
    ['eve-other-web-prod'],
    ['eve-acme-webx-prod'],
    ['eve-acme-web'],
  ])('rejects %s, which is outside the project prefix', async (namespace) => {
    await expect(service.create('proj_1', { name: 'staging', type: 'persistent', namespace } as any))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(environments.create).not.toHaveBeenCalled();
  });

  it('rejects the stored namespace of another environment', async () => {
    environments.listByNamespace.mockResolvedValue([env('env_prod', 'prod', 'eve-acme-web-shared')]);

    await expect(service.create('proj_1', { name: 'staging', type: 'persistent', namespace: 'eve-acme-web-shared' } as any))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects a sibling environment's derived namespace", async () => {
    await expect(service.create('proj_1', { name: 'staging', type: 'persistent', namespace: 'EVE-acme-web-Test' } as any))
      .rejects.toThrow('Namespace "eve-acme-web-test" is already used by another environment');
  });

  it('stores a free namespace under the project prefix, normalized', async () => {
    await service.create('proj_1', { name: 'staging', type: 'persistent', namespace: 'EVE-acme-web-Blue' } as any);

    expect(environments.create).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'eve-acme-web-blue' }));
  });

  it('lets an environment keep or reset its own namespace on update', async () => {
    environments.findByProjectAndName.mockResolvedValue(env('env_staging', 'staging', 'eve-acme-web-blue'));
    environments.listByNamespace.mockResolvedValue([env('env_staging', 'staging', 'eve-acme-web-blue')]);
    environments.listByProject.mockResolvedValue([env('env_staging', 'staging', 'eve-acme-web-blue'), env('env_test', 'test')]);

    await service.update('proj_1', 'staging', { namespace: 'eve-acme-web-blue' } as any);
    await service.update('proj_1', 'staging', { namespace: null } as any);

    expect(environments.update).toHaveBeenNthCalledWith(1, 'env_staging', expect.objectContaining({ namespace: 'eve-acme-web-blue' }));
    expect(environments.update).toHaveBeenNthCalledWith(2, 'env_staging', expect.objectContaining({ namespace: null }));
  });

  it('rejects moving an environment onto another environment namespace', async () => {
    environments.findByProjectAndName.mockResolvedValue(env('env_staging', 'staging'));

    await expect(service.update('proj_1', 'staging', { namespace: 'eve-acme-web-test' } as any))
      .rejects.toBeInstanceOf(ConflictException);
    expect(environments.update).not.toHaveBeenCalled();
  });
});
