// Runs the real dashboard server (server.js) for tests.
//
// server.js serves dist/ next to itself and listens on PORT as soon as it is
// imported, so each start copies it (and server/) into a fresh directory
// beside a stub dist/index.html and imports that copy on a free port. Test
// files mock `express` (with the workspace's real express) and
// `http-proxy-middleware` (with a stub that records what reaches the API).
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, parse as legacyParseUrl } from 'node:url';

const appDir = fileURLToPath(new URL('..', import.meta.url));

export const STUB_INDEX_HTML =
  '<!doctype html><html><head><title>Eve</title></head><body><div id="root"></div></body></html>';

/** A free TCP port on the loopback interface. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * GET `path` exactly as written (no URL normalisation), so encoded,
 * dot-segment and doubled-slash spellings reach the server unchanged.
 */
export function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Send `target` as the raw request-target of a GET (absolute-form, fragments
 * and all) and return the response status.
 */
export function rawGet(port, target) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: dashboard.test\r\nConnection: close\r\n\r\n`);
    });
    let response = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.on('end', () => resolve(Number(response.split(' ', 2)[1])));
    socket.on('error', reject);
  });
}

/**
 * Stand-in for http-proxy-middleware 3 (over http-proxy 1.18), following
 * their documented behaviour: an object `pathRewrite` replaces the first
 * matching pattern in req.url; the upstream path is the target's path joined
 * with url.parse(req.url).path (so a fragment or an absolute-form host is
 * dropped); `on.proxyReq(proxyReq, req, res)` runs before anything is sent
 * (not for requests carrying an Expect header), and a proxyReq it destroys
 * goes to `on.error`, or to a 500 without one. Paths that would be sent are
 * pushed to `forwarded`.
 */
export function proxyMiddlewareStub(forwarded) {
  return {
    createProxyMiddleware(options) {
      const targetPath = new URL(options.target).pathname.replace(/\/+$/, '');
      const rewrites = Object.entries(options.pathRewrite ?? {}).map(([from, to]) => [new RegExp(from), to]);
      return (req, res) => {
        let url = req.url;
        const rewrite = rewrites.find(([from]) => from.test(url));
        if (rewrite) url = url.replace(rewrite[0], rewrite[1]);

        const proxyReq = {
          path: targetPath + (legacyParseUrl(url).path ?? ''),
          destroyed: false,
          destroy(error) {
            this.destroyed = true;
            this.error = error ?? Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
          },
        };
        if (!req.headers.expect) options.on?.proxyReq?.(proxyReq, req, res, options);
        if (proxyReq.destroyed) {
          if (options.on?.error) {
            options.on.error(proxyReq.error, req, res, options.target);
          } else if (!res.headersSent) {
            res.writeHead(500);
            res.end('Error occurred while trying to proxy');
          }
          return;
        }
        forwarded.push(proxyReq.path);
        res.end(`proxied ${proxyReq.path}`);
      };
    },
  };
}

async function waitForListening(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await get(port, '/__ready');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`dashboard server did not start on port ${port}`);
}

/** Start a copy of server.js with `env` and return a client for it. */
export async function startDashboardServer(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eve-dashboard-server-'));
  cpSync(join(appDir, 'server.js'), join(dir, 'server.js'));
  if (existsSync(join(appDir, 'server'))) {
    cpSync(join(appDir, 'server'), join(dir, 'server'), { recursive: true });
  }
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.html'), STUB_INDEX_HTML);

  const port = await freePort();
  Object.assign(process.env, env, { PORT: String(port) });
  await import(/* @vite-ignore */ join(dir, 'server.js'));
  await waitForListening(port);
  return { port, get: (path) => get(port, path), rawGet: (target) => rawGet(port, target) };
}
