import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import * as yaml from 'yaml';
import { EnvironmentsService } from './environments.service';
import { ApiRegistrationService } from './api-registration.service';

// ---------------------------------------------------------------------------
// A fake network (DNS table, canned responses, connection log). The fake
// fetch follows redirects like the real one; the fake http(s).request
// resolves through the `lookup` option when given, else through DNS.
// ---------------------------------------------------------------------------

type Route = { status: number; headers?: Record<string, string>; body?: string };

const net = vi.hoisted(() => ({
  dns: new Map<string, string[]>(),
  routes: new Map<string, { status: number; headers?: Record<string, string>; body?: string }>(),
  connections: [] as Array<{ host: string; address: string; url: string; method: string }>,
}));

function resolveName(host: string): Array<{ address: string; family: number }> {
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

const SPEC = { openapi: '3.0.0', info: { title: 'svc', version: '1' }, paths: {} };

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
  apiSources: { upsert: vi.fn(), updateCachedSchema: vi.fn() },
  manifests: { findByProjectAndHash: vi.fn() },
  projects: { findById: vi.fn() },
  orgs: { findById: vi.fn() },
  environments: { findByProjectAndName: vi.fn() },
}));

vi.mock('@eve/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eve/db')>()),
  projectApiSourceQueries: vi.fn(() => db.apiSources),
  projectManifestQueries: vi.fn(() => db.manifests),
  projectQueries: vi.fn(() => db.projects),
  orgQueries: vi.fn(() => db.orgs),
  environmentQueries: vi.fn(() => db.environments),
  releaseQueries: vi.fn(() => ({})),
  managedDbQueries: vi.fn(() => ({})),
  ingressAliasQueries: vi.fn(() => ({})),
}));

// Project "shop" in org "acme"; environment "dev" lives in eve-acme-shop-dev.
const NAMESPACE = 'eve-acme-shop-dev';
const OWN_WEB_HOST = `dev-web.${NAMESPACE}.svc.cluster.local`;

type ServiceDef = Record<string, unknown>;

function deployWith(services: Record<string, ServiceDef>) {
  db.manifests.findByProjectAndHash.mockResolvedValue({ manifest_yaml: yaml.stringify({ services }) });
}

function cachedNames(): string[] {
  return db.apiSources.updateCachedSchema.mock.calls.map(([, , name]) => name as string);
}

function registeredNames(): string[] {
  return db.apiSources.upsert.mock.calls.map(([row]) => (row as { name: string }).name);
}

const openapi = (specUrl: string, name: string) => ({ type: 'openapi', spec_url: specUrl, name });

