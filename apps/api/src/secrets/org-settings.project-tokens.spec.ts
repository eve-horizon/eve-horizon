import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { OrgSecretsController, ProjectSecretsController } from './secrets.controller';
import { CloudFsController } from '../cloud-fs/cloud-fs.controller';
import type { AuthUser } from '../auth/auth.types';

const jobToken: AuthUser = {
  user_id: 'user_padmin',
  is_job_token: true,
  job_id: 'a-1',
  project_id: 'proj_a',
  org_id: 'org_a',
  permissions: ['secrets:read', 'secrets:write', 'secrets:admin', 'cloud_fs:read', 'cloud_fs:admin'],
};
const serviceToken: AuthUser = {
  user_id: 'service:web',
  is_service_token: true,
  project_id: 'proj_a',
  org_id: 'org_a',
  permissions: ['secrets:write', 'secrets:admin', 'cloud_fs:admin'],
};
const principal: AuthUser = { user_id: 'sp_1', is_service_principal: true, org_id: 'org_a', permissions: ['secrets:write'] };
const orgAdmin: AuthUser = { user_id: 'user_oadmin' };

/** Calls a route handler with its arguments in order (the caller is the last one). */
function call(controller: object, handler: string, ...args: unknown[]): Promise<unknown> {
  const fn = (controller as Record<string, (...a: unknown[]) => Promise<unknown>>)[handler];
  return fn.call(controller, ...args);
}

function orgSecrets() {
  const secretsService = {
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    delete: vi.fn(async () => undefined),
  };
  return { secretsService, controller: new OrgSecretsController(secretsService as never) };
}

describe('org-wide secrets and cloud-fs mounts', () => {
  it('refuse job and service tokens that write, overwrite or delete org secrets', async () => {
    for (const token of [jobToken, serviceToken]) {
      const { secretsService, controller } = orgSecrets();

      await expect(call(controller, 'create', 'org_a', { key: 'K', value: 'v' }, token)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(call(controller, 'update', 'org_a', 'K', { value: 'v2' }, token)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(call(controller, 'remove', 'org_a', 'K', token)).rejects.toBeInstanceOf(ForbiddenException);
      expect(secretsService.create).not.toHaveBeenCalled();
      expect(secretsService.update).not.toHaveBeenCalled();
      expect(secretsService.delete).not.toHaveBeenCalled();
    }
  });

  it('still let people and org-level service principals manage org secrets', async () => {
    for (const caller of [orgAdmin, principal]) {
      const { secretsService, controller } = orgSecrets();
      await call(controller, 'create', 'org_a', { key: 'K', value: 'v' }, caller);
      expect(secretsService.create).toHaveBeenCalledWith('org', 'org_a', { key: 'K', value: 'v' });
    }
  });

  it("still let a job token write its own project's secrets", async () => {
    const secretsService = { create: vi.fn(async () => ({})) };
    const controller = new ProjectSecretsController(secretsService as never);

    await call(controller, 'create', 'proj_a', { key: 'K', value: 'v' }, jobToken);

    expect(secretsService.create).toHaveBeenCalledWith('project', 'proj_a', { key: 'K', value: 'v' });
  });

  it('refuse job and service tokens that create, change or remove cloud-fs mounts', async () => {
    for (const token of [jobToken, serviceToken]) {
      const cloudFs = {
        createMount: vi.fn(async () => ({})),
        updateMount: vi.fn(async () => ({})),
        removeMount: vi.fn(async () => undefined),
        getMount: vi.fn(async () => ({ id: 'mnt_1', project_id: 'proj_a' })),
      };
      const scopedAccess = { assert: vi.fn(async () => undefined) };
      const controller = new CloudFsController(cloudFs as never, scopedAccess as never);

      await expect(call(controller, 'createMount', 'org_a', { name: 'drive' }, token)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(call(controller, 'updateMount', 'org_a', 'mnt_1', token, { name: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(call(controller, 'removeMount', 'org_a', 'mnt_1', token)).rejects.toBeInstanceOf(ForbiddenException);
      expect(cloudFs.createMount).not.toHaveBeenCalled();
      expect(cloudFs.updateMount).not.toHaveBeenCalled();
      expect(cloudFs.removeMount).not.toHaveBeenCalled();
    }
  });
});
