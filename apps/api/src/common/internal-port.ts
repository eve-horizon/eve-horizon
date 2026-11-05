import { createServer, type Server as NetServer } from 'node:net';
import type { Server as HttpServer } from 'node:http';

/**
 * Optional split of the API onto two ports.
 *
 * With `EVE_API_INTERNAL_PORT` set, the API also listens on that port, and
 * `/internal/*` routes answer only there. The public port (the one the
 * ingress routes to) answers 404 for them, exactly as for a route that does
 * not exist, except for the routes in `PUBLIC_INTERNAL_ROUTES`. In-cluster
 * callers reach `/internal/*` by pointing `EVE_API_URL` at the internal port,
 * which also serves every public route, so callers need no code change.
 *
 * Unset (the default), the API behaves as before: one port, every route.
 */

/**
 * Internal routes that must stay reachable on the public port: the registry
 * token realm, which BuildKit and kubelet on every node follow from the
 * registry's challenge.
 */
export const PUBLIC_INTERNAL_ROUTES: readonly string[] = ['/internal/registry/token'];

/** Parse `EVE_API_INTERNAL_PORT`; null when unset. Throws on a bad value. */
export function resolveInternalPort(raw: string | undefined, publicPort: number): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`EVE_API_INTERNAL_PORT must be a TCP port number, got "${raw}"`);
  }
  if (port === publicPort) {
    throw new Error(`EVE_API_INTERNAL_PORT (${port}) must differ from the public API port`);
  }
  return port;
}

function isInternalRoute(route: string): boolean {
  return route === '/internal' || route.startsWith('/internal/');
}

/**
 * Refuse `/internal/*` routes on every port but the internal one.
 *
 * Matches on the route Fastify resolved (`routeOptions.url`, e.g.
 * `/internal/projects/:project_id/events`) rather than the raw URL, so
 * percent-encoded or otherwise unusual spellings that route to an internal
 * handler are refused too. The port is the socket's local port, which a
 * client cannot influence.
 */
export function registerInternalRouteGuard(
  fastify: { addHook(name: 'onRequest', hook: (request: any, reply: any, done: () => void) => void): unknown },
  internalPort: number,
  publicRoutes: readonly string[] = PUBLIC_INTERNAL_ROUTES,
): void {
  const open = new Set(publicRoutes);
  fastify.addHook('onRequest', (request: any, reply: any, done: () => void) => {
    const route: unknown = request.routeOptions?.url;
    if (
      typeof route !== 'string' ||
      !isInternalRoute(route) ||
      open.has(route) ||
      request.raw?.socket?.localPort === internalPort
    ) {
      done();
      return;
    }
    const url: string = typeof request.url === 'string' ? request.url : '';
    const path = url.split('?')[0];
    reply.code(404).send({ message: `Cannot ${request.method} ${path}`, error: 'Not Found', statusCode: 404 });
  });
}

/**
 * Accept connections on `port` and hand them to the app's HTTP server, so a
 * single server (same routes, timeouts and keep-alive settings) answers on
 * both ports. Closes with the HTTP server.
 */
export async function listenOnInternalPort(
  httpServer: HttpServer,
  port: number,
  host: string,
): Promise<NetServer> {
  const listener = createServer((socket) => {
    httpServer.emit('connection', socket);
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, host, () => {
      listener.off('error', reject);
      resolve();
    });
  });
  httpServer.once('close', () => listener.close());
  return listener;
}
