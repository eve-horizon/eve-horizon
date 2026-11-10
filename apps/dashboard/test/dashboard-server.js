// Runs the real dashboard server (server.js) for tests.
//
// server.js serves dist/ next to itself and listens on PORT as soon as it is
// imported, so each start copies it (and server/) into a fresh directory
// beside a stub dist/index.html and imports that copy on a free port. Test
// files mock `express` (with the workspace's real express) and
// `http-proxy-middleware` (with a stub that records what reaches the API).
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  return { port, get: (path) => get(port, path) };
}
