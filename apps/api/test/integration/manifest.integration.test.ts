/**
 * Integration tests for manifest sync functionality
 *
 * Run tests with:
 *   ./bin/eh test integration                  # from repo root
 *   cd apps/api && pnpm test manifest.spec.ts  # run just this file
 *
 * Prerequisites:
 *   - API server must be running
 *   - EVE_API_URL environment variable should point to the API
 *
 * The tests will:
 *   - Create temporary test organizations and projects via API
 *   - Test manifest sync, deduplication, and retrieval via API
 *   - Clean up all test data after completion via API
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { SyncManifestRequest, ManifestResponse, ProjectResponse } from '@eve/shared';

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';
const gitShaPrimary = '1111111111111111111111111111111111111111';
const gitShaSecondary = '2222222222222222222222222222222222222222';
const gitShaTertiary = '3333333333333333333333333333333333333333';
const gitShaQuaternary = '4444444444444444444444444444444444444444';
const gitShaQuinary = '5555555555555555555555555555555555555555';

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

async function syncManifest(projectId: string, request: SyncManifestRequest): Promise<ManifestResponse> {
  const response = await fetch(`${apiUrl}/projects/${projectId}/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sync manifest failed: ${response.status} ${text}`);
  }

  return (await response.json()) as ManifestResponse;
}

async function getLatestManifest(projectId: string): Promise<ManifestResponse | null> {
  const response = await fetch(`${apiUrl}/projects/${projectId}/manifest`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Get manifest failed: ${response.status} ${text}`);
  }

  const body = await response.json();
  return body as ManifestResponse | null;
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
    const text = await response.text();
    throw new Error(`Set secret failed: ${response.status} ${text}`);
  }
}

describe('Manifest Sync Integration Tests', () => {
  let testOrgId: string;
  let testProjectId: string;

  beforeEach(async () => {
    // Use unique prefix that affects slug generation (first 8 alphanumeric chars)
    const uniqueId = Math.random().toString(36).substring(2, 8);

    // Create a test organization
    const org = await ensureOrg(`ManifestOrg${uniqueId}`);
    testOrgId = org.id;

    // Create a test project - uniqueId at start ensures unique slug
    const project = await ensureProject(
      testOrgId,
      `MfstProj${uniqueId}`,
      'https://github.com/test/repo',
      'main'
    );
    testProjectId = project.id;
  });

  describe('POST /projects/:id/manifest - sync manifest', () => {
    it('should sync a new manifest successfully', async () => {
      const manifestYaml = `
name: test-service
services:
  api:
    image: test/api:latest
x-eve:
  defaults:
    env:
      NODE_ENV: production
      PORT: "3000"
`;

      const request: SyncManifestRequest = {
        yaml: manifestYaml,
        git_sha: gitShaPrimary,
        branch: 'main',
      };

      const result = await syncManifest(testProjectId, request);

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.project_id).toBe(testProjectId);
      expect(result.manifest_hash).toBeDefined();
      expect(result.git_sha).toBe(gitShaPrimary);
      expect(result.branch).toBe('main');
      expect(result.parsed_defaults).toEqual({
        env: {
          NODE_ENV: 'production',
          PORT: '3000',
        },
      });
      expect(result.created_at).toBeDefined();
      expect(result.updated_at).toBeDefined();
    });

    it('should reject invalid manifest shapes', async () => {
      // Pipeline steps must define action, script, agent, or run
      const invalidYaml = `
name: invalid-manifest
pipelines:
  ci:
    steps:
      - name: invalid-step
`;

      const response = await fetch(`${apiUrl}/projects/${testProjectId}/manifest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: invalidYaml }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(400);
    });

    it('should reject unresolved local workflow references', async () => {
      const invalidYaml = `
name: unresolved-workflow-ref
workflows:
  acme-make-plan:
    $ref: .eve/workflows/acme-make-plan
`;

      const response = await fetch(`${apiUrl}/projects/${testProjectId}/manifest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: invalidYaml }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(400);
      const body = await response.json() as { message?: string };
      expect(body.message).toContain('contains unresolved $ref');
    });

    it('should sync same manifest without creating duplicate', async () => {
      const manifestYaml = `
name: test-service
services:
  api:
    image: test/api:latest
x-eve:
  defaults:
    env:
      NODE_ENV: staging
`;

      const request: SyncManifestRequest = {
        yaml: manifestYaml,
        git_sha: gitShaSecondary,
        branch: 'main',
      };

      // First sync
      const firstResult = await syncManifest(testProjectId, request);
      const firstManifestId = firstResult.id;

      // Second sync with same YAML (should return existing manifest)
      const secondResult = await syncManifest(testProjectId, request);

      expect(secondResult.id).toBe(firstManifestId);
      expect(secondResult.manifest_hash).toBe(firstResult.manifest_hash);
      expect(secondResult.created_at).toBe(firstResult.created_at);
    });

    it('should warn on missing required secrets when validation requested', async () => {
      await setProjectSecret(testProjectId, 'GITHUB_TOKEN', 'ghp_test');

      const manifestYaml = `
services:
  api:
    image: test/api:latest
x-eve:
  requires:
    secrets:
      - GITHUB_TOKEN
      - REGISTRY_TOKEN
pipelines:
  ci:
    steps:
      - run: echo "hello"
        requires:
          secrets:
            - PIPELINE_SECRET
`;

      const request: SyncManifestRequest = {
        yaml: manifestYaml,
        validate_secrets: true,
      };

      const result = await syncManifest(testProjectId, request);
      expect(result.secret_validation?.missing?.length).toBe(2);
      const missingKeys = result.secret_validation?.missing.map((item) => item.key) ?? [];
      expect(missingKeys).toContain('REGISTRY_TOKEN');
      expect(missingKeys).toContain('PIPELINE_SECRET');
      expect(result.warnings && result.warnings.length > 0).toBe(true);
    });

    it('should fail sync when strict secret validation is enabled', async () => {
      const manifestYaml = `
services:
  api:
    image: test/api:latest
x-eve:
  requires:
    secrets:
      - STRICT_SECRET
`;

      const response = await fetch(`${apiUrl}/projects/${testProjectId}/manifest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: manifestYaml, strict: true }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(400);
      const body = await response.json() as { secret_validation?: { missing?: Array<{ key: string }> } };
      const missing = body.secret_validation?.missing ?? [];
      expect(missing.some((item) => item.key === 'STRICT_SECRET')).toBe(true);
    });

    it('should sync updated manifest and create new record', async () => {
      const originalYaml = `
name: test-service
services:
  api:
    image: test/api:latest
x-eve:
  defaults:
    env:
      VERSION: "1.0.0"
`;

      const updatedYaml = `
name: test-service
services:
  api:
    image: test/api:latest
x-eve:
  defaults:
    env:
      VERSION: "2.0.0"
`;

      // Sync original manifest
      const originalResult = await syncManifest(testProjectId, {
        yaml: originalYaml,
        git_sha: gitShaTertiary,
      });

      // Sync updated manifest
      const updatedResult = await syncManifest(testProjectId, {
        yaml: updatedYaml,
        git_sha: gitShaQuaternary,
      });

      expect(updatedResult.id).not.toBe(originalResult.id);
      expect(updatedResult.manifest_hash).not.toBe(originalResult.manifest_hash);
      expect(updatedResult.parsed_defaults).toEqual({
        env: {
          VERSION: '2.0.0',
        },
      });
    });

    it('accepts v2 services with ingress and env overrides', async () => {
      const manifestYaml = `
name: test-service
services:
  api:
    image: test/api:latest
    ports: ["3000:3000"]
    environment:
      HELLO: world
    x-eve:
      ingress:
        public: true
        port: 3000
environments:
  staging:
    overrides:
      services:
        api:
          environment:
            HELLO: staging
`;

      const result = await syncManifest(testProjectId, { yaml: manifestYaml });
      expect(result).toBeDefined();
      expect(result.warnings ?? []).toHaveLength(0);
    });

    it('accepts v2 services with x-eve api specs', async () => {
      const manifestYaml = `
name: test-service
services:
  api:
    image: test/api:latest
    ports: [3000]
    x-eve:
      ingress:
        public: true
        port: 3000
      api_spec:
        type: openapi
        spec_url: /openapi.json
`;

      const result = await syncManifest(testProjectId, { yaml: manifestYaml });
      expect(result).toBeDefined();
      expect(result.warnings ?? []).toHaveLength(0);
    });

    it('should handle invalid YAML gracefully', async () => {
      const invalidYaml = `
name: test-service
defaults:
  env:
    - this is invalid
    indentation is wrong
      - broken yaml
`;

      const request: SyncManifestRequest = {
        yaml: invalidYaml,
      };

      await expect(
        syncManifest(testProjectId, request)
      ).rejects.toThrow();
    });

    it('should handle manifest without defaults', async () => {
      const manifestYaml = `
name: test-service
services:
  api:
    image: node:18
`;

      const request: SyncManifestRequest = {
        yaml: manifestYaml,
      };

      const result = await syncManifest(testProjectId, request);

      expect(result).toBeDefined();
      expect(result.parsed_defaults).toBeNull();
    });

    it('should throw NotFoundException for non-existent project', async () => {
      const manifestYaml = `name: test`;

      const request: SyncManifestRequest = {
        yaml: manifestYaml,
      };

      await expect(
        syncManifest('prj_nonexistent', request)
      ).rejects.toThrow();
    });

    it('should extract nested defaults correctly', async () => {
      const manifestYaml = `
name: test-service
services:
  api:
    image: test/api:latest
x-eve:
  defaults:
    env:
      DB_HOST: localhost
      DB_PORT: "5432"
    resources:
      cpu: "1"
      memory: "512Mi"
`;

      const request: SyncManifestRequest = {
        yaml: manifestYaml,
      };

      const result = await syncManifest(testProjectId, request);

      expect(result.parsed_defaults).toEqual({
        env: {
          DB_HOST: 'localhost',
          DB_PORT: '5432',
        },
        resources: {
          cpu: '1',
          memory: '512Mi',
        },
      });
    });
  });

  describe('GET /projects/:id/manifest - get latest manifest', () => {
    it('should get latest manifest for project', async () => {
      // Create multiple manifests
      const yaml1 = `name: v1\nservices:\n  api:\n    image: test/api:latest\n    ports: [3000]\n\nx-eve:\n  defaults:\n    env:\n      VERSION: "1"`;
      const yaml2 = `name: v2\nservices:\n  api:\n    image: test/api:latest\n    ports: [3000]\n\nx-eve:\n  defaults:\n    env:\n      VERSION: "2"`;
      const yaml3 = `name: v3\nservices:\n  api:\n    image: test/api:latest\n    ports: [3000]\n\nx-eve:\n  defaults:\n    env:\n      VERSION: "3"`;

      await syncManifest(testProjectId, { yaml: yaml1 });
      await syncManifest(testProjectId, { yaml: yaml2 });
      await syncManifest(testProjectId, { yaml: yaml3 });

      const result = await getLatestManifest(testProjectId);

      expect(result).toBeDefined();
      expect(result?.parsed_defaults).toEqual({
        env: {
          VERSION: '3',
        },
      });
    });

    it('should return null when no manifests exist', async () => {
      const result = await getLatestManifest(testProjectId);
      expect(result).toBeNull();
    });

    it('should throw NotFoundException for non-existent project', async () => {
      await expect(
        getLatestManifest('prj_nonexistent')
      ).rejects.toThrow();
    });
  });

  describe('Manifest hashing and deduplication', () => {
    it('should generate same hash for identical YAML content', async () => {
      const yaml = `name: test\nservices:\n  api:\n    image: test/api:latest\n\nx-eve:\n  defaults:\n    env:\n      KEY: value`;

      const result1 = await syncManifest(testProjectId, { yaml });
      const result2 = await syncManifest(testProjectId, { yaml });

      expect(result1.manifest_hash).toBe(result2.manifest_hash);
      expect(result1.id).toBe(result2.id);
    });

    it('should generate different hashes for different YAML content', async () => {
      const yaml1 = `name: test1\nservices:\n  api:\n    image: test/api:latest`;
      const yaml2 = `name: test2\nservices:\n  api:\n    image: test/api:latest`;

      const result1 = await syncManifest(testProjectId, { yaml: yaml1 });
      const result2 = await syncManifest(testProjectId, { yaml: yaml2 });

      expect(result1.manifest_hash).not.toBe(result2.manifest_hash);
      expect(result1.id).not.toBe(result2.id);
    });

    it('should hash include whitespace differences', async () => {
      const yaml1 = `name: test\nservices:\n  api:\n    image: test/api:latest`;
      const yaml2 = `name: test\n\nservices:\n  api:\n    image: test/api:latest`;

      const result1 = await syncManifest(testProjectId, { yaml: yaml1 });
      const result2 = await syncManifest(testProjectId, { yaml: yaml2 });

      // Different whitespace means different hashes
      expect(result1.manifest_hash).not.toBe(result2.manifest_hash);
    });
  });

  describe('YAML parsing and defaults extraction', () => {
    it('should extract defaults.env from manifest', async () => {
      const manifestYaml = `
name: api-service
services:
  api:
    image: test/api:latest
x-eve:
  defaults:
    env:
      API_KEY: secret123
      TIMEOUT: "30"
`;

      const result = await syncManifest(testProjectId, {
        yaml: manifestYaml,
      });

      expect(result.parsed_defaults).toBeDefined();
      expect(result.parsed_defaults?.env).toEqual({
        API_KEY: 'secret123',
        TIMEOUT: '30',
      });
    });

    it('should handle empty defaults object', async () => {
      const manifestYaml = `
name: api-service
services:
  api:
    image: test/api:latest
x-eve:
  defaults: {}
`;

      const result = await syncManifest(testProjectId, {
        yaml: manifestYaml,
      });

      expect(result.parsed_defaults).toEqual({});
    });

    it('should handle complex nested defaults', async () => {
      const manifestYaml = `
name: api-service
services:
  api:
    image: test/api:latest
x-eve:
  defaults:
    env:
      DATABASE_URL: postgres://localhost
      REDIS_URL: redis://localhost
    volumes:
      - name: data
        path: /data
    labels:
      app: myapp
      version: "1.0"
`;

      const result = await syncManifest(testProjectId, {
        yaml: manifestYaml,
      });

      expect(result.parsed_defaults).toEqual({
        env: {
          DATABASE_URL: 'postgres://localhost',
          REDIS_URL: 'redis://localhost',
        },
        volumes: [
          {
            name: 'data',
            path: '/data',
          },
        ],
        labels: {
          app: 'myapp',
          version: '1.0',
        },
      });
    });

    it('should preserve number types in defaults', async () => {
      const manifestYaml = `
name: api-service
services:
  api:
    image: test/api:latest
x-eve:
  defaults:
    env:
      PORT: 3000
      WORKERS: 4
      ENABLED: true
`;

      const result = await syncManifest(testProjectId, {
        yaml: manifestYaml,
      });

      expect(result.parsed_defaults?.env).toEqual({
        PORT: 3000,
        WORKERS: 4,
        ENABLED: true,
      });
    });
  });

  describe('Git metadata tracking', () => {
    it('should store git_sha and branch when provided', async () => {
      const manifestYaml = `name: test\nservices:\n  api:\n    image: test/api:latest`;

      const result = await syncManifest(testProjectId, {
        yaml: manifestYaml,
        git_sha: gitShaQuinary,
        branch: 'feature/test',
      });

      expect(result.git_sha).toBe(gitShaQuinary);
      expect(result.branch).toBe('feature/test');
    });

    it('should allow null git_sha and branch', async () => {
      const manifestYaml = `name: test\nservices:\n  api:\n    image: test/api:latest`;

      const result = await syncManifest(testProjectId, {
        yaml: manifestYaml,
      });

      expect(result.git_sha).toBeNull();
      expect(result.branch).toBeNull();
    });
  });
});
