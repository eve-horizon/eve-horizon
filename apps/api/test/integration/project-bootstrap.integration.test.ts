import { describe, expect, it, beforeAll } from 'vitest';
import type { BootstrapProjectResponse, EnvironmentResponse } from '@eve/shared';

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

async function bootstrapProject(
  orgId: string,
  name: string,
  options: {
    slug?: string;
    repo_url?: string;
    environments?: string[];
  } = {},
): Promise<{ status: number; body: BootstrapProjectResponse }> {
  const response = await fetch(`${apiUrl}/projects/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      org_id: orgId,
      name,
      repo_url: options.repo_url ?? 'https://github.com/test/bootstrap-test',
      branch: 'main',
      slug: options.slug,
      environments: options.environments,
    }),
  });
  const body = (await response.json()) as BootstrapProjectResponse;
  return { status: response.status, body };
}

describe('Project Bootstrap API', () => {
  let orgId: string;
  // Use unique suffixes so the test is idempotent across re-runs on a dirty DB
  const uid = Math.random().toString(36).substring(2, 5);

  beforeAll(async () => {
    const org = await ensureOrg('bootstrap-test-org');
    orgId = org.id;
  });

  it('creates a new project with default staging environment', async () => {
    const slug = `bt${uid}`;
    const name = `bootstrap-test-${uid}`;
    const { status, body } = await bootstrapProject(orgId, name, { slug });

    expect(status).toBe(200);
    expect(body.status).toBe('created');
    expect(body.project.name).toBe(name);
    expect(body.project.slug).toBe(slug);
    expect(body.environments).toHaveLength(1);
    expect(body.environments[0].name).toBe('staging');
    expect(body.environments[0].type).toBe('persistent');
    expect(body.next_steps).toBeInstanceOf(Array);
    expect(body.next_steps.length).toBeGreaterThan(0);
  });

  it('returns existing project on re-bootstrap (idempotent)', async () => {
    const slug = `bi${uid}`;
    const name = `bootstrap-idem-${uid}`;

    // First call creates
    const first = await bootstrapProject(orgId, name, { slug });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('created');

    // Second call returns existing
    const second = await bootstrapProject(orgId, name, { slug });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('existing');
    expect(second.body.project.id).toBe(first.body.project.id);
  });

  it('creates multiple environments when requested', async () => {
    const slug = `bm${uid}`;
    const name = `bootstrap-multi-${uid}`;
    const { status, body } = await bootstrapProject(orgId, name, {
      slug,
      environments: ['staging', 'production'],
    });

    expect(status).toBe(200);
    expect(body.environments).toHaveLength(2);
    const envNames = body.environments.map((e: EnvironmentResponse) => e.name).sort();
    expect(envNames).toEqual(['production', 'staging']);
  });

  it('handles missing org gracefully', async () => {
    const response = await fetch(`${apiUrl}/projects/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        org_id: 'org_nonexistent000000000000',
        name: 'should-fail',
        repo_url: 'https://github.com/test/fail',
        branch: 'main',
      }),
    });

    expect(response.status).toBe(404);
  });

  it('validates required fields', async () => {
    const response = await fetch(`${apiUrl}/projects/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        org_id: orgId,
        // Missing name and repo_url
      }),
    });

    expect(response.status).toBe(400);
  });
});
