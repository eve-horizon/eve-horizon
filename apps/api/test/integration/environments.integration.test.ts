import { describe, expect, it, beforeAll } from 'vitest';
import type {
  EnvironmentResponse,
  EnvironmentListResponse,
  DeployResponse,
  ManifestResponse,
} from '@eve/shared';

// Helper type guard for direct deploy response
function isDirectDeployResponse(response: DeployResponse): response is { release: any; environment: any } {
  return 'release' in response;
}

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';

// Minimal test manifest YAML
const TEST_MANIFEST_YAML = `
services:
  api:
    image: test/api:latest
    ports: [8080]
    replicas: 1
`;

// Helper functions for API calls
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
  slug: string
): Promise<{ id: string }> {
  const response = await fetch(`${apiUrl}/projects/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      org_id: orgId,
      name,
      slug,
      repo_url: 'https://github.com/test/repo',
      branch: 'main',
    }),
  });

  const body = (await response.json()) as { id: string };
  if (!response.ok) {
    throw new Error(`Ensure project failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

async function createEnvironment(
  projectId: string,
  name: string,
  type: 'persistent' | 'temporary'
): Promise<EnvironmentResponse> {
  const response = await fetch(`${apiUrl}/projects/${projectId}/envs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type }),
  });

  const body = (await response.json()) as EnvironmentResponse;
  if (!response.ok) {
    throw new Error(`Create environment failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

async function listEnvironments(
  projectId: string,
  limit = 10,
  offset = 0
): Promise<EnvironmentListResponse> {
  const response = await fetch(
    `${apiUrl}/projects/${projectId}/envs?limit=${limit}&offset=${offset}`,
    {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    }
  );

  const body = (await response.json()) as EnvironmentListResponse;
  if (!response.ok) {
    throw new Error(`List environments failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

async function getEnvironment(
  projectId: string,
  name: string
): Promise<EnvironmentResponse> {
  const response = await fetch(`${apiUrl}/projects/${projectId}/envs/${name}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  const body = (await response.json()) as EnvironmentResponse;
  if (!response.ok) {
    throw new Error(`Get environment failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

async function syncManifest(
  projectId: string,
  yamlContent: string,
  gitSha?: string
): Promise<ManifestResponse> {
  const response = await fetch(`${apiUrl}/projects/${projectId}/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      yaml: yamlContent,
      git_sha: gitSha,
    }),
  });

  const body = (await response.json()) as ManifestResponse;
  if (!response.ok) {
    throw new Error(`Sync manifest failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

async function deployToEnvironment(
  projectId: string,
  envName: string,
  gitSha: string,
  manifestHash: string,
  imageDigests?: Record<string, string>
): Promise<DeployResponse> {
  const response = await fetch(`${apiUrl}/projects/${projectId}/envs/${envName}/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      git_sha: gitSha,
      manifest_hash: manifestHash,
      image_digests: imageDigests,
      direct: true, // Use direct deploy to bypass pipeline routing in tests
    }),
  });

  const body = (await response.json()) as DeployResponse;
  if (!response.ok) {
    throw new Error(`Deploy failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

describe('Environment Integration Tests', () => {
  let testOrgId: string;
  let testProjectId: string;

  beforeAll(async () => {
    // Create test org and project
    const timestamp = Date.now().toString();
    const uniqueId = timestamp.slice(-6); // Last 6 digits of timestamp
    const org = await ensureOrg(`Test Org ${uniqueId}`);
    testOrgId = org.id;

    // Slug must be 4-8 alphanumeric characters starting with a letter
    const slug = `env${uniqueId.slice(0, 5)}`; // env + 5 digits = 8 chars
    const project = await ensureProject(testOrgId, `Test Project ${uniqueId}`, slug);
    testProjectId = project.id;
  });

  describe('POST /projects/:id/envs - create environment', () => {
    it('should create a new environment successfully', async () => {
      const envName = `staging-${Date.now()}`;
      const environment = await createEnvironment(testProjectId, envName, 'persistent');

      expect(environment).toBeDefined();
      expect(environment.id).toBeDefined();
      expect(environment.project_id).toBe(testProjectId);
      expect(environment.name).toBe(envName);
      expect(environment.type).toBe('persistent');
      expect(environment.namespace).toBeNull();
      expect(environment.db_ref).toBeNull();
      expect(environment.overrides).toBeNull();
      expect(environment.current_release_id).toBeNull();
      expect(environment.created_at).toBeDefined();
      expect(environment.updated_at).toBeDefined();
    });

    it('should create temporary environment', async () => {
      const envName = `temp-${Date.now()}`;
      const environment = await createEnvironment(testProjectId, envName, 'temporary');

      expect(environment.type).toBe('temporary');
    });
  });

  describe('GET /projects/:id/envs - list environments', () => {
    it('should list environments for a project', async () => {
      // Create a couple of environments
      const env1Name = `list-test-1-${Date.now()}`;
      const env2Name = `list-test-2-${Date.now()}`;
      await createEnvironment(testProjectId, env1Name, 'persistent');
      await createEnvironment(testProjectId, env2Name, 'persistent');

      const list = await listEnvironments(testProjectId);

      expect(list.data).toBeDefined();
      expect(Array.isArray(list.data)).toBe(true);
      expect(list.data.length).toBeGreaterThanOrEqual(2);
      expect(list.pagination).toBeDefined();
      expect(list.pagination.limit).toBe(10);
      expect(list.pagination.offset).toBe(0);

      // Check that our created environments are in the list
      const envNames = list.data.map(env => env.name);
      expect(envNames).toContain(env1Name);
      expect(envNames).toContain(env2Name);
    });

    it('should respect limit and offset parameters', async () => {
      const list = await listEnvironments(testProjectId, 1, 0);

      expect(list.data.length).toBeLessThanOrEqual(1);
      expect(list.pagination.limit).toBe(1);
      expect(list.pagination.offset).toBe(0);
    });
  });

  describe('GET /projects/:id/envs/:name - get environment', () => {
    it('should get environment by name', async () => {
      const envName = `get-test-${Date.now()}`;
      const created = await createEnvironment(testProjectId, envName, 'persistent');

      const retrieved = await getEnvironment(testProjectId, envName);

      expect(retrieved.id).toBe(created.id);
      expect(retrieved.name).toBe(envName);
      expect(retrieved.project_id).toBe(testProjectId);
    });

    it('should handle missing environment gracefully', async () => {
      const nonExistentName = `missing-${Date.now()}`;

      await expect(getEnvironment(testProjectId, nonExistentName)).rejects.toThrow();
    });
  });

  describe('POST /projects/:id/manifest - sync manifest', () => {
    it('should sync a manifest to a project', async () => {
      const gitSha = '1111111111111111111111111111111111111111';
      const manifest = await syncManifest(testProjectId, TEST_MANIFEST_YAML, gitSha);

      expect(manifest).toBeDefined();
      expect(manifest.id).toBeDefined();
      expect(manifest.project_id).toBe(testProjectId);
      expect(manifest.manifest_hash).toBeDefined();
      expect(manifest.manifest_hash.length).toBe(64); // SHA-256 hex
      expect(manifest.git_sha).toBe(gitSha);
      expect(manifest.created_at).toBeDefined();
    });

    it('should return same manifest for identical content', async () => {
      const manifest1 = await syncManifest(testProjectId, TEST_MANIFEST_YAML);
      const manifest2 = await syncManifest(testProjectId, TEST_MANIFEST_YAML);

      expect(manifest1.id).toBe(manifest2.id);
      expect(manifest1.manifest_hash).toBe(manifest2.manifest_hash);
    });
  });

  // Deploy tests require K8s cluster - skip in docker-only environments
  // These tests are intended for environments with K8s access (e.g., k8s stack mode)
  describe.skip('POST /projects/:id/envs/:name/deploy - deploy to environment (requires K8s)', () => {
    it('should deploy to an environment', async () => {
      const envName = `deploy-test-${Date.now()}`;
      const environment = await createEnvironment(testProjectId, envName, 'persistent');

      // Sync manifest first
      const gitSha = '2222222222222222222222222222222222222222';
      const manifest = await syncManifest(testProjectId, TEST_MANIFEST_YAML, gitSha);

      const deployResult = await deployToEnvironment(
        testProjectId,
        envName,
        gitSha,
        manifest.manifest_hash
      );

      expect(deployResult).toBeDefined();
      expect(isDirectDeployResponse(deployResult)).toBe(true);
      if (!isDirectDeployResponse(deployResult)) return;

      expect(deployResult.release).toBeDefined();
      expect(deployResult.release.id).toBeDefined();
      expect(deployResult.release.project_id).toBe(testProjectId);
      expect(deployResult.release.git_sha).toBe(gitSha);
      expect(deployResult.release.manifest_hash).toBe(manifest.manifest_hash);
      expect(deployResult.release.created_at).toBeDefined();

      expect(deployResult.environment).toBeDefined();
      expect(deployResult.environment.id).toBe(environment.id);
      expect(deployResult.environment.current_release_id).toBe(deployResult.release.id);
    });

    it("should update environment's current_release_id after deploy", async () => {
      const envName = `deploy-update-test-${Date.now()}`;
      await createEnvironment(testProjectId, envName, 'persistent');

      // Sync two different manifests
      const gitSha1 = '3333333333333333333333333333333333333333';
      const manifest1 = await syncManifest(testProjectId, TEST_MANIFEST_YAML + '\n# v1', gitSha1);

      // First deployment
      const deploy1 = await deployToEnvironment(testProjectId, envName, gitSha1, manifest1.manifest_hash);
      expect(isDirectDeployResponse(deploy1)).toBe(true);
      if (!isDirectDeployResponse(deploy1)) return;
      expect(deploy1.environment.current_release_id).toBe(deploy1.release.id);

      // Second deployment with different manifest
      const gitSha2 = '4444444444444444444444444444444444444444';
      const manifest2 = await syncManifest(testProjectId, TEST_MANIFEST_YAML + '\n# v2', gitSha2);

      const deploy2 = await deployToEnvironment(testProjectId, envName, gitSha2, manifest2.manifest_hash);
      expect(isDirectDeployResponse(deploy2)).toBe(true);
      if (!isDirectDeployResponse(deploy2)) return;
      expect(deploy2.environment.current_release_id).toBe(deploy2.release.id);
      expect(deploy2.release.id).not.toBe(deploy1.release.id);

      // Verify by fetching the environment
      const retrieved = await getEnvironment(testProjectId, envName);
      expect(retrieved.current_release_id).toBe(deploy2.release.id);
    });

    it('should deploy with image digests', async () => {
      const envName = `deploy-images-test-${Date.now()}`;
      await createEnvironment(testProjectId, envName, 'persistent');

      const gitSha = '5555555555555555555555555555555555555555';
      const manifest = await syncManifest(testProjectId, TEST_MANIFEST_YAML, gitSha);
      const imageDigests = {
        api: 'sha256:abcdef1234567890',
        worker: 'sha256:1234567890abcdef',
      };

      const deployResult = await deployToEnvironment(
        testProjectId,
        envName,
        gitSha,
        manifest.manifest_hash,
        imageDigests
      );

      expect(isDirectDeployResponse(deployResult)).toBe(true);
      if (!isDirectDeployResponse(deployResult)) return;
      expect(deployResult.release.image_digests).toEqual(imageDigests);
    });

    it('should handle deployment to missing environment', async () => {
      const nonExistentName = `missing-deploy-${Date.now()}`;
      const gitSha = '6666666666666666666666666666666666666666';
      const manifest = await syncManifest(testProjectId, TEST_MANIFEST_YAML, gitSha);

      await expect(
        deployToEnvironment(testProjectId, nonExistentName, gitSha, manifest.manifest_hash)
      ).rejects.toThrow();
    });
  });

  // Tests for new pipeline routing behavior
  describe.skip('POST /projects/:id/envs/:name/deploy - pipeline routing (requires K8s)', () => {
    it('should route deploy to pipeline when environment has pipeline configured', async () => {
      const envName = `pipeline-test-${Date.now()}`;

      // Create environment
      await createEnvironment(testProjectId, envName, 'persistent');

      // Sync manifest with pipeline configuration for the environment
      const manifestWithPipeline = `
services:
  api:
    image: test/api:latest
    ports: [8080]
    replicas: 1

environments:
  ${envName}:
    type: persistent
    pipeline: deploy

pipelines:
  deploy:
    steps:
      - name: build
        script:
          run: echo "Building..."
      - name: deploy-app
        script:
          run: echo "Deploying..."
        depends_on:
          - build
`;
      const gitSha = '7777777777777777777777777777777777777777';
      await syncManifest(testProjectId, manifestWithPipeline, gitSha);

      // Deploy without direct flag - should route to pipeline
      const response = await fetch(`${apiUrl}/projects/${testProjectId}/envs/${envName}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          git_sha: gitSha,
          manifest_hash: (await syncManifest(testProjectId, manifestWithPipeline, gitSha)).manifest_hash,
        }),
      });

      expect(response.ok).toBe(true);
      const result = (await response.json()) as any;

      // Should return pipeline_run instead of release
      expect(result.pipeline_run).toBeDefined();
      expect(result.pipeline_run.pipeline_name).toBe('deploy');
      expect(result.pipeline_run.env_name).toBe(envName);
      expect(result.pipeline_run.git_sha).toBe(gitSha);
      expect(result.environment).toBeDefined();
      expect(result.release).toBeUndefined();
    });

    it('should bypass pipeline when direct flag is true', async () => {
      const envName = `direct-test-${Date.now()}`;

      // Create environment
      await createEnvironment(testProjectId, envName, 'persistent');

      // Sync manifest with pipeline configuration
      const manifestWithPipeline = `
services:
  api:
    image: test/api:latest
    ports: [8080]
    replicas: 1

environments:
  ${envName}:
    type: persistent
    pipeline: deploy

pipelines:
  deploy:
    steps:
      - name: build
        script:
          run: echo "Building..."
`;
      const gitSha = '8888888888888888888888888888888888888888';
      const manifest = await syncManifest(testProjectId, manifestWithPipeline, gitSha);

      // Deploy with direct flag - should bypass pipeline
      const deployResult = await deployToEnvironment(
        testProjectId,
        envName,
        gitSha,
        manifest.manifest_hash
      );

      // Should return release, not pipeline_run
      expect(isDirectDeployResponse(deployResult)).toBe(true);
      if (!isDirectDeployResponse(deployResult)) return;
      expect(deployResult.release).toBeDefined();
      expect(deployResult.release.git_sha).toBe(gitSha);
    });

    it('should merge pipeline inputs from manifest and request', async () => {
      const envName = `inputs-test-${Date.now()}`;

      // Create environment
      await createEnvironment(testProjectId, envName, 'persistent');

      // Sync manifest with pipeline and pipeline_inputs
      const manifestWithInputs = `
services:
  api:
    image: test/api:latest
    ports: [8080]
    replicas: 1

environments:
  ${envName}:
    type: persistent
    pipeline: deploy
    pipeline_inputs:
      manifest_key: manifest_value
      shared_key: manifest_default

pipelines:
  deploy:
    steps:
      - name: deploy-app
        script:
          run: echo "Deploying with inputs..."
`;
      const gitSha = '9999999999999999999999999999999999999999';
      await syncManifest(testProjectId, manifestWithInputs, gitSha);

      // Deploy with additional inputs - request inputs should override manifest
      const response = await fetch(`${apiUrl}/projects/${testProjectId}/envs/${envName}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          git_sha: gitSha,
          manifest_hash: (await syncManifest(testProjectId, manifestWithInputs, gitSha)).manifest_hash,
          inputs: {
            request_key: 'request_value',
            shared_key: 'request_override',
          },
        }),
      });

      expect(response.ok).toBe(true);
      const result = (await response.json()) as any;

      // Verify pipeline run was created with merged inputs
      expect(result.pipeline_run).toBeDefined();
      expect(result.pipeline_run.inputs).toBeDefined();

      // Request inputs should override manifest inputs
      expect(result.pipeline_run.inputs.manifest_key).toBe('manifest_value');
      expect(result.pipeline_run.inputs.request_key).toBe('request_value');
      expect(result.pipeline_run.inputs.shared_key).toBe('request_override');
    });
  });
});
