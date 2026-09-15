import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManifestSchema } from '@eve/shared';
import { ManagedDbProvisioner } from '../managed-db-provisioner.js';
import { DeployerService } from '../deployer.service.js';

vi.mock('@eve/shared', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

const tenantUrl =
  'postgres://acme-shop-test-u-1a2b3c:ownerpw@db.internal:6543/acme-shop-test-1a2b3c?sslmode=verify-full';
const roleUrl =
  'postgres://acme-shop-test-u-1a2b3c-app_ro:rolepw@db.internal:6543/acme-shop-test-1a2b3c?sslmode=verify-full';

const scope = {
  envId: 'env_123',
  orgId: 'org_456',
  orgSlug: 'acme',
  projectId: 'proj_123',
  projectSlug: 'shop',
  envName: 'test',
};

function buildManifest(roles?: Array<{ name: string; grants: 'readwrite' | 'readonly' }>) {
  return ManifestSchema.parse({
    schema: 'eve/compose/v2',
    services: {
      db: {
        'x-eve': {
          role: 'managed_db',
          managed: {
            class: 'db.p1',
            engine: 'postgres',
            ...(roles ? { roles } : {}),
          },
        },
      },
    },
  });
}

function buildTenant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mdbt_1',
    instance_id: 'mdbi_1',
    status: 'ready',
    db_name: 'acme-shop-test-1a2b3c',
    db_user: 'acme-shop-test-u-1a2b3c',
    credential_secret_ref: tenantUrl,
    desired_extensions: [],
    enabled_extensions: [],
    desired_roles: [],
    ...overrides,
  };
}

function buildManagedDb(overrides: Record<string, unknown> = {}) {
  return {
    findTenantByEnv: vi.fn().mockResolvedValue(buildTenant()),
    syncTenantDesiredExtensions: vi.fn().mockResolvedValue(null),
    syncTenantDesiredRoles: vi.fn().mockResolvedValue(null),
    listTenantRoles: vi.fn().mockResolvedValue([]),
    acquireOperationLock: vi.fn().mockResolvedValue(null),
    transitionStatus: vi.fn().mockResolvedValue(null),
    syncTenantBackupConfig: vi.fn().mockResolvedValue(null),
    findInstanceById: vi.fn().mockResolvedValue({ id: 'mdbi_1', provider: 'local', region: 'local' }),
    ...overrides,
  };
}

function createProvisioner(managedDb: Record<string, unknown>) {
  const logger = new Logger('test');
  vi.spyOn(logger, 'log').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  return new ManagedDbProvisioner(managedDb as never, {} as never, logger);
}

