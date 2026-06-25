import { describe, expect, it } from 'vitest';

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';
const bootstrapKey = process.env.EVE_AUTH_TEST_PUBLIC_KEY;

describe('auth', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await fetch(`${apiUrl}/orgs`, {
      headers: { Authorization: '' },
    });

    expect(response.status).toBe(401);
  });

  it('registers a GitHub SSH key for the current user', async () => {
    if (!bootstrapKey) {
      throw new Error('EVE_AUTH_TEST_PUBLIC_KEY is required for auth tests');
    }

    const response = await fetch(`${apiUrl}/auth/identities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: bootstrapKey, label: 'integration-test' }),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as { provider?: string; fingerprint?: string };
    expect(data.provider).toBe('github_ssh');
    expect(typeof data.fingerprint).toBe('string');
  });
});
