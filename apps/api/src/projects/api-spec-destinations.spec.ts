import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { HttpException } from '@nestjs/common';
import type { ApiSpec } from '@eve/shared';
import { ProjectApisService } from './project-apis.service';
import { ApiRegistrationService } from '../environments/api-registration.service';

// ---------------------------------------------------------------------------
// A fake network: a DNS table, canned responses per URL, and a log of every
// outbound connection (host asked for, address connected to). The fake fetch
// and the fake http(s).request behave like the real ones: fetch follows
// redirects by default, and a request resolves its host through the `lookup`
// option when one is given, else through the system resolver.
// ---------------------------------------------------------------------------

type Route = { status: number; headers?: Record<string, string>; body?: string };

const net = vi.hoisted(() => ({
  dns: new Map<string, string[]>(),
  routes: new Map<string, { status: number; headers?: Record<string, string>; body?: string }>(),
  connections: [] as Array<{ host: string; address: string; url: string; method: string }>,
}));

function resolveName(host: string): Array<{ address: string; family: number }> {
  // Absolute names (trailing dot) resolve like the plain spelling here.
  const answers = net.dns.get(host.toLowerCase().replace(/\.$/, ''));
  if (!answers) {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  }
  return answers.map((address) => ({ address, family: isIP(address) }));
}

vi.mock('node:dns/promises', () => {
  const lookup = vi.fn(async (host: string, options?: { all?: boolean }) => {
    const answers = resolveName(host);
    return options?.all ? answers : answers[0];
  });
  return { lookup, default: { lookup } };
});

const SPEC = { openapi: '3.0.0', info: { title: 'shop', version: '1' }, paths: {} };

function routeFor(url: string): Route {
  return net.routes.get(url) ?? { status: 200, body: JSON.stringify(SPEC) };
}

function bare(host: string): string {
  return host.replace(/^\[(.*)\]$/, '$1');
}

async function connectAddress(
  host: string,
  lookup?: (h: string, o: object, cb: (e: Error | null, a: string, f: number) => void) => void,
): Promise<string> {
  const name = bare(host);
  if (isIP(name)) return name;
  if (lookup) {
    return new Promise((resolve, reject) => {
      lookup(name, {}, (err, address) => (err ? reject(err) : resolve(address)));
    });
  }
  return resolveName(name)[0].address;
}

async function fakeFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  let url = new URL(String(input));
  for (let hop = 0; hop < 5; hop += 1) {
    const address = await connectAddress(url.hostname);
    net.connections.push({ host: bare(url.hostname), address, url: url.toString(), method: init?.method ?? 'GET' });
    const route = routeFor(url.toString());
    const location = route.headers?.location;
    if (route.status >= 300 && route.status < 400 && location && (init?.redirect ?? 'follow') === 'follow') {
      url = new URL(location, url);
      continue;
    }
    return new Response(route.body ?? '', { status: route.status, headers: route.headers });
  }
  throw new Error('too many redirects');
}

function fakeRequest(protocol: 'http:' | 'https:') {
  return (options: Record<string, any>, onResponse?: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & Record<string, any>;
    req.write = () => true;
    req.setTimeout = () => req;
    req.destroy = (err?: Error) => {
      if (err) req.emit('error', err);
      return req;
    };
    req.end = () => {
      setImmediate(async () => {
        try {
          const host = String(options.hostname ?? options.host);
          const address = await connectAddress(host, options.lookup);
          const authority = isIP(host) === 6 ? `[${host}]` : host;
          const url = new URL(`${protocol}//${authority}${options.port ? `:${options.port}` : ''}${options.path ?? '/'}`);
          net.connections.push({ host, address, url: url.toString(), method: options.method ?? 'GET' });
          const route = routeFor(url.toString());
          const res = Readable.from([Buffer.from(route.body ?? '')], { objectMode: false }) as Readable & Record<string, any>;
          res.statusCode = route.status;
          res.headers = route.headers ?? {};
          onResponse?.(res);
          req.emit('response', res);
        } catch (err) {
          req.emit('error', err);
        }
      });
      return req;
    };
    return req;
  };
}

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  const request = fakeRequest('http:');
  return { ...actual, request, default: { ...actual, request } };
});

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  const request = fakeRequest('https:');
  return { ...actual, request, default: { ...actual, request } };
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => ({
  apiSources: {
    findByProjectEnvAndName: vi.fn(),
    upsert: vi.fn(),
    updateCachedSchema: vi.fn(),
    list: vi.fn(),
  },
  projects: { findById: vi.fn(), listByOrgAndSlugIgnoringCase: vi.fn(async () => []) },
  orgs: { findById: vi.fn() },
  manifests: { findLatestByProject: vi.fn() },
  environments: { list: vi.fn(), findByProjectAndName: vi.fn() },
}));

