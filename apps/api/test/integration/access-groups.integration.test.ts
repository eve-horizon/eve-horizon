import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccessGroupListResponse,
  AccessGroupMemberListResponse,
  AccessGroupResponse,
  ServicePrincipalResponse,
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

describe('Access groups integration', () => {
  let orgId = '';

  beforeEach(async () => {
    const unique = Math.random().toString(36).slice(2, 8);
    const org = await ensureOrg(`AccessGroups${unique}`);
    orgId = org.id;
  });

  afterEach(async () => {
    if (orgId) {
      await deleteOrg(orgId);
    }
  });

  it('supports group CRUD and member lifecycle', async () => {
    const createGroup = await fetch(`${apiUrl}/orgs/${orgId}/access/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Product Management',
      }),
    });
    expect(createGroup.ok).toBe(true);
    const group = (await createGroup.json()) as AccessGroupResponse;
    expect(group.id).toMatch(/^grp_/);
    expect(group.slug).toBe('product-management');

    const duplicate = await fetch(`${apiUrl}/orgs/${orgId}/access/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Product Management',
      }),
    });
    expect(duplicate.status).toBe(409);

    const listResponse = await fetch(`${apiUrl}/orgs/${orgId}/access/groups`);
    expect(listResponse.ok).toBe(true);
    const listed = (await listResponse.json()) as AccessGroupListResponse;
    expect(listed.data.some((item) => item.id === group.id)).toBe(true);

    const getBySlug = await fetch(`${apiUrl}/orgs/${orgId}/access/groups/${group.slug}`);
    expect(getBySlug.ok).toBe(true);
    const bySlug = (await getBySlug.json()) as AccessGroupResponse;
    expect(bySlug.id).toBe(group.id);

    const updateGroup = await fetch(`${apiUrl}/orgs/${orgId}/access/groups/${group.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'PM team',
      }),
    });
    expect(updateGroup.ok).toBe(true);
    const updated = (await updateGroup.json()) as AccessGroupResponse;
    expect(updated.description).toBe('PM team');

    const createSp = await fetch(`${apiUrl}/orgs/${orgId}/service-principals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'pm-bot',
      }),
    });
    expect(createSp.ok).toBe(true);
    const sp = (await createSp.json()) as ServicePrincipalResponse;

    const addMember = await fetch(`${apiUrl}/orgs/${orgId}/access/groups/${group.slug}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        principal_type: 'service_principal',
        principal_id: sp.id,
      }),
    });
    expect(addMember.ok).toBe(true);

    const listMembers = await fetch(`${apiUrl}/orgs/${orgId}/access/groups/${group.id}/members`);
    expect(listMembers.ok).toBe(true);
    const members = (await listMembers.json()) as AccessGroupMemberListResponse;
    expect(members.data.some((item) => item.principal_type === 'service_principal' && item.principal_id === sp.id)).toBe(true);

    const removeMember = await fetch(
      `${apiUrl}/orgs/${orgId}/access/groups/${group.id}/members/service_principal/${sp.id}`,
      { method: 'DELETE' },
    );
    expect(removeMember.status).toBe(204);

    const membersAfter = await fetch(`${apiUrl}/orgs/${orgId}/access/groups/${group.id}/members`);
    const membersAfterBody = (await membersAfter.json()) as AccessGroupMemberListResponse;
    expect(membersAfterBody.data.some((item) => item.principal_id === sp.id)).toBe(false);

    const deleteGroupRes = await fetch(`${apiUrl}/orgs/${orgId}/access/groups/${group.id}`, {
      method: 'DELETE',
    });
    expect(deleteGroupRes.status).toBe(204);

    const fetchDeleted = await fetch(`${apiUrl}/orgs/${orgId}/access/groups/${group.id}`);
    expect(fetchDeleted.status).toBe(404);
  });
});
