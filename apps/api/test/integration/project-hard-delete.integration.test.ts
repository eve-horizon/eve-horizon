import { describe, expect, it } from 'vitest';

const apiUrl =
  process.env.EVE_API_URL ||
  `http://localhost:${process.env.EVE_API_PORT || '4701'}`;

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

function uniqueSuffix(): string {
  return Math.random().toString(36).substring(2, 7);
}

async function ensureProject(orgId: string, name: string, slug: string): Promise<{ id: string }> {
  return requestJson('/projects/ensure', {
    method: 'POST',
    body: JSON.stringify({ org_id: orgId, name, slug, repo_url: 'https://github.com/test/repo', branch: 'main' }),
  });
}

function syncAgents(projectId: string, agentSlug: string): Promise<unknown> {
  return requestJson(`/projects/${projectId}/agents/sync`, {
    method: 'POST',
    body: JSON.stringify({
      agents_yaml: `version: 1\nagents:\n  helper:\n    slug: ${agentSlug}\n    skill: eve-mission-control\n    workflow: assistant\n`,
      teams_yaml: 'version: 1\nteams: {}\n',
      chat_yaml: 'version: 1\nroutes: []\n',
      git_sha: '1111111111111111111111111111111111111111',
      branch: 'main',
    }),
  });
}

describe('project delete', () => {
  it('frees agent slugs on soft delete and hard-deletes a project that has events', async () => {
    const suffix = uniqueSuffix();
    const org = await requestJson<{ id: string }>('/orgs/ensure', {
      method: 'POST',
      body: JSON.stringify({ name: `HardDeleteOrg${suffix}` }),
    });

    const first = await ensureProject(org.id, `hard-delete-a-${suffix}`, `Hda${suffix}`);
    const second = await ensureProject(org.id, `hard-delete-b-${suffix}`, `Hdb${suffix}`);
    const agentSlug = `hd${suffix}`;

    await syncAgents(first.id, agentSlug);
    await requestJson(`/projects/${first.id}/events`, {
      method: 'POST',
      body: JSON.stringify({ type: 'manual.test', source: 'manual' }),
    });

    // Soft delete: the project's agent slug is no longer reserved in the org.
    expect((await request(`/projects/${first.id}`, { method: 'DELETE' })).status).toBe(204);
    await syncAgents(second.id, agentSlug);

    // Hard delete: removes the project even though it has events.
    const hard = await request(`/projects/${first.id}?hard=true`, { method: 'DELETE' });
    expect(hard.status, await hard.clone().text()).toBe(204);
    expect((await request(`/projects/${first.id}?include_deleted=true`)).status).toBe(404);

    expect((await request(`/projects/${second.id}?hard=true`, { method: 'DELETE' })).status).toBe(204);
  }, 60_000);
});
