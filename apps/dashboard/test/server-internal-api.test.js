import { createRequire } from 'node:module';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDashboardServer } from './dashboard-server.js';

const proxied = vi.hoisted(() => []);

// The dashboard image installs express and http-proxy-middleware at build
// time; the workspace has express through the SSO app.
vi.mock('express', () => ({
  default: createRequire(new URL('../../sso/package.json', import.meta.url))('express'),
}));
vi.mock('http-proxy-middleware', async () => (await import('./dashboard-server.js')).proxyMiddlewareStub(proxied));

let dashboard;

beforeAll(async () => {
  dashboard = await startDashboardServer({ EVE_API_URL: 'http://127.0.0.1:9' });
});

beforeEach(() => {
  proxied.length = 0;
});

describe('dashboard /api proxy and the API internal routes', () => {
  it.each([
    '/api/internal',
    '/api/internal/',
    '/api/internal/registry/token',
    '/api/internal/projects/proj_1/secrets/resolve?x=1',
    '/api//internal/projects/proj_1/events',
    '/api///internal/x',
    '/api/./internal/x',
    '/api/foo/../internal/x',
    '/api/internal/../internal/x',
    '/api/%69nternal/x',
    '/api/%2569nternal/x',
    '/api/%2Finternal/x',
    '/api/INTERNAL/x',
    '/API/internal/x',
    '/Api/Internal/x',
    '/api\\internal/x',
  ])('answers 404 for %s without calling the API', async (path) => {
    const res = await dashboard.get(path);
    expect(res.status).toBe(404);
    expect(proxied).toEqual([]);
  });

  it.each([
    ['/api/auth/config', '/auth/config'],
    ['/api/jobs/job-1/attempts/1/logs?after=0', '/jobs/job-1/attempts/1/logs?after=0'],
    ['/api/projects/internal-tools', '/projects/internal-tools'],
    ['/api/internalize', '/internalize'],
    ['/api/orgs/o1/files/50%25off.txt', '/orgs/o1/files/50%25off.txt'],
    ['/api/projects/p1/docs/100%2525%2520off', '/projects/p1/docs/100%2525%2520off'],
    ['/api/files/%E0%A4%A', '/files/%E0%A4%A'],
  ])('still proxies %s', async (path, forwarded) => {
    const res = await dashboard.get(path);
    expect(res.status).toBe(200);
    expect(proxied).toEqual([forwarded]);
  });

  it.each([
    '/api/internal/integrations/active#/../../..',
    '/api/internal/secrets#',
    'http://dashboard.test/api/internal/integrations/active',
    'HTTP://x/API/internal/secrets',
    'http://dashboard.test/api/auth/me',
  ])('answers 404 for the raw request target %s without calling the API', async (target) => {
    expect(await dashboard.rawGet(target)).toBe(404);
    expect(proxied).toEqual([]);
  });

  describe.each([
    ['', []],
    [' with Expect: 100-continue', ['Expect: 100-continue']],
  ])('dot segments under /api%s', (_label, headers) => {
    it.each([
      '/api/%2e%2e/internal/projects/p1/secrets',
      '/api/../internal/projects/p1/secrets',
      '/api/%2E%2e/internal/x',
      '/api/.%2e/internal/x',
      '/api/%252e%252e/internal/x',
      '/api/projects/%2e%2e/jobs',
      '/api/projects/../jobs',
      '/api/projects/p1/..',
    ])('answer 404 for %s without calling the API', async (target) => {
      expect(await dashboard.rawGet(target, headers)).toBe(404);
      expect(proxied).toEqual([]);
    });

    it('still proxy segments that only contain dots', async () => {
      for (const target of ['/api/files/a..b', '/api/files/...', '/api/files/v1.2.tar']) {
        expect(await dashboard.rawGet(target, headers), target).toBe(200);
      }
      expect(proxied).toEqual(['/files/a..b', '/files/...', '/files/v1.2.tar']);
    });
  });

  it('never sends a path under /internal to the API, whatever the proxy rewrites', async () => {
    for (const path of ['/api/api/internal/x', '/API/api/internal/integrations/active', '/api/API/internal/x']) {
      await dashboard.get(path);
    }
    expect(proxied.filter((path) => /^\/internal(\/|$)/i.test(path))).toEqual([]);
  });

  it('still serves the app on SPA routes', async () => {
    const res = await dashboard.get('/jobs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});
