import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { EnvDbService } from './env-db.service';
import type { SecretsService } from '../secrets/secrets.service';

const PLATFORM_DATABASE_URL = 'postgres://eve:platform-pass@eve-db.internal:5432/eve';

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  lookup: vi.fn(),
  projects: { findById: vi.fn() },
  environments: { findByProjectAndName: vi.fn() },
  manifests: { findLatestByProject: vi.fn() },
  orgs: { findById: vi.fn() },
  managedDb: { findReadyTenantByEnv: vi.fn(), listTenantsByOrg: vi.fn() },
  accessGroups: { listGroupIdsForPrincipal: vi.fn() },
  // What a role-privilege query on a fresh connection reports.
  privileged: false,
}));

vi.mock('@eve/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eve/db')>()),
  createDb: mocks.createDb,
  projectQueries: vi.fn(() => mocks.projects),
  environmentQueries: vi.fn(() => mocks.environments),
  projectManifestQueries: vi.fn(() => mocks.manifests),
  orgQueries: vi.fn(() => mocks.orgs),
  managedDbQueries: vi.fn(() => mocks.managedDb),
  accessGroupQueries: vi.fn(() => mocks.accessGroups),
}));

vi.mock('node:dns/promises', () => ({
  lookup: mocks.lookup,
  default: { lookup: mocks.lookup },
}));

// Host name -> addresses, as dns.lookup(host, { all: true }) would answer.
const DNS: Record<string, string[]> = {
  'eve-db.internal': ['10.20.0.5'],
  'dev-db.eve-acme-shop-dev.svc.cluster.local': ['10.43.0.20'],
  'db.tenant.example': ['203.0.113.40'],
};

function fakeClient() {
  const tx = Object.assign(vi.fn(async () => []), {
    unsafe: vi.fn(async () => []),
  });
  // Queries outside the transaction (the client used as a tagged template)
  // are answered as a role-privilege check.
  return Object.assign(vi.fn(async () => [{ privileged: mocks.privileged }]), {
    tx,
    unsafe: vi.fn(async () => []),
    begin: vi.fn(async (callback: (t: typeof tx) => unknown) => callback(tx)),
    end: vi.fn(async () => {}),
  });
}

const CONTAINER_DB_MANIFEST = [
  'services:',
  '  db:',
  '    image: postgres:16',
  '    ports: [5432]',
  '    environment:',
  '      POSTGRES_USER: postgres',
  '      POSTGRES_PASSWORD: pw',
  '      POSTGRES_DB: app',
  '    x-eve:',
  '      role: database',
].join('\n');

const MANAGED_MANIFEST = [
  'services:',
  '  db:',
  '    x-eve:',
  '      role: managed_db',
  '      managed:',
  '        class: db.p1',
  '        engine: postgres',
  '        engine_version: "16"',
].join('\n');

