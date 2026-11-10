import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { LoopService } from './loop.service';

// A fake network: DNS table, canned responses, and every connection made
// (host asked for, address used). The fake fetch follows redirects like the
// real one; the fake http(s).request resolves through its `lookup` option
// when given, else through DNS.

type Route = { status: number; headers?: Record<string, string> };

const net = vi.hoisted(() => ({
  dns: new Map<string, string[]>(),
  routes: new Map<string, { status: number; headers?: Record<string, string> }>(),
  connections: [] as Array<{ host: string; address: string; url: string }>,
}));

function resolveName(host: string): Array<{ address: string; family: number }> {
  const answers = net.dns.get(host.toLowerCase().replace(/\.$/, ''));
  if (!answers) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return answers.map((address) => ({ address, family: isIP(address) }));
}

vi.mock('node:dns/promises', () => {
  const lookup = vi.fn(async (host: string, options?: { all?: boolean }) => {
    const answers = resolveName(host);
    return options?.all ? answers : answers[0];
  });
  return { lookup, default: { lookup } };
});

const routeFor = (url: string): Route => net.routes.get(url) ?? { status: 200 };
const bare = (host: string) => host.replace(/^\[(.*)\]$/, '$1');

async function connectAddress(
  host: string,
  lookup?: (h: string, o: object, cb: (e: Error | null, a: string, f: number) => void) => void,
): Promise<string> {
  const name = bare(host);
  if (isIP(name)) return name;
  if (lookup) {
    return new Promise((resolve, reject) => lookup(name, {}, (err, address) => (err ? reject(err) : resolve(address))));
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
    return new Response('', { status: route.status, headers: route.headers });
  }
  throw new Error('too many redirects');
}

function fakeRequest(protocol: 'http:' | 'https:') {
  return (options: Record<string, any>, onResponse?: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & Record<string, any>;
    req.write = () => true;
    req.destroy = () => req;
    req.end = () => {
      setImmediate(async () => {
        try {
          const host = String(options.hostname ?? options.host);
          const address = await connectAddress(host, options.lookup);
          const url = `${protocol}//${host}${options.port ? `:${options.port}` : ''}${options.path ?? '/'}`;
          net.connections.push({ host, address, url });
          const route = routeFor(url);
          const res = Readable.from([Buffer.from('')], { objectMode: false }) as Readable & Record<string, any>;
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

const PUBLIC = '93.184.216.34';

const record = (callbackUrl: string) => ({
  id: 'ing_1',
  callback_url: callbackUrl,
  file_name: 'notes.pdf',
  mime_type: 'application/pdf',
  size_bytes: 1024,
  storage_key: 'ingest/ing_1/notes.pdf',
});

describe('ingest completion callbacks', () => {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const fire = (callbackUrl: string) =>
    (LoopService.prototype as any).fireIngestCallback.call({ logger }, record(callbackUrl), 'done', 'job_1', null) as Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    net.dns.clear();
    net.routes.clear();
    net.connections.length = 0;
    net.dns.set('hooks.example.com', [PUBLIC]);
    net.dns.set('internal.example.com', ['10.0.0.7']);
    net.dns.set('localhost', ['127.0.0.1']);
    vi.stubGlobal('fetch', vi.fn(fakeFetch));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Retries wait on (fake) timers scheduled only after each attempt's async
  // work, so keep advancing until the sender is done.
  const run = async (callbackUrl: string) => {
    let finished = false;
    const done = fire(callbackUrl).finally(() => {
      finished = true;
    });
    while (!finished) {
      await vi.advanceTimersByTimeAsync(60_000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await done;
  };

  for (const [label, url] of [
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['a private address', 'http://10.0.0.5/hook'],
    ['localhost', 'http://localhost:8080/hook'],
    ['a name that resolves to a private address', 'https://internal.example.com/hook'],
  ] as const) {
    it(`does not send to ${label}`, async () => {
      await run(url);
      expect(net.connections).toEqual([]);
    });
  }

  it('does not follow a redirect', async () => {
    net.routes.set('https://hooks.example.com/ingest', {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    });

    await run('https://hooks.example.com/ingest');

    expect(net.connections.length).toBeGreaterThan(0);
    expect(net.connections.every((c) => c.address === PUBLIC)).toBe(true);
  });

  it('delivers to a public address from the address it checked', async () => {
    await run('https://hooks.example.com/ingest');

    expect(net.connections).toEqual([
      { host: 'hooks.example.com', address: PUBLIC, url: 'https://hooks.example.com/ingest' },
    ]);
  });
});
