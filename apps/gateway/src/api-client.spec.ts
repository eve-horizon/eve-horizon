import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getJson, postJson } from './api-client.js';

const API_URL = 'http://api.internal.test';

describe('gateway API client paths', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('EVE_API_URL', API_URL);
    vi.stubEnv('EVE_INTERNAL_API_KEY', 'internal-key');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    ['a dot segment', '/internal/membership-requests/../../projects/proj_x/workflows/deploy/invoke'],
    ['an encoded dot segment', '/internal/membership-requests/%2e%2e/%2E%2E/projects/proj_x'],
    ['an encoded slash', '/internal/membership-requests/mreq_a%2f..%2fx/approve'],
    ['an encoded backslash', '/internal/membership-requests/mreq_a%5cx/approve'],
    ['a backslash', '/internal/membership-requests/mreq_a\\..\\x/approve'],
    ['a query', '/internal/membership-requests/mreq_a?next=/approve'],
    ['a fragment', '/internal/membership-requests/mreq_a#/approve'],
    ['a relative path', 'internal/integrations/resolve'],
    ['a protocol-relative path', '//other.example/internal/integrations/resolve'],
    ['an absolute URL', 'http://other.example/internal/integrations/resolve'],
    ['whitespace', '/internal/integrations/resolve /x'],
  ])('refuses a path with %s and sends nothing', async (_label, path) => {
    await expect(postJson(path, {})).rejects.toThrow();
    await expect(getJson(path)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '/internal/integrations/resolve',
    '/internal/orgs/org_01h2xcejqtf2nbrexx3vqjhp41/chat/route',
    '/internal/storage/chat-attachments/presign',
  ])('sends a plain path (%s)', async (path) => {
    await expect(postJson(path, { a: 1 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_URL}${path}`);
  });
});
