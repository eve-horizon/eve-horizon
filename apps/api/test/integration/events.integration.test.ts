import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CreateEventRequest, EventResponse, EventListResponse } from '@eve/shared';

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

async function ensureProject(
  orgId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const response = await fetch(`${apiUrl}/projects/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      org_id: orgId,
      name,
      repo_url: 'https://github.com/test/repo',
      branch: 'main',
    }),
  });

  const body = (await response.json()) as { id: string; name: string };
  if (!response.ok) {
    throw new Error(`Ensure project failed: ${response.status} ${JSON.stringify(body)}`);
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

async function deleteProject(projectId: string): Promise<void> {
  await fetch(`${apiUrl}/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deleted: true }),
  });
}

describe('Events API Integration Tests', () => {
  let testOrgId: string;
  let testProjectId: string;
  const internalToken = process.env.EVE_INTERNAL_API_KEY || 'test-internal-key';

  beforeEach(async () => {
    const uniqueId = Math.random().toString(36).substring(2, 8);
    const org = await ensureOrg(`EventsOrg${uniqueId}`);
    testOrgId = org.id;

    const project = await ensureProject(testOrgId, `EventsProj${uniqueId}`);
    testProjectId = project.id;
  });

  afterEach(async () => {
    await deleteProject(testProjectId);
    await deleteOrg(testOrgId);
  });

  it('should create an event with all required fields', async () => {
    const eventData: CreateEventRequest = {
      type: 'pipeline.run',
      source: 'github',
      env_name: 'production',
      ref_sha: 'abc123def456',
      ref_branch: 'main',
      actor_type: 'user',
      actor_id: 'user-123',
      payload_json: { commit_message: 'Test commit' },
    };

    const response = await fetch(`${apiUrl}/projects/${testProjectId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventData),
    });

    expect(response.ok).toBe(true);
    expect(response.status).toBe(201);

    const event = (await response.json()) as EventResponse;
    expect(event.id).toBeDefined();
    expect(event.project_id).toBe(testProjectId);
    expect(event.type).toBe('pipeline.run');
    expect(event.source).toBe('github');
    expect(event.env_name).toBe('production');
    expect(event.ref_sha).toBe('abc123def456');
    expect(event.ref_branch).toBe('main');
    expect(event.actor_type).toBe('user');
    expect(event.actor_id).toBe('user-123');
    expect(event.payload_json).toEqual({ commit_message: 'Test commit' });
    expect(event.status).toBe('pending');
    expect(event.created_at).toBeDefined();
  });

  it('should create an event with deduplication', async () => {
    const dedupeKey = `test-dedupe-${Date.now()}`;
    const eventData: CreateEventRequest = {
      type: 'pipeline.run',
      source: 'manual',
      dedupe_key: dedupeKey,
    };

    const firstResponse = await fetch(`${apiUrl}/projects/${testProjectId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventData),
    });

    expect(firstResponse.ok).toBe(true);
    const firstEvent = (await firstResponse.json()) as EventResponse;

    const secondResponse = await fetch(`${apiUrl}/projects/${testProjectId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventData),
    });

    expect(secondResponse.ok).toBe(true);
    const secondEvent = (await secondResponse.json()) as EventResponse;

    expect(secondEvent.id).toBe(firstEvent.id);
    expect(secondEvent.dedupe_key).toBe(dedupeKey);
  });

  it('should list events for a project', async () => {
    await fetch(`${apiUrl}/projects/${testProjectId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'test.event.1',
        source: 'manual',
      }),
    });

    await fetch(`${apiUrl}/projects/${testProjectId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'test.event.2',
        source: 'github',
      }),
    });

    const response = await fetch(`${apiUrl}/projects/${testProjectId}/events`);
    expect(response.ok).toBe(true);

    const listResult = (await response.json()) as EventListResponse;
    expect(listResult.data.length).toBeGreaterThanOrEqual(2);
    expect(listResult.pagination).toBeDefined();
    expect(listResult.pagination.limit).toBeDefined();
    expect(listResult.pagination.offset).toBeDefined();
  });

  it('should filter events by type', async () => {
    const uniqueType = `test.event.type.${Date.now()}`;

    await fetch(`${apiUrl}/projects/${testProjectId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: uniqueType,
        source: 'manual',
      }),
    });

    await fetch(`${apiUrl}/projects/${testProjectId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'other.type',
        source: 'manual',
      }),
    });

    const response = await fetch(`${apiUrl}/projects/${testProjectId}/events?type=${uniqueType}`);
    expect(response.ok).toBe(true);

    const listResult = (await response.json()) as EventListResponse;
    expect(listResult.data.length).toBeGreaterThanOrEqual(1);
    expect(listResult.data.every((event) => event.type === uniqueType)).toBe(true);
  });

  it('should filter events by source', async () => {
    await fetch(`${apiUrl}/projects/${testProjectId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'test.event',
        source: 'cron',
      }),
    });

    await fetch(`${apiUrl}/projects/${testProjectId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'test.event',
        source: 'manual',
      }),
    });

    const response = await fetch(`${apiUrl}/projects/${testProjectId}/events?source=cron`);
    expect(response.ok).toBe(true);

    const listResult = (await response.json()) as EventListResponse;
    expect(listResult.data.length).toBeGreaterThanOrEqual(1);
    expect(listResult.data.every((event) => event.source === 'cron')).toBe(true);
  });

  it('should filter events by status', async () => {
    await fetch(`${apiUrl}/projects/${testProjectId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'test.event',
        source: 'manual',
      }),
    });

    const response = await fetch(`${apiUrl}/projects/${testProjectId}/events?status=pending`);
    expect(response.ok).toBe(true);

    const listResult = (await response.json()) as EventListResponse;
    expect(listResult.data.length).toBeGreaterThanOrEqual(1);
    expect(listResult.data.every((event) => event.status === 'pending')).toBe(true);
  });

  it('should filter internal events by attempt_id', async () => {
    const attemptA = `attempt-${Date.now()}-a`;
    const attemptB = `attempt-${Date.now()}-b`;

    const create = async (attemptId: string) => {
      const response = await fetch(`${apiUrl}/internal/projects/${testProjectId}/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-eve-internal-token': internalToken,
        },
        body: JSON.stringify({
          type: 'runner.completed',
          source: 'runner',
          payload_json: {
            attemptId,
            jobId: `job-${attemptId}`,
          },
        }),
      });

      expect(response.ok).toBe(true);
    };

    await create(attemptA);
    await create(attemptB);

    const response = await fetch(
      `${apiUrl}/internal/projects/${testProjectId}/events?type=runner.completed,runner.failed&attempt_id=${encodeURIComponent(attemptA)}`,
      {
        headers: {
          'x-eve-internal-token': internalToken,
        },
      },
    );

    expect(response.ok).toBe(true);
    const listResult = (await response.json()) as EventListResponse;
    expect(listResult.data.length).toBeGreaterThanOrEqual(1);
    expect(
      listResult.data.every((event) => {
        const payload = event.payload_json as Record<string, unknown> | null;
        return payload?.attemptId === attemptA;
      }),
    ).toBe(true);
  });

  it('should get event by ID', async () => {
    const createResponse = await fetch(`${apiUrl}/projects/${testProjectId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'test.event',
        source: 'manual',
        payload_json: { test: 'data' },
      }),
    });

    const createdEvent = (await createResponse.json()) as EventResponse;

    const getResponse = await fetch(`${apiUrl}/projects/${testProjectId}/events/${createdEvent.id}`);
    expect(getResponse.ok).toBe(true);

    const event = (await getResponse.json()) as EventResponse;
    expect(event.id).toBe(createdEvent.id);
    expect(event.type).toBe('test.event');
    expect(event.source).toBe('manual');
    expect(event.payload_json).toEqual({ test: 'data' });
  });

  it('should return error when creating event for non-existent project', async () => {
    const fakeProjectId = 'non-existent-project-id';
    const response = await fetch(`${apiUrl}/projects/${fakeProjectId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'test.event',
        source: 'manual',
      }),
    });

    expect(response.ok).toBe(false);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('should return error when getting event for wrong project', async () => {
    const otherProject = await ensureProject(testOrgId, `OtherProj${Date.now()}`);

    const createResponse = await fetch(`${apiUrl}/projects/${testProjectId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'test.event',
        source: 'manual',
      }),
    });

    const createdEvent = (await createResponse.json()) as EventResponse;

    const getResponse = await fetch(`${apiUrl}/projects/${otherProject.id}/events/${createdEvent.id}`);
    expect(getResponse.ok).toBe(false);
    expect(getResponse.status).toBe(404);

    await deleteProject(otherProject.id);
  });
});
