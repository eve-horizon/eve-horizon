import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionExecutorService } from '../../src/action-executor/action-executor.service.js';
import { DeployerService } from '../../src/deployer/deployer.service.js';
import type { Db } from '@eve/db';

vi.mock('@eve/db', async () => {
  const actual = await vi.importActual<typeof import('@eve/db')>('@eve/db');
  return {
    ...actual,
    buildQueries: () => ({
      createSpec: vi.fn(),
      findSpecById: vi.fn(),
      listSpecs: vi.fn(),
      createRun: vi.fn(),
      findRunById: vi.fn(),
      findLatestRunByBuildId: vi.fn(),
      listRuns: vi.fn(),
      updateRun: vi.fn(),
      createArtifact: vi.fn(),
      listArtifacts: vi.fn(),
      appendLog: vi.fn(),
      listLogs: vi.fn(),
    }),
  };
});

/**
 * Unit tests for ActionExecutorService env_name input handling.
 *
 * These tests verify that the deploy action correctly handles the optional env_name input:
 * 1. When env_name is provided in action input, it uses that value
 * 2. When env_name is not provided in action input, it falls back to job.env_name
 * 3. When env_name is not provided in action input, it falls back to run.env_name
 * 4. When env_name cannot be resolved from any source, deploy fails with clear error
 */
