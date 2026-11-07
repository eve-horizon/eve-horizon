import type { AddressInfo, Server as NetServer } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listenOnInternalPort,
  registerInternalRouteGuard,
  resolveInternalPort,
} from './internal-port.js';

describe('resolveInternalPort', () => {
  it('is off when unset or empty', () => {
    expect(resolveInternalPort(undefined, 4701)).toBeNull();
    expect(resolveInternalPort('', 4701)).toBeNull();
  });

  it('parses a port', () => {
    expect(resolveInternalPort('4791', 4701)).toBe(4791);
  });

  it('refuses a bad value or the public port', () => {
    expect(() => resolveInternalPort('abc', 4701)).toThrow(/TCP port/);
    expect(() => resolveInternalPort('70000', 4701)).toThrow(/TCP port/);
    expect(() => resolveInternalPort('4701', 4701)).toThrow(/differ/);
  });
});

/**
 * One Fastify server answering on a public and an internal port, wired the
 * way main.ts wires the API: routes first, then the guard, then both
 * listeners.
 */
describe('API split onto public and internal ports', () => {
  let app: FastifyInstance;
  let internalListener: NetServer;
  let publicUrl: string;
  let internalUrl: string;

  beforeAll(async () => {
    app = Fastify();
    app.get('/projects', async () => ({ route: 'public' }));
    app.get('/health', async () => ({ status: 'ok' }));
    app.get('/internal/projects/:project_id/events', async () => ({ route: 'internal' }));
    app.get('/internal/registry/token', async () => ({ route: 'realm' }));

    internalListener = await listenOnInternalPort(app.server, 0, '127.0.0.1');
    const internalPort = (internalListener.address() as AddressInfo).port;
    registerInternalRouteGuard(app, internalPort);

    await app.listen({ port: 0, host: '127.0.0.1' });
    const publicPort = (app.server.address() as AddressInfo).port;
    publicUrl = `http://127.0.0.1:${publicPort}`;
    internalUrl = `http://127.0.0.1:${internalPort}`;
  });

  afterAll(async () => {
    await app.close();
    expect(internalListener.listening).toBe(false);
  });

  async function get(base: string, path: string): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, body: await response.json() };
  }

  it('serves public routes on both ports', async () => {
    expect(await get(publicUrl, '/projects')).toEqual({ status: 200, body: { route: 'public' } });
    expect(await get(internalUrl, '/projects')).toEqual({ status: 200, body: { route: 'public' } });
    expect((await get(publicUrl, '/health')).status).toBe(200);
  });

  it('serves internal routes on the internal port', async () => {
    expect(await get(internalUrl, '/internal/projects/proj_1/events')).toEqual({
      status: 200,
      body: { route: 'internal' },
    });
  });

  it('answers internal routes on the public port with a plain 404', async () => {
    const response = await get(publicUrl, '/internal/projects/proj_1/events?limit=5');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      message: 'Cannot GET /internal/projects/proj_1/events',
      error: 'Not Found',
      statusCode: 404,
    });
  });

  it('refuses encoded spellings that route to an internal handler', async () => {
    // The router decodes %69 to "i", so this reaches the internal route...
    expect((await get(internalUrl, '/%69nternal/projects/proj_1/events')).status).toBe(200);
    // ...and the guard, which checks the resolved route, still refuses it publicly.
    expect((await get(publicUrl, '/%69nternal/projects/proj_1/events')).status).toBe(404);
  });

  it('keeps the registry token realm public', async () => {
    expect(await get(publicUrl, '/internal/registry/token')).toEqual({ status: 200, body: { route: 'realm' } });
  });
});
