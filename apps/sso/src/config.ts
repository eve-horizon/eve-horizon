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
