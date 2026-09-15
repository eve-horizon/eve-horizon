import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedDbReconcilerService } from './managed-db-reconciler.service.js';

type FakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) & {
  unsafe: (text: string) => Promise<unknown[]>;
  end: () => Promise<void>;
  statements: string[];
};

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Records every statement issued through a postgres.js-style client so the
 * specs can assert on the exact DDL/DCL the reconciler runs.
 */
function createFakeSql(respond: (text: string, values: unknown[]) => unknown[] = () => []): FakeSql {
  const statements: string[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = normalizeSql(strings.reduce((acc, part, index) => acc + part + (index < values.length ? `$${index + 1}` : ''), ''));
    statements.push(text);
    return Promise.resolve(respond(text, values));
  }) as FakeSql;
  sql.unsafe = (text: string) => {
    statements.push(normalizeSql(text));
    return Promise.resolve([]);
  };
  sql.end = vi.fn().mockResolvedValue(undefined);
  sql.statements = statements;
  return sql;
}

const instance = {
  id: 'mdbi_1',
  provider: 'local',
  provider_instance_id: 'local-system-postgres',
  engine_version: '16',
  host: 'db.internal',
  port: 5432,
};

const OWNER = 'acme-shop-test-u-1a2b3c';
const DB = 'acme-shop-test-1a2b3c';

function buildTenant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mdbt_1',
    status: 'provisioning',
    instance_id: instance.id,
    db_name: DB,
    db_user: OWNER,
    class: 'db.p1',
    desired_class: null,
    provider_tenant_id: null,
    credential_secret_ref: null,
    snapshot_on_delete: false,
    org_id: 'org_1',
    project_id: 'proj_1',
    env_id: 'env_1',
    backup_retention: null,
    desired_extensions: [],
    enabled_extensions: [],
    desired_roles: [],
    deleted_at: null,
    ...overrides,
  };
}

function provisionedRole(name: string, grants: string) {
  return {
    id: `mdbr_${name}`,
    tenant_id: 'mdbt_1',
    name,
    grants,
    db_user: `${OWNER}-${name}`,
    credential_secret_ref: `postgres://${OWNER}-${name}:old@db.internal:5432/${DB}?sslmode=disable`,
  };
}

function createService(tenant: ReturnType<typeof buildTenant>, managedDbOverrides: Record<string, unknown> = {}) {
  const mockDb = Object.assign(
    () => Promise.resolve([]),
    { json: vi.fn(), end: vi.fn() },
  ) as unknown as import('@eve/db').Db;
  const service = new ManagedDbReconcilerService(mockDb);
  const managedDb = {
    forceReleaseStaleOperationLocks: vi.fn().mockResolvedValue([]),
    listTenantsNeedingReconciliation: vi.fn().mockResolvedValue([tenant]),
    findOrphanedTenants: vi.fn().mockResolvedValue([]),
    acquireOperationLock: vi.fn().mockResolvedValue(tenant),
    releaseOperationLock: vi.fn().mockResolvedValue(true),
    findInstanceById: vi.fn().mockResolvedValue(instance),
    transitionStatus: vi.fn().mockResolvedValue(tenant),
    markTenantExtensionsEnabled: vi.fn().mockResolvedValue(tenant),
    markTenantDeleted: vi.fn().mockResolvedValue(true),
    listTenantRoles: vi.fn().mockResolvedValue([]),
    upsertTenantRole: vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({ id: 'mdbr_new', ...input })),
    updateTenantRoleGrants: vi.fn().mockResolvedValue(null),
    updateTenantRoleCredentialSecretRef: vi.fn().mockResolvedValue(null),
    deleteTenantRole: vi.fn().mockResolvedValue(true),
    deleteTenantRoles: vi.fn().mockResolvedValue(0),
    ...managedDbOverrides,
  };
  Object.assign(service, { managedDb });
  return { service, managedDb };
}

