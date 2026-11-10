import { describe, expect, it, vi } from 'vitest';
import {
  buildContentSecurityPolicy,
  httpOrigin,
  ssoOriginFromApi,
} from '../server/content-security-policy.js';

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}

describe('httpOrigin', () => {
  it('reduces an http(s) URL to its origin', () => {
    expect(httpOrigin('https://sso.example.test/login?x=1')).toBe('https://sso.example.test');
    expect(httpOrigin('http://sso.eve.lvh.me')).toBe('http://sso.eve.lvh.me');
    expect(httpOrigin('https://sso.example.test:8443/')).toBe('https://sso.example.test:8443');
  });

  it('refuses values that are not a plain http(s) origin', () => {
    for (const value of [
      undefined,
      null,
      '',
      'not a url',
      'javascript:alert(1)',
      'data:text/html,x',
      "https://sso.example.test;script-src 'unsafe-inline'",
      'https://a,b.example.test',
      "https://a'b.example.test",
    ]) {
      expect(httpOrigin(value), String(value)).toBeNull();
    }
  });
});

describe('buildContentSecurityPolicy', () => {
  it('allows only the page origin to be called when there is no SSO origin', () => {
    expect(buildContentSecurityPolicy(null)).toContain("connect-src 'self';");
  });
});

describe('ssoOriginFromApi', () => {
  it('asks the API once and reuses the answer', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ sso_url: 'https://sso.example.test/' }));
    const resolve = ssoOriginFromApi('http://eve-api:4701/', { fetchImpl });

    expect(await resolve()).toBe('https://sso.example.test');
    expect(await resolve()).toBe('https://sso.example.test');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://eve-api:4701/auth/config');
  });

  it('is null when the API names no SSO URL or an unusable one', async () => {
    for (const config of [{ sso_url: null }, {}, { sso_url: 'https://x.test;script-src *' }]) {
      const resolve = ssoOriginFromApi('http://eve-api:4701', { fetchImpl: async () => jsonResponse(config) });
      expect(await resolve()).toBeNull();
    }
  });

  it('is null until the API answers, then picks the answer up on the next call', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse({}, false))
      .mockResolvedValueOnce(jsonResponse({ sso_url: 'https://sso.example.test' }));
    const resolve = ssoOriginFromApi('http://eve-api:4701', { fetchImpl });

    expect(await resolve()).toBeNull();
    expect(await resolve()).toBeNull();
    expect(await resolve()).toBe('https://sso.example.test');
  });

  it('keeps the last known origin when a refresh fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ sso_url: 'https://sso.example.test' }))
      .mockRejectedValueOnce(new Error('timeout'));
    const resolve = ssoOriginFromApi('http://eve-api:4701', { fetchImpl, refreshMs: 0 });

    expect(await resolve()).toBe('https://sso.example.test');
    expect(await resolve()).toBe('https://sso.example.test');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
