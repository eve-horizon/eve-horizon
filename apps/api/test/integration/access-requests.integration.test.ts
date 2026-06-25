import { beforeAll, describe, expect, it } from 'vitest';

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';
const bootstrapKey = process.env.EVE_AUTH_TEST_PUBLIC_KEY;

type AuthStatus = {
  user_id?: string;
  email?: string;
};

type AccessRequestResponse = {
  id: string;
  status: string;
  user_id: string | null;
  org_id: string | null;
};

type OrgResponse = {
  id: string;
  name: string;
  slug: string;
};

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Generate a unique slug that survives the 12-char deriveSlug truncation. */
function uniqueSlug(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}${rand}`.slice(0, 12);
}

async function getAuthStatus(): Promise<AuthStatus> {
  const response = await fetch(`${apiUrl}/auth/me`);
  expect(response.status).toBe(200);
  return (await response.json()) as AuthStatus;
}

async function createOrg(name: string, slug: string): Promise<OrgResponse> {
  const response = await fetch(`${apiUrl}/orgs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, slug }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as OrgResponse;
}

async function createAccessRequest(input: {
  provider: 'github_ssh' | 'nostr';
  public_key: string;
  email?: string;
  desired_org_name: string;
  desired_org_slug?: string;
}): Promise<AccessRequestResponse> {
  const response = await fetch(`${apiUrl}/auth/request-access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as AccessRequestResponse;
}

async function approveRequest(id: string): Promise<Response> {
  return fetch(`${apiUrl}/admin/access-requests/${id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

async function listOrgMembers(orgId: string): Promise<Array<{ user_id: string; role: string }>> {
  const response = await fetch(`${apiUrl}/orgs/${orgId}/members`);
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { data: Array<{ user_id: string; role: string }> };
  return payload.data;
}

describe('access requests', () => {
  // Clean up stale pending requests from previous test runs so the idempotent
  // createAccessRequest endpoint returns fresh requests with correct slugs.
  beforeAll(async () => {
    const response = await fetch(`${apiUrl}/admin/access-requests`);
    if (response.status !== 200) return;
    const { data } = (await response.json()) as { data: AccessRequestResponse[] };
    for (const req of data) {
      if (req.status === 'pending') {
        await fetch(`${apiUrl}/admin/access-requests/${req.id}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: 'stale test cleanup' }),
        });
      }
    }
  });

  it('reuses existing identity owner when fingerprint is already registered', async () => {
    if (!bootstrapKey) {
      throw new Error('EVE_AUTH_TEST_PUBLIC_KEY is required for duplicate fingerprint test');
    }

    const auth = await getAuthStatus();
    const request = await createAccessRequest({
      provider: 'github_ssh',
      public_key: bootstrapKey,
      email: uid('reuse-owner') + '@example.com',
      desired_org_name: uid('reuse-owner-org'),
      desired_org_slug: uniqueSlug('ro'),
    });

    const response = await approveRequest(request.id);
    expect(response.status).toBe(200);
    const approved = (await response.json()) as AccessRequestResponse;
    expect(approved.status).toBe('approved');
    expect(approved.user_id).toBe(auth.user_id);
    expect(approved.org_id).toBeTruthy();
  });

  it('is idempotent when approve is retried', async () => {
    const request = await createAccessRequest({
      provider: 'nostr',
      public_key: uid('nostr-pub'),
      desired_org_name: uid('retry-org'),
    });

    const first = await approveRequest(request.id);
    expect(first.status).toBe(200);
    const approvedFirst = (await first.json()) as AccessRequestResponse;
    expect(approvedFirst.status).toBe('approved');

    const second = await approveRequest(request.id);
    expect(second.status).toBe(200);
    const approvedSecond = (await second.json()) as AccessRequestResponse;
    expect(approvedSecond.status).toBe('approved');
    expect(approvedSecond.user_id).toBe(approvedFirst.user_id);
    expect(approvedSecond.org_id).toBe(approvedFirst.org_id);
  });

  it('recovers by reusing an already-created org slug from a partial prior attempt', async () => {
    const desiredOrgSlug = uniqueSlug('lg');
    const desiredOrgName = `legacy-org-${desiredOrgSlug}`;

    const existingOrg = await createOrg(desiredOrgName, desiredOrgSlug);
    const request = await createAccessRequest({
      provider: 'nostr',
      public_key: uid('nostr-legacy'),
      desired_org_name: desiredOrgName,
      desired_org_slug: desiredOrgSlug,
    });

    const response = await approveRequest(request.id);
    expect(response.status).toBe(200);
    const approved = (await response.json()) as AccessRequestResponse;
    expect(approved.status).toBe('approved');
    expect(approved.org_id).toBe(existingOrg.id);
  });

  it('preserves owner role instead of downgrading to admin on reuse', async () => {
    if (!bootstrapKey) {
      throw new Error('EVE_AUTH_TEST_PUBLIC_KEY is required for role preservation test');
    }

    const auth = await getAuthStatus();
    const orgSlug = uniqueSlug('or');
    const orgName = `owner-role-${orgSlug}`;
    const org = await createOrg(orgName, orgSlug);

    const request = await createAccessRequest({
      provider: 'github_ssh',
      public_key: bootstrapKey,
      desired_org_name: orgName,
      desired_org_slug: orgSlug,
    });

    const response = await approveRequest(request.id);
    expect(response.status).toBe(200);
    const approved = (await response.json()) as AccessRequestResponse;
    expect(approved.org_id).toBe(org.id);
    expect(approved.user_id).toBe(auth.user_id);

    const members = await listOrgMembers(org.id);
    const currentUser = members.find((member) => member.user_id === auth.user_id);
    expect(currentUser?.role).toBe('owner');
  });
});
