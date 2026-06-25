import { describe, expect, it, beforeEach } from 'vitest';
import type { ManifestResponse, ProjectResponse } from '@eve/shared';

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';

type CustomDomainResponse = {
  id: string;
  hostname: string;
  project_id: string;
  service_name: string;
  environment_id: string | null;
  environment_name: string | null;
  owner_env: { id: string; name: string } | null;
  status: string;
  dns_state: string;
  cert_state: string;
  last_verified_at: string | null;
};

async function ensureOrg(name: string): Promise<{ id: string; name: string }> {
  const response = await fetch(`${apiUrl}/orgs/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = await response.json() as { id: string; name: string };
  if (!response.ok) {
    throw new Error(`Ensure org failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function ensureProject(orgId: string, name: string): Promise<ProjectResponse> {
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
  const body = await response.json() as ProjectResponse;
  if (!response.ok) {
    throw new Error(`Ensure project failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function syncManifest(projectId: string, manifest: string): Promise<ManifestResponse> {
  const response = await fetch(`${apiUrl}/projects/${projectId}/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml: manifest }),
  });
  const body = await response.json() as ManifestResponse;
  if (!response.ok) {
    throw new Error(`Sync manifest failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function listDomains(projectId: string): Promise<CustomDomainResponse[]> {
  const response = await fetch(`${apiUrl}/projects/${projectId}/domains`);
  const body = await response.json() as { data: CustomDomainResponse[] };
  if (!response.ok) {
    throw new Error(`List domains failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function registerDomain(
  projectId: string,
  body: { hostname: string; service_name: string; environment?: string },
): Promise<CustomDomainResponse> {
  const response = await fetch(`${apiUrl}/projects/${projectId}/domains`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json() as CustomDomainResponse;
  if (!response.ok) {
    throw new Error(`Register domain failed: ${response.status} ${JSON.stringify(result)}`);
  }
  return result;
}

async function getDomain(projectId: string, hostname: string): Promise<CustomDomainResponse> {
  const response = await fetch(`${apiUrl}/projects/${projectId}/domains/${encodeURIComponent(hostname)}`);
  const result = await response.json() as CustomDomainResponse;
  if (!response.ok) {
    throw new Error(`Get domain failed: ${response.status} ${JSON.stringify(result)}`);
  }
  return result;
}

describe('Custom Domains Integration Tests', () => {
  let testProjectId: string;
  let unique: string;

  beforeEach(async () => {
    unique = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`.toLowerCase();
    const org = await ensureOrg(`DomainOrg${unique.slice(-8)}`);
    const project = await ensureProject(org.id, `DomProj${unique.slice(-8)}`);
    testProjectId = project.id;
  });

  it('syncs an env-scoped manifest domain and preserves it on repeat sync', async () => {
    const hostname = `sandbox-${unique}.example.com`;
    const manifest = `
services:
  api:
    image: test/api:latest
    x-eve:
      ingress:
        public: true
        port: 3000
environments:
  sandbox:
    overrides:
      services:
        api:
          x-eve:
            ingress:
              domains:
                - ${hostname}
`;

    await syncManifest(testProjectId, manifest);
    const first = (await listDomains(testProjectId)).find((domain) => domain.hostname === hostname);
    expect(first).toBeDefined();
    expect(first?.service_name).toBe('api');
    expect(first?.owner_env?.name).toBe('sandbox');
    expect(first?.dns_state).toBe('pending');
    expect(first?.cert_state).toBe('not_requested');
    expect(first?.last_verified_at).toBeNull();

    await syncManifest(testProjectId, manifest);
    const second = (await listDomains(testProjectId)).find((domain) => domain.hostname === hostname);
    expect(second?.id).toBe(first?.id);
    expect(second?.owner_env?.id).toBe(first?.owner_env?.id);
  });

  it('preserves manually registered domains across project sync', async () => {
    const hostname = `manual-${unique}.example.com`;
    const manifest = `
services:
  api:
    image: test/api:latest
environments:
  sandbox:
    overrides:
      services:
        api:
          environment:
            NODE_ENV: sandbox
`;

    await syncManifest(testProjectId, manifest);
    const registered = await registerDomain(testProjectId, {
      hostname,
      service_name: 'api',
      environment: 'sandbox',
    });
    expect(registered.hostname).toBe(hostname);
    expect(registered.owner_env?.name).toBe('sandbox');

    await syncManifest(testProjectId, manifest);
    const afterSync = await getDomain(testProjectId, hostname);
    expect(afterSync.id).toBe(registered.id);
    expect(afterSync.owner_env?.name).toBe('sandbox');
  });
});
