// The API's /internal/* routes are for platform services inside the cluster.
// The dashboard proxies /api/* to the API with the prefix removed, so it
// answers 404 for /api/internal and everything under it however the path is
// spelled: percent-encoded (once or more), with doubled slashes or
// backslashes, with dot segments, or in any letter case. A path that cannot
// be decoded is refused too.

const MAX_DECODE_ROUNDS = 5;

/** The path of `url`, decoded, with dot segments resolved, in lower case; null if undecodable. */
function canonicalPath(url) {
  let path = url.split('?', 1)[0];
  for (let round = 0; ; round += 1) {
    let decoded;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (decoded === path) break;
    if (round === MAX_DECODE_ROUNDS) return null;
    path = decoded;
  }

  const segments = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`.toLowerCase();
}

/** True when `url` names /api/internal or a path under it, or cannot be read. */
export function isInternalApiPath(url) {
  const path = canonicalPath(url);
  return path === null || path === '/api/internal' || path.startsWith('/api/internal/');
}

/** Express middleware: 404 for internal API paths, before the /api proxy sees them. */
export function refuseInternalApi(req, res, next) {
  if (!isInternalApiPath(req.originalUrl ?? req.url)) {
    next();
    return;
  }
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not Found');
}
