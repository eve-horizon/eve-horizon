import { afterEach, describe, expect, it, vi } from 'vitest';
import type express from 'express';

// The security module derives its allowlists from env vars read at module
// load (via config.ts), so each suite loads a fresh copy with stubbed env.
// These tests document CURRENT behavior, including its sharp edges.

type SecurityModule = typeof import('../src/security.js');

const ENV_KEYS = [
  'EVE_DEFAULT_DOMAIN',
  'EVE_SIGNUP_ALLOWED_EMAIL_DOMAINS',
  'EVE_INTERNAL_API_KEY',
] as const;

async function loadSecurity(env: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}): Promise<SecurityModule> {
  vi.resetModules();
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, env[key]);
  }
  return await import('../src/security.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('isClusterDomainHost', () => {
  it('accepts the default cluster domain and its subdomains', async () => {
    const sec = await loadSecurity();
    expect(sec.isClusterDomainHost('lvh.me')).toBe(true);
    expect(sec.isClusterDomainHost('api.lvh.me')).toBe(true);
    expect(sec.isClusterDomainHost('app.mto-dtest-test.lvh.me')).toBe(true);
  });

  it('rejects lookalike and unrelated hosts', async () => {
    const sec = await loadSecurity();
    expect(sec.isClusterDomainHost('evillvh.me')).toBe(false);
    expect(sec.isClusterDomainHost('lvh.me.evil.com')).toBe(false);
    expect(sec.isClusterDomainHost('example.com')).toBe(false);
    expect(sec.isClusterDomainHost('')).toBe(false);
  });

  it('respects EVE_DEFAULT_DOMAIN overrides', async () => {
    const sec = await loadSecurity({ EVE_DEFAULT_DOMAIN: 'eve.example.com' });
    expect(sec.isClusterDomainHost('eve.example.com')).toBe(true);
    expect(sec.isClusterDomainHost('app.eve.example.com')).toBe(true);
    expect(sec.isClusterDomainHost('lvh.me')).toBe(false);
    expect(sec.isClusterDomainHost('example.com')).toBe(false);
  });
});

describe('isLocalHttpOrigin', () => {
  it('accepts http on loopback names and lvh.me', async () => {
    const sec = await loadSecurity();
    expect(sec.isLocalHttpOrigin(new URL('http://localhost:3000'))).toBe(true);
    expect(sec.isLocalHttpOrigin(new URL('http://127.0.0.1'))).toBe(true);
    expect(sec.isLocalHttpOrigin(new URL('http://0.0.0.0:8080'))).toBe(true);
    expect(sec.isLocalHttpOrigin(new URL('http://LOCALHOST:5173'))).toBe(true);
    expect(sec.isLocalHttpOrigin(new URL('http://lvh.me'))).toBe(true);
    expect(sec.isLocalHttpOrigin(new URL('http://foo.lvh.me:4801'))).toBe(true);
  });

  it('rejects non-http protocols and non-local hosts', async () => {
    const sec = await loadSecurity();
    expect(sec.isLocalHttpOrigin(new URL('https://localhost'))).toBe(false);
    expect(sec.isLocalHttpOrigin(new URL('http://example.com'))).toBe(false);
    expect(sec.isLocalHttpOrigin(new URL('http://foolvh.me'))).toBe(false);
  });

  it('does not recognize bracketed IPv6 loopback (URL.hostname keeps brackets)', async () => {
    const sec = await loadSecurity();
    // The set contains '::1' but new URL('http://[::1]').hostname is '[::1]'.
    expect(sec.isLocalHttpOrigin(new URL('http://[::1]:3000'))).toBe(false);
  });
});

describe('normalizeOrigin', () => {
  it('reduces URLs to their origin', async () => {
    const sec = await loadSecurity();
    expect(sec.normalizeOrigin('https://app.example.com/path?q=1#frag')).toBe('https://app.example.com');
    expect(sec.normalizeOrigin('https://app.example.com:8443/x')).toBe('https://app.example.com:8443');
    expect(sec.normalizeOrigin('HTTPS://APP.EXAMPLE.COM')).toBe('https://app.example.com');
  });

  it('returns null for unparseable values', async () => {
    const sec = await loadSecurity();
    expect(sec.normalizeOrigin('not a url')).toBe(null);
    expect(sec.normalizeOrigin('')).toBe(null);
  });
});

