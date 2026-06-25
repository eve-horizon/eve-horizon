import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccessCanResponse,
  AccessExplainResponse,
  AccessGroupResponse,
  AccessPrincipalMembershipsResponse,
} from '@eve/shared';

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';

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
  return (await response.json()) as { user_id: string };
}

function queryWith(basePath: string, params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `${basePath}?${search.toString()}`;
}

describe('Access introspection integration', () => {
  let orgId = '';
  let userId = '';

  beforeEach(async () => {
    const unique = Math.random().toString(36).slice(2, 8);
    const org = await ensureOrg(`AccessIntrospection${unique}`);
    orgId = org.id;
    userId = (await queryAuthMe()).user_id;
  });

  afterEach(async () => {
    if (orgId) {
      await deleteOrg(orgId);
    }
  });

  it('reports memberships and evaluates resource scoped grants', async () => {
    const unique = Math.random().toString(36).slice(2, 8);
    const roleName = `orgfs_reader_${unique}`;

    const createGroup = await fetch(`${apiUrl}/orgs/${orgId}/access/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `PM Team ${unique}`,
        slug: `pm-${unique}`,
      }),
    });
    expect(createGroup.ok).toBe(true);
    const group = (await createGroup.json()) as AccessGroupResponse;

    const addMember = await fetch(`${apiUrl}/orgs/${orgId}/access/groups/${group.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        principal_type: 'user',
        principal_id: userId,
      }),
    });
    expect(addMember.ok).toBe(true);

    const createRole = await fetch(`${apiUrl}/orgs/${orgId}/access/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: roleName,
        scope: 'org',
        permissions: ['orgfs:read'],
      }),
    });
    expect(createRole.ok).toBe(true);

    const bindRole = await fetch(`${apiUrl}/orgs/${orgId}/access/bindings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role_name: roleName,
        principal_type: 'group',
        principal_id: group.id,
        scope_json: {
          orgfs: {
            allow_prefixes: ['/groups/pm/**'],
          },
        },
      }),
    });
    expect(bindRole.ok).toBe(true);

    const memberships = await fetch(
      `${apiUrl}/orgs/${orgId}/access/principals/user/${userId}/memberships`,
    );
    expect(memberships.ok).toBe(true);
    const membershipsBody = (await memberships.json()) as AccessPrincipalMembershipsResponse;
    expect(membershipsBody.principal_type).toBe('user');
    expect(membershipsBody.groups.some((item) => item.id === group.id)).toBe(true);
    expect(membershipsBody.effective_permissions).toContain('orgfs:read');
    expect(
      membershipsBody.effective_bindings.some(
        (binding) => binding.matched_via === 'group' && binding.matched_group_id === group.id,
      ),
    ).toBe(true);
    expect(membershipsBody.effective_scopes.orgfs.allow_prefixes).toContain('/groups/pm/**');

    const canAllowed = await fetch(
      queryWith(`${apiUrl}/orgs/${orgId}/access/can`, {
        principal_type: 'user',
        principal_id: userId,
        permission: 'orgfs:read',
        resource_type: 'orgfs',
        resource_id: '/groups/pm/roadmap.md',
        action: 'read',
      }),
    );
    expect(canAllowed.ok).toBe(true);
    const canAllowedBody = (await canAllowed.json()) as AccessCanResponse;
    expect(canAllowedBody.allowed).toBe(true);
    expect(canAllowedBody.resource?.scope_required).toBe(true);
    expect(canAllowedBody.resource?.scope_matched).toBe(true);

    const canDenied = await fetch(
      queryWith(`${apiUrl}/orgs/${orgId}/access/can`, {
        principal_type: 'user',
        principal_id: userId,
        permission: 'orgfs:read',
        resource_type: 'orgfs',
        resource_id: '/groups/eng/roadmap.md',
        action: 'read',
      }),
    );
    expect(canDenied.ok).toBe(true);
    const canDeniedBody = (await canDenied.json()) as AccessCanResponse;
    expect(canDeniedBody.allowed).toBe(false);
    expect(canDeniedBody.resource?.scope_required).toBe(true);
    expect(canDeniedBody.resource?.scope_matched).toBe(false);

    const explainDenied = await fetch(
      queryWith(`${apiUrl}/orgs/${orgId}/access/explain`, {
        principal_type: 'user',
        principal_id: userId,
        permission: 'orgfs:read',
        resource_type: 'orgfs',
        resource_id: '/groups/eng/roadmap.md',
        action: 'read',
      }),
    );
    expect(explainDenied.ok).toBe(true);
    const explainBody = (await explainDenied.json()) as AccessExplainResponse;
    expect(explainBody.result).toBe('DENIED');
    expect(
      explainBody.grants.some((grant) => grant.has_permission && grant.scope_match === false),
    ).toBe(true);
  });
});
