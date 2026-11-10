// The API's /internal/* routes are for platform services inside the cluster.
// The dashboard proxies /api/* to the API, so it keeps those routes out at
// two points:
//
// 1. refuseInternalApi, before routing: 404 unless the request target is a
//    plain origin-form path ("/...", no fragment) that is not /api/internal
//    or under it.
// 2. internalRouteProxyHooks, in the proxy: a request whose upstream path is
//    under the API's /internal is dropped before anything is sent and gets a
//    404. (http-proxy skips this hook for requests with an Expect header;
//    point 1 still covers those.)
//
// Paths are compared however they are spelled: percent-decoded (repeatedly),
// backslashes read as slashes, empty and "." segments dropped, letter case
// ignored, and with ".." segments both kept and resolved. A path that cannot
// be decoded is refused.

const MAX_DECODE_ROUNDS = 5;
const REFUSED = 'EVE_DASHBOARD_INTERNAL_ROUTE';

/** `path` percent-decoded until stable; null if undecodable or still changing. */
function decodeFully(path) {
  for (let round = 0; ; round += 1) {
    let decoded;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (decoded === path) return path;
    if (round === MAX_DECODE_ROUNDS) return null;
    path = decoded;
  }
}

/** Lower-case segments of `path` with ".." kept, and with ".." resolved; null if undecodable. */
function segmentViews(path) {
  const decoded = decodeFully(path.split('?', 1)[0]);
  if (decoded === null) return null;
  const kept = [];
  const resolved = [];
  for (const segment of decoded.replace(/\\/g, '/').toLowerCase().split('/')) {
    if (segment === '' || segment === '.') continue;
    kept.push(segment);
    if (segment === '..') resolved.pop();
    else resolved.push(segment);
  }
  return [kept, resolved];
}

/** True when `path` is `prefix` (a segment list) or under it in either view, or cannot be read. */
function isUnder(path, prefix) {
  const views = segmentViews(path);
  return views === null || views.some((segments) => prefix.every((part, i) => segments[i] === part));
}

/** True when `target` names /api/internal or a path under it, or cannot be read. */
export function isInternalApiPath(target) {
  return isUnder(target, ['api', 'internal']);
}

function isOriginForm(target) {
  return typeof target === 'string' && target.startsWith('/') && !target.includes('#');
}

function refuse(res) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not Found');
}

/** Express middleware: 404 for internal API paths and for unusual request targets. */
export function refuseInternalApi(req, res, next) {
  const target = req.originalUrl ?? req.url;
  if (isOriginForm(target) && !isInternalApiPath(target)) {
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
 * request bound for the API's /internal, and `error` answers it with 404.
 * Supplying `error` replaces the library's default error response, so it
 * answers other proxy failures the way the default does.
 */
export function internalRouteProxyHooks(apiUrl) {
  const prefix = [...new URL(apiUrl).pathname.toLowerCase().split('/').filter(Boolean), 'internal'];
  return {
    proxyReq(proxyReq) {
      if (isUnder(proxyReq.path, prefix)) {
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