describe('isAllowedRedirect', () => {
  it('always allows cluster-domain hosts regardless of protocol', async () => {
    const sec = await loadSecurity();
    expect(sec.isAllowedRedirect('http://app.mto-dtest-test.lvh.me/cb')).toBe(true);
    expect(sec.isAllowedRedirect('https://api.lvh.me/x?y=1')).toBe(true);
    // Hostname check precedes the protocol check, so even non-web schemes
    // pass for cluster hosts (current behavior).
    expect(sec.isAllowedRedirect('ftp://x.lvh.me/file')).toBe(true);
  });

  it('rejects external origins that are not allowlisted', async () => {
    const sec = await loadSecurity();
    expect(sec.isAllowedRedirect('https://evil.example/phish')).toBe(false);
    expect(sec.isAllowedRedirect('https://evil.example/phish', {})).toBe(false);
    expect(sec.isAllowedRedirect('https://evil.example/phish', { allowedOrigins: [] })).toBe(false);
  });

  it('accepts project-declared https origins (path/query ignored via origin match)', async () => {
    const sec = await loadSecurity();
    const ctx = { allowedOrigins: ['https://app.acme.example'] };
    expect(sec.isAllowedRedirect('https://app.acme.example/deep/path?x=1', ctx)).toBe(true);
    expect(sec.isAllowedRedirect('https://other.acme.example/', ctx)).toBe(false);
  });

  it('normalizes allowlist entries to origins (paths in entries are ignored)', async () => {
    const sec = await loadSecurity();
    const ctx = { allowedOrigins: ['https://app.acme.example/some/path'] };
    expect(sec.isAllowedRedirect('https://app.acme.example/elsewhere', ctx)).toBe(true);
  });

  it('treats ports as part of the origin', async () => {
    const sec = await loadSecurity();
    const ctx = { allowedOrigins: ['https://app.acme.example'] };
    expect(sec.isAllowedRedirect('https://app.acme.example:8443/x', ctx)).toBe(false);
    expect(sec.isAllowedRedirect('https://app.acme.example:8443/x', { allowedOrigins: ['https://app.acme.example:8443'] })).toBe(true);
  });

  it('rejects allowlisted plain-http origins unless they are local', async () => {
    const sec = await loadSecurity();
    expect(sec.isAllowedRedirect('http://plain.example/cb', { allowedOrigins: ['http://plain.example'] })).toBe(false);
    expect(sec.isAllowedRedirect('http://localhost:5173/cb', { allowedOrigins: ['http://localhost:5173'] })).toBe(true);
  });

  it('rejects malformed and non-web URLs', async () => {
    const sec = await loadSecurity();
    expect(sec.isAllowedRedirect('not a url')).toBe(false);
    expect(sec.isAllowedRedirect('')).toBe(false);
    expect(sec.isAllowedRedirect('javascript:alert(1)')).toBe(false);
    expect(sec.isAllowedRedirect('javascript:alert(1)', { allowedOrigins: ['javascript:alert(1)'] })).toBe(false);
  });

  it('drops unparseable allowlist entries instead of failing', async () => {
    const sec = await loadSecurity();
    const ctx = { allowedOrigins: ['not a url', 'https://ok.example'] };
    expect(sec.isAllowedRedirect('https://ok.example/cb', ctx)).toBe(true);
  });

  it('uses the configured cluster domain', async () => {
    const sec = await loadSecurity({ EVE_DEFAULT_DOMAIN: 'eve.example.com' });
    expect(sec.isAllowedRedirect('https://app.eve.example.com/cb')).toBe(true);
    expect(sec.isAllowedRedirect('http://app.lvh.me/cb')).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  it('mirrors redirect validation for CORS origins', async () => {
    const sec = await loadSecurity();
    expect(sec.isAllowedOrigin('http://app.lvh.me')).toBe(true);
    expect(sec.isAllowedOrigin('https://sandbox.acme.example', { allowedOrigins: ['https://sandbox.acme.example'] })).toBe(true);
    expect(sec.isAllowedOrigin('https://sandbox.acme.example')).toBe(false);
    expect(sec.isAllowedOrigin('http://plain.example', { allowedOrigins: ['http://plain.example'] })).toBe(false);
    expect(sec.isAllowedOrigin('http://localhost:5173', { allowedOrigins: ['http://localhost:5173'] })).toBe(true);
    expect(sec.isAllowedOrigin('null')).toBe(false);
    expect(sec.isAllowedOrigin('')).toBe(false);
  });
});

describe('isSignupEmailAllowed', () => {
  it('allows everything when unrestricted', async () => {
    const sec = await loadSecurity();
    expect(sec.isSignupEmailAllowed('user@anywhere.example')).toBe(true);
    expect(sec.isSignupEmailAllowed('not-an-email')).toBe(true);
  });

  it('enforces the domain allowlist case-insensitively', async () => {
    const sec = await loadSecurity({ EVE_SIGNUP_ALLOWED_EMAIL_DOMAINS: ' acme.com , Example.ORG ' });
    expect(sec.isSignupEmailAllowed('user@acme.com')).toBe(true);
    expect(sec.isSignupEmailAllowed('USER@ACME.COM')).toBe(true);
    expect(sec.isSignupEmailAllowed('user@example.org')).toBe(true);
    expect(sec.isSignupEmailAllowed('user@other.com')).toBe(false);
  });

  it('rejects malformed emails when restricted', async () => {
    const sec = await loadSecurity({ EVE_SIGNUP_ALLOWED_EMAIL_DOMAINS: 'acme.com' });
    expect(sec.isSignupEmailAllowed('plainstring')).toBe(false);
    expect(sec.isSignupEmailAllowed('')).toBe(false);
    // split('@')[1] takes the segment after the FIRST @, so a second @ does
    // not smuggle an allowed domain through.
    expect(sec.isSignupEmailAllowed('a@b@acme.com')).toBe(false);
  });
});

describe('wrap CSRF signing', () => {
  const WRAP = 'mlw_0123456789abcdefghjkmnpqrs';

  it('produces a 64-char hex signature that round-trips', async () => {
    const sec = await loadSecurity({ EVE_INTERNAL_API_KEY: 'test-key' });
    const nonce = sec.signWrapCsrf(WRAP);
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(sec.verifyWrapCsrf(WRAP, nonce)).toBe(true);
  });

  it('is deterministic per key and differs across keys and tokens', async () => {
    const sec1 = await loadSecurity({ EVE_INTERNAL_API_KEY: 'key-one' });
    const a = sec1.signWrapCsrf(WRAP);
    expect(sec1.signWrapCsrf(WRAP)).toBe(a);
    expect(sec1.signWrapCsrf('mlw_zzzzzzzzzzzzzzzzzzzzzzzzzz')).not.toBe(a);
    const sec2 = await loadSecurity({ EVE_INTERNAL_API_KEY: 'key-two' });
    expect(sec2.signWrapCsrf(WRAP)).not.toBe(a);
  });

  it('falls back to a fixed key when EVE_INTERNAL_API_KEY is unset', async () => {
    const sec = await loadSecurity();
    const nonce = sec.signWrapCsrf(WRAP);
    expect(sec.verifyWrapCsrf(WRAP, nonce)).toBe(true);
  });

  it('rejects tampered, truncated, and non-hex nonces', async () => {
    const sec = await loadSecurity({ EVE_INTERNAL_API_KEY: 'test-key' });
    const nonce = sec.signWrapCsrf(WRAP);
    const flipped = (nonce[0] === 'a' ? 'b' : 'a') + nonce.slice(1);
    expect(sec.verifyWrapCsrf(WRAP, flipped)).toBe(false);
    expect(sec.verifyWrapCsrf(WRAP, '')).toBe(false);
    expect(sec.verifyWrapCsrf(WRAP, nonce.slice(0, 63))).toBe(false);
    expect(sec.verifyWrapCsrf(WRAP, nonce + '0')).toBe(false);
    // 64 chars but not hex: Buffer.from(..., 'hex') yields a shorter buffer,
    // timingSafeEqual throws, and the catch returns false.
    expect(sec.verifyWrapCsrf(WRAP, 'z'.repeat(64))).toBe(false);
  });

  it('binds the nonce to the wrap token', async () => {
    const sec = await loadSecurity({ EVE_INTERNAL_API_KEY: 'test-key' });
    const nonce = sec.signWrapCsrf(WRAP);
    expect(sec.verifyWrapCsrf('mlw_zzzzzzzzzzzzzzzzzzzzzzzzzz', nonce)).toBe(false);
  });
});

describe('isValidWrapToken', () => {
  it('accepts the typeid(mlw) shape only', async () => {
    const sec = await loadSecurity();
    expect(sec.isValidWrapToken('mlw_0123456789abcdefghjkmnpqrs')).toBe(true);
    expect(sec.isValidWrapToken('mlw_0123456789ABCDEFGHJKMNPQRS')).toBe(false);
    expect(sec.isValidWrapToken('mlw_0123456789abcdefghjkmnpqr')).toBe(false); // 25 chars
    expect(sec.isValidWrapToken('mlw_0123456789abcdefghjkmnpqrst')).toBe(false); // 27 chars
    expect(sec.isValidWrapToken('mlx_0123456789abcdefghjkmnpqrs')).toBe(false);
    expect(sec.isValidWrapToken('mlw_0123456789abcdefghjkmnpqrs\n')).toBe(false);
    expect(sec.isValidWrapToken('')).toBe(false);
  });
});

describe('applyCorsHeaders', () => {
  function fakeReq(origin: string | undefined, query: Record<string, string> = {}): express.Request {
    return {
      headers: origin === undefined ? {} : { origin },
      query,
    } as unknown as express.Request;
  }

  function fakeRes() {
    const headers: Record<string, string> = {};
    const state = { statusCode: 200, jsonBody: undefined as unknown };
    const res = {
      setHeader(key: string, value: string) { headers[key] = value; return res; },
      status(code: number) { state.statusCode = code; return res; },
      json(body: unknown) { state.jsonBody = body; return res; },
    };
    return { res: res as unknown as express.Response, headers, state };
  }

  function stubAppContext(allowedOrigins: string[]): void {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      project_id: 'proj_1',
      org_id: 'org_1',
      branding: null,
      auth: {
        login_method: 'password_or_magic_link',
        self_signup: false,
        invite_requires_password: true,
        allowed_redirect_origins: allowedOrigins,
      },
    })));
  }

  it('allows requests without an Origin header and sets no headers', async () => {
    const sec = await loadSecurity();
    const { res, headers } = fakeRes();
    expect(await sec.applyCorsHeaders(fakeReq(undefined), res)).toBe(true);
    expect(headers).toEqual({});
  });

  it('allows cluster-domain origins without project context', async () => {
    const sec = await loadSecurity();
    const { res, headers } = fakeRes();
    expect(await sec.applyCorsHeaders(fakeReq('http://app.lvh.me'), res)).toBe(true);
    expect(headers).toEqual({
      'Access-Control-Allow-Origin': 'http://app.lvh.me',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    });
  });

  it('rejects unparseable origins with 403', async () => {
    const sec = await loadSecurity();
    const { res, state } = fakeRes();
    expect(await sec.applyCorsHeaders(fakeReq('not a url'), res)).toBe(false);
    expect(state.statusCode).toBe(403);
    expect(state.jsonBody).toEqual({ error: 'Origin not allowed' });
  });

  it('rejects external origins without a project_id', async () => {
    const sec = await loadSecurity();
    const { res, state } = fakeRes();
    expect(await sec.applyCorsHeaders(fakeReq('https://sandbox.acme.example'), res)).toBe(false);
    expect(state.statusCode).toBe(403);
    expect(state.jsonBody).toEqual({ error: 'Origin not allowed (project_id required for cross-domain requests)' });
  });

  it('allows external origins declared by the project allowlist', async () => {
    const sec = await loadSecurity();
    stubAppContext(['https://sandbox.acme.example']);
    const { res, headers } = fakeRes();
    const req = fakeReq('https://sandbox.acme.example', { project_id: 'proj_1' });
    expect(await sec.applyCorsHeaders(req, res)).toBe(true);
    expect(headers['Access-Control-Allow-Origin']).toBe('https://sandbox.acme.example');
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('rejects external origins missing from the project allowlist', async () => {
    const sec = await loadSecurity();
    stubAppContext(['https://other.acme.example']);
    const { res, state, headers } = fakeRes();
    const req = fakeReq('https://sandbox.acme.example', { project_id: 'proj_1' });
    expect(await sec.applyCorsHeaders(req, res)).toBe(false);
    expect(state.statusCode).toBe(403);
    expect(state.jsonBody).toEqual({ error: 'Origin not allowed' });
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
});
