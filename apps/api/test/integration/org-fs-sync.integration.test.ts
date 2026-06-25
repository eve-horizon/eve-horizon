import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  OrgFsCreateLinkResponse,
  OrgFsEnrollDeviceResponse,
  OrgFsEventListResponse,
  OrgFsListConflictsResponse,
  OrgFsStatusResponse,
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
  const body = (await response.json()) as { authenticated?: boolean; user_id?: string };
  if (!body.authenticated || !body.user_id) {
    throw new Error('auth/me did not return an authenticated user');
  }
  return { user_id: body.user_id };
}

async function grantOrgFsScope(orgId: string, userId: string): Promise<void> {
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const roleName = `orgfs_rw_${unique}`;

  const roleResponse = await fetch(`${apiUrl}/orgs/${orgId}/access/roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: roleName,
      scope: 'org',
      permissions: ['orgfs:read', 'orgfs:write'],
    }),
  });
  if (!roleResponse.ok) {
    throw new Error(`Create orgfs role failed: ${roleResponse.status} ${await roleResponse.text()}`);
  }

  const bindResponse = await fetch(`${apiUrl}/orgs/${orgId}/access/bindings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      role_name: roleName,
      principal_type: 'user',
      principal_id: userId,
      scope_json: {
        orgfs: {
          allow_prefixes: ['/**'],
        },
      },
    }),
  });
  if (!bindResponse.ok) {
    throw new Error(`Bind orgfs role failed: ${bindResponse.status} ${await bindResponse.text()}`);
  }
}

