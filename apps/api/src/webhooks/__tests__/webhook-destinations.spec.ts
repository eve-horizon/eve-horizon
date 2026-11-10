import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { HttpException } from '@nestjs/common';
import { WebhooksService } from '../webhooks.service';

// ---------------------------------------------------------------------------
// A fake network: a DNS table, canned responses per URL, and a log of every
// outbound connection (host asked for, address actually connected to). The
// fake fetch and the fake http(s).request both behave like the real ones:
// fetch follows redirects by default, and a request resolves its host through
// the `lookup` option when one is given, else through the system resolver.
// ---------------------------------------------------------------------------

type Route = { status: number; headers?: Record<string, string>; body?: string };
type Connection = { host: string; address: string; url: string };

const net = vi.hoisted(() => ({
  dns: new Map<string, string[][]>(),
  dnsCalls: new Map<string, number>(),
  routes: new Map<string, Route>(),
  connections: [] as Array<{ host: string; address: string; url: string }>,
}));

function resolveName(host: string): Array<{ address: string; family: number }> {
  // Absolute names (trailing dot) resolve like the plain spelling here.
  const name = host.toLowerCase().replace(/\.$/, '');
  const answers = net.dns.get(name);
  if (!answers) {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  }
  const call = net.dnsCalls.get(name) ?? 0;
  net.dnsCalls.set(name, call + 1);
  const addresses = answers[Math.min(call, answers.length - 1)];
  return addresses.map((address) => ({ address, family: isIP(address) }));
}

vi.mock('node:dns/promises', () => {
  const lookup = vi.fn(async (host: string, options?: { all?: boolean }) => {
    const answers = resolveName(host);
    return options?.all ? answers : answers[0];
  });
  return { lookup, default: { lookup } };
});

