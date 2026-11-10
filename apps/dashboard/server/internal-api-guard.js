// The API's /internal/* routes are for platform services inside the cluster.
// The dashboard proxies /api/* to the API, so it keeps those routes out at
// two points:
//
// 1. refuseInternalApi, before routing: 404 unless the request target is a
//    plain origin-form path ("/...", no fragment). Under /api the path is
//    also judged as the API will receive it, with the /api mount removed: it
//    is refused if it holds a ".." segment at all, or names /internal. This
//    check alone covers requests the proxy hook does not see.
// 2. internalRouteProxyHooks, in the proxy: a request whose upstream path
//    holds a ".." segment or is under the API's /internal is dropped before
//    anything is sent and gets a 404. (http-proxy skips this hook for
//    requests with an Expect header; point 1 covers those.)
//
// Paths are compared however they are spelled: percent-escapes of ASCII
// characters decoded (repeatedly), backslashes read as slashes, empty and "."
// segments dropped, letter case ignored, and /internal looked for with ".."
// segments both kept and resolved. A malformed or non-ASCII escape cannot
// spell a route name, so it stays as it is and the path is judged on the
// rest (a path holding "%25" therefore still passes). A path still changing
// after five rounds of decoding is refused.

const MAX_DECODE_ROUNDS = 5;
const REFUSED = 'EVE_DASHBOARD_INTERNAL_ROUTE';

const ASCII_ESCAPE = /%([0-7][0-9a-f])/gi;

/** `path` with ASCII percent-escapes decoded until stable; null if still changing. */
function decodeFully(path) {
  for (let round = 0; ; round += 1) {
    const decoded = path.replace(ASCII_ESCAPE, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (decoded === path) return path;
    if (round === MAX_DECODE_ROUNDS) return null;
    path = decoded;
  }
}

/** Lower-case, decoded segments of `path` without its query, empty and "." segments dropped; null if it never settles. */
function segmentsOf(path) {
  const decoded = decodeFully(path.split('?', 1)[0]);
  if (decoded === null) return null;
  return decoded
    .replace(/\\/g, '/')
    .toLowerCase()
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
}

function startsWith(segments, prefix) {
  return prefix.every((part, i) => segments[i] === part);
}

/** True when `segments`, with ".." segments kept or resolved, are `prefix` or under it. */
function isUnder(segments, prefix) {
  const resolved = [];
  for (const segment of segments) {
    if (segment === '..') resolved.pop();
    else resolved.push(segment);
  }
  return startsWith(segments, prefix) || startsWith(resolved, prefix);
}

/** True when an upstream path, as `segments` below the API's base, must not reach the API. */
function isRefusedUpstream(segments) {
  return segments.includes('..') || isUnder(segments, ['internal']);
}

/**
 * True when the dashboard refuses the path of `target`: under /api, one the
 * API would receive with a ".." segment or under /internal; elsewhere, one
 * that resolves to /api/internal or under it; anywhere, one that never
 * settles.
 */
export function isRefusedPath(target) {
  const segments = segmentsOf(target);
  if (segments === null) return true;
  if (segments[0] === 'api') return isRefusedUpstream(segments.slice(1));
  return isUnder(segments, ['api', 'internal']);
}

function isOriginForm(target) {
  return typeof target === 'string' && target.startsWith('/') && !target.includes('#');
}

function refuse(res) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not Found');
}

/** Express middleware: 404 for refused paths and for unusual request targets. */
export function refuseInternalApi(req, res, next) {
  const target = req.originalUrl ?? req.url;
  if (isOriginForm(target) && !isRefusedPath(target)) {
    next();
    return;
  }
  refuse(res);
}

/** The status http-proxy-middleware gives a failed upstream call. */
function proxyErrorStatus(code) {
  if (/HPE_INVALID/.test(code ?? '')) return 502;
  return ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'].includes(code) ? 504 : 500;
}

/**
 * http-proxy-middleware `on` hooks for a proxy to `apiUrl`: `proxyReq` drops a
 * request whose upstream path holds a ".." segment or is under the API's
 * /internal, and `error` answers it with 404.
 * Supplying `error` replaces the library's default error response, so it
 * answers other proxy failures the way the default does.
 */
export function internalRouteProxyHooks(apiUrl) {
  const base = new URL(apiUrl).pathname.toLowerCase().split('/').filter(Boolean);
  return {
    proxyReq(proxyReq) {
      const segments = segmentsOf(proxyReq.path);
      if (segments === null || !startsWith(segments, base) || isRefusedUpstream(segments.slice(base.length))) {
        proxyReq.destroy(Object.assign(new Error('internal API route'), { code: REFUSED }));
      }
    },
    error(error, _req, res) {
      if (typeof res?.writeHead !== 'function') {
        res?.destroy?.();
        return;
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error?.code === REFUSED) {
        refuse(res);
        return;
      }
      res.writeHead(proxyErrorStatus(error?.code));
      res.end('Error occurred while trying to proxy');
    },
  };
}
