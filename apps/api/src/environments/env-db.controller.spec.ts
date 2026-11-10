import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { DbResetResponse, DbRlsResponse, DbSqlResponse } from '@eve/shared';
import { EnvDbController } from './env-db.controller';
import type { EnvDbService } from './env-db.service';
import type { AuthService, AuthUser, JobTokenPayload } from '../auth/auth.service';
import type { ScopedAccessService } from '../auth/scoped-access.service';

type EnvDbServiceMock = {
  resolveOrgIdForProject: ReturnType<typeof vi.fn<(projectId: string) => Promise<string>>>;
  executeSql: ReturnType<typeof vi.fn<() => Promise<DbSqlResponse>>>;
  getRls: ReturnType<typeof vi.fn<() => Promise<DbRlsResponse>>>;
  reset: ReturnType<typeof vi.fn<() => Promise<DbResetResponse>>>;
};

type AuthServiceMock = {
  isEnabled: ReturnType<typeof vi.fn<() => boolean>>;
  verifyJobToken: ReturnType<typeof vi.fn<(token: string) => JobTokenPayload>>;
};

type ScopedAccessMock = {
  assert: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

describe('EnvDbController', () => {
  let envDbService: EnvDbServiceMock;
  let authService: AuthServiceMock;
  let scopedAccess: ScopedAccessMock;
  let controller: EnvDbController;

  beforeEach(() => {
    envDbService = {
      resolveOrgIdForProject: vi.fn(async () => 'org_test'),
      executeSql: vi.fn(async () => ({ rows: [], row_count: 0 })),
      getRls: vi.fn(async () => ({
        tables: [],
        diagnostics: {
          context: {
            user_id: 'user_test',
            principal_type: 'user',
            org_id: 'org_test',
            project_id: 'proj_test',
            env_name: 'test',
            group_ids: [],
            permissions: [],
          },
        },
      })),
      reset: vi.fn(async () => ({ reset: true, migrations_applied: [] })),
    };
    authService = {
      isEnabled: vi.fn(() => true),
      verifyJobToken: vi.fn(),
    };
    scopedAccess = {
      assert: vi.fn(async () => {}),
    };

    controller = new EnvDbController(
      envDbService as unknown as EnvDbService,
      authService as unknown as AuthService,
      scopedAccess as unknown as ScopedAccessService,
    );
  });

  it('propagates service-principal permissions to env-db sql context', async () => {
    const requestUser: AuthUser = {
      user_id: 'sp_123',
      is_service_principal: true,
      permissions: ['envdb:write'],
    };

    await controller.sql(
      'proj_test',
      'test',
      { sql: 'SELECT 1', allow_write: true },
      requestUser,
      'req_1',
      undefined,
    );

    expect(scopedAccess.assert).toHaveBeenCalled();
    expect(envDbService.executeSql).toHaveBeenCalledWith(
      'proj_test',
      'test',
      'SELECT 1',
      undefined,
      true,
      expect.objectContaining({
        user_id: 'sp_123',
        principal_type: 'service_principal',
        permissions: ['envdb:write'],
      }),
    );
  });

  it('prefers eve-job-token permissions over request user permissions', async () => {
    authService.verifyJobToken.mockReturnValue({
      sub: 'job',
      user_id: 'user_123',
      org_id: 'org_test',
      project_id: 'proj_test',
      job_id: 'job_123',
      permissions: ['envdb:write'],
      exp: Math.floor(Date.now() / 1000) + 600,
      iat: Math.floor(Date.now() / 1000),
      type: 'job',
    });

    const requestUser: AuthUser = {
      user_id: 'user_123',
      permissions: ['envdb:read'],
    };

    await controller.sql(
      'proj_test',
      'test',
      { sql: 'SELECT 1', allow_write: true },
      requestUser,
      'req_2',
      'job-token-value',
    );

    expect(authService.verifyJobToken).toHaveBeenCalledWith('job-token-value');
    expect(envDbService.executeSql).toHaveBeenCalledWith(
      'proj_test',
      'test',
      'SELECT 1',
      undefined,
      true,
      expect.objectContaining({
        permissions: ['envdb:write'],
      }),
    );
  });

  describe('eve-job-token header', () => {
    const member: AuthUser = { user_id: 'user_123', permissions: ['envdb:read'] };

    function headerToken(projectId: string, orgId: string): JobTokenPayload {
      return {
        sub: 'job',
        user_id: 'user_123',
        org_id: orgId,
        project_id: projectId,
        job_id: 'job_123',
        permissions: ['envdb:read', 'envdb:write'],
        exp: Math.floor(Date.now() / 1000) + 600,
        iat: Math.floor(Date.now() / 1000),
        type: 'job',
      };
    }

    const runWrite = () =>
      controller.sql('proj_test', 'test', { sql: 'DELETE FROM notes', allow_write: true }, member, 'req_3', 'job-token-value');

    it('does not unlock writes with a job token from another project in the same org', async () => {
      authService.verifyJobToken.mockReturnValue(headerToken('proj_sibling', 'org_test'));

      await expect(runWrite()).rejects.toBeInstanceOf(ForbiddenException);
      expect(envDbService.executeSql).not.toHaveBeenCalled();
    });

    it('does not unlock writes with a job token from another org', async () => {
      authService.verifyJobToken.mockReturnValue(headerToken('proj_other', 'org_other'));

      await expect(runWrite()).rejects.toBeInstanceOf(ForbiddenException);
      expect(envDbService.executeSql).not.toHaveBeenCalled();
    });

    it('refuses a job token that names no project', async () => {
      authService.verifyJobToken.mockReturnValue(headerToken('', 'org_test'));

      await expect(runWrite()).rejects.toBeInstanceOf(ForbiddenException);
      expect(envDbService.executeSql).not.toHaveBeenCalled();
    });

    it('does not run a reset with a job token from another project', async () => {
      authService.verifyJobToken.mockReturnValue(headerToken('proj_sibling', 'org_test'));

      await expect(
        controller.reset('proj_test', 'test', { force: true }, member, 'req_4', 'job-token-value'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(envDbService.reset).not.toHaveBeenCalled();
    });

    it('does not lend its permissions to read routes of another project', async () => {
      authService.verifyJobToken.mockReturnValue(headerToken('proj_sibling', 'org_test'));

      await expect(
        controller.rls('proj_test', 'test', member, 'req_5', 'job-token-value'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(envDbService.getRls).not.toHaveBeenCalled();
    });

    it("still unlocks writes with a job token from the path's own project", async () => {
      authService.verifyJobToken.mockReturnValue(headerToken('proj_test', 'org_test'));

      await runWrite();

      expect(envDbService.executeSql).toHaveBeenCalledWith(
        'proj_test',
        'test',
        'DELETE FROM notes',
        undefined,
        true,
        expect.objectContaining({ permissions: ['envdb:read', 'envdb:write'] }),
      );
    });
  });
});
