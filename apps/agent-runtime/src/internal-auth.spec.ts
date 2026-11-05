import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { INTERNAL_TOKEN_HEADER, registerInternalAuthHook } from '@eve/shared';

/**
 * Exercises the shared internal-auth hook on a real Fastify server, wired the
 * same way main.ts wires it for the agent runtime and the worker.
 */
describe('internal auth on the service HTTP server', () => {
  let app: FastifyInstance | undefined;
  let invoked = 0;

  async function startServer(key: string): Promise<FastifyInstance> {
    invoked = 0;
    app = Fastify();
    registerInternalAuthHook(app, { key });
    app.get('/health', async () => ({ status: 'ok' }));
    app.post('/invoke', async () => {
      invoked += 1;
      return { accepted: true };
    });
    await app.ready();
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('refuses /invoke without a token and never reaches the handler', async () => {
    const server = await startServer('internal-key');
    const response = await server.inject({ method: 'POST', url: '/invoke', payload: {} });
    expect(response.statusCode).toBe(401);
    expect(invoked).toBe(0);
  });

  it('refuses /invoke with the wrong token', async () => {
    const server = await startServer('internal-key');
    const response = await server.inject({
      method: 'POST',
      url: '/invoke',
      headers: { [INTERNAL_TOKEN_HEADER]: 'not-the-key' },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(invoked).toBe(0);
  });

  it('serves /invoke with the right token', async () => {
    const server = await startServer('internal-key');
    const response = await server.inject({
      method: 'POST',
      url: '/invoke',
      headers: { [INTERNAL_TOKEN_HEADER]: 'internal-key' },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true });
    expect(invoked).toBe(1);
  });

  it('keeps /health open for probes', async () => {
    const server = await startServer('internal-key');
    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });

  it('answers unknown routes with 401 rather than revealing them', async () => {
    const server = await startServer('internal-key');
    const response = await server.inject({ method: 'POST', url: '/scripts/execute', payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it('refuses everything but /health when no key is configured', async () => {
    const server = await startServer('');
    const refused = await server.inject({
      method: 'POST',
      url: '/invoke',
      headers: { [INTERNAL_TOKEN_HEADER]: '' },
      payload: {},
    });
    expect(refused.statusCode).toBe(401);
    expect(refused.json().message).toBe('Internal API key not configured');
    const health = await server.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
  });
});
