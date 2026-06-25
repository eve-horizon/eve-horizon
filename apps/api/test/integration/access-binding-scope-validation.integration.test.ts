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

async function authMe(): Promise<{ user_id: string }> {
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

describe('Access binding scope validation integration', () => {
  let orgId = '';
  let userId = '';

  beforeEach(async () => {
    const unique = Math.random().toString(36).slice(2, 8);
    const org = await ensureOrg(`AccessScopeValidation${unique}`);
    orgId = org.id;
    userId = (await authMe()).user_id;
  });

  afterEach(async () => {
    if (orgId) {
      await deleteOrg(orgId);
    }
  });

  it('fails fast when data-plane role bindings are missing required scope', async () => {
    const unique = Math.random().toString(36).slice(2, 8);

    const createReadRole = await fetch(`${apiUrl}/orgs/${orgId}/access/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `orgdocs_reader_${unique}`,
        scope: 'org',
        permissions: ['orgdocs:read'],
      }),
    });
    expect(createReadRole.ok).toBe(true);

    const bindReadWithoutScope = await fetch(`${apiUrl}/orgs/${orgId}/access/bindings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role_name: `orgdocs_reader_${unique}`,
        principal_type: 'user',
        principal_id: userId,
      }),
    });
    expect(bindReadWithoutScope.status).toBe(400);

    const bindReadWithScope = await fetch(`${apiUrl}/orgs/${orgId}/access/bindings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role_name: `orgdocs_reader_${unique}`,
        principal_type: 'user',
        principal_id: userId,
        scope_json: {
          orgdocs: {
            read_only_prefixes: ['/groups/pm/**'],
          },
        },
      }),
    });
    expect(bindReadWithScope.status).toBe(201);

    const createWriteRole = await fetch(`${apiUrl}/orgs/${orgId}/access/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `orgdocs_writer_${unique}`,
        scope: 'org',
        permissions: ['orgdocs:write'],
      }),
    });
    expect(createWriteRole.ok).toBe(true);

    const bindWriteReadOnly = await fetch(`${apiUrl}/orgs/${orgId}/access/bindings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role_name: `orgdocs_writer_${unique}`,
        principal_type: 'user',
        principal_id: userId,
        scope_json: {
          orgdocs: {
            read_only_prefixes: ['/groups/pm/**'],
          },
        },
      }),
    });
    expect(bindWriteReadOnly.status).toBe(400);

    const createEnvDbRole = await fetch(`${apiUrl}/orgs/${orgId}/access/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `envdb_reader_${unique}`,
        scope: 'org',
        permissions: ['envdb:read'],
      }),
    });
    expect(createEnvDbRole.ok).toBe(true);

    const bindEnvDbWithoutScope = await fetch(`${apiUrl}/orgs/${orgId}/access/bindings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role_name: `envdb_reader_${unique}`,
        principal_type: 'user',
        principal_id: userId,
      }),
    });
    expect(bindEnvDbWithoutScope.status).toBe(400);

    const bindEnvDbWithScope = await fetch(`${apiUrl}/orgs/${orgId}/access/bindings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role_name: `envdb_reader_${unique}`,
        principal_type: 'user',
        principal_id: userId,
        scope_json: {
          envdb: {
            schemas: ['pm'],
          },
        },
      }),
    });
    expect(bindEnvDbWithScope.status).toBe(201);
  });
});