describe('EnvDbService database target', () => {
  let service: EnvDbService;
  let environment: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DATABASE_URL', PLATFORM_DATABASE_URL);
    mocks.privileged = false;

    environment = {
      id: 'env_1',
      name: 'dev',
      namespace: null,
      db_ref: null,
      overrides_json: {},
    };

    mocks.projects.findById.mockResolvedValue({ id: 'proj_1', org_id: 'org_1', slug: 'shop' });
    mocks.environments.findByProjectAndName.mockImplementation(async () => environment);
    mocks.manifests.findLatestByProject.mockResolvedValue(null);
    mocks.orgs.findById.mockResolvedValue({ id: 'org_1', slug: 'acme' });
    mocks.managedDb.findReadyTenantByEnv.mockResolvedValue(null);
    mocks.managedDb.listTenantsByOrg.mockResolvedValue([]);
    mocks.accessGroups.listGroupIdsForPrincipal.mockResolvedValue([]);
    mocks.createDb.mockImplementation(() => fakeClient());
    mocks.lookup.mockImplementation(async (host: string) => {
      const addresses = DNS[host.toLowerCase()];
      if (!addresses) {
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      }
      return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    });

    const secrets = { resolveProjectSecretValue: vi.fn(async () => null) };
    service = new EnvDbService({} as never, secrets as unknown as SecretsService);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const context = { user_id: 'user_1', project_id: 'proj_1', env_name: 'dev' };

  const runSql = () => service.executeSql('proj_1', 'dev', 'SELECT 1', undefined, true, context);
  const runReset = () => service.reset('proj_1', 'dev', { force: true, no_migrate: true }, context);

  describe('an environment with no database', () => {
    it('answers sql with 409 and opens no connection', async () => {
      await expect(runSql()).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.createDb).not.toHaveBeenCalled();
    });

    it('answers reset with 409 and opens no connection', async () => {
      await expect(runReset()).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.createDb).not.toHaveBeenCalled();
    });

    it('answers schema reads with 409 and opens no connection', async () => {
      await expect(service.getSchema('proj_1', 'dev', context)).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.createDb).not.toHaveBeenCalled();
    });
  });

  describe('an override that names the platform database', () => {
    const cases: Array<{ name: string; url: string; platformUrl?: string }> = [
      {
        name: 'different credentials',
        url: 'postgres://tenant:tenant-pass@eve-db.internal:5432/eve',
      },
      {
        name: 'host in another case and the default port left out',
        url: 'postgresql://tenant:x@EVE-DB.Internal/eve',
      },
      {
        name: 'host written with a trailing dot',
        url: 'postgres://tenant:x@eve-db.internal.:5432/eve',
      },
      {
        name: 'database chosen by a startup parameter',
        url: 'postgres://tenant:x@eve-db.internal:5432/app?database=eve',
      },
      {
        name: 'host given as its address',
        url: 'postgres://tenant:x@10.20.0.5:5432/eve',
      },
      {
        name: 'another loopback spelling',
        platformUrl: 'postgres://eve:platform-pass@localhost:5432/eve',
        url: 'postgres://tenant:x@127.0.0.1/eve',
      },
    ];

    for (const testCase of cases) {
      it(`is refused for sql and reset (${testCase.name})`, async () => {
        if (testCase.platformUrl) {
          vi.stubEnv('DATABASE_URL', testCase.platformUrl);
        }
        environment.overrides_json = { db: { url: testCase.url } };

        await expect(runSql()).rejects.toBeInstanceOf(ForbiddenException);
        await expect(runReset()).rejects.toBeInstanceOf(ForbiddenException);
        expect(mocks.createDb).not.toHaveBeenCalled();
      });
    }
  });

  it('allows an override to an external database that shares the platform database name', async () => {
    environment.overrides_json = { db: { url: 'postgres://app:pw@db.tenant.example:5432/eve' } };

    await expect(runSql()).resolves.toMatchObject({ row_count: 0 });
    expect(mocks.createDb).toHaveBeenCalledWith('postgres://app:pw@db.tenant.example:5432/eve');
  });

  it('allows a managed database on the platform database server under another database name', async () => {
    const managedUrl = 'postgres://tenant_role:tenant-pass@eve-db.internal:5432/tenant_shop_dev';
    mocks.manifests.findLatestByProject.mockResolvedValue({ manifest_yaml: MANAGED_MANIFEST });
    mocks.managedDb.findReadyTenantByEnv.mockResolvedValue({
      id: 'mdbt_1',
      status: 'ready',
      credential_secret_ref: managedUrl,
    });

    await expect(runSql()).resolves.toMatchObject({ row_count: 0 });
    await expect(runReset()).resolves.toMatchObject({ reset: true });
    expect(mocks.createDb).toHaveBeenCalledWith(managedUrl);
  });
  describe('the platform database server', () => {
    for (const database of ['postgres', 'template1']) {
      it(`refuses the platform user on its ${database} database`, async () => {
        environment.overrides_json = {
          db: { url: `postgres://eve:platform-pass@eve-db.internal:5432/${database}` },
        };

        await expect(runSql()).rejects.toBeInstanceOf(ForbiddenException);
        await expect(runReset()).rejects.toBeInstanceOf(ForbiddenException);
        expect(mocks.createDb).not.toHaveBeenCalled();
      });
    }

    it('refuses the platform user chosen by a startup parameter', async () => {
      environment.overrides_json = {
        db: { url: 'postgres://someone:x@10.20.0.5:5432/postgres?user=eve' },
      };

      await expect(runSql()).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.createDb).not.toHaveBeenCalled();
    });

    it('refuses a superuser login before running anything', async () => {
      mocks.privileged = true;
      environment.overrides_json = {
        db: { url: 'postgres://admin2:x@eve-db.internal:5432/tenant_db' },
      };

      await expect(runSql()).rejects.toBeInstanceOf(ForbiddenException);
      await expect(runReset()).rejects.toBeInstanceOf(ForbiddenException);
      for (const result of mocks.createDb.mock.results) {
        const client = result.value as ReturnType<typeof fakeClient>;
        expect(client.begin).not.toHaveBeenCalled();
        expect(client.unsafe).not.toHaveBeenCalled();
        expect(client.end).toHaveBeenCalled();
      }
    });

    it('allows a superuser on a container database in the tenant namespace', async () => {
      mocks.privileged = true;
      mocks.manifests.findLatestByProject.mockResolvedValue({ manifest_yaml: CONTAINER_DB_MANIFEST });

      await expect(runSql()).resolves.toMatchObject({ row_count: 0 });
      expect(mocks.createDb).toHaveBeenCalledWith(
        'postgres://postgres:pw@dev-db.eve-acme-shop-dev.svc.cluster.local:5432/app',
      );
    });

    it('refuses every target when the platform host does not resolve', async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://eve:platform-pass@eve-db.unresolvable:5432/eve');
      environment.overrides_json = { db: { url: 'postgres://app:pw@db.tenant.example:5432/app' } };

      await expect(runSql()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mocks.createDb).not.toHaveBeenCalled();
    });
  });
});
