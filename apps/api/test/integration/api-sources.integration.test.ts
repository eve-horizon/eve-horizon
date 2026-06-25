import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { SyncManifestRequest, ProjectResponse } from '@eve/shared';

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
  repoUrl: string,
  branch: string
): Promise<ProjectResponse> {
  const response = await fetch(`${apiUrl}/projects/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_id: orgId, name, repo_url: repoUrl, branch }),
  });

  const body = (await response.json()) as ProjectResponse;
  if (!response.ok) {
    throw new Error(`Ensure project failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

async function syncManifest(projectId: string, request: SyncManifestRequest) {
  const response = await fetch(`${apiUrl}/projects/${projectId}/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sync manifest failed: ${response.status} ${text}`);
  }

  return response.json();
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

function startSpecServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === '/openapi.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ openapi: '3.0.0', info: { title: 'Test', version: '1.0.0' } }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve({ server, url: `http://localhost:${address.port}` });
      }
    });
  });
}

describe('Project API Sources Integration Tests', () => {
  let testOrgId: string;
  let testProjectId: string;
  let specServer: Server | null = null;
  let specUrl = '';

  beforeEach(async () => {
    const uniqueId = Math.random().toString(36).substring(2, 8);
    const org = await ensureOrg(`ApiSourceOrg${uniqueId}`);
    testOrgId = org.id;

    const project = await ensureProject(
      testOrgId,
      `ApiSourceProj${uniqueId}`,
      'https://github.com/test/repo',
      'main'
    );
    testProjectId = project.id;

    const server = await startSpecServer();
    specServer = server.server;
    specUrl = server.url;
  });

  afterEach(async () => {
    if (specServer) {
      await new Promise((resolve) => specServer?.close(() => resolve(null)));
    }
    await deleteProject(testProjectId);
    await deleteOrg(testOrgId);
  });

  it('should sync manifest without top-level apis section', async () => {
    // Test that manifest sync works without the legacy top-level apis section
    // API sources are now registered during deploy via service-level api_spec
    const manifestYaml = `
name: api-source-test
services:
  app:
    image: test/app:latest
    ports: [3000]
`;

    await syncManifest(testProjectId, { yaml: manifestYaml });

    // Verify manifest was synced successfully
    const manifestResponse = await fetch(`${apiUrl}/projects/${testProjectId}/manifest`);
    expect(manifestResponse.ok).toBe(true);
    const manifestBody = await manifestResponse.json();
    expect(manifestBody.project_id).toBe(testProjectId);

    // Note: API sources are no longer registered during manifest sync
    // They are registered during deploy when service-level api_spec is processed
  });
});
