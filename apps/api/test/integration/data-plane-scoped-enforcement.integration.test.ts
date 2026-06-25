import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';

async function ensureOrg(name: string): Promise<{ id: string }> {
  const response = await fetch(`${apiUrl}/orgs/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new Error(`Ensure org failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as { id: string };
}

async function deleteOrg(orgId: string): Promise<void> {
  await fetch(`${apiUrl}/orgs/${orgId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deleted: true }),
  });
}

async function queryAuthMe(): Promise<{ user_id: string }> {
  const response = await fetch(`${apiUrl}/auth/me`);
  if (!response.ok) {
    throw new Error(`auth/me failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { authenticated?: boolean; user_id?: string };
  if (!body.authenticated || !body.user_id) {
    throw new Error('auth/me did not return an authenticated user');
  }
  return { user_id: body.user_id };
}

async function grantOrgDocsScope(orgId: string, userId: string): Promise<void> {
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const roleName = `orgdocs_rw_${unique}`;

  const roleResponse = await fetch(`${apiUrl}/orgs/${orgId}/access/roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: roleName,
      scope: 'org',
      permissions: ['orgdocs:read', 'orgdocs:write'],
    }),
  });
  if (!roleResponse.ok) {
    throw new Error(`Create orgdocs role failed: ${roleResponse.status} ${await roleResponse.text()}`);
  }

  const bindResponse = await fetch(`${apiUrl}/orgs/${orgId}/access/bindings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      role_name: roleName,
      principal_type: 'user',
      principal_id: userId,
      scope_json: {
        orgdocs: {
          allow_prefixes: ['/groups/pm/**'],
        },
      },
    }),
  });
  if (!bindResponse.ok) {
    throw new Error(`Bind orgdocs role failed: ${bindResponse.status} ${await bindResponse.text()}`);
  }
}

describe('Data-plane scoped enforcement integration', () => {
  let orgId = '';
  let userId = '';

  beforeEach(async () => {
    const unique = Math.random().toString(36).slice(2, 8);
    const org = await ensureOrg(`ScopedDataPlaneOrg${unique}`);
    orgId = org.id;
    userId = (await queryAuthMe()).user_id;
  });

  afterEach(async () => {
    if (orgId) {
      await deleteOrg(orgId);
    }
  });

  it('requires scoped orgdocs grants for path reads/writes', async () => {
    const withoutScope = await fetch(`${apiUrl}/orgs/${orgId}/docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/groups/pm/spec.md',
        content: '# spec',
      }),
    });
    expect(withoutScope.status).toBe(403);

    await grantOrgDocsScope(orgId, userId);

    const inScopeCreate = await fetch(`${apiUrl}/orgs/${orgId}/docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/groups/pm/spec.md',
        content: '# spec',
      }),
    });
    expect(inScopeCreate.ok).toBe(true);

    const inScopeRead = await fetch(
      `${apiUrl}/orgs/${orgId}/docs/by-path?path=${encodeURIComponent('/groups/pm/spec.md')}`,
    );
    expect(inScopeRead.ok).toBe(true);

    const outOfScopeCreate = await fetch(`${apiUrl}/orgs/${orgId}/docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/groups/eng/spec.md',
        content: '# eng',
      }),
    });
    expect(outOfScopeCreate.status).toBe(403);

    const outOfScopeList = await fetch(
      `${apiUrl}/orgs/${orgId}/docs?path=${encodeURIComponent('/groups/eng')}`,
    );
    expect(outOfScopeList.status).toBe(403);
  });
});
