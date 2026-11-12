// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const PORT = parseInt(process.env.PORT ?? '3100', 10);
export const EVE_API_URL = process.env.EVE_API_URL ?? 'http://eve-api.eve.svc.cluster.local:4701';
export const SUPABASE_AUTH_URL = process.env.SUPABASE_AUTH_URL ?? 'http://supabase-auth.eve.svc.cluster.local:9999';
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
export const EVE_DEFAULT_DOMAIN = process.env.EVE_DEFAULT_DOMAIN ?? 'lvh.me';
export const SECURE_COOKIES = process.env.EVE_SSO_SECURE_COOKIES === 'true';
// SameSite for the SSO session cookies.
//   - SECURE_COOKIES=true (staging/prod, https://): use 'none' so cross-site
//     fetch from custom-domain apps (e.g. sandbox.acme.example) to the
//     SSO origin (sso.eve.example.com) carries the cookies. The previous
//     'lax' value caused 401 No session on the React SDK's /session probe.
//     SameSite=None requires Secure (browser-enforced) — only emitted on
//     https://. See apps/sso README and docs/system/auth.md.
//   - SECURE_COOKIES=false (local k3d, http:// lvh.me): use 'lax'. Browsers
//     reject SameSite=None on insecure origins; lvh.me apps are same-site
//     anyway so cross-site fetch is not an issue locally.
export const COOKIE_SAMESITE: 'none' | 'lax' = SECURE_COOKIES ? 'none' : 'lax';
export const SIGNUP_ALLOWED_DOMAINS: string[] = (process.env.EVE_SIGNUP_ALLOWED_EMAIL_DOMAINS ?? '')
  .split(',')
  .map(d => d.trim().toLowerCase())
  .filter(Boolean);
export const EVE_INTERNAL_API_KEY = process.env.EVE_INTERNAL_API_KEY ?? '';

export type GoogleOauthConfig = {
  ssoUrl: URL;
  supabaseAuthExternalUrl: URL;
  stateKey: Buffer;
};

const LOCAL_HTTP_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'lvh.me']);

function isLocalHttpUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return url.protocol === 'http:' && (LOCAL_HTTP_HOSTNAMES.has(host) || host.endsWith('.lvh.me'));
}

function parsePublicUrl(name: string, value: string | undefined, secureCookies: boolean, requireRootPath: boolean): URL {
  if (!value) throw new Error(`${name} is required when EVE_SSO_GOOGLE_ENABLED=true`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute public URL`);
  }
  if (url.username || url.password || url.search || url.hash || (requireRootPath && url.pathname !== '/')) {
    throw new Error(requireRootPath
      ? `${name} must be an origin without credentials, query, hash, or path`
      : `${name} must not include credentials, query, or hash`);
  }
  if (secureCookies ? url.protocol !== 'https:' : !isLocalHttpUrl(url)) {
    throw new Error(secureCookies
      ? `${name} must use HTTPS when EVE_SSO_SECURE_COOKIES=true`
      : `${name} must use HTTP on an explicit local development host when EVE_SSO_SECURE_COOKIES=false`);
  }
  return url;
}

/** Parse the explicitly enabled Google SSO configuration. Kept pure for startup and route tests. */
export function parseGoogleOauthConfig(env: NodeJS.ProcessEnv = process.env): GoogleOauthConfig | null {
  if (env.EVE_SSO_GOOGLE_ENABLED !== 'true') return null;
  const secureCookies = env.EVE_SSO_SECURE_COOKIES === 'true';
  const ssoUrl = parsePublicUrl('EVE_SSO_URL', env.EVE_SSO_URL, secureCookies, true);
  const supabaseAuthExternalUrl = parsePublicUrl(
    'SUPABASE_AUTH_EXTERNAL_URL',
    env.SUPABASE_AUTH_EXTERNAL_URL,
    secureCookies,
    false,
  );
  const encodedKey = env.EVE_SSO_OAUTH_STATE_KEY;
  if (!encodedKey || !/^[A-Za-z0-9_-]+$/.test(encodedKey)) {
    throw new Error('EVE_SSO_OAUTH_STATE_KEY must be a base64url-encoded 32-byte key');
  }
  const stateKey = Buffer.from(encodedKey, 'base64url');
  if (stateKey.length !== 32 || stateKey.toString('base64url') !== encodedKey) {
    throw new Error('EVE_SSO_OAUTH_STATE_KEY must be a base64url-encoded 32-byte key');
  }
  return { ssoUrl, supabaseAuthExternalUrl, stateKey };
}

export const GOOGLE_OAUTH_CONFIG = parseGoogleOauthConfig();
