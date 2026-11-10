import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createTcpServer } from 'node:net';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { freePort, startDashboardServer, STUB_ASSET_PATH } from './dashboard-server.js';

// The dashboard image installs express and http-proxy-middleware at build
// time; the workspace has express through the SSO app.
vi.mock('express', () => ({
  default: createRequire(new URL('../../sso/package.json', import.meta.url))('express'),
}));
vi.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: () => (req, res) => {
    res.end(`proxied ${req.url}`);
  },
}));

const servers = [];

afterAll(() => {
  for (const server of servers) server.close();
});

function connectSources(res) {
  const directive = (res.headers['content-security-policy'] ?? '')
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([name]) => name === 'connect-src');
  return directive?.slice(1);
}

/** A stand-in API answering /auth/config with `ssoUrl`, counting the calls. */
async function configApi(ssoUrl, port = 0) {
  const api = { calls: 0 };
  api.server = createHttpServer((req, res) => {
    if (req.url === '/auth/config') api.calls += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/auth/config' ? { sso_url: ssoUrl } : {}));
  });
  await new Promise((resolve) => api.server.listen(port, '127.0.0.1', resolve));
  servers.push(api.server);
  return api;
}

describe('dashboard pages while the API is slow or down', () => {
  it('answers pages and assets at once, with a policy, while the API accepts connections but never answers', async () => {
    const silent = createTcpServer(() => {});
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    servers.push(silent);
    const dashboard = await startDashboardServer({
      EVE_API_URL: `http://127.0.0.1:${silent.address().port}`,
      EVE_SSO_URL: '',
    });

    for (const path of ['/', STUB_ASSET_PATH, '/', '/jobs', STUB_ASSET_PATH]) {
      const started = performance.now();
      const res = await dashboard.get(path);
      const elapsed = performance.now() - started;
      expect(res.status, path).toBe(200);
      expect(elapsed, `${path} took ${Math.round(elapsed)}ms`).toBeLessThan(150);
      expect(connectSources(res), path).toEqual(["'self'"]);
    }
  });

  it('picks the SSO origin up once the API starts answering', async () => {
    const apiPort = await freePort();
    const dashboard = await startDashboardServer({ EVE_API_URL: `http://127.0.0.1:${apiPort}`, EVE_SSO_URL: '' });
    expect(connectSources(await dashboard.get('/'))).toEqual(["'self'"]);

    await configApi('https://sso.eve.example.test/', apiPort);
    let sources;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      sources = connectSources(await dashboard.get('/jobs'));
      if (sources?.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(sources).toEqual(["'self'", 'https://sso.eve.example.test']);
  }, 15_000);
});

describe('EVE_SSO_URL', () => {
  it('names the SSO origin without asking the API', async () => {
    const api = await configApi('https://sso.from-api.example.test');
    const dashboard = await startDashboardServer({
      EVE_API_URL: `http://127.0.0.1:${api.server.address().port}`,
      EVE_SSO_URL: 'https://sso.eve.example.test/login',
    });

    expect(connectSources(await dashboard.get('/'))).toEqual(["'self'", 'https://sso.eve.example.test']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connectSources(await dashboard.get('/jobs'))).toEqual(["'self'", 'https://sso.eve.example.test']);
    expect(api.calls).toBe(0);
  });
});