describe('Org FS Sync API integration', () => {
  let orgId = '';

  beforeEach(async () => {
    const unique = Math.random().toString(36).slice(2, 8);
    const org = await ensureOrg(`FsSyncOrg${unique}`);
    orgId = org.id;
    const auth = await queryAuthMe();
    await grantOrgFsScope(orgId, auth.user_id);
  });

  afterEach(async () => {
    if (orgId) {
      await deleteOrg(orgId);
    }
  });

  it('enrolls a device, creates a link, and reports status', async () => {
    const enrollResponse = await fetch(`${apiUrl}/orgs/${orgId}/fs/devices/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_name: 'integration-mac',
        platform: 'macos',
        client_version: '0.2.0',
        public_key: `pk-${Date.now()}`,
      }),
    });
    expect(enrollResponse.ok).toBe(true);
    const enrollment = (await enrollResponse.json()) as OrgFsEnrollDeviceResponse;
    expect(enrollment.device.id).toMatch(/^fsdev_/);
    expect(enrollment.enrollment.token).toMatch(/^efs_enroll_/);

    const linkResponse = await fetch(`${apiUrl}/orgs/${orgId}/fs/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: enrollment.device.id,
        mode: 'two_way',
        local_path: '/Users/test/Eve/acme',
        remote_path: '/',
      }),
    });
    expect(linkResponse.ok).toBe(true);
    const link = (await linkResponse.json()) as OrgFsCreateLinkResponse;
    expect(link.link.id).toMatch(/^fslk_/);
    expect(link.link.mode).toBe('two_way');

    const statusResponse = await fetch(`${apiUrl}/orgs/${orgId}/fs/status`);
    expect(statusResponse.ok).toBe(true);
    const status = (await statusResponse.json()) as OrgFsStatusResponse;
    expect(status.org_id).toBe(orgId);
    expect(status.links.active).toBeGreaterThanOrEqual(1);
  });

  it('supports mode transitions, events paging, and conflict lifecycle', async () => {
    const enroll = await fetch(`${apiUrl}/orgs/${orgId}/fs/devices/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_name: 'integration-mac-2',
        platform: 'macos',
        client_version: '0.2.0',
        public_key: `pk-${Date.now()}-2`,
      }),
    });
    const enrollment = (await enroll.json()) as OrgFsEnrollDeviceResponse;

    const createLink = await fetch(`${apiUrl}/orgs/${orgId}/fs/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: enrollment.device.id,
        mode: 'two_way',
        local_path: '/Users/test/Eve/acme-2',
        remote_path: '/',
      }),
    });
    const link = (await createLink.json()) as OrgFsCreateLinkResponse;
    const gatewayToken = link.runtime.gateway.token;

    const legacyTokenAttempt = await fetch(`${apiUrl}/internal/orgs/${orgId}/fs/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-eve-internal-token': 'test-internal-key',
      },
      body: JSON.stringify({
        event_id: `fsev_test_${Date.now()}_legacy`,
        link_id: link.link.id,
        device_id: enrollment.device.id,
        event_type: 'file.updated',
        path: '/pm/legacy.md',
        source_side: 'local',
      }),
    });
    expect(legacyTokenAttempt.status).toBe(401);

    const pause = await fetch(`${apiUrl}/orgs/${orgId}/fs/links/${link.link.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'pull_only', status: 'paused' }),
    });
    expect(pause.ok).toBe(true);

    const ingestUpdated = await fetch(`${apiUrl}/internal/orgs/${orgId}/fs/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-eve-internal-token': gatewayToken,
      },
      body: JSON.stringify({
        event_id: `fsev_test_${Date.now()}`,
        link_id: link.link.id,
        device_id: enrollment.device.id,
        event_type: 'file.updated',
        path: '/pm/roadmap.md',
        content_hash: 'sha256:test',
        size_bytes: 42,
        source_side: 'local',
      }),
    });
    expect(ingestUpdated.ok).toBe(true);

    const rotateToken = await fetch(`${apiUrl}/orgs/${orgId}/fs/links/${link.link.id}/token`, {
      method: 'POST',
    });
    expect(rotateToken.ok).toBe(true);
    const rotated = (await rotateToken.json()) as { gateway: { token: string } };
    const rotatedToken = rotated.gateway.token;

    const ingestConflict = await fetch(`${apiUrl}/internal/orgs/${orgId}/fs/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-eve-internal-token': rotatedToken,
      },
      body: JSON.stringify({
        event_id: `fsev_test_${Date.now()}_conflict`,
        link_id: link.link.id,
        device_id: enrollment.device.id,
        event_type: 'conflict.detected',
        path: '/pm/roadmap.md',
        source_side: 'system',
        metadata: { local_hash: 'sha256:a', remote_hash: 'sha256:b' },
      }),
    });
    expect(ingestConflict.ok).toBe(true);

    const eventsResponse = await fetch(`${apiUrl}/orgs/${orgId}/fs/events?after_seq=0&limit=20`);
    expect(eventsResponse.ok).toBe(true);
    const events = (await eventsResponse.json()) as OrgFsEventListResponse;
    expect(events.data.length).toBeGreaterThanOrEqual(2);
    const firstSeq = events.data[0]?.seq ?? 0;

    const resumeResponse = await fetch(`${apiUrl}/orgs/${orgId}/fs/events?after_seq=${firstSeq}&limit=20`);
    expect(resumeResponse.ok).toBe(true);
    const resumed = (await resumeResponse.json()) as OrgFsEventListResponse;
    expect(resumed.data.every((event) => event.seq > firstSeq)).toBe(true);

    const conflictsResponse = await fetch(`${apiUrl}/orgs/${orgId}/fs/conflicts?open_only=true`);
    expect(conflictsResponse.ok).toBe(true);
    const conflicts = (await conflictsResponse.json()) as OrgFsListConflictsResponse;
    expect(conflicts.data.length).toBeGreaterThanOrEqual(1);

    const resolve = await fetch(`${apiUrl}/orgs/${orgId}/fs/conflicts/${conflicts.data[0].id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: 'pick_remote' }),
    });
    expect(resolve.ok).toBe(true);

    const conflictsAfter = await fetch(`${apiUrl}/orgs/${orgId}/fs/conflicts?open_only=true`);
    const openAfter = (await conflictsAfter.json()) as OrgFsListConflictsResponse;
    expect(openAfter.data.some((item) => item.id === conflicts.data[0].id)).toBe(false);
  });

  it('enforces link-scoped ACLs for internal fs ingestion', async () => {
    const enroll = await fetch(`${apiUrl}/orgs/${orgId}/fs/devices/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_name: 'integration-acl',
        platform: 'macos',
        client_version: '0.2.0',
        public_key: `pk-${Date.now()}-acl`,
      }),
    });
    const enrollment = (await enroll.json()) as OrgFsEnrollDeviceResponse;

    const outOfRoot = await fetch(`${apiUrl}/orgs/${orgId}/fs/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: enrollment.device.id,
        mode: 'two_way',
        local_path: '/Users/test/Eve/acl',
        remote_path: '/groups/pm',
        allow_prefixes: ['/groups/eng/**'],
      }),
    });
    expect(outOfRoot.status).toBe(400);

    const createScopedLink = await fetch(`${apiUrl}/orgs/${orgId}/fs/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: enrollment.device.id,
        mode: 'two_way',
        local_path: '/Users/test/Eve/acl',
        remote_path: '/groups/pm',
        allow_prefixes: ['/groups/pm/**'],
      }),
    });
    expect(createScopedLink.ok).toBe(true);
    const scopedLink = (await createScopedLink.json()) as OrgFsCreateLinkResponse;
    const token = scopedLink.runtime.gateway.token;

    const outOfScopeEvent = await fetch(`${apiUrl}/internal/orgs/${orgId}/fs/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-eve-internal-token': token,
      },
      body: JSON.stringify({
        event_id: `fsev_test_${Date.now()}_acl_oos`,
        link_id: scopedLink.link.id,
        device_id: enrollment.device.id,
        event_type: 'file.updated',
        path: '/groups/eng/roadmap.md',
        source_side: 'local',
      }),
    });
    expect(outOfScopeEvent.status).toBe(403);

    const inScopeEvent = await fetch(`${apiUrl}/internal/orgs/${orgId}/fs/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-eve-internal-token': token,
      },
      body: JSON.stringify({
        event_id: `fsev_test_${Date.now()}_acl_ok`,
        link_id: scopedLink.link.id,
        device_id: enrollment.device.id,
        event_type: 'file.updated',
        path: '/groups/pm/roadmap.md',
        source_side: 'local',
      }),
    });
    expect(inScopeEvent.ok).toBe(true);
  });

  it('rejects internal gateway tokens for revoked links', async () => {
    const enroll = await fetch(`${apiUrl}/orgs/${orgId}/fs/devices/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_name: 'integration-revoked',
        platform: 'macos',
        client_version: '0.2.0',
        public_key: `pk-${Date.now()}-revoked`,
      }),
    });
    const enrollment = (await enroll.json()) as OrgFsEnrollDeviceResponse;

    const createLink = await fetch(`${apiUrl}/orgs/${orgId}/fs/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: enrollment.device.id,
        mode: 'two_way',
        local_path: '/Users/test/Eve/revoked',
        remote_path: '/groups/pm',
        allow_prefixes: ['/groups/pm/**'],
      }),
    });
    expect(createLink.ok).toBe(true);
    const link = (await createLink.json()) as OrgFsCreateLinkResponse;
    const token = link.runtime.gateway.token;

    const revoke = await fetch(`${apiUrl}/orgs/${orgId}/fs/links/${link.link.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'revoked' }),
    });
    expect(revoke.ok).toBe(true);

    const ingest = await fetch(`${apiUrl}/internal/orgs/${orgId}/fs/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-eve-internal-token': token,
      },
      body: JSON.stringify({
        event_id: `fsev_test_${Date.now()}_revoked`,
        link_id: link.link.id,
        device_id: enrollment.device.id,
        event_type: 'file.updated',
        path: '/groups/pm/revoked.md',
        source_side: 'local',
      }),
    });
    expect(ingest.status).toBe(409);
  });
});
