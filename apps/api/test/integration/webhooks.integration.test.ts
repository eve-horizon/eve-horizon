import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';
const githubSecret = process.env.EVE_GITHUB_WEBHOOK_SECRET;

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
): Promise<{ id: string }> {
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

  if (!response.ok) {
    throw new Error(`Ensure project failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as { id: string };
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

async function setProjectSecret(projectId: string, key: string, value: string): Promise<void> {
  const response = await fetch(`${apiUrl}/projects/${projectId}/secrets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });

  if (!response.ok) {
    throw new Error(`Set project secret failed: ${response.status} ${await response.text()}`);
  }
}

function signGithub(body: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${digest}`;
}

describe('Webhook Integration Tests', () => {
  let testOrgId: string;
  let testProjectId: string;

  beforeEach(async () => {
    const uniqueId = Math.random().toString(36).substring(2, 8);
    const org = await ensureOrg(`WebhookOrg${uniqueId}`);
    testOrgId = org.id;
    const project = await ensureProject(testOrgId, `WebhookProj${uniqueId}`);
    testProjectId = project.id;
  });

  afterEach(async () => {
    await deleteProject(testProjectId);
    await deleteOrg(testOrgId);
  });

  it('accepts GitHub webhook with valid signature', async () => {
    if (!githubSecret) {
      throw new Error('EVE_GITHUB_WEBHOOK_SECRET is required for webhook tests');
    }

    const payload = {
      ref: 'refs/heads/main',
      after: 'abc123',
      sender: { login: 'octocat' },
    };

    const body = JSON.stringify(payload);
    const response = await fetch(`${apiUrl}/integrations/github/events/${testProjectId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': signGithub(body, githubSecret),
      },
      body,
    });

    expect(response.ok).toBe(true);
  });

  it('prefers project-scoped GitHub webhook secret when configured', async () => {
    if (!githubSecret) {
      throw new Error('EVE_GITHUB_WEBHOOK_SECRET is required for webhook tests');
    }

    const projectSecret = `proj-secret-${Date.now()}`;
    await setProjectSecret(testProjectId, 'GITHUB_WEBHOOK_SECRET', projectSecret);

    const payload = {
      ref: 'refs/heads/main',
      after: 'abc123',
      sender: { login: 'octocat' },
    };

    const body = JSON.stringify(payload);
    const projectResponse = await fetch(`${apiUrl}/integrations/github/events/${testProjectId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': signGithub(body, projectSecret),
      },
      body,
    });

    expect(projectResponse.ok).toBe(true);

    const globalResponse = await fetch(`${apiUrl}/integrations/github/events/${testProjectId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': signGithub(body, githubSecret),
      },
      body,
    });

    expect(globalResponse.status).toBe(401);
  });

  it('rejects GitHub webhook with invalid signature', async () => {
    if (!githubSecret) {
      throw new Error('EVE_GITHUB_WEBHOOK_SECRET is required for webhook tests');
    }

    const payload = {
      ref: 'refs/heads/main',
      after: 'abc123',
      sender: { login: 'octocat' },
    };

    const body = JSON.stringify(payload);
    const response = await fetch(`${apiUrl}/integrations/github/events/${testProjectId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': signGithub(body, `${githubSecret}-bad`),
      },
      body,
    });

    expect(response.status).toBe(401);
  });

  // Note: Slack webhook tests removed — the /integrations/slack/events/:projectId
  // endpoint was deleted in af1dc91. Slack events now route through the gateway
  // (POST /gateway/providers/slack/webhook), not the API.
});
