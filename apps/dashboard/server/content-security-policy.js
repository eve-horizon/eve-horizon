// Content-Security-Policy for the dashboard's pages.
//
// The page runs only its own script files (index.html has no inline script),
// loads its own styles plus the Google Fonts stylesheet and font files, and
// calls only its own /api proxy and the SSO service. The SSO origin comes from
// EVE_SSO_URL when set; otherwise it is the `sso_url` the API's /auth/config
// gives the browser, which the server learns from the same place, so no
// instance needs extra configuration. Responses never wait on that lookup.

const FONT_STYLESHEETS = 'https://fonts.googleapis.com';
const FONT_FILES = 'https://fonts.gstatic.com';

/** The policy for a page whose SSO origin is `ssoOrigin` (null: none). */
export function buildContentSecurityPolicy(ssoOrigin) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self' ${FONT_STYLESHEETS}`,
    `font-src 'self' ${FONT_FILES}`,
    ssoOrigin ? `connect-src 'self' ${ssoOrigin}` : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const PLAIN_ORIGIN = /^https?:\/\/(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])(?::\d+)?$/i;

/** The origin of an http(s) URL, or null for anything else. */
export function httpOrigin(url) {
  if (typeof url !== 'string') return null;
  try {
    const { origin } = new URL(url);
    return PLAIN_ORIGIN.test(origin) ? origin : null;
  } catch {
    return null;
  }
}

/**
 * Returns a function giving the SSO origin to allow right now, or null. It
 * never waits:
 *
 * - With `ssoUrl` (EVE_SSO_URL) set to an http(s) URL, that origin is used
 *   and the API is never asked.
 * - Otherwise the origin is the `sso_url` from the API's /auth/config,
 *   looked up in the background: once at start, again every `refreshMs`
 *   after a success, and after a failure (no answer within `timeoutMs`, an
 *   error status, unreadable JSON) again after 1s, 2s, 4s ... up to
 *   `maxRetryMs`. Until the first answer the result is null (the policy then
 *   allows only the page's own origin); after a failed refresh the last known
 *   origin stays.
 */
export function ssoOriginSource({
  ssoUrl,
  apiUrl,
  fetchImpl = fetch,
  refreshMs = 60_000,
  timeoutMs = 2_000,
  maxRetryMs = 60_000,
  now = Date.now,
} = {}) {
  if (ssoUrl) {
    const fixed = httpOrigin(ssoUrl);
    if (fixed) return () => fixed;
    console.warn('EVE_SSO_URL is not an http(s) URL; learning the SSO origin from the API instead');
  }

  const configUrl = `${apiUrl.replace(/\/+$/, '')}/auth/config`;
  let origin = null;
  let nextLookupAt = 0;
  let failures = 0;
  let looking = false;

  async function lookUp() {
    looking = true;
    try {
      const res = await fetchImpl(configUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`/auth/config answered ${res.status}`);
      const config = await res.json();
      origin = httpOrigin(config?.sso_url);
      failures = 0;
      nextLookupAt = now() + refreshMs;
    } catch {
      failures += 1;
      nextLookupAt = now() + Math.min(maxRetryMs, 1_000 * 2 ** (failures - 1));
    } finally {
      looking = false;
    }
  }

  function currentSsoOrigin() {
    if (!looking && now() >= nextLookupAt) void lookUp();
    return origin;
  }

  currentSsoOrigin();
  return currentSsoOrigin;
}

/** Express middleware that sets the policy on every response it passes on. */
export function contentSecurityPolicy(currentSsoOrigin) {
  return (_req, res, next) => {
    res.setHeader('Content-Security-Policy', buildContentSecurityPolicy(currentSsoOrigin()));
    next();
  };
}
