import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EVE_API_URL, EVE_DEFAULT_DOMAIN, SECURE_COOKIES, SUPABASE_ANON_KEY, SUPABASE_AUTH_URL, type GoogleOauthConfig } from './config.js';
import type { ProjectAuthConfig, SsoLoginContext } from './types.js';

export const GOOGLE_OAUTH_COOKIE = SECURE_COOKIES ? '__Host-eve_oauth' : 'eve_oauth';
export const GOOGLE_OAUTH_TTL_MS = 5 * 60 * 1000;
const MAX_PROJECT_ID_LENGTH = 256;
const MAX_REDIRECT_LENGTH = 2048;
const MAX_STATE_LENGTH = 256;
const MAX_CODE_LENGTH = 4096;
const MAX_COOKIE_LENGTH = 3800;
const MAX_REFRESH_TOKEN_LENGTH = 2048;
const REQUEST_TIMEOUT_MS = 10_000;

export type GoogleOauthTransaction = {
  state: string;
  verifier: string;
  projectId: string;
  redirectTo: string;
  expiresAt: number;
};

export type GoogleOauthEndpoints = {
  eveApiUrl: string;
  supabaseAuthInternalUrl: string;
};

export type OAuthExchangeResponse = {
  access_token: string;
  token_type: string;
  expires_at: number;
  user_id: string;
};

export const defaultGoogleOauthEndpoints: GoogleOauthEndpoints = {
  eveApiUrl: EVE_API_URL,
  supabaseAuthInternalUrl: SUPABASE_AUTH_URL,
};

function isLocalHttpUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return url.protocol === 'http:' && (
    host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1'
    || host === 'lvh.me' || host.endsWith('.lvh.me')
  );
}

function isClusterHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === EVE_DEFAULT_DOMAIN || normalized.endsWith(`.${EVE_DEFAULT_DOMAIN}`);
}

export function scalarQuery(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return null;
  return value;
}

export function isGoogleOptedIn(
  context: SsoLoginContext | null,
  projectId: string,
): context is SsoLoginContext & { auth: ProjectAuthConfig } {
  return Boolean(
    context
    && context.project_id === projectId
    && context.auth
    && context.auth.oauth_providers?.includes('google'),
  );
}

function endpointUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  base.pathname = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  return new URL(path.replace(/^\//, ''), base);
}

function parseGoogleProjectContext(data: unknown, projectId: string): SsoLoginContext | null {
  if (!data || typeof data !== 'object') return null;
  const context = data as Record<string, unknown>;
  if (context.project_id !== projectId || typeof context.org_id !== 'string') return null;
  if (context.branding !== null && (typeof context.branding !== 'object' || Array.isArray(context.branding))) return null;
  if (!context.auth || typeof context.auth !== 'object' || Array.isArray(context.auth)) return null;
  const auth = context.auth as Record<string, unknown>;
  if (!Array.isArray(auth.oauth_providers) || !auth.oauth_providers.every((provider) => provider === 'google')) return null;
  if (!Array.isArray(auth.allowed_redirect_origins) || !auth.allowed_redirect_origins.every((origin) => typeof origin === 'string')) return null;
  return context as unknown as SsoLoginContext;
}

/** Strict validation used only by the new OAuth flow; legacy redirect behavior is unchanged. */
export function isGoogleRedirectAllowed(redirectTo: string, allowedOrigins: string[] = []): boolean {
  try {
    const destination = new URL(redirectTo);
    if (destination.username || destination.password) return false;
    if (destination.protocol !== 'https:' && !isLocalHttpUrl(destination)) return false;
    if (isClusterHost(destination.hostname)) return true;
    return allowedOrigins.some((origin) => {
      try {
        const allowed = new URL(origin);
        return !allowed.username
          && !allowed.password
          && (allowed.protocol === 'https:' || isLocalHttpUrl(allowed))
          && allowed.origin === destination.origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function createGoogleOauthTransaction(projectId: string, redirectTo: string, now = Date.now()): GoogleOauthTransaction {
  return {
    state: randomBytes(32).toString('base64url'),
    verifier: randomBytes(32).toString('base64url'),
    projectId,
    redirectTo,
    expiresAt: now + GOOGLE_OAUTH_TTL_MS,
  };
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function sealGoogleOauthTransaction(transaction: GoogleOauthTransaction, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(transaction), 'utf8'), cipher.final()]);
  const cookie = `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
  if (cookie.length > MAX_COOKIE_LENGTH) throw new Error('OAuth transaction exceeds cookie limit');
  return cookie;
}

export function unsealGoogleOauthTransaction(
  cookie: unknown,
  key: Buffer,
  now = Date.now(),
  options: { allowExpired?: boolean } = {},
): GoogleOauthTransaction | null {
  if (typeof cookie !== 'string' || cookie.length === 0 || cookie.length > MAX_COOKIE_LENGTH) return null;
  const parts = cookie.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
    const decoded = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(parts[2], 'base64url')),
      decipher.final(),
    ]).toString('utf8')) as Record<string, unknown>;
    if (
      typeof decoded.state !== 'string' || decoded.state.length === 0 || decoded.state.length > MAX_STATE_LENGTH
      || typeof decoded.verifier !== 'string' || decoded.verifier.length < 43 || decoded.verifier.length > MAX_STATE_LENGTH
      || typeof decoded.projectId !== 'string' || decoded.projectId.length === 0 || decoded.projectId.length > MAX_PROJECT_ID_LENGTH
      || typeof decoded.redirectTo !== 'string' || decoded.redirectTo.length === 0 || decoded.redirectTo.length > MAX_REDIRECT_LENGTH
      || typeof decoded.expiresAt !== 'number' || !Number.isSafeInteger(decoded.expiresAt)
      || (!options.allowExpired && decoded.expiresAt <= now)
    ) return null;
    return decoded as GoogleOauthTransaction;
  } catch {
    return null;
  }
}

export function statesMatch(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function googleCallbackUrl(config: GoogleOauthConfig, state: string): string {
  const callback = new URL('/auth/google/callback', config.ssoUrl);
  callback.searchParams.set('state', state);
  return callback.toString();
}

export function googleAuthorizeUrl(config: GoogleOauthConfig, transaction: GoogleOauthTransaction): string {
  const externalBase = config.supabaseAuthExternalUrl;
  const base = new URL(externalBase);
  base.pathname = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const authorize = new URL('authorize', base);
  authorize.searchParams.set('provider', 'google');
  authorize.searchParams.set('scopes', 'openid,email,profile');
  authorize.searchParams.set('code_challenge', pkceChallenge(transaction.verifier));
  authorize.searchParams.set('code_challenge_method', 's256');
  authorize.searchParams.set('redirect_to', googleCallbackUrl(config, transaction.state));
  return authorize.toString();
}

async function boundedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

export async function fetchGoogleProjectContext(projectId: string, endpoints = defaultGoogleOauthEndpoints): Promise<SsoLoginContext | null> {
  try {
    const url = endpointUrl(endpoints.eveApiUrl, 'auth/app-context');
    url.searchParams.set('project_id', projectId);
    const response = await boundedFetch(url.toString());
    if (!response.ok) return null;
    return parseGoogleProjectContext(await response.json(), projectId);
  } catch {
    return null;
  }
}

export async function isGoogleEnabledUpstream(endpoints = defaultGoogleOauthEndpoints): Promise<boolean> {
  try {
    const response = await boundedFetch(endpointUrl(endpoints.supabaseAuthInternalUrl, 'settings').toString());
    if (!response.ok) return false;
    const data: unknown = await response.json();
    return Boolean(
      data && typeof data === 'object'
      && 'external' in data && data.external && typeof data.external === 'object'
      && 'google' in data.external && data.external.google === true,
    );
  } catch {
    return false;
  }
}

export async function exchangeGooglePkceCode(
  code: string,
  verifier: string,
  endpoints = defaultGoogleOauthEndpoints,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  try {
    const tokenUrl = endpointUrl(endpoints.supabaseAuthInternalUrl, 'token');
    tokenUrl.searchParams.set('grant_type', 'pkce');
    const response = await boundedFetch(tokenUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(SUPABASE_ANON_KEY ? { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } : {}),
      },
      body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object') return null;
    const record = data as Record<string, unknown>;
    if (typeof record.access_token !== 'string' || record.access_token.length === 0 || record.access_token.length > 16_384) return null;
    if (typeof record.refresh_token !== 'string' || record.refresh_token.length === 0 || record.refresh_token.length > MAX_REFRESH_TOKEN_LENGTH) return null;
    return { accessToken: record.access_token, refreshToken: record.refresh_token };
  } catch {
    return null;
  }
}

export async function exchangeGoogleForEveToken(
  accessToken: string,
  projectId: string,
  endpoints = defaultGoogleOauthEndpoints,
): Promise<OAuthExchangeResponse | null> {
  try {
    const response = await boundedFetch(endpointUrl(endpoints.eveApiUrl, 'auth/oauth/exchange').toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, provider: 'google' }),
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object') return null;
    const record = data as Record<string, unknown>;
    if (
      typeof record.access_token !== 'string' || record.access_token.length === 0
      || typeof record.token_type !== 'string' || record.token_type.toLowerCase() !== 'bearer'
      || typeof record.expires_at !== 'number' || !Number.isFinite(record.expires_at) || record.expires_at <= Date.now() / 1000
      || typeof record.user_id !== 'string' || record.user_id.length === 0
    ) return null;
    return record as OAuthExchangeResponse;
  } catch {
    return null;
  }
}

export const googleOauthLimits = {
  projectId: MAX_PROJECT_ID_LENGTH,
  redirectTo: MAX_REDIRECT_LENGTH,
  state: MAX_STATE_LENGTH,
  code: MAX_CODE_LENGTH,
};
