import { describe, expect, it } from 'vitest';

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';

async function ensureOrg(name: string, id?: string): Promise<{ id: string; name: string; deleted: boolean }> {
  const response = await fetch(`${apiUrl}/orgs/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...(id ? { id } : {}) }),
  });

  const body = (await response.json()) as { id: string; name: string; deleted: boolean };
  if (!response.ok) {
    throw new Error(`Ensure org failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

async function updateOrg(id: string, updates: { deleted?: boolean }): Promise<void> {
  const response = await fetch(`${apiUrl}/orgs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Update org failed: ${response.status} ${body}`);
  }
}

describe('org ensure (name-based)', () => {
  it('is idempotent when only name is provided', async () => {
    const name = `integration-ensure-${Date.now()}`;
    const first = await ensureOrg(name);
    const second = await ensureOrg(name);

    expect(second.id).toBe(first.id);
    expect(second.name).toBe(name);
  });

  it('undeletes an org when ensured by name', async () => {
    const name = `integration-ensure-deleted-${Date.now()}`;
    const created = await ensureOrg(name);

    await updateOrg(created.id, { deleted: true });
    const restored = await ensureOrg(name);

    expect(restored.id).toBe(created.id);
    expect(restored.deleted).toBe(false);
  });
});
