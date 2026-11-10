import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { BadRequestException } from '@nestjs/common';
import { EnvDbService } from './env-db.service';
import type { SecretsService } from '../secrets/secrets.service';

// The real Postgres client is used here; only the row lookups are faked. A
// local TCP listener stands in for the database and records what arrives.

const mocks = vi.hoisted(() => ({
  projects: { findById: vi.fn() },
  environments: { findByProjectAndName: vi.fn() },
  manifests: { findLatestByProject: vi.fn() },
  orgs: { findById: vi.fn() },
  managedDb: { findReadyTenantByEnv: vi.fn(), listTenantsByOrg: vi.fn() },
  accessGroups: { listGroupIdsForPrincipal: vi.fn() },
}));

vi.mock('@eve/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eve/db')>()),
  projectQueries: vi.fn(() => mocks.projects),
  environmentQueries: vi.fn(() => mocks.environments),
  projectManifestQueries: vi.fn(() => mocks.manifests),
  orgQueries: vi.fn(() => mocks.orgs),
  managedDbQueries: vi.fn(() => mocks.managedDb),
  accessGroupQueries: vi.fn(() => mocks.accessGroups),
}));

vi.mock('node:dns/promises', () => {
  const lookup = vi.fn(async (host: string) => {
    if (host.replace(/\.$/, '') === 'eve-db.internal') return [{ address: '10.20.0.5', family: 4 }];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  });
  return { lookup, default: { lookup } };
});

/** A FATAL ErrorResponse, so the client gives up at once instead of retrying. */
function fatal(message: string): Buffer {
  const body = Buffer.from(`SFATAL\0C28000\0M${message}\0\0`, 'latin1');
  const header = Buffer.alloc(5);
  header.write('E', 0, 'latin1');
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

/** Startup packet: int32 length, int32 protocol, then name\0value\0 pairs, then \0. */
function startupParameters(packet: Buffer): Array<[string, string]> {
  const fields = packet.subarray(8).toString('latin1').split('\0');
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i + 1 < fields.length && fields[i] !== ''; i += 2) {
    pairs.push([fields[i], fields[i + 1]]);
  }
  return pairs;
}

describe('env-db connection strings reach the database exactly as checked', () => {
  let server: Server;
  let port: number;
  let received: Buffer[];
  let service: EnvDbService;
  let environment: Record<string, unknown>;

  beforeAll(async () => {
    server = createServer((socket: Socket) => {
      socket.once('data', (chunk: Buffer) => {
        received.push(chunk);
        socket.end(fatal('test listener accepts no logins'));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    received = [];
    vi.stubEnv('DATABASE_URL', 'postgres://eve:platform-pass@eve-db.internal:5432/eve');
    environment = { id: 'env_1', name: 'dev', namespace: null, db_ref: null, overrides_json: {} };
    mocks.projects.findById.mockResolvedValue({ id: 'proj_1', org_id: 'org_1', slug: 'shop' });
    mocks.environments.findByProjectAndName.mockImplementation(async () => environment);
    mocks.manifests.findLatestByProject.mockResolvedValue(null);
    mocks.orgs.findById.mockResolvedValue({ id: 'org_1', slug: 'acme' });
    mocks.accessGroups.listGroupIdsForPrincipal.mockResolvedValue([]);
    const secrets = { resolveProjectSecretValue: vi.fn(async () => null) };
    service = new EnvDbService({} as never, secrets as unknown as SecretsService);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const runSql = () =>
    service.executeSql('proj_1', 'dev', 'SELECT 1', undefined, false, { user_id: 'user_1', project_id: 'proj_1', env_name: 'dev' });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  const hiddenPairs = encodeURIComponent('x\0user\0eve\0database\0eve\0session_authorization\0pg_monitor');

  for (const [label, url] of [
    ['extra pairs hidden in application_name', () => `postgres://tenant:pw@127.0.0.1:${port}/app?application_name=${hiddenPairs}`],
    ['a NUL in the user', () => `postgres://ten%00ant:pw@127.0.0.1:${port}/app`],
    ['a NUL in the password', () => `postgres://tenant:p%00w@127.0.0.1:${port}/app`],
    ['a NUL in the database', () => `postgres://tenant:pw@127.0.0.1:${port}/app%00eve`],
    ['a NUL in a parameter name', () => `postgres://tenant:pw@127.0.0.1:${port}/app?application%00name=x`],
    ['a newline in search_path', () => `postgres://tenant:pw@127.0.0.1:${port}/app?search_path=a%0Ab`],
    ['another control character', () => `postgres://tenant:pw@127.0.0.1:${port}/app?application_name=a%01b`],
  ] as const) {
    it(`refuses ${label} and sends nothing`, async () => {
      environment.overrides_json = { db: { url: url() } };

      const error = await runSql().then(() => null, (err: unknown) => err);
      await settle();

      expect(error).toBeInstanceOf(BadRequestException);
      expect(received).toEqual([]);
    });
  }

  it('sends exactly the checked user, database and parameters for a plain URL', async () => {
    environment.overrides_json = {
      db: { url: `postgres://tenant:pw@127.0.0.1:${port}/app?application_name=shop&search_path=app` },
    };

    await runSql().catch(() => undefined);
    await settle();

    expect(received).toHaveLength(1);
    const params = Object.fromEntries(startupParameters(received[0]));
    expect(params).toMatchObject({ user: 'tenant', database: 'app', application_name: 'shop', search_path: 'app' });
    expect(Object.keys(params).sort()).toEqual(['application_name', 'client_encoding', 'database', 'search_path', 'user']);
  });
});