describe('ManagedDbProvisioner interpolation values', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('publishes the tenant url unchanged plus its connection components', async () => {
    const managedDb = buildManagedDb();
    const provisioner = createProvisioner(managedDb);

    const { managedValues } = await provisioner.resolveManagedDbTenants({
      manifest: buildManifest(),
      ...scope,
    });

    expect(managedValues.get('db.url')).toBe(tenantUrl);
    expect(managedValues.get('db.host')).toBe('db.internal');
    expect(managedValues.get('db.port')).toBe('6543');
    expect(managedValues.get('db.database')).toBe('acme-shop-test-1a2b3c');
    expect(managedValues.get('db.username')).toBe('acme-shop-test-u-1a2b3c');
    expect(managedValues.get('db.password')).toBe('ownerpw');
    expect(managedValues.get('db.extensions')).toBe('');
    expect([...managedValues.keys()].some((key) => key.includes('.roles.'))).toBe(false);
    expect(managedDb.syncTenantDesiredRoles).toHaveBeenCalledWith('mdbt_1', []);
    expect(managedDb.transitionStatus).not.toHaveBeenCalled();
  });

  it('publishes url, username, and password for each provisioned role', async () => {
    const managedDb = buildManagedDb({
      findTenantByEnv: vi.fn().mockResolvedValue(
        buildTenant({ desired_roles: [{ name: 'app_ro', grants: 'readonly' }] }),
      ),
      listTenantRoles: vi.fn().mockResolvedValue([
        {
          id: 'mdbr_1',
          tenant_id: 'mdbt_1',
          name: 'app_ro',
          grants: 'readonly',
          db_user: 'acme-shop-test-u-1a2b3c-app_ro',
          credential_secret_ref: roleUrl,
        },
      ]),
    });
    const provisioner = createProvisioner(managedDb);

    const { managedValues } = await provisioner.resolveManagedDbTenants({
      manifest: buildManifest([{ name: 'app_ro', grants: 'readonly' }]),
      ...scope,
    });

    expect(managedValues.get('db.url')).toBe(tenantUrl);
    expect(managedValues.get('db.roles.app_ro.url')).toBe(roleUrl);
    expect(managedValues.get('db.roles.app_ro.username')).toBe('acme-shop-test-u-1a2b3c-app_ro');
    expect(managedValues.get('db.roles.app_ro.password')).toBe('rolepw');
    expect(managedDb.syncTenantDesiredRoles).toHaveBeenCalledWith('mdbt_1', [
      { name: 'app_ro', grants: 'readonly' },
    ]);
    expect(managedDb.transitionStatus).not.toHaveBeenCalled();
  });

  it('requests a modifying reconcile when declared roles differ from provisioned roles', async () => {
    vi.useFakeTimers();
    const readyTenant = buildTenant({ desired_roles: [{ name: 'app', grants: 'readwrite' }] });
    const modifyingTenant = { ...readyTenant, status: 'modifying' };
    const provisionedRole = {
      id: 'mdbr_1',
      tenant_id: 'mdbt_1',
      name: 'app',
      grants: 'readwrite',
      db_user: 'acme-shop-test-u-1a2b3c-app',
      credential_secret_ref: roleUrl,
    };
    const managedDb = buildManagedDb({
      findTenantByEnv: vi.fn()
        .mockResolvedValueOnce(readyTenant)
        .mockResolvedValueOnce(modifyingTenant)
        .mockResolvedValue(readyTenant),
      listTenantRoles: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([provisionedRole]),
      acquireOperationLock: vi.fn().mockResolvedValue(readyTenant),
    });
    const provisioner = createProvisioner(managedDb);

    const pending = provisioner.resolveManagedDbTenants({
      manifest: buildManifest([{ name: 'app', grants: 'readwrite' }]),
      ...scope,
    });
    await vi.runAllTimersAsync();
    const { managedValues } = await pending;

    expect(managedDb.acquireOperationLock).toHaveBeenCalledWith('mdbt_1', expect.any(String));
    expect(managedDb.transitionStatus).toHaveBeenCalledWith('mdbt_1', expect.any(String), 'modifying');
    expect(managedValues.get('db.roles.app.url')).toBe(roleUrl);
  });

  it('fails the deploy when the tenant is ready but declared roles were not reconciled', async () => {
    const managedDb = buildManagedDb({
      findTenantByEnv: vi.fn().mockResolvedValue(
        buildTenant({ desired_roles: [{ name: 'app', grants: 'readwrite' }] }),
      ),
      listTenantRoles: vi.fn().mockResolvedValue([]),
      acquireOperationLock: vi.fn().mockResolvedValue(null),
    });
    const provisioner = createProvisioner(managedDb);

    await expect(provisioner.resolveManagedDbTenants({
      manifest: buildManifest([{ name: 'app', grants: 'readwrite' }]),
      ...scope,
    })).rejects.toThrow(/declared role\(s\)/);
  });
});

describe('DeployerService managed value interpolation', () => {
  it('resolves tenant fields and nested role fields', () => {
    const deployer = new DeployerService(null as any, null as any);
    const managedValues = new Map<string, string>([
      ['db.url', tenantUrl],
      ['db.host', 'db.internal'],
      ['db.port', '6543'],
      ['db.roles.app_ro.url', roleUrl],
      ['db.roles.app_ro.username', 'acme-shop-test-u-1a2b3c-app_ro'],
      ['db.roles.app_ro.password', 'rolepw'],
    ]);
    const context = {
      envName: 'test',
      projectId: 'proj_123',
      orgId: 'org_456',
      orgSlug: 'acme',
      componentName: 'api',
      managedValues,
    };

    const interpolate = (value: string) => (deployer as any).interpolateValue(value, context);

    expect(interpolate('${managed.db.url}')).toBe(tenantUrl);
    expect(interpolate('${managed.db.host}:${managed.db.port}')).toBe('db.internal:6543');
    expect(interpolate('${managed.db.roles.app_ro.url}')).toBe(roleUrl);
    expect(interpolate('user=${managed.db.roles.app_ro.username} pass=${managed.db.roles.app_ro.password}'))
      .toBe('user=acme-shop-test-u-1a2b3c-app_ro pass=rolepw');
    expect(interpolate('${managed.db.roles.missing.url}')).toBe('${managed.db.roles.missing.url}');
  });
});