describe('deploy-time API registration targets', () => {
  let service: EnvironmentsService;
  let environment: { id: string; name: string; namespace: string | null };

  beforeEach(() => {
    vi.clearAllMocks();
    net.dns.clear();
    net.routes.clear();
    net.connections.length = 0;

    // The tenant's own services, and services elsewhere in the cluster.
    net.dns.set(OWN_WEB_HOST, ['10.43.0.5']);
    net.dns.set(`dev-my-api.${NAMESPACE}.svc.cluster.local`, ['10.43.0.6']);
    net.dns.set('dev-web.eve-acme-shop-custom.svc.cluster.local', ['10.43.0.7']);
    net.dns.set('eve-api.eve.svc.cluster.local', ['10.43.0.1']);
    net.dns.set('prod-web.eve-other-app-prod.svc.cluster.local', ['10.43.0.77']);
    net.dns.set('dev-web.eve-other-app-prod.svc.cluster.local', ['10.43.0.78']);
    // A two-label name a pod's search path would expand to a cluster service.
    net.dns.set('dev-eve-api.eve', ['34.118.224.5']);
    net.dns.set('specs.example.com', ['93.184.216.34']);

    vi.stubGlobal('fetch', vi.fn(fakeFetch));

    environment = { id: 'env_1', name: 'dev', namespace: null };
    db.projects.findById.mockResolvedValue({ id: 'proj_1', org_id: 'org_1', slug: 'shop', repo_url: 'https://github.com/acme/shop' });
    db.orgs.findById.mockResolvedValue({ id: 'org_1', slug: 'acme' });
    db.environments.findByProjectAndName.mockImplementation(async () => environment);
    db.apiSources.upsert.mockImplementation(async (row: Record<string, unknown>) => row);
    db.apiSources.updateCachedSchema.mockImplementation(async () => ({}));

    const registration = new ApiRegistrationService({} as never);
    service = new EnvironmentsService(null as never, registration, {} as never, {} as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const register = () => (service as any).registerComponentApis('proj_1', 'dev', 'hash_1') as Promise<void>;

  describe('services Eve does not deploy', () => {
    const cases: Array<[string, string, ServiceDef]> = [
      [
        'an external service whose key carries userinfo and a fragment',
        'x@eve-api.eve.svc.cluster.local:4791/#',
        { 'x-eve': { external: true, api_spec: openapi('/system/config', 'loot') } },
      ],
      [
        'a job service posting GraphQL introspection through a crafted key',
        'y@prod-web.eve-other-app-prod.svc.cluster.local:8080/#',
        { 'x-eve': { role: 'job', api_spec: { type: 'graphql', spec_url: '/graphql', name: 'gql' } } },
      ],
      [
        'a managed database service',
        'db',
        { 'x-eve': { role: 'managed_db', api_spec: openapi('/openapi.json', 'dbapi') } },
      ],
      [
        'a service with a connection_url',
        'ext',
        { 'x-eve': { connection_url: 'postgres://x@h/db', api_spec: openapi('/openapi.json', 'extapi') } },
      ],
    ];

    for (const [label, key, definition] of cases) {
      it(`fetches nothing for ${label} with a relative spec URL`, async () => {
        deployWith({ [key]: definition });

        await register();

        expect(net.connections).toEqual([]);
        expect(cachedNames()).toEqual([]);
        expect(registeredNames()).toEqual([]);
      });
    }

    it('still registers a public spec URL for an external service', async () => {
      deployWith({
        partner: { 'x-eve': { external: true, api_spec: openapi('https://specs.example.com/openapi.json', 'partner') } },
      });

      await register();

      expect(net.connections.map((c) => [c.host, c.address])).toEqual([['specs.example.com', '93.184.216.34']]);
      expect(cachedNames()).toEqual(['partner']);
    });
  });

  describe('deployed services with keys that are not DNS names', () => {
    const keys: Array<[string, string]> = [
      ['userinfo and a fragment', 'x@eve-api.eve.svc.cluster.local:4791/#'],
      ['a fragment', 'z#eve-api.eve.svc.cluster.local'],
      ['a query', 'q?x=@eve-api.eve.svc.cluster.local:4791'],
      ['another namespace and port', 'web.eve-other-app-prod.svc.cluster.local:8080/'],
      ['another port in the own namespace', `web.${NAMESPACE}.svc.cluster.local:9090/`],
      ['a two-label name', 'eve-api.eve:4791/'],
    ];

    for (const [label, key] of keys) {
      it(`never reaches past the service's own in-cluster name (${label})`, async () => {
        deployWith({ [key]: { image: 'example/api:1', ports: [3000], 'x-eve': { api_spec: openapi('/system/config', 'crafted') } } });

        await register();

        // The sanitised service name is not deployed in this fake cluster, so
        // nothing resolves; the point is that no other host or port is tried.
        expect(net.connections).toEqual([]);
        expect(cachedNames()).toEqual([]);
      });
    }
  });

  describe('normal services', () => {
    it('registers a relative spec URL from the service\'s own in-cluster URL', async () => {
      deployWith({ web: { image: 'example/web:1', ports: [3000], 'x-eve': { api_spec: openapi('/openapi.json', 'web') } } });

      await register();

      expect(net.connections).toEqual([
        { host: OWN_WEB_HOST, address: '10.43.0.5', url: `http://${OWN_WEB_HOST}:3000/openapi.json`, method: 'GET' },
      ]);
      expect(cachedNames()).toEqual(['web']);
      expect(db.apiSources.upsert).toHaveBeenCalledWith(expect.objectContaining({ base_url: `http://${OWN_WEB_HOST}:3000` }));
    });

    it('builds the in-cluster name the way the worker does', async () => {
      deployWith({ My_API: { image: 'example/api:1', ports: [3000], 'x-eve': { api_spec: openapi('/openapi.json', 'myapi') } } });

      await register();

      expect(net.connections.map((c) => c.host)).toEqual([`dev-my-api.${NAMESPACE}.svc.cluster.local`]);
      expect(cachedNames()).toEqual(['myapi']);
    });

    it('uses the environment\'s own namespace when it has a chosen one', async () => {
      environment.namespace = 'eve-acme-shop-custom';
      deployWith({ web: { image: 'example/web:1', ports: [3000], 'x-eve': { api_spec: openapi('/openapi.json', 'web') } } });

      await register();

      expect(net.connections.map((c) => c.host)).toEqual(['dev-web.eve-acme-shop-custom.svc.cluster.local']);
      expect(cachedNames()).toEqual(['web']);
    });
  });
});
