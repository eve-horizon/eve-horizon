import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectResponse } from '@eve/shared';

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';
const databaseUrl = process.env.DATABASE_URL;
const hasDatabaseUrl = Boolean(databaseUrl);

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

async function ensureProject(
  orgId: string,
  name: string,
  repoUrl: string,
  branch: string,
): Promise<ProjectResponse> {
  const response = await fetch(`${apiUrl}/projects/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_id: orgId, name, repo_url: repoUrl, branch }),
  });
  if (!response.ok) {
    throw new Error(`Ensure project failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as ProjectResponse;
}

async function createEnvironment(
  projectId: string,
  name: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${apiUrl}/projects/${projectId}/envs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type: 'persistent', overrides }),
  });
  if (!response.ok) {
    throw new Error(`Create env failed: ${response.status} ${await response.text()}`);
  }
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
  return (await response.json()) as { user_id: string };
}

async function grantEnvDbScope(orgId: string, userId: string, schemaName: string): Promise<void> {
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const roleName = `envdb_scope_${unique}`;

  const roleResponse = await fetch(`${apiUrl}/orgs/${orgId}/access/roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: roleName,
      scope: 'org',
      permissions: ['envdb:read', 'envdb:write'],
      description: 'Role used by scoped access envdb integration setup',
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

async function execEnvSql(
  projectId: string,
  envName: string,
  sql: string,
  params: unknown[] = [],
  allowWrite = true,
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${apiUrl}/projects/${projectId}/envs/${envName}/db/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sql,
      params,
      allow_write: allowWrite,
    }),
  });
  if (!response.ok) {
    throw new Error(`db/sql failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { rows: Array<Record<string, unknown>> };
  return body.rows;
}

describe.skipIf(!hasDatabaseUrl)('Access scoped foundation integration', () => {
  let orgId = '';
  let projectId = '';
  let schemaName = '';
  let userId = '';

  beforeEach(async () => {
    const unique = Math.random().toString(36).slice(2, 8);
    schemaName = `access_scope_${unique}`;

    const org = await ensureOrg(`ScopedAccessOrg${unique}`);
    orgId = org.id;

    const project = await ensureProject(
      orgId,
      `ScopedAccessProject${unique}`,
      'https://github.com/eve-horizon/eve-horizon-fullstack-example',
      'main',
    );
    projectId = project.id;

    await createEnvironment(projectId, 'test', {
      db: {
        url: databaseUrl,
        schema: schemaName,
      },
    });

    userId = (await queryAuthMe()).user_id;
    await grantEnvDbScope(orgId, userId, schemaName);
  });

  afterEach(async () => {
    if (projectId) {
      await execEnvSql(
        projectId,
        'test',
        `DROP SCHEMA IF EXISTS ${schemaName} CASCADE`,
        [],
        true,
      ).catch(() => {});
    }
    if (projectId) {
      await deleteProject(projectId);
    }
    if (orgId) {
      await deleteOrg(orgId);
    }
  });

  it('inherits custom permissions via group binding and sets env-db group context', async () => {
    const unique = Math.random().toString(36).slice(2, 8);
    const groupId = `grp_test_${unique}`;
    const roleName = `orgfs_reader_${unique}`;

    await execEnvSql(
      projectId,
      'test',
      `
      INSERT INTO public.access_groups (id, org_id, name, slug, description, created_by)
      VALUES ($1, $2, $3, $4, NULL, $5)
      `,
      [groupId, orgId, `PM Team ${unique}`, `pm-team-${unique}`, userId],
      true,
    );

    await execEnvSql(
      projectId,
      'test',
      `
      INSERT INTO public.access_group_members (group_id, principal_type, principal_id, added_by)
      VALUES ($1, 'user', $2, $3)
      `,
      [groupId, userId, userId],
      true,
    );

    const roleResponse = await fetch(`${apiUrl}/orgs/${orgId}/access/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: roleName,
        scope: 'org',
        permissions: ['orgfs:read'],
        description: 'Role used by scoped access integration test',
      }),
    });
    expect(roleResponse.ok).toBe(true);

    const bindResponse = await fetch(`${apiUrl}/orgs/${orgId}/access/bindings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role_name: roleName,
        principal_type: 'group',
        principal_id: groupId,
        scope_json: {
          orgfs: {
            allow_prefixes: ['/groups/pm/**'],
          },
        },
      }),
    });
    expect(bindResponse.ok).toBe(true);

    const canResponse = await fetch(
      `${apiUrl}/orgs/${orgId}/access/can?principal_type=user&principal_id=${userId}&permission=orgfs:read`,
    );
    expect(canResponse.ok).toBe(true);
    const canBody = (await canResponse.json()) as { allowed: boolean; source: string };
    expect(canBody.allowed).toBe(true);
    expect(canBody.source).toContain('via group');

    const explainResponse = await fetch(
      `${apiUrl}/orgs/${orgId}/access/explain?principal_type=user&principal_id=${userId}&permission=orgfs:read`,
    );
    expect(explainResponse.ok).toBe(true);
    const explainBody = (await explainResponse.json()) as {
      result: 'ALLOWED' | 'DENIED';
      grants: Array<{ source: string; has_permission: boolean }>;
    };
    expect(explainBody.result).toBe('ALLOWED');
    expect(explainBody.grants.some((grant) => grant.source.includes('via group') && grant.has_permission)).toBe(true);

    const contextRows = await execEnvSql(
      projectId,
      'test',
      `
      SELECT
        current_setting('app.org_id', true) AS org_id,
        current_setting('app.group_ids', true) AS group_ids
      `,
      [],
      false,
    );
    expect(contextRows.length).toBe(1);
    expect(contextRows[0].org_id).toBe(orgId);
    const groupIds = JSON.parse(String(contextRows[0].group_ids ?? '[]')) as string[];
    expect(groupIds).toContain(groupId);

    const rlsResponse = await fetch(`${apiUrl}/projects/${projectId}/envs/test/db/rls`);
    expect(rlsResponse.ok).toBe(true);
    const rlsBody = (await rlsResponse.json()) as {
      diagnostics?: {
        context?: {
          user_id?: string;
          principal_type?: string;
          org_id?: string;
          project_id?: string;
          env_name?: string;
          group_ids?: string[];
        };
      };
    };
    expect(rlsBody.diagnostics?.context?.org_id).toBe(orgId);
    expect(rlsBody.diagnostics?.context?.project_id).toBe(projectId);
    expect(rlsBody.diagnostics?.context?.env_name).toBe('test');
    expect(rlsBody.diagnostics?.context?.user_id).toBe(userId);
    expect(rlsBody.diagnostics?.context?.principal_type).toBe('user');
    expect(rlsBody.diagnostics?.context?.group_ids ?? []).toContain(groupId);
  });
});
