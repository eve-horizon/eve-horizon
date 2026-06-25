import { describe, expect, it } from 'vitest';

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';
const bootstrapToken = process.env.EVE_BOOTSTRAP_TOKEN || 'test-bootstrap-token';
const bootstrapEmail = process.env.EVE_AUTH_TEST_EMAIL || 'admin@example.com';
const bootstrapKey = process.env.EVE_AUTH_TEST_PUBLIC_KEY;

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

async function ensureOrg(name: string): Promise<{ id: string; name: string }> {
  const response = await fetch(`${apiUrl}/orgs/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = (await response.json()) as { id: string; name: string };
  if (!response.ok) {
    throw new Error(`Ensure org failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function getFreshToken(): Promise<string> {
  if (!bootstrapKey) {
    throw new Error('EVE_AUTH_TEST_PUBLIC_KEY is required');
  }
  const response = await fetch(`${apiUrl}/auth/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: bootstrapToken,
      email: bootstrapEmail,
      public_key: bootstrapKey,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bootstrap failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error('Bootstrap response missing access_token');
  }
  return data.access_token;
}

describe('auth token claims', () => {
  it('includes orgs claim with owner role after org creation', async () => {
    // 1. Create an org — auto-assigns bootstrap user as owner
    const orgName = `token-claim-test-${Date.now()}`;
    const org = await ensureOrg(orgName);

    // 2. Get a fresh token (minted after org membership exists)
    const freshToken = await getFreshToken();

    // 3. Decode and verify
    const claims = decodeJwtPayload(freshToken);
    expect(claims.type).toBe('user');
    expect(claims.sub).toBeDefined();
    expect(Array.isArray(claims.orgs)).toBe(true);

    const orgs = claims.orgs as Array<{ id: string; role: string }>;
    const match = orgs.find(o => o.id === org.id);
    expect(match).toBeDefined();
    expect(match!.role).toBe('owner');
  });

  it('token orgs claim reflects multiple memberships', async () => {
    // Create two orgs
    const org1 = await ensureOrg(`multi-org-a-${Date.now()}`);
    const org2 = await ensureOrg(`multi-org-b-${Date.now()}`);

    const freshToken = await getFreshToken();
    const claims = decodeJwtPayload(freshToken);
    const orgs = claims.orgs as Array<{ id: string; role: string }>;

    expect(orgs.find(o => o.id === org1.id)).toBeDefined();
    expect(orgs.find(o => o.id === org2.id)).toBeDefined();
  });
});
