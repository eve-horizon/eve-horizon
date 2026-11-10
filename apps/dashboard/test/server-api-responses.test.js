import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { startDashboardServer } from './dashboard-server.js';

const forwarded = vi.hoisted(() => []);

/** What the stand-in API answers, by upstream path. */
const answers = vi.hoisted(() => ({
  '/orgs/o1/fs/files/page.html': {
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-disposition': 'inline' },
    body: '<p>A page someone stored</p>',
  },
  '/orgs/o1/fs/files/report.csv': {
    headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' },
    body: 'a,b\n1,2\n',
  },
  '/jobs?limit=1': {
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': 'req-1' },
    body: '{"jobs":[{"id":"job-1"}]}',
  },
  '/jobs/job-1/stream': {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: 'data: {"seq":1}\n\ndata: {"seq":2}\n\n',
  },
}));

// The dashboard image installs express and http-proxy-middleware at build
// time; the workspace has express through the SSO app.
vi.mock('express', () => ({
  default: createRequire(new URL('../../sso/package.json', import.meta.url))('express'),
}));
vi.mock('http-proxy-middleware', async () =>
  (await import('./dashboard-server.js')).proxyMiddlewareStub(forwarded, (path) => answers[path] ?? { status: 404 }),
);

let dashboard;

beforeAll(async () => {
  dashboard = await startDashboardServer({ EVE_API_URL: 'http://127.0.0.1:9', EVE_SSO_URL: 'https://sso.example.test' });
});

describe('responses proxied from /api', () => {
  it('never render as a dashboard page', async () => {
    const res = await dashboard.get('/api/orgs/o1/fs/files/page.html');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toBe('<p>A page someone stored</p>');
  });

  it('pass JSON through unchanged', async () => {
    const res = await dashboard.get('/api/jobs?limit=1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['x-request-id']).toBe('req-1');
    expect(JSON.parse(res.body)).toEqual({ jobs: [{ id: 'job-1' }] });
  });

  it('pass an event stream through unchanged', async () => {
    const res = await dashboard.get('/api/jobs/job-1/stream');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toBe('data: {"seq":1}\n\ndata: {"seq":2}\n\n');
  });

  it('pass a file download through unchanged', async () => {
    const res = await dashboard.get('/api/orgs/o1/fs/files/report.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="report.csv"');
    expect(res.body).toBe('a,b\n1,2\n');
  });

  it('pass API errors through with their status', async () => {
    const res = await dashboard.get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(forwarded).toContain('/does-not-exist');
  });
});
