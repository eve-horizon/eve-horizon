import { describe, it, expect, vi } from 'vitest';
import { fetchApiSpec } from '../src/commands/api';

vi.mock('../src/lib/client', () => ({
  requestJson: vi.fn(),
}));

import { requestJson } from '../src/lib/client';

const context = {
  apiUrl: 'http://example.test',
  token: 'token',
  profile: null,
  profileName: null,
  projectId: 'proj_test',
};

describe('fetchApiSpec', () => {
  it('returns raw text when schema is a string', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce({ schema: 'type Query { ping: String }' });

    const result = await fetchApiSpec(context as never, 'proj_test', 'app');
    expect(result.data).toBe('type Query { ping: String }');
    expect(result.raw).toBe('type Query { ping: String }');
  });

  it('returns json when schema is object', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce({ schema: { openapi: '3.1.0' } });

    const result = await fetchApiSpec(context as never, 'proj_test', 'app');
    expect(result.data).toEqual({ openapi: '3.1.0' });
    expect(result.raw).toBe(JSON.stringify({ openapi: '3.1.0' }));
  });
});
