import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestJson } from '../src/lib/client';

const context = {
  apiUrl: 'http://api.example.test',
  token: 'token',
  profile: {},
  profileName: 'default',
};

function respondWith(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })),
  );
}

async function errorMessage(): Promise<string> {
  try {
    await requestJson(context as never, '/orgs/ensure', { method: 'POST', body: { name: 'x' } });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected requestJson to throw');
}

describe('CLI API error messages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists each validation issue with its field path', async () => {
    respondWith(400, {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
      errors: [
        { path: 'slug', message: 'String must contain at most 12 character(s)', code: 'too_big' },
        { path: '', message: 'Expected object, received string', code: 'invalid_type' },
      ],
    });

    expect(await errorMessage()).toBe(
      'HTTP 400: while calling POST /orgs/ensure: Validation failed\n' +
      '  - slug: String must contain at most 12 character(s)\n' +
      '  - Expected object, received string',
    );
  });

  it('handles validation bodies from older APIs (no statusCode or code)', async () => {
    respondWith(400, {
      message: 'Validation failed',
      errors: [{ path: 'owner.email', message: 'Invalid email' }],
    });

    expect(await errorMessage()).toBe(
      'HTTP 400: while calling POST /orgs/ensure: Validation failed\n  - owner.email: Invalid email',
    );
  });

  it('accepts array paths and plain string issues', async () => {
    respondWith(400, {
      message: 'Invalid manifest',
      errors: [{ path: ['services', 'web', 'port'], message: 'Expected number' }, 'unknown key x-foo'],
    });

    expect(await errorMessage()).toBe(
      'HTTP 400: while calling POST /orgs/ensure: Invalid manifest\n' +
      '  - services.web.port: Expected number\n' +
      '  - unknown key x-foo',
    );
  });

  it('keeps ordinary error bodies on one line', async () => {
    respondWith(409, { statusCode: 409, error: 'Conflict', message: 'Org slug already taken' });

    expect(await errorMessage()).toBe('HTTP 409: while calling POST /orgs/ensure: Org slug already taken');
  });

  it('joins array messages', async () => {
    respondWith(400, { statusCode: 400, error: 'Bad Request', message: ['name must be a string', 'slug is too long'] });

    expect(await errorMessage()).toBe(
      'HTTP 400: while calling POST /orgs/ensure: name must be a string; slug is too long',
    );
  });

  it('falls back to the raw text for non-JSON bodies', async () => {
    respondWith(502, 'Bad Gateway');

    expect(await errorMessage()).toBe('HTTP 502: while calling POST /orgs/ensure: Bad Gateway');
  });
});