function routeFor(url: string): Route {
  return net.routes.get(url) ?? { status: 200, body: 'ok' };
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
    net.connections.push({ host: bare(url.hostname), address, url: url.toString() });
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
          net.connections.push({ host, address, url: url.toString() });
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
// Webhook rows
// ---------------------------------------------------------------------------

const queries = vi.hoisted(() => ({
  createSubscription: vi.fn(),
  findSubscriptionById: vi.fn(),
  findPendingDeliveries: vi.fn(),
  updateDelivery: vi.fn(),
  countConsecutiveFailures: vi.fn(),
  disableSubscription: vi.fn(),
}));

vi.mock('@eve/db', () => ({
  webhookQueries: vi.fn(() => queries),
  eventQueries: vi.fn(() => ({})),
  projectQueries: vi.fn(() => ({})),
}));

function subscription(url: string) {
  return {
    id: 'wh_1',
    org_id: 'org_1',
    project_id: null,
    url,
    events: ['system.job.completed'],
    filter: {},
    secret: 'a-test-signing-secret',
    active: true,
    created_by: null,
    created_at: new Date('2026-11-10T00:00:00Z'),
    updated_at: new Date('2026-11-10T00:00:00Z'),
  };
}

const delivery = {
  id: 'whd_1',
  subscription_id: 'wh_1',
  event_id: 'evt_1',
  event_type: 'system.job.completed',
  payload: { specversion: '1.0', type: 'system.job.completed', id: 'evt_1' },
  status: 'pending',
  attempts: 0,
  last_attempt_at: null,
  next_retry_at: null,
  response_status: null,
  response_body: null,
  created_at: new Date('2026-11-10T00:00:00Z'),
};

const PUBLIC_IP = '93.184.216.34';

const NON_PUBLIC_DESTINATIONS: Array<[string, string]> = [
  ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
  ['a 10.x address', 'http://10.1.2.3/hook'],
  ['a 127.x address', 'http://127.0.0.1:8080/hook'],
  ['an IPv4-mapped loopback address', 'http://[::ffff:127.0.0.1]/hook'],
  ['localhost', 'http://localhost:3000/hook'],
  ['a cluster service name', 'http://eve-api.eve.svc.cluster.local:4801/internal'],
  ['a name that resolves to a private address', 'https://internal.example.com/hook'],
];

describe('webhook destinations', () => {
  let service: WebhooksService;

  beforeEach(() => {
    vi.clearAllMocks();
    net.dns.clear();
    net.dnsCalls.clear();
    net.routes.clear();
    net.connections.length = 0;

    net.dns.set('hooks.example.com', [[PUBLIC_IP]]);
    net.dns.set('internal.example.com', [['10.0.0.7']]);
    net.dns.set('localhost', [['127.0.0.1', '::1']]);
    net.dns.set('eve-api.eve.svc.cluster.local', [['10.43.0.12']]);

    vi.stubGlobal('fetch', vi.fn(fakeFetch));
    vi.stubEnv('EVE_WEBHOOKS_ALLOW_PRIVATE_TARGETS', '');

    queries.createSubscription.mockImplementation(async (data: { url: string }) => subscription(data.url));
    queries.findPendingDeliveries.mockResolvedValue([delivery]);
    queries.updateDelivery.mockResolvedValue(undefined);
    queries.countConsecutiveFailures.mockResolvedValue(0);

    service = new WebhooksService({} as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function deliverTo(url: string) {
    queries.findSubscriptionById.mockResolvedValue(subscription(url));
    return service.processDeliveries();
  }

  function deliveryStatuses(): string[] {
    return queries.updateDelivery.mock.calls.map(([, update]) => (update as { status: string }).status);
  }

  describe('at delivery', () => {
    for (const [label, url] of NON_PUBLIC_DESTINATIONS) {
      it(`does not send to ${label}`, async () => {
        const result = await deliverTo(url);

        expect(net.connections).toEqual([]);
        expect(result).toMatchObject({ processed: 1, succeeded: 0, failed: 1 });
        expect(deliveryStatuses()).not.toContain('delivered');
      });
    }

    it('treats a redirect as a failed delivery and does not follow it', async () => {
      net.routes.set('https://hooks.example.com/hook', {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      });

      const result = await deliverTo('https://hooks.example.com/hook');

      expect(net.connections.map((c) => c.address)).toEqual([PUBLIC_IP]);
      expect(result).toMatchObject({ succeeded: 0, failed: 1 });
      expect(queries.updateDelivery).toHaveBeenCalledWith(
        'whd_1',
        expect.objectContaining({ status: 'retrying', response_status: 302 }),
      );
    });

    it('delivers to a public address', async () => {
      const result = await deliverTo('https://hooks.example.com/hook');

      expect(result).toMatchObject({ succeeded: 1, failed: 0 });
      expect(net.connections).toEqual([
        { host: 'hooks.example.com', address: PUBLIC_IP, url: 'https://hooks.example.com/hook' },
      ]);
      expect(queries.updateDelivery).toHaveBeenCalledWith(
        'whd_1',
        expect.objectContaining({ status: 'delivered', response_status: 200 }),
      );
    });

    it('connects to the address it checked even if a later lookup answers differently', async () => {
      net.dns.set('flip.example.com', [[PUBLIC_IP], ['10.0.0.7']]);

      const result = await deliverTo('https://flip.example.com/hook');

      expect(result).toMatchObject({ succeeded: 1 });
      expect(net.connections.map((c) => c.address)).toEqual([PUBLIC_IP]);
    });

    it('sends to a private address when the development setting allows it', async () => {
      vi.stubEnv('EVE_WEBHOOKS_ALLOW_PRIVATE_TARGETS', 'true');

      const result = await deliverTo('http://127.0.0.1:8080/hook');

      expect(result).toMatchObject({ succeeded: 1, failed: 0 });
      expect(net.connections.map((c) => c.address)).toEqual(['127.0.0.1']);
    });
  });

  describe('at subscription create', () => {
    const create = (url: string) =>
      service.createSubscription('org_1', {
        url,
        events: ['system.job.completed'],
        secret: 'a-test-signing-secret',
      });

    for (const [label, url] of NON_PUBLIC_DESTINATIONS) {
      it(`rejects ${label} with 400`, async () => {
        const error = await create(url).then(() => null, (err: unknown) => err);

        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(400);
        expect(queries.createSubscription).not.toHaveBeenCalled();
      });
    }

    it('accepts a public URL', async () => {
      await expect(create('https://hooks.example.com/hook')).resolves.toMatchObject({
        url: 'https://hooks.example.com/hook',
      });
    });

    it('accepts a private URL when the development setting allows it', async () => {
      vi.stubEnv('EVE_WEBHOOKS_ALLOW_PRIVATE_TARGETS', 'true');

      await expect(create('http://localhost:3000/hook')).resolves.toMatchObject({
        url: 'http://localhost:3000/hook',
      });
    });
  });
});