describe('ActionExecutorService - env_name input handling', () => {
  let mockDb: Db;
  let mockDeployer: DeployerService;
  let service: ActionExecutorService;

  beforeEach(() => {
    // Create mock database functions
    mockDb = vi.fn() as unknown as Db;
    (mockDb as any).json = (value: unknown) => value;

    // Create mock deployer
    mockDeployer = {
      deploy: vi.fn(),
      getDeploymentStatus: vi.fn(),
      runJobService: vi.fn(),
    } as unknown as DeployerService;

    // Create service instance
    service = new ActionExecutorService(mockDb, mockDeployer);
  });

  describe('deploy action with env_name input', () => {
    it('uses env_name from action input when provided', async () => {
      const projectId = 'proj_test123';
      const jobId = 'test-job-abc123';
      const attemptId = 'proj_test123:1:1';
      const releaseId = 'rel_test456';
      const envName = 'pr-123';

      // Mock job queries
      const mockJob = {
        id: jobId,
        project_id: projectId,
        execution_type: 'action',
        action_type: 'deploy',
        action_input: {
          env_name: envName,
          release_id: releaseId,
        },
        env_name: null,
        run_id: null,
        step_name: null,
        hints: {},
      };

      // Mock environment queries
      const mockEnvironment = {
        id: 'env_test789',
        project_id: projectId,
        name: envName,
        type: 'persistent' as const,
        kind: 'preview' as const,
        namespace: null,
        db_ref: null,
        overrides_json: null,
        labels_json: null,
        current_release_id: null,
        last_failed_release_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // Mock release queries
      const mockRelease = {
        id: releaseId,
        project_id: projectId,
        git_sha: 'abc123',
        manifest_hash: 'hash123',
        image_digests_json: null,
        version: '1.0.0',
        tag: 'v1.0.0',
        created_by: null,
        created_at: new Date(),
      };

      // Setup mocks
      (service as any).jobs = {
        findById: vi.fn().mockResolvedValue(mockJob),
        markExecutionStarted: vi.fn().mockResolvedValue(undefined),
      };

      (service as any).envs = {
        findByProjectAndName: vi.fn().mockResolvedValue(mockEnvironment),
        update: vi.fn().mockResolvedValue(undefined),
      };

      (service as any).releases = {
        findById: vi.fn().mockResolvedValue(mockRelease),
      };

      (service as any).runs = {
        findRunById: vi.fn().mockResolvedValue(null),
      };

      (service as any).projects = {
        findById: vi.fn().mockResolvedValue(null),
      };

      (service as any).manifests = {
        findByProjectAndHash: vi.fn().mockResolvedValue(null),
      };

      (service as any).logs = {
        appendLog: vi.fn().mockResolvedValue(undefined),
      };

      vi.spyOn(mockDeployer, 'deploy').mockResolvedValue({
        envId: mockEnvironment.id,
        currentReleaseId: releaseId,
        state: 'ready',
        message: 'Deployment completed',
        namespace: 'eve-test-pr-123',
        k8sStatus: {
          ready: true,
          availableReplicas: 1,
          desiredReplicas: 1,
          conditions: [],
        },
      });

      // Execute
      const result = await service.execute(jobId, attemptId);

      // Verify
      expect(result.success).toBe(true);
      expect((service as any).envs.findByProjectAndName).toHaveBeenCalledWith(
        projectId,
        envName
      );
      expect(mockDeployer.deploy).toHaveBeenCalledWith(
        mockEnvironment.id,
        releaseId,
        expect.objectContaining({
          timeout: 180,
        })
      );
    });

    it('falls back to job.env_name when action input env_name is not provided', async () => {
      const projectId = 'proj_test123';
      const jobId = 'test-job-abc123';
      const attemptId = 'proj_test123:1:1';
      const releaseId = 'rel_test456';
      const envName = 'staging';

      // Mock job with env_name but no action_input.env_name
      const mockJob = {
        id: jobId,
        project_id: projectId,
        execution_type: 'action',
        action_type: 'deploy',
        action_input: {
          release_id: releaseId,
          // env_name NOT provided in action_input
        },
        env_name: envName, // Falls back to this
        run_id: null,
        step_name: null,
        hints: {},
      };

      const mockEnvironment = {
        id: 'env_test789',
        project_id: projectId,
        name: envName,
        type: 'persistent' as const,
        kind: 'standard' as const,
        namespace: null,
        db_ref: null,
        overrides_json: null,
        labels_json: null,
        current_release_id: null,
        last_failed_release_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const mockRelease = {
        id: releaseId,
        project_id: projectId,
        git_sha: 'abc123',
        manifest_hash: 'hash123',
        image_digests_json: null,
        version: '1.0.0',
        tag: 'v1.0.0',
        created_by: null,
        created_at: new Date(),
      };

      (service as any).jobs = {
        findById: vi.fn().mockResolvedValue(mockJob),
        markExecutionStarted: vi.fn().mockResolvedValue(undefined),
      };

      (service as any).envs = {
        findByProjectAndName: vi.fn().mockResolvedValue(mockEnvironment),
        update: vi.fn().mockResolvedValue(undefined),
      };

      (service as any).releases = {
        findById: vi.fn().mockResolvedValue(mockRelease),
      };

      (service as any).runs = {
        findRunById: vi.fn().mockResolvedValue(null),
      };

      (service as any).projects = {
        findById: vi.fn().mockResolvedValue(null),
      };

      (service as any).manifests = {
        findByProjectAndHash: vi.fn().mockResolvedValue(null),
      };

      (service as any).logs = {
        appendLog: vi.fn().mockResolvedValue(undefined),
      };

      vi.spyOn(mockDeployer, 'deploy').mockResolvedValue({
        envId: mockEnvironment.id,
        currentReleaseId: releaseId,
        state: 'ready',
        message: 'Deployment completed',
        namespace: 'eve-test-staging',
        k8sStatus: {
          ready: true,
          availableReplicas: 1,
          desiredReplicas: 1,
          conditions: [],
        },
      });

      const result = await service.execute(jobId, attemptId);

      expect(result.success).toBe(true);
      expect((service as any).envs.findByProjectAndName).toHaveBeenCalledWith(
        projectId,
        envName
      );
    });

    it('falls back to run.env_name when neither action input nor job.env_name are provided', async () => {
      const projectId = 'proj_test123';
      const jobId = 'test-job-abc123';
      const attemptId = 'proj_test123:1:1';
      const releaseId = 'rel_test456';
      const runId = 'run_test999';
      const envName = 'production';

      const mockJob = {
        id: jobId,
        project_id: projectId,
        execution_type: 'action',
        action_type: 'deploy',
        action_input: {
          release_id: releaseId,
        },
        env_name: null, // Not on job
        run_id: runId,
        step_name: 'deploy',
        hints: {},
      };

      const mockRun = {
        id: runId,
        project_id: projectId,
        pipeline_name: 'test-pipeline',
        env_name: envName, // Falls back to this
        git_sha: 'abc123',
        manifest_hash: 'hash123',
        status: 'running',
        inputs_json: {},
        step_outputs_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      };

      const mockEnvironment = {
        id: 'env_test789',
        project_id: projectId,
        name: envName,
        type: 'persistent' as const,
        kind: 'standard' as const,
        namespace: null,
        db_ref: null,
        overrides_json: null,
        labels_json: null,
        current_release_id: null,
        last_failed_release_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const mockRelease = {
        id: releaseId,
        project_id: projectId,
        git_sha: 'abc123',
        manifest_hash: 'hash123',
        image_digests_json: null,
        version: '1.0.0',
        tag: 'v1.0.0',
        created_by: null,
        created_at: new Date(),
      };

      (service as any).jobs = {
        findById: vi.fn().mockResolvedValue(mockJob),
        markExecutionStarted: vi.fn().mockResolvedValue(undefined),
      };

      (service as any).envs = {
        findByProjectAndName: vi.fn().mockResolvedValue(mockEnvironment),
        update: vi.fn().mockResolvedValue(undefined),
      };

      (service as any).releases = {
        findById: vi.fn().mockResolvedValue(mockRelease),
      };

      (service as any).runs = {
        findRunById: vi.fn().mockResolvedValue(mockRun),
      };

      (service as any).projects = {
        findById: vi.fn().mockResolvedValue(null),
      };

      (service as any).manifests = {
        findByProjectAndHash: vi.fn().mockResolvedValue(null),
      };

      (service as any).logs = {
        appendLog: vi.fn().mockResolvedValue(undefined),
      };

      vi.spyOn(mockDeployer, 'deploy').mockResolvedValue({
        envId: mockEnvironment.id,
        currentReleaseId: releaseId,
        state: 'ready',
        message: 'Deployment completed',
        namespace: 'eve-test-production',
        k8sStatus: {
          ready: true,
          availableReplicas: 1,
          desiredReplicas: 1,
          conditions: [],
        },
      });

      const result = await service.execute(jobId, attemptId);

      expect(result.success).toBe(true);
      expect((service as any).envs.findByProjectAndName).toHaveBeenCalledWith(
        projectId,
        envName
      );
    });

    it('fails with clear error when env_name cannot be resolved from any source', async () => {
      const projectId = 'proj_test123';
      const jobId = 'test-job-abc123';
      const attemptId = 'proj_test123:1:1';
      const releaseId = 'rel_test456';

      const mockJob = {
        id: jobId,
        project_id: projectId,
        execution_type: 'action',
        action_type: 'deploy',
        action_input: {
          release_id: releaseId,
          // env_name NOT provided
        },
        env_name: null, // Not on job
        run_id: null, // No run to fall back to
        step_name: null,
        hints: {},
      };

      (service as any).jobs = {
        findById: vi.fn().mockResolvedValue(mockJob),
        markExecutionStarted: vi.fn().mockResolvedValue(undefined),
      };

      (service as any).runs = {
        findRunById: vi.fn().mockResolvedValue(null),
      };

      (service as any).logs = {
        appendLog: vi.fn().mockResolvedValue(undefined),
      };

      const result = await service.execute(jobId, attemptId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Deploy action requires env_name');
    });

    it('fails when environment does not exist', async () => {
      const projectId = 'proj_test123';
      const jobId = 'test-job-abc123';
      const attemptId = 'proj_test123:1:1';
      const releaseId = 'rel_test456';
      const envName = 'nonexistent';

      const mockJob = {
        id: jobId,
        project_id: projectId,
        execution_type: 'action',
        action_type: 'deploy',
        action_input: {
          env_name: envName,
          release_id: releaseId,
        },
        env_name: null,
        run_id: null,
        step_name: null,
        hints: {},
      };

      const mockRelease = {
        id: releaseId,
        project_id: projectId,
        git_sha: 'abc123',
        manifest_hash: 'hash123',
        image_digests_json: null,
        version: '1.0.0',
        tag: 'v1.0.0',
        created_by: null,
        created_at: new Date(),
      };

      (service as any).jobs = {
        findById: vi.fn().mockResolvedValue(mockJob),
        markExecutionStarted: vi.fn().mockResolvedValue(undefined),
      };

      (service as any).envs = {
        findByProjectAndName: vi.fn().mockResolvedValue(null), // Environment not found
      };

      (service as any).releases = {
        findById: vi.fn().mockResolvedValue(mockRelease),
      };

      (service as any).runs = {
        findRunById: vi.fn().mockResolvedValue(null),
      };

      (service as any).logs = {
        appendLog: vi.fn().mockResolvedValue(undefined),
      };

      const result = await service.execute(jobId, attemptId);

      expect(result.success).toBe(false);
      expect(result.error).toContain(`Environment ${envName} not found`);
    });
  });
});
