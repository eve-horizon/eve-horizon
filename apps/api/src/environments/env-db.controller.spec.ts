import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbRlsResponse, DbSqlResponse } from '@eve/shared';
import { EnvDbController } from './env-db.controller';
import type { EnvDbService } from './env-db.service';
import type { AuthService, AuthUser, JobTokenPayload } from '../auth/auth.service';
import type { ScopedAccessService } from '../auth/scoped-access.service';

type EnvDbServiceMock = {
  resolveOrgIdForProject: ReturnType<typeof vi.fn<(projectId: string) => Promise<string>>>;
  executeSql: ReturnType<typeof vi.fn<() => Promise<DbSqlResponse>>>;
  getRls: ReturnType<typeof vi.fn<() => Promise<DbRlsResponse>>>;
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
});
