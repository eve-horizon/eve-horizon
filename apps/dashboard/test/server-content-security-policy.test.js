import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDashboardServer } from './dashboard-server.js';

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

const SSO_ORIGIN = 'https://sso.eve.example.test';

/** Parse a CSP header into { directive: [sources] }. */
function directives(header) {
  expect(header, 'Content-Security-Policy header').toBeTypeOf('string');
  const map = {};
  for (const part of header.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) map[name] = sources;
  }
  return map;
}

let api;
let dashboard;

beforeAll(async () => {
  // Stands in for the Eve API: the browser learns the SSO URL from /auth/config.
  api = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/auth/config' ? JSON.stringify({ sso_url: `${SSO_ORIGIN}/` }) : '{}');
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  dashboard = await startDashboardServer({ EVE_API_URL: `http://127.0.0.1:${api.address().port}` });
});

afterAll(() => {
  api?.close();
});

describe('dashboard pages carry a Content-Security-Policy', () => {
  it.each(['/', '/jobs', '/apps/project?project=proj_1'])('on %s', async (path) => {
    const res = await dashboard.get(path);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);

    const csp = directives(res.headers['content-security-policy']);
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
  });

  it('lets the page call its own /api and the SSO origin the API names, nothing wider', async () => {
    const res = await dashboard.get('/jobs');
    const connect = directives(res.headers['content-security-policy'])['connect-src'];
    expect(connect).toEqual(["'self'", SSO_ORIGIN]);
  });

  it('allows the Google Fonts stylesheet and font files the page loads, and no inline styles', async () => {
    const res = await dashboard.get('/');
    const csp = directives(res.headers['content-security-policy']);
    expect(csp['style-src']).toEqual(["'self'", 'https://fonts.googleapis.com']);
    expect(csp['font-src']).toEqual(["'self'", 'https://fonts.gstatic.com']);
  });
});

describe('index.html works under script-src self', () => {
  it('has no inline scripts', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag, 'every script must load from a file').toMatch(/\ssrc=/i);
    }
  });
});
