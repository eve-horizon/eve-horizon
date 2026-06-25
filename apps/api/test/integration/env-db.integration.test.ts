import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ProjectResponse } from '@eve/shared';

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';
const databaseUrl = process.env.DATABASE_URL;
const hasDatabaseUrl = Boolean(databaseUrl);

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

async function ensureProject(
  orgId: string,
  name: string,
  repoUrl: string,
  branch: string
): Promise<ProjectResponse> {
  const response = await fetch(`${apiUrl}/projects/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_id: orgId, name, repo_url: repoUrl, branch }),
  });

  const body = (await response.json()) as ProjectResponse;
  if (!response.ok) {
    throw new Error(`Ensure project failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

async function createEnvironment(
  projectId: string,
  name: string,
  overrides: Record<string, unknown>
) {
  const response = await fetch(`${apiUrl}/projects/${projectId}/envs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      type: 'persistent',
      overrides,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Create env failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function deleteOrg(orgId: string): Promise<void> {
  await fetch(`${apiUrl}/orgs/${orgId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deleted: true }),
  });
}

async function deleteProject(projectId: string): Promise<void> {
  await fetch(`${apiUrl}/projects/${projectId}`, {
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

async function grantEnvDbScope(orgId: string, userId: string, schemaName: string): Promise<void> {
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const roleName = `envdb_rw_${unique}`;

  const roleResponse = await fetch(`${apiUrl}/orgs/${orgId}/access/roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: roleName,
      scope: 'org',
      permissions: ['envdb:read', 'envdb:write'],
    }),
  });
  if (!roleResponse.ok) {
    throw new Error(`Create envdb role failed: ${roleResponse.status} ${await roleResponse.text()}`);
  }

  const bindResponse = await fetch(`${apiUrl}/orgs/${orgId}/access/bindings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      role_name: roleName,
      principal_type: 'user',
      principal_id: userId,
      scope_json: {
        envdb: {
          schemas: [schemaName],
        },
      },
    }),
  });
  if (!bindResponse.ok) {
    throw new Error(`Bind envdb role failed: ${bindResponse.status} ${await bindResponse.text()}`);
  }
}

describe.skipIf(!hasDatabaseUrl)('Env DB Integration Tests', () => {
  let testOrgId: string;
  let testProjectId: string;
  let schemaName: string;

  beforeEach(async () => {
    const uniqueId = Math.random().toString(36).substring(2, 8);
    schemaName = `envdb_${uniqueId}`;

    const org = await ensureOrg(`EnvDbOrg${uniqueId}`);
    testOrgId = org.id;

    const project = await ensureProject(
      testOrgId,
      `EnvDbProj${uniqueId}`,
      'https://github.com/test/repo',
      'main'
    );
    testProjectId = project.id;

    await createEnvironment(testProjectId, 'test', {
      db: {
        url: databaseUrl,
        schema: schemaName,
      },
    });

    const auth = await queryAuthMe();
    await grantEnvDbScope(testOrgId, auth.user_id, schemaName);
  });

  afterEach(async () => {
    if (databaseUrl) {
      await fetch(`${apiUrl}/projects/${testProjectId}/envs/test/db/sql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sql: `DROP SCHEMA IF EXISTS ${schemaName} CASCADE`,
          allow_write: true,
        }),
      });
    }
    await deleteProject(testProjectId);
    await deleteOrg(testOrgId);
  });

  it('should apply migrations and query schema', async () => {
    const migrateResponse = await fetch(`${apiUrl}/projects/${testProjectId}/envs/test/db/migrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        migrations: [
          {
            name: '001_create_notes.sql',
            sql: 'CREATE TABLE notes (id SERIAL PRIMARY KEY, title TEXT NOT NULL);',
          },
        ],
      }),
    });

    expect(migrateResponse.ok).toBe(true);
    const migrateBody = await migrateResponse.json();
    expect(migrateBody.applied.length).toBe(1);

    const listResponse = await fetch(`${apiUrl}/projects/${testProjectId}/envs/test/db/migrations`);
    expect(listResponse.ok).toBe(true);
    const listBody = await listResponse.json();
    expect(listBody.migrations.length).toBe(1);

    const schemaResponse = await fetch(`${apiUrl}/projects/${testProjectId}/envs/test/db/schema`);
    expect(schemaResponse.ok).toBe(true);
    const schemaBody = await schemaResponse.json();
    const notesTable = schemaBody.tables.find((table: { name: string }) => table.name === 'notes');
    expect(notesTable).toBeTruthy();

    const sqlResponse = await fetch(`${apiUrl}/projects/${testProjectId}/envs/test/db/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sql: 'SELECT 1 as value',
      }),
    });
    expect(sqlResponse.ok).toBe(true);
    const sqlBody = await sqlResponse.json();
    expect(sqlBody.rows[0].value).toBe(1);
  });
});