vi.mock('@eve/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eve/db')>()),
  projectApiSourceQueries: vi.fn(() => db.apiSources),
  projectQueries: vi.fn(() => db.projects),
  orgQueries: vi.fn(() => db.orgs),
  projectManifestQueries: vi.fn(() => db.manifests),
  environmentQueries: vi.fn(() => db.environments),
}));

// The component "api" of project "shop" (org "acme"), environment "dev".
const OWN_HOST = 'dev-api.eve-acme-shop-dev.svc.cluster.local';
const OWN_BASE = `http://${OWN_HOST}:3000`;
const OWN_ADDRESS = '10.43.0.5';
const PUBLIC_ADDRESS = '93.184.216.34';
const METADATA_URL = 'http://169.254.169.254/latest/meta-data/';

const REFUSED: Array<[string, string]> = [
  ['a loopback address', 'http://127.0.0.1:4801/projects'],
  ['the cloud metadata address', METADATA_URL],
  ['a private address', 'http://10.1.2.3/openapi.json'],
  ['a service in another namespace', 'http://prod-api.eve-other-app-prod.svc.cluster.local:3000/openapi.json'],
  ['another port on the component host', `http://${OWN_HOST}:9090/metrics`],
];

function manifestWithSpecUrl(specUrl: string): string {
  return [
    'services:',
    '  api:',
    '    image: example/api:1',
    '    ports: [3000]',
    '    x-eve:',
    '      api_spec:',
    '        type: openapi',
    `        spec_url: "${specUrl}"`,
  ].join('\n');
}

function sourceRow(specUrl: string) {
  return {
    project_id: 'proj_1',
    env_name: 'dev',
    name: 'api',
    type: 'openapi',
    base_url: OWN_BASE,
    spec_url: specUrl,
    auth_mode: 'eve',
    cached_schema_json: SPEC,
    last_synced_at: new Date('2026-11-10T00:00:00Z'),
    created_at: new Date('2026-11-10T00:00:00Z'),
    updated_at: new Date('2026-11-10T00:00:00Z'),
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => null, (err: unknown) => err);
}

function expectClientError(error: unknown) {
  expect(error).toBeInstanceOf(HttpException);
  const status = (error as HttpException).getStatus();
  expect(status).toBeGreaterThanOrEqual(400);
  expect(status).toBeLessThan(500);
}

