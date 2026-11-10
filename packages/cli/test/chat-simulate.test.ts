import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleChat } from '../src/commands/chat';

vi.mock('../src/lib/client', () => ({
  requestJson: vi.fn(),
}));

import { requestJson } from '../src/lib/client';

function contextFor(apiUrl: string) {
  return {
    apiUrl,
    token: 'token',
    profile: null,
    profileName: null,
  } as any;
}

const flags = { 'team-id': 'T_TEAM', text: 'mission-control status' };

function sentHeaders(): Record<string, string> | undefined {
  const [, , options] = vi.mocked(requestJson).mock.calls[0]!;
  return (options as { headers?: Record<string, string> }).headers;
}

describe('eve chat simulate internal token', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(requestJson).mockResolvedValue({ immediate_reply: null, duplicate: false, route: null });
    vi.stubEnv('EVE_INTERNAL_API_KEY', 'local-internal-key');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(requestJson).mockReset();
    vi.unstubAllEnvs();
  });

  it.each([
    'http://localhost:4801',
    'http://127.0.0.1:4801',
    'http://[::1]:4801',
    'http://api.eve.lvh.me',
    'http://lvh.me',
    'http://api.eve.localhost',
  ])('sends the token to a local API (%s)', async (apiUrl) => {
    await handleChat('simulate', [], flags, contextFor(apiUrl));

    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(sentHeaders()).toEqual({ 'x-eve-internal-token': 'local-internal-key' });
  });

  it.each([
    'https://api.eve.example.com',
    'http://staging.example.com:4801',
    'http://api.eve.lvh.me.example.com',
    'http://localhost.example.com',
    'http://127.0.0.1.nip.io',
  ])('refuses to send the token to a non-local API (%s)', async (apiUrl) => {
    await expect(handleChat('simulate', [], flags, contextFor(apiUrl))).rejects.toThrow(
      /EVE_INTERNAL_API_KEY/,
    );
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('sends no token when EVE_INTERNAL_API_KEY is not set', async () => {
    vi.stubEnv('EVE_INTERNAL_API_KEY', '');

    await handleChat('simulate', [], flags, contextFor('https://api.eve.example.com'));

    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(sentHeaders()).toBeUndefined();
  });
});