describe('ManagedDbReconcilerService tenant roles', () => {
  const originalEnv = { ...process.env };
  let adminSql: FakeSql;
  let tenantSql: FakeSql;

  beforeEach(() => {
    process.env = { ...originalEnv, DATABASE_URL: 'postgres://eve:eve@localhost:5432/eve?sslmode=disable' };
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    adminSql = createFakeSql();
    tenantSql = createFakeSql();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  function wireConnections(service: ManagedDbReconcilerService) {
    const connectToInstance = vi.spyOn(service as any, 'connectToInstance').mockReturnValue(adminSql);
    const connectToTenantDb = vi.spyOn(service as any, 'connectToTenantDb').mockReturnValue(tenantSql);
    return { connectToInstance, connectToTenantDb };
  }

  it('creates declared roles with least-privilege grants during provisioning', async () => {
    const tenant = buildTenant({
      desired_roles: [
        { name: 'app', grants: 'readwrite' },
        { name: 'reports', grants: 'readonly' },
      ],
    });
    const { service, managedDb } = createService(tenant);
    wireConnections(service);

    await service.reconcile();

    expect(adminSql.statements).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^CREATE ROLE "${OWNER}-app" WITH LOGIN NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '[0-9a-f]{32}'$`)),
      `GRANT CONNECT ON DATABASE "${DB}" TO "${OWNER}-app"`,
      expect.stringMatching(new RegExp(`^CREATE ROLE "${OWNER}-reports" WITH LOGIN NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '[0-9a-f]{32}'$`)),
      `GRANT CONNECT ON DATABASE "${DB}" TO "${OWNER}-reports"`,
    ]));
    expect(tenantSql.statements).toEqual([
      `GRANT USAGE ON SCHEMA "public" TO "${OWNER}-app"`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "${OWNER}-app"`,
      `GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA "public" TO "${OWNER}-app"`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${OWNER}" IN SCHEMA "public" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${OWNER}-app"`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${OWNER}" IN SCHEMA "public" GRANT SELECT, USAGE ON SEQUENCES TO "${OWNER}-app"`,
      `GRANT USAGE ON SCHEMA "public" TO "${OWNER}-reports"`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "${OWNER}-reports"`,
      `GRANT SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "${OWNER}-reports"`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${OWNER}" IN SCHEMA "public" GRANT SELECT ON TABLES TO "${OWNER}-reports"`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${OWNER}" IN SCHEMA "public" GRANT SELECT ON SEQUENCES TO "${OWNER}-reports"`,
    ]);

    expect(managedDb.upsertTenantRole).toHaveBeenCalledTimes(2);
    expect(managedDb.upsertTenantRole).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: 'mdbt_1',
      name: 'app',
      grants: 'readwrite',
      db_user: `${OWNER}-app`,
      credential_secret_ref: expect.stringMatching(
        new RegExp(`^postgres://${OWNER}-app:[0-9a-f]{32}@db\\.internal:5432/${DB}\\?sslmode=disable$`),
      ),
    }));
    expect(managedDb.transitionStatus).toHaveBeenCalledWith('mdbt_1', expect.any(String), 'ready', expect.objectContaining({
      credentialSecretRef: expect.stringMatching(new RegExp(`^postgres://${OWNER}:[0-9a-f]{32}@db\\.internal:5432/${DB}\\?sslmode=disable$`)),
      setReady: true,
    }));
    expect(adminSql.end).toHaveBeenCalled();
    expect(tenantSql.end).toHaveBeenCalled();
  });

  it('issues no role SQL for tenants without declared roles', async () => {
    const { service, managedDb } = createService(buildTenant());
    const { connectToTenantDb } = wireConnections(service);

    await service.reconcile();

    expect(adminSql.statements.some((statement) => statement.includes('NOINHERIT'))).toBe(false);
    expect(connectToTenantDb).not.toHaveBeenCalled();
    expect(managedDb.upsertTenantRole).not.toHaveBeenCalled();
    expect(managedDb.transitionStatus).toHaveBeenCalledWith('mdbt_1', expect.any(String), 'ready', expect.objectContaining({ setReady: true }));
  });

  it('adds, regrants, and drops roles when the manifest changes', async () => {
    const tenant = buildTenant({
      status: 'modifying',
      desired_roles: [
        { name: 'app', grants: 'readonly' },
        { name: 'new_role', grants: 'readwrite' },
      ],
    });
    const { service, managedDb } = createService(tenant, {
      listTenantRoles: vi.fn().mockResolvedValue([
        provisionedRole('app', 'readwrite'),
        provisionedRole('old_role', 'readonly'),
      ]),
    });
    wireConnections(service);

    await service.reconcile();

    // Dropped role: revoke inside the tenant DB, then at the instance level, then DROP ROLE.
    expect(tenantSql.statements.slice(0, 5)).toEqual([
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${OWNER}" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "${OWNER}-old_role"`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${OWNER}" IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM "${OWNER}-old_role"`,
      `REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM "${OWNER}-old_role"`,
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA "public" FROM "${OWNER}-old_role"`,
      `REVOKE ALL ON SCHEMA "public" FROM "${OWNER}-old_role"`,
    ]);
    expect(adminSql.statements).toEqual(expect.arrayContaining([
      `REVOKE ALL ON DATABASE "${DB}" FROM "${OWNER}-old_role"`,
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid != pg_backend_pid()',
      `DROP ROLE IF EXISTS "${OWNER}-old_role"`,
    ]));
    expect(managedDb.deleteTenantRole).toHaveBeenCalledWith('mdbt_1', 'old_role');

    // Regranted role: revoke tenant-level privileges, then re-grant readonly. No new credential.
    expect(tenantSql.statements).toEqual(expect.arrayContaining([
      `REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM "${OWNER}-app"`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "${OWNER}-app"`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${OWNER}" IN SCHEMA "public" GRANT SELECT ON TABLES TO "${OWNER}-app"`,
    ]));
    expect(tenantSql.statements).not.toEqual(expect.arrayContaining([
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "${OWNER}-app"`,
    ]));
    expect(adminSql.statements.some((statement) => statement.startsWith(`CREATE ROLE "${OWNER}-app"`))).toBe(false);
    expect(managedDb.updateTenantRoleGrants).toHaveBeenCalledWith('mdbt_1', 'app', 'readonly');

    // New role: created with a fresh credential.
    expect(adminSql.statements).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^CREATE ROLE "${OWNER}-new_role" WITH LOGIN NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '[0-9a-f]{32}'$`)),
      `GRANT CONNECT ON DATABASE "${DB}" TO "${OWNER}-new_role"`,
    ]));
    expect(managedDb.upsertTenantRole).toHaveBeenCalledTimes(1);
    expect(managedDb.upsertTenantRole).toHaveBeenCalledWith(expect.objectContaining({ name: 'new_role', grants: 'readwrite' }));

    expect(managedDb.transitionStatus).toHaveBeenCalledWith('mdbt_1', expect.any(String), 'ready', { desiredClass: null });
  });

  it('rotates role passwords alongside the owner credential', async () => {
    const tenant = buildTenant({
      status: 'rotating',
      provider_tenant_id: `local:${DB}`,
      desired_roles: [{ name: 'app', grants: 'readwrite' }],
    });
    const { service, managedDb } = createService(tenant, {
      listTenantRoles: vi.fn().mockResolvedValue([provisionedRole('app', 'readwrite')]),
    });
    wireConnections(service);

    await service.reconcile();

    expect(adminSql.statements).toEqual([
      expect.stringMatching(new RegExp(`^ALTER ROLE "${OWNER}" WITH PASSWORD '[0-9a-f]{32}'$`)),
      expect.stringMatching(new RegExp(`^ALTER ROLE "${OWNER}-app" WITH PASSWORD '[0-9a-f]{32}'$`)),
    ]);
    expect(managedDb.updateTenantRoleCredentialSecretRef).toHaveBeenCalledWith(
      'mdbt_1',
      'app',
      expect.stringMatching(new RegExp(`^postgres://${OWNER}-app:[0-9a-f]{32}@db\\.internal:5432/${DB}\\?sslmode=disable$`)),
    );
    expect(managedDb.transitionStatus).toHaveBeenCalledWith('mdbt_1', expect.any(String), 'ready', {
      credentialSecretRef: expect.stringMatching(new RegExp(`^postgres://${OWNER}:[0-9a-f]{32}@`)),
    });
  });

  it('drops role logins when the tenant is deleted', async () => {
    const tenant = buildTenant({
      status: 'deleting',
      deleted_at: new Date(),
      provider_tenant_id: `local:${DB}`,
      desired_roles: [{ name: 'app', grants: 'readwrite' }],
    });
    const { service, managedDb } = createService(tenant, {
      listTenantRoles: vi.fn().mockResolvedValue([
        provisionedRole('app', 'readwrite'),
        provisionedRole('reports', 'readonly'),
      ]),
    });
    wireConnections(service);

    await service.reconcile();

    expect(adminSql.statements).toEqual([
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid != pg_backend_pid()',
      `DROP DATABASE IF EXISTS "${DB}"`,
      `DROP ROLE IF EXISTS "${OWNER}"`,
      `DROP ROLE IF EXISTS "${OWNER}-app"`,
      `DROP ROLE IF EXISTS "${OWNER}-reports"`,
    ]);
    expect(managedDb.deleteTenantRoles).toHaveBeenCalledWith('mdbt_1');
    expect(managedDb.markTenantDeleted).toHaveBeenCalledWith('mdbt_1');
  });

  it('fails provisioning with provider_unsupported when a cloud tenant declares roles', async () => {
    const tenant = buildTenant({ desired_roles: [{ name: 'app', grants: 'readonly' }] });
    const { service, managedDb } = createService(tenant, {
      findInstanceById: vi.fn().mockResolvedValue({ ...instance, provider: 'aws-rds' }),
    });
    wireConnections(service);

    await service.reconcile();

    expect(managedDb.transitionStatus).toHaveBeenCalledWith('mdbt_1', expect.any(String), 'failed', {
      error: expect.objectContaining({ code: 'provider_unsupported' }),
    });
  });
});