describe('API spec fetch destinations', () => {
  let projectApis: ProjectApisService;
  let registration: ApiRegistrationService;
  let manifestSpecUrl: string;

  beforeEach(() => {
    vi.clearAllMocks();
    net.dns.clear();
    net.routes.clear();
    net.connections.length = 0;

    net.dns.set(OWN_HOST, [OWN_ADDRESS]);
    net.dns.set('prod-api.eve-other-app-prod.svc.cluster.local', ['10.43.0.9']);
    net.dns.set('specs.example.com', [PUBLIC_ADDRESS]);
    net.dns.set('localhost', ['127.0.0.1']);

    vi.stubGlobal('fetch', vi.fn(fakeFetch));

    manifestSpecUrl = '/openapi.json';
    db.projects.findById.mockResolvedValue({ id: 'proj_1', org_id: 'org_1', slug: 'shop' });
    db.orgs.findById.mockResolvedValue({ id: 'org_1', slug: 'acme' });
    db.manifests.findLatestByProject.mockImplementation(async () => ({
      manifest_yaml: manifestWithSpecUrl(manifestSpecUrl),
    }));
    db.apiSources.findByProjectEnvAndName.mockResolvedValue(null);
    db.apiSources.upsert.mockImplementation(async (row: { spec_url: string }) => ({
      ...sourceRow(row.spec_url),
      cached_schema_json: null,
    }));
    db.apiSources.updateCachedSchema.mockImplementation(async () => sourceRow(manifestSpecUrl));
    db.apiSources.list.mockResolvedValue([]);
    db.environments.list.mockResolvedValue([]);
    db.environments.findByProjectAndName.mockResolvedValue({ id: 'env_1', name: 'dev', namespace: null });

    projectApis = new ProjectApisService({} as never);
    registration = new ApiRegistrationService({} as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const register = (specUrl: string, type: ApiSpec['type'] = 'openapi') =>
    registration.registerComponentApi(
      'proj_1',
      'dev',
      'api',
      { type, spec_url: specUrl, on_deploy: true, auth: 'eve' },
      { baseUrl: OWN_BASE, namespace: 'eve-acme-shop-dev', deployed: true },
    );

  describe('refused destinations', () => {
    for (const [label, specUrl] of REFUSED) {
      it(`getSpec refuses ${label}`, async () => {
        manifestSpecUrl = specUrl;
        expectClientError(await failure(projectApis.getSpec('proj_1', 'api', 'dev')));
        expect(net.connections).toEqual([]);
      });

      it(`refreshSpec refuses ${label}`, async () => {
        manifestSpecUrl = specUrl;
        expectClientError(await failure(projectApis.refreshSpec('proj_1', 'api', 'dev')));
        expect(net.connections).toEqual([]);
        expect(db.apiSources.updateCachedSchema).not.toHaveBeenCalled();
      });

      it(`refreshSpec of a registered source refuses ${label}`, async () => {
        db.apiSources.findByProjectEnvAndName.mockResolvedValue(sourceRow(specUrl));
        expectClientError(await failure(projectApis.refreshSpec('proj_1', 'api', 'dev')));
        expect(net.connections).toEqual([]);
        expect(db.apiSources.updateCachedSchema).not.toHaveBeenCalled();
      });

      it(`deploy-time registration refuses ${label}`, async () => {
        expectClientError(await failure(register(specUrl)));
        expect(net.connections).toEqual([]);
        expect(db.apiSources.upsert).not.toHaveBeenCalled();
      });
    }

    it('deploy-time registration refuses a host given relative to the scheme', async () => {
      expectClientError(await failure(register('//169.254.169.254/latest/meta-data/')));
      expect(net.connections).toEqual([]);
    });

    it('deploy-time GraphQL registration refuses a loopback address', async () => {
      expectClientError(await failure(register('http://127.0.0.1:4801/graphql', 'graphql')));
      expect(net.connections).toEqual([]);
    });
  });

  describe('allowed destinations', () => {
    it('getSpec fetches from the component\'s own in-cluster URL', async () => {
      await expect(projectApis.getSpec('proj_1', 'api', 'dev')).resolves.toEqual(SPEC);
      expect(net.connections).toEqual([
        { host: OWN_HOST, address: OWN_ADDRESS, url: `${OWN_BASE}/openapi.json`, method: 'GET' },
      ]);
    });

    it('getSpec fetches a public URL from the address it checked', async () => {
      manifestSpecUrl = 'https://specs.example.com/openapi.json';
      await expect(projectApis.getSpec('proj_1', 'api', 'dev')).resolves.toEqual(SPEC);
      expect(net.connections.map((c) => [c.host, c.address])).toEqual([['specs.example.com', PUBLIC_ADDRESS]]);
    });

    it('refreshSpec caches a spec from the component\'s own in-cluster URL', async () => {
      await projectApis.refreshSpec('proj_1', 'api', 'dev');
      expect(db.apiSources.updateCachedSchema).toHaveBeenCalledWith('proj_1', 'dev', 'api', SPEC);
    });

    it('deploy-time registration stores specs from its own URL and from a public URL', async () => {
      await register('/openapi.json');
      await register('https://specs.example.com/openapi.json');
      expect(db.apiSources.updateCachedSchema).toHaveBeenCalledTimes(2);
      expect(net.connections.map((c) => c.address)).toEqual([OWN_ADDRESS, PUBLIC_ADDRESS]);
    });

    it('deploy-time GraphQL registration posts the introspection query to its own URL', async () => {
      net.routes.set(`${OWN_BASE}/graphql`, { status: 200, body: JSON.stringify({ data: { __schema: {} } }) });
      await register('/graphql', 'graphql');
      expect(net.connections).toEqual([
        { host: OWN_HOST, address: OWN_ADDRESS, url: `${OWN_BASE}/graphql`, method: 'POST' },
      ]);
    });
  });

  describe('responses', () => {
    it('does not follow a redirect', async () => {
      net.routes.set(`${OWN_BASE}/openapi.json`, { status: 302, headers: { location: METADATA_URL } });

      expectClientError(await failure(projectApis.getSpec('proj_1', 'api', 'dev')));
      expect(await failure(register('/openapi.json'))).toBeTruthy();
      expect(net.connections.map((c) => c.address)).toEqual([OWN_ADDRESS, OWN_ADDRESS]);
    });

    it('refuses a spec larger than the size limit', async () => {
      net.routes.set(`${OWN_BASE}/openapi.json`, {
        status: 200,
        body: JSON.stringify({ openapi: '3.0.0', padding: 'x'.repeat(11 * 1024 * 1024) }),
      });

      expectClientError(await failure(projectApis.getSpec('proj_1', 'api', 'dev')));
    });
  });
});
