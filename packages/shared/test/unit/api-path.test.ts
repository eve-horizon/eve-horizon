import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiPath, internalApiFetch, isPlainApiPath } from '../../src/api-client/index.js';

describe('apiPath', () => {
  it('encodes each value as one path segment', () => {
    expect(apiPath`/internal/projects/${'proj_1'}/workflows/${'nightly-report'}/invoke`).toBe(
      '/internal/projects/proj_1/workflows/nightly-report/invoke',
    );
    expect(apiPath`/internal/projects/${'proj_1'}/workflows/${'release 1'}/invoke`).toBe(
      '/internal/projects/proj_1/workflows/release%201/invoke',
    );
    expect(apiPath`/internal/projects/${'proj_1'}/workflows/${'what?#50%'}/invoke`).toBe(
      '/internal/projects/proj_1/workflows/what%3F%2350%25/invoke',
    );
    expect(apiPath`/internal/projects/${'proj_1'}/workflows/${'%2e%2e'}/invoke`).toBe(
      '/internal/projects/proj_1/workflows/%252e%252e/invoke',
    );
    expect(apiPath`/jobs/${'myproj-a3f2dd12.1'}`).toBe('/jobs/myproj-a3f2dd12.1');
  });

  it.each([
    ['an empty value', ''],
    ['a dot', '.'],
    ['two dots', '..'],
    ['a slash', '../../proj_other/workflows/x/invoke?'],
    ['a backslash', '..\\..\\proj_other'],
  ])('refuses %s', (_label, value) => {
    expect(() => apiPath`/internal/projects/proj_1/workflows/${value}/invoke`).toThrow(/refused/);
  });
});

describe('isPlainApiPath', () => {
  it.each([
    '/internal/projects/proj_1/workflows/nightly-report/invoke',
    '/internal/projects/proj_1/workflows/release%201/invoke',
    '/internal/auth/mint-job-token',
  ])('accepts %s', (path) => {
    expect(isPlainApiPath(path)).toBe(true);
  });

  it.each([
    '/internal/projects/proj_1/../proj_2/workflows/x/invoke',
    '/internal/projects/proj_1/%2e%2e/proj_2',
    '/internal/projects/proj_1/a%2Fb',
    '/internal/projects/proj_1/a%5Cb',
    '/internal/projects/proj_1/a\\b',
    '/internal/projects/proj_1?x=1',
    '/internal/projects/proj_1#x',
    '//other.example/internal',
    'internal/projects/proj_1',
    '',
  ])('refuses %s', (path) => {
    expect(isPlainApiPath(path)).toBe(false);
  });
});

describe('internalApiFetch', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses a path that is not plain and sends nothing', async () => {
    await expect(
      internalApiFetch('/internal/projects/proj_1/../proj_2/secrets/resolve', {
        baseUrl: 'http://api.internal.test',
        internalToken: 'internal-key',
      }),
    ).rejects.toThrow(/plain/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a plain path with the internal token', async () => {
    await internalApiFetch('/internal/auth/mint-job-token', {
      method: 'POST',
      body: {},
      baseUrl: 'http://api.internal.test',
      internalToken: 'internal-key',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.internal.test/internal/auth/mint-job-token');
  });
});
