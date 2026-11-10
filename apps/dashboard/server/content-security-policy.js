// Content-Security-Policy for the dashboard's pages.
//
// The page runs only its own script files (index.html has no inline script),
// loads its own styles plus the Google Fonts stylesheet and font files, and
// calls only its own /api proxy and the SSO service. The SSO origin is the
// `sso_url` the API's /auth/config gives the browser, so the server learns it
// from the same place and no instance needs extra configuration.

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
 * Returns an async function that resolves to the SSO origin named by the
 * API's /auth/config, or null. A successful answer is reused for `refreshMs`;
 * after a failed call the last known origin stays and the next page asks
 * again.
 */
export function ssoOriginFromApi(apiUrl, { fetchImpl = fetch, refreshMs = 60_000, timeoutMs = 2_000 } = {}) {
  const configUrl = `${apiUrl.replace(/\/+$/, '')}/auth/config`;
  let origin = null;
  let loadedAt = -Infinity;
  let loading = null;

  async function load() {
    try {
      const res = await fetchImpl(configUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return;
      const config = await res.json();
      origin = httpOrigin(config?.sso_url);
      loadedAt = Date.now();
    } catch {
      // API unreachable or not JSON: keep what we had.
    }
  }

  return async function resolveSsoOrigin() {
    if (Date.now() - loadedAt >= refreshMs) {
      loading ??= load().finally(() => {
        loading = null;
      });
      await loading;
    }
    return origin;
  };
}

/** Express middleware that sets the policy on every response it passes on. */
export function contentSecurityPolicy(resolveSsoOrigin) {
  return (_req, res, next) => {
    resolveSsoOrigin().then((ssoOrigin) => {
      res.setHeader('Content-Security-Policy', buildContentSecurityPolicy(ssoOrigin));
      next();
    }, next);
  };
}
