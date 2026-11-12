import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseGoogleOauthConfig, type GoogleOauthConfig } from '../src/config.js';
import {
  GOOGLE_OAUTH_COOKIE,
  createGoogleOauthTransaction,
  fetchGoogleProjectContext,
  googleAuthorizeUrl,
  googleOauthLimits,
  isGoogleRedirectAllowed,
  scalarQuery,
  sealGoogleOauthTransaction,
  unsealGoogleOauthTransaction,
} from '../src/google-oauth.js';
import { registerGoogleRoutes } from '../src/routes/google.js';
import { registerSessionRoutes } from '../src/routes/session.js';
import type { SsoLoginContext } from '../src/types.js';

const STATE_KEY = Buffer.alloc(32, 7);

function context(google = true): SsoLoginContext {
  return {
    project_id: 'proj_1',
    org_id: 'org_1',
    branding: null,
    auth: {
      login_method: 'password_or_magic_link',
      self_signup: false,
      invite_requires_password: true,
      allowed_redirect_origins: ['http://localhost:5173'],
      ...(google ? { oauth_providers: ['google'] } : {}),
    },
  };
}

async function listen(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function firstCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (!header) throw new Error('missing set-cookie');
  return header.split(';', 1)[0];
}

describe('Google OAuth configuration and rendering', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('requires explicit, compatible public URLs and a 32-byte key only when enabled', () => {
    expect(parseGoogleOauthConfig({})).toBeNull();
    expect(() => parseGoogleOauthConfig({ EVE_SSO_GOOGLE_ENABLED: 'true' })).toThrow('EVE_SSO_URL is required');
    expect(() => parseGoogleOauthConfig({
      EVE_SSO_GOOGLE_ENABLED: 'true', EVE_SSO_SECURE_COOKIES: 'true',
      EVE_SSO_URL: 'http://localhost:3100', SUPABASE_AUTH_EXTERNAL_URL: 'https://auth.example',
      EVE_SSO_OAUTH_STATE_KEY: STATE_KEY.toString('base64url'),
    })).toThrow('EVE_SSO_URL must use HTTPS');
    expect(parseGoogleOauthConfig({
      EVE_SSO_GOOGLE_ENABLED: 'true', EVE_SSO_SECURE_COOKIES: 'true',
      EVE_SSO_URL: 'https://sso.example', SUPABASE_AUTH_EXTERNAL_URL: 'https://auth.example',
      EVE_SSO_OAUTH_STATE_KEY: STATE_KEY.toString('base64url'),
    })?.stateKey).toEqual(STATE_KEY);
    const prefixed = parseGoogleOauthConfig({
      EVE_SSO_GOOGLE_ENABLED: 'true', EVE_SSO_SECURE_COOKIES: 'true',
      EVE_SSO_URL: 'https://sso.example', SUPABASE_AUTH_EXTERNAL_URL: 'https://auth.example/auth/v1',
      EVE_SSO_OAUTH_STATE_KEY: STATE_KEY.toString('base64url'),
    })!;
    expect(new URL(googleAuthorizeUrl(prefixed, createGoogleOauthTransaction('proj_1', 'https://app.example'))).pathname)
      .toBe('/auth/v1/authorize');
  });

  it('shows Google only when both the operator and the project opt in', async () => {
    vi.stubEnv('EVE_SSO_GOOGLE_ENABLED', 'true');
    vi.stubEnv('EVE_SSO_SECURE_COOKIES', 'false');
    vi.stubEnv('EVE_SSO_URL', 'http://localhost:3100');
    vi.stubEnv('SUPABASE_AUTH_EXTERNAL_URL', 'http://localhost:9999');
    vi.stubEnv('EVE_SSO_OAUTH_STATE_KEY', STATE_KEY.toString('base64url'));
    const { loginPageHtml } = await import('../src/views/login.js');
    expect(loginPageHtml('http://localhost:5173/finish', 'signin', undefined, context(true))).toContain('Continue with Google');
    expect(loginPageHtml('http://localhost:5173/finish', 'signin', undefined, context(false))).not.toContain('Continue with Google');
    expect(loginPageHtml('', 'signin')).not.toContain('Continue with Google');
    const malformed = context(true);
    (malformed.auth as unknown as { oauth_providers: unknown }).oauth_providers = 'google';
    expect(loginPageHtml('http://localhost:5173/finish', 'signin', undefined, malformed)).not.toContain('Continue with Google');
  });

  it('rejects tampered, wrong-key, and boundary-expired sealed transactions', async () => {
    const transaction = createGoogleOauthTransaction('proj_1', 'https://app.example', 1_000);
    const sealed = sealGoogleOauthTransaction(transaction, STATE_KEY);
    const tampered = `${sealed.slice(0, -1)}${sealed.endsWith('a') ? 'b' : 'a'}`;
    expect(unsealGoogleOauthTransaction(tampered, STATE_KEY, 1_001)).toBeNull();
    expect(unsealGoogleOauthTransaction(sealed, Buffer.alloc(32, 8), 1_001)).toBeNull();
    expect(unsealGoogleOauthTransaction(sealed, STATE_KEY, transaction.expiresAt)).toBeNull();
  });

  it('fails closed when app context has an invalid configured base URL', async () => {
    await expect(fetchGoogleProjectContext('proj_1', {
      eveApiUrl: 'not-a-url', supabaseAuthInternalUrl: 'http://localhost:9999',
    })).resolves.toBeNull();
  });
});

