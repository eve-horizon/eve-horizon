import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleChat } from '../src/commands/chat';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('eve chat simulate does not follow redirects', () => {
  let target: Server;
  let redirector: Server;
  let targetRequests: IncomingHttpHeaders[];
  let apiUrl: string;

  beforeEach(async () => {
    targetRequests = [];
    target = createServer((req, res) => {
      targetRequests.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ immediate_reply: null, duplicate: false, route: null }));
    });
    const targetPort = await listen(target);

    redirector = createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/elsewhere` });
      res.end();
    });
    apiUrl = `http://127.0.0.1:${await listen(redirector)}`;

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('EVE_INTERNAL_API_KEY', 'local-internal-key');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await close(redirector);
    await close(target);
  });

  it('treats a redirect as an error and never sends the token to the redirect target', async () => {
    const context = { apiUrl, token: 'token', profile: null, profileName: null } as any;

    await expect(
      handleChat('simulate', [], { 'team-id': 'T_TEAM', text: 'mission-control status' }, context),
    ).rejects.toThrow(/307/);
    expect(targetRequests).toEqual([]);
  });
});
