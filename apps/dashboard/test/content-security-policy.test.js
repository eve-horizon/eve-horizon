import { describe, expect, it, vi } from 'vitest';
import {
  buildContentSecurityPolicy,
  httpOrigin,
  ssoOriginSource,
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
      'javascript:void(0)',
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

const API_URL = 'http://eve-api:4701/';

/** Let pending lookups settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A clock the test moves by hand. */
function clock() {
  let time = 0;
  return { now: () => time, advance: (ms) => (time += ms) };
}

describe('ssoOriginSource', () => {
  it('uses EVE_SSO_URL and never asks the API', () => {
    const fetchImpl = vi.fn();
    const current = ssoOriginSource({ ssoUrl: 'https://sso.example.test/login', apiUrl: API_URL, fetchImpl });
    expect(current()).toBe('https://sso.example.test');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks the API when EVE_SSO_URL is not an http(s) URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => jsonResponse({ sso_url: 'https://sso.example.test' }));
    const current = ssoOriginSource({ ssoUrl: 'sso.example.test', apiUrl: API_URL, fetchImpl });
    await settle();
    expect(current()).toBe('https://sso.example.test');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('never waits: null until the API answers, then the answer', async () => {
    let answer;
    const fetchImpl = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    const current = ssoOriginSource({ apiUrl: API_URL, fetchImpl });

    expect(current()).toBeNull();
    expect(current()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe('http://eve-api:4701/auth/config');

    answer(jsonResponse({ sso_url: 'https://sso.example.test/' }));
    await settle();
    expect(current()).toBe('https://sso.example.test');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('is null when the API names no SSO URL or an unusable one', async () => {
    for (const config of [{ sso_url: null }, {}, { sso_url: 'https://x.test;script-src' }]) {
      const current = ssoOriginSource({ apiUrl: API_URL, fetchImpl: async () => jsonResponse(config) });
      await settle();
      expect(current(), JSON.stringify(config)).toBeNull();
    }
  });

  it('refreshes after refreshMs and keeps the last known origin when a refresh fails', async () => {
    const time = clock();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ sso_url: 'https://sso.example.test' }))
      .mockRejectedValueOnce(new Error('timeout'));
    const current = ssoOriginSource({ apiUrl: API_URL, fetchImpl, refreshMs: 60_000, now: time.now });
    await settle();

    time.advance(59_999);
    expect(current()).toBe('https://sso.example.test');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    time.advance(1);
    current();
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(current()).toBe('https://sso.example.test');
  });

  it('backs off after failures: 1s, 2s, 4s ... up to maxRetryMs', async () => {
    const time = clock();
    const fetchImpl = vi.fn(async () => jsonResponse({}, false));
    const current = ssoOriginSource({ apiUrl: API_URL, fetchImpl, maxRetryMs: 5_000, now: time.now });
    await settle();

    const lookups = [];
    for (let ms = 0; ms <= 20_000; ms += 250) {
      if (ms > 0) time.advance(250);
      const before = fetchImpl.mock.calls.length;
      current();
      await settle();
      if (fetchImpl.mock.calls.length > before) lookups.push(ms);
    }
    expect(lookups).toEqual([1_000, 3_000, 7_000, 12_000, 17_000]);
    expect(current()).toBeNull();
  });
});