describe('Google OAuth routes', () => {
  let closes: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closes.map((close) => close()));
    closes = [];
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function fixture(options: {
    google?: boolean; callbackGoogle?: boolean; settings?: boolean; refreshToken?: string; malformedToken?: boolean; malformedExchange?: boolean; rejectExchange?: boolean;
  } = {}) {
    const calls = { context: 0, token: 0, exchange: 0 };
    let codeUsed = false;
    const api = await listen(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://api.test');
      if (url.pathname === '/auth/app-context') {
        calls.context += 1;
        const enabled = calls.context === 1 ? options.google !== false : options.callbackGoogle ?? options.google !== false;
        json(res, 200, context(enabled));
        return;
      }
      if (url.pathname === '/auth/oauth/exchange' && req.method === 'POST') {
        calls.exchange += 1;
        if (options.rejectExchange) {
          json(res, 503, { error: 'upstream_unavailable' });
          return;
        }
        expect(req.headers.authorization).toBe('Bearer supabase-access');
        expect(await readJson(req)).toEqual({ project_id: 'proj_1', provider: 'google' });
        json(res, 200, options.malformedExchange
          ? { access_token: 'eve-access', token_type: 'bearer', expires_at: 1_893_456_000 }
          : { access_token: 'eve-access', token_type: 'bearer', expires_at: 1_893_456_000, user_id: 'usr_1' });
        return;
      }
      json(res, 404, {});
    });
    const auth = await listen(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://auth.test');
      if (url.pathname === '/settings') {
        json(res, 200, { external: { google: options.settings !== false } });
        return;
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        calls.token += 1;
        expect(url.searchParams.get('grant_type')).toBe('pkce');
        expect(await readJson(req)).toMatchObject({ auth_code: 'one-use-code' });
        if (codeUsed) {
          json(res, 400, { error: 'already_used' });
        } else {
          codeUsed = true;
          json(res, 200, options.malformedToken
            ? { access_token: 'supabase-access' }
            : { access_token: 'supabase-access', refresh_token: options.refreshToken ?? 'supabase-refresh' });
        }
        return;
      }
      json(res, 404, {});
    });
    closes.push(api.close, auth.close);
    const app = express();
    app.use(cookieParser());
    const config: GoogleOauthConfig = {
      ssoUrl: new URL('http://localhost:3100'),
      supabaseAuthExternalUrl: new URL(auth.url),
      stateKey: STATE_KEY,
    };
    registerGoogleRoutes(app, { config, endpoints: { eveApiUrl: api.url, supabaseAuthInternalUrl: auth.url } });
    const sso = await listen(app);
    closes.push(sso.close);
    return { api, auth, sso, config, calls };
  }

  it('uses PKCE and a sealed browser transaction for a complete local HTTP roundtrip', async () => {
    const { sso, config, calls } = await fixture();
    const start = await fetch(`${sso.url}/auth/google/start?project_id=proj_1&redirect_to=${encodeURIComponent('http://localhost:5173/finish')}`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    expect(start.headers.get('cache-control')).toBe('no-store');
    expect(start.headers.get('referrer-policy')).toBe('no-referrer');
    const cookie = firstCookie(start);
    expect(cookie.startsWith(`${GOOGLE_OAUTH_COOKIE}=`)).toBe(true);
    const encrypted = cookie.slice(cookie.indexOf('=') + 1);
    const transaction = unsealGoogleOauthTransaction(encrypted, config.stateKey);
    expect(transaction?.projectId).toBe('proj_1');
    const authorize = new URL(start.headers.get('location')!);
    expect(authorize.pathname).toBe('/authorize');
    expect(authorize.searchParams.get('provider')).toBe('google');
    expect(authorize.searchParams.get('scopes')).toBe('openid,email,profile');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('s256');
    expect(authorize.searchParams.has('state')).toBe(false);
    expect(new URL(authorize.searchParams.get('redirect_to')!).searchParams.get('state')).toBe(transaction?.state);

    const callback = await fetch(`${sso.url}/auth/google/callback?state=${transaction!.state}&code=one-use-code`, {
      redirect: 'manual', headers: { cookie },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('http://localhost:5173/finish');
    expect(callback.headers.get('set-cookie')).toContain('eve_sso_rt=supabase-refresh');
    expect(calls).toEqual({ context: 3, token: 1, exchange: 1 });
  });

  it('rejects repeated query values, unsafe destinations, disabled settings, and browser-state mismatches before token exchange', async () => {
    const { sso, calls } = await fixture({ settings: false });
    const repeated = await fetch(`${sso.url}/auth/google/start?project_id=proj_1&project_id=other`, { redirect: 'manual' });
    expect(repeated.status).toBe(400);
    const unsafe = await fetch(`${sso.url}/auth/google/start?project_id=proj_1&redirect_to=${encodeURIComponent('https://good.example@evil.example/')}`, { redirect: 'manual' });
    expect(unsafe.status).toBe(400);
    const disabled = await fetch(`${sso.url}/auth/google/start?project_id=proj_1`, { redirect: 'manual' });
    expect(disabled.status).toBe(400);
    expect(calls.token).toBe(0);
    expect(isGoogleRedirectAllowed('https://good.example@evil.example/', ['https://evil.example'])).toBe(false);
    expect(scalarQuery('x'.repeat(googleOauthLimits.code + 1), googleOauthLimits.code)).toBeNull();
  });

  it('rechecks project opt-in, clears the transaction, and never sets a session on a failed callback', async () => {
    const { sso, config, calls } = await fixture({ callbackGoogle: false });
    const start = await fetch(`${sso.url}/auth/google/start?project_id=proj_1&redirect_to=${encodeURIComponent('http://localhost:5173/finish')}`, { redirect: 'manual' });
    const cookie = firstCookie(start);
    const transaction = unsealGoogleOauthTransaction(cookie.slice(cookie.indexOf('=') + 1), config.stateKey)!;
    const callback = await fetch(`${sso.url}/auth/google/callback?state=${transaction.state}&code=one-use-code`, {
      redirect: 'manual', headers: { cookie },
    });
    expect(callback.headers.get('location')).toContain('/login?error=Google+sign-in+failed');
    expect(callback.headers.get('set-cookie')).toContain(`${GOOGLE_OAUTH_COOKIE}=;`);
    expect(callback.headers.get('set-cookie')).not.toContain('eve_sso_rt=supabase-refresh');
    expect(calls).toEqual({ context: 2, token: 0, exchange: 0 });
  });

  it('preserves a newer valid transaction after a wrong-state callback and keeps only revalidated retry context', async () => {
    const { sso, config, calls } = await fixture();
    const start = await fetch(`${sso.url}/auth/google/start?project_id=proj_1&redirect_to=${encodeURIComponent('http://localhost:5173/finish')}`, { redirect: 'manual' });
    const cookie = firstCookie(start);
    const transaction = unsealGoogleOauthTransaction(cookie.slice(cookie.indexOf('=') + 1), config.stateKey)!;
    const callback = await fetch(`${sso.url}/auth/google/callback?state=wrong-state&code=one-use-code`, {
      redirect: 'manual', headers: { cookie },
    });
    expect(callback.headers.get('location')).toContain('project_id=proj_1');
    expect(callback.headers.get('set-cookie')).toBeNull();
    expect(calls).toEqual({ context: 2, token: 0, exchange: 0 });
    expect(unsealGoogleOauthTransaction(cookie.slice(cookie.indexOf('=') + 1), config.stateKey)?.state).toBe(transaction.state);
  });

  it('rejects provider refresh tokens too large for the browser session cookie', async () => {
    const { sso, config, calls } = await fixture({ refreshToken: 'r'.repeat(2049) });
    const start = await fetch(`${sso.url}/auth/google/start?project_id=proj_1&redirect_to=${encodeURIComponent('http://localhost:5173/finish')}`, { redirect: 'manual' });
    const cookie = firstCookie(start);
    const transaction = unsealGoogleOauthTransaction(cookie.slice(cookie.indexOf('=') + 1), config.stateKey)!;
    const callback = await fetch(`${sso.url}/auth/google/callback?state=${transaction.state}&code=one-use-code`, {
      redirect: 'manual', headers: { cookie },
    });
    expect(callback.headers.get('location')).toContain('/login?error=Google+sign-in+failed');
    expect(callback.headers.get('set-cookie')).not.toContain('eve_sso_rt=');
    expect(calls).toEqual({ context: 3, token: 1, exchange: 0 });
  });

  it('does not leak a malformed provider response into the browser or create a session', async () => {
    const { sso, config, calls } = await fixture({ malformedToken: true });
    const start = await fetch(`${sso.url}/auth/google/start?project_id=proj_1&redirect_to=${encodeURIComponent('http://localhost:5173/finish')}`, { redirect: 'manual' });
    const cookie = firstCookie(start);
    const transaction = unsealGoogleOauthTransaction(cookie.slice(cookie.indexOf('=') + 1), config.stateKey)!;
    const callback = await fetch(`${sso.url}/auth/google/callback?state=${transaction.state}&code=one-use-code`, {
      redirect: 'manual', headers: { cookie },
    });
    expect(callback.headers.get('location')).toContain('/login?error=Google+sign-in+failed');
    expect(callback.headers.get('location')).not.toContain('one-use-code');
    expect(callback.headers.get('set-cookie')).not.toContain('eve_sso_rt=');
    expect(calls).toEqual({ context: 3, token: 1, exchange: 0 });
  });

  it('rejects malformed and rejected Eve exchanges without setting a session', async () => {
    for (const options of [{ malformedExchange: true }, { rejectExchange: true }]) {
      const { sso, config, calls } = await fixture(options);
      const start = await fetch(`${sso.url}/auth/google/start?project_id=proj_1&redirect_to=${encodeURIComponent('http://localhost:5173/finish')}`, { redirect: 'manual' });
      const cookie = firstCookie(start);
      const transaction = unsealGoogleOauthTransaction(cookie.slice(cookie.indexOf('=') + 1), config.stateKey)!;
      const callback = await fetch(`${sso.url}/auth/google/callback?state=${transaction.state}&code=one-use-code`, {
        redirect: 'manual', headers: { cookie },
      });
      expect(callback.headers.get('location')).toContain('/login?error=Google+sign-in+failed');
      expect(callback.headers.get('set-cookie')).not.toContain('eve_sso_rt=');
      expect(calls).toEqual({ context: 3, token: 1, exchange: 1 });
    }
  });

  it('clears an expired authenticated transaction while retaining only its revalidated retry context', async () => {
    const { sso, config, calls } = await fixture();
    const expired = {
      state: 'expired-state', verifier: 'v'.repeat(43), projectId: 'proj_1',
      redirectTo: 'http://localhost:5173/finish', expiresAt: Date.now() - 1,
    };
    const cookie = `${GOOGLE_OAUTH_COOKIE}=${sealGoogleOauthTransaction(expired, config.stateKey)}`;
    const callback = await fetch(`${sso.url}/auth/google/callback?state=expired-state&code=one-use-code`, {
      redirect: 'manual', headers: { cookie },
    });
    expect(callback.headers.get('location')).toContain('project_id=proj_1');
    expect(callback.headers.get('set-cookie')).toContain(`${GOOGLE_OAUTH_COOKIE}=;`);
    expect(calls).toEqual({ context: 1, token: 0, exchange: 0 });
  });

  it('does not accept a replay after the browser transaction is consumed', async () => {
    const { sso, config, calls } = await fixture();
    const start = await fetch(`${sso.url}/auth/google/start?project_id=proj_1&redirect_to=${encodeURIComponent('http://localhost:5173/finish')}`, { redirect: 'manual' });
    const cookie = firstCookie(start);
    const transaction = unsealGoogleOauthTransaction(cookie.slice(cookie.indexOf('=') + 1), config.stateKey)!;
    await fetch(`${sso.url}/auth/google/callback?state=${transaction.state}&code=one-use-code`, { redirect: 'manual', headers: { cookie } });
    const replay = await fetch(`${sso.url}/auth/google/callback?state=${transaction.state}&code=one-use-code`, { redirect: 'manual', headers: { cookie } });
    expect(replay.headers.get('location')).toContain('/login?error=Google+sign-in+failed');
    expect(replay.headers.get('set-cookie')).not.toContain('eve_sso_rt=supabase-refresh');
    expect(calls).toEqual({ context: 5, token: 2, exchange: 1 });
  });

  it('keeps the existing refresh and logout routes usable with the resulting session cookie', async () => {
    const nativeFetch = globalThis.fetch;
    const refreshedAccess = `header.${Buffer.from(JSON.stringify({ email: 'member@example.test' })).toString('base64url')}.signature`;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('grant_type=refresh_token')) {
        return Response.json({ access_token: refreshedAccess, refresh_token: 'rotated-refresh' });
      }
      if (url.endsWith('/auth/exchange')) {
        return Response.json({ access_token: 'eve-access', expires_at: 1_893_456_000, user_id: 'usr_1' });
      }
      throw new Error(`unexpected upstream URL: ${url}`);
    }));
    const app = express();
    app.use(cookieParser());
    registerSessionRoutes(app);
    const sso = await listen(app);
    closes.push(sso.close);
    const refreshed = await nativeFetch(`${sso.url}/session`, { headers: { cookie: 'eve_sso_rt=initial-refresh' } });
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ user: { id: 'usr_1', email: 'member@example.test' } });
    expect(refreshed.headers.get('set-cookie')).toContain('eve_sso_rt=rotated-refresh');
    const loggedOut = await nativeFetch(`${sso.url}/logout`, { method: 'POST' });
    expect(loggedOut.status).toBe(200);
    expect(loggedOut.headers.get('set-cookie')).toContain('eve_sso_rt=;');
  });

  it('uses a host-only secure transaction cookie in secure deployments', async () => {
    vi.resetModules();
    vi.stubEnv('EVE_SSO_GOOGLE_ENABLED', 'true');
    vi.stubEnv('EVE_SSO_SECURE_COOKIES', 'true');
    vi.stubEnv('EVE_SSO_URL', 'https://sso.example');
    vi.stubEnv('SUPABASE_AUTH_EXTERNAL_URL', 'https://auth.example/auth/v1');
    vi.stubEnv('EVE_SSO_OAUTH_STATE_KEY', STATE_KEY.toString('base64url'));
    const { registerGoogleRoutes: registerSecureGoogleRoutes } = await import('../src/routes/google.js');
    const { api, auth } = await fixture();
    const app = express();
    app.use(cookieParser());
    registerSecureGoogleRoutes(app, { endpoints: { eveApiUrl: api.url, supabaseAuthInternalUrl: auth.url } });
    const sso = await listen(app);
    closes.push(sso.close);
    const response = await fetch(`${sso.url}/auth/google/start?project_id=proj_1&redirect_to=${encodeURIComponent('http://localhost:5173/finish')}`, { redirect: 'manual' });
    const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).toContain('__Host-eve_oauth=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Domain=');
  });
});
