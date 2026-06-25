/**
 * Git Controls Integration Tests
 *
 * Tests the git controls implementation for job execution:
 * - ref resolution with different policies (auto, env, project_default, explicit)
 * - branch creation policies (never, if_missing, always)
 * - commit and push policies
 * - backwards compatibility (no git config = shallow clone)
 *
 * These tests use the API to create jobs with git config, then verify the
 * behavior via job/attempt metadata.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const apiUrl =
  process.env.EVE_API_URL ||
  `http://localhost:${process.env.EVE_API_PORT || '4701'}`;

async function runEve(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(eveBin, args, {
    cwd: repoRoot,
    env: { ...process.env, EVE_API_URL: apiUrl },
    timeout: 30_000,
  });
  return stdout.trim();
}

async function request(requestPath: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${apiUrl}${requestPath}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed: ${response.status} ${text}`);
  }
  return response.json();
}

async function createJob(projectId: string, body: Record<string, unknown>): Promise<unknown> {
  return request(`/projects/${projectId}/jobs`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function updateJob(jobId: string, body: Record<string, unknown>): Promise<unknown> {
  return request(`/jobs/${jobId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

// Job response type - git/workspace are top-level fields, not nested under data
interface JobResponse {
  id: string;
  git?: {
    ref?: string;
    ref_policy?: string;
    branch?: string;
    create_branch?: string;
    commit?: string;
    commit_message?: string;
    push?: string;
    remote?: string;
  } | null;
  workspace?: {
    mode?: string;
    key?: string;
  } | null;
}

describe('integration git controls', () => {
  let orgId: string;
  let projectId: string;

  beforeAll(async () => {
    // Setup org
    const orgRaw = await runEve(['org', 'ensure', `git-controls-test-${Date.now()}`, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };
    orgId = org.id;

    // Setup project with the e2e fixture repo
    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = `file://${repoPath}`;

    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      orgId,
      '--name',
      `git-controls-test-${Date.now()}`,
      '--repo-url',
      repoUrl,
      '--branch',
      'main',
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };
    projectId = project.id;
  }, 60_000);

  describe('job creation with git config', () => {
    it('creates job with git.ref specified', async () => {
      const result = await createJob(projectId, {
        description: 'Test job with explicit git ref',
        phase: 'backlog',
        git: {
          ref: 'feature-branch',
          ref_policy: 'explicit',
        },
      }) as JobResponse;

      expect(result.id).toBeTruthy();
      expect(result.git?.ref).toBe('feature-branch');
      expect(result.git?.ref_policy).toBe('explicit');
    });

    it('creates job with branch creation policy', async () => {
      const result = await createJob(projectId, {
        description: 'Test job with branch creation',
        phase: 'backlog',
        git: {
          branch: 'job/test-feature',
          create_branch: 'if_missing',
        },
      }) as JobResponse;

      expect(result.id).toBeTruthy();
      expect(result.git?.branch).toBe('job/test-feature');
      expect(result.git?.create_branch).toBe('if_missing');
    });

    it('creates job with commit and push policies', async () => {
      const result = await createJob(projectId, {
        description: 'Test job with commit/push policies',
        phase: 'backlog',
        git: {
          commit: 'auto',
          commit_message: 'job/${job_id}: ${summary}',
          push: 'on_success',
          remote: 'origin',
        },
      }) as JobResponse;

      expect(result.id).toBeTruthy();
      expect(result.git?.commit).toBe('auto');
      expect(result.git?.commit_message).toBe('job/${job_id}: ${summary}');
      expect(result.git?.push).toBe('on_success');
      expect(result.git?.remote).toBe('origin');
    });

    it('creates job with full git config for CI workflow', async () => {
      const result = await createJob(projectId, {
        description: 'Complete CI workflow job',
        phase: 'backlog',
        git: {
          ref_policy: 'auto',
          branch: 'ci/automated-fix',
          create_branch: 'always',
          commit: 'auto',
          push: 'on_success',
        },
      }) as JobResponse;

      expect(result.id).toBeTruthy();
      expect(result.git?.ref_policy).toBe('auto');
      expect(result.git?.branch).toBe('ci/automated-fix');
      expect(result.git?.create_branch).toBe('always');
      expect(result.git?.commit).toBe('auto');
      expect(result.git?.push).toBe('on_success');
    });
  });

  describe('job creation with workspace config', () => {
    it('creates job with workspace mode', async () => {
      const result = await createJob(projectId, {
        description: 'Test job with workspace mode',
        phase: 'backlog',
        workspace: {
          mode: 'session',
          key: 'session:test-123',
        },
      }) as JobResponse;

      expect(result.id).toBeTruthy();
      expect(result.workspace?.mode).toBe('session');
      expect(result.workspace?.key).toBe('session:test-123');
    });
  });

  describe('backwards compatibility', () => {
    it('creates job without git config (legacy behavior)', async () => {
      const result = await createJob(projectId, {
        description: 'Legacy job without git config',
        phase: 'backlog',
      }) as JobResponse;

      expect(result.id).toBeTruthy();
      // No git config should be present (null is acceptable)
      expect(result.git).toBeFalsy();
    });

    it('retrieves job without git config correctly', async () => {
      // Create a job without git config
      const createResult = await createJob(projectId, {
        description: 'Legacy job to retrieve',
        phase: 'backlog',
      }) as JobResponse;

      // Retrieve it
      const showRaw = await runEve(['job', 'show', createResult.id, '--json']);
      const job = JSON.parse(showRaw) as JobResponse;

      expect(job.id).toBe(createResult.id);
      // Should not have git config (null is acceptable)
      expect(job.git).toBeFalsy();
    });
  });

  describe('ref policy validation', () => {
    it('accepts all valid ref_policy values', async () => {
      const policies = ['auto', 'env', 'project_default', 'explicit'];

      for (const policy of policies) {
        const result = await createJob(projectId, {
          description: `Test ref_policy=${policy}`,
          phase: 'backlog',
          git: {
            ref_policy: policy,
            // explicit requires ref
            ...(policy === 'explicit' ? { ref: 'main' } : {}),
          },
        }) as JobResponse;

        expect(result.git?.ref_policy).toBe(policy);
      }
    });

    it('accepts all valid create_branch values', async () => {
      const modes = ['never', 'if_missing', 'always'];

      for (const mode of modes) {
        const result = await createJob(projectId, {
          description: `Test create_branch=${mode}`,
          phase: 'backlog',
          git: {
            branch: `test-${mode}`,
            create_branch: mode,
          },
        }) as JobResponse;

        expect(result.git?.create_branch).toBe(mode);
      }
    });

    it('accepts all valid commit policy values', async () => {
      const policies = ['never', 'manual', 'auto', 'required'];

      for (const policy of policies) {
        const result = await createJob(projectId, {
          description: `Test commit=${policy}`,
          phase: 'backlog',
          git: {
            commit: policy,
          },
        }) as JobResponse;

        expect(result.git?.commit).toBe(policy);
      }
    });

    it('accepts all valid push policy values', async () => {
      const policies = ['never', 'on_success', 'required'];

      for (const policy of policies) {
        const result = await createJob(projectId, {
          description: `Test push=${policy}`,
          phase: 'backlog',
          git: {
            push: policy,
          },
        }) as JobResponse;

        expect(result.git?.push).toBe(policy);
      }
    });
  });

  describe('job update with git config', () => {
    it('updates job to add git config', async () => {
      // Create job without git config
      const createResult = await createJob(projectId, {
        description: 'Job to update with git config',
        phase: 'backlog',
      }) as JobResponse;

      // Update to add git config
      const updateResult = await updateJob(createResult.id, {
        git: {
          branch: 'updated-branch',
          create_branch: 'if_missing',
        },
      }) as JobResponse;

      expect(updateResult.git?.branch).toBe('updated-branch');
      expect(updateResult.git?.create_branch).toBe('if_missing');
    });

    it('replaces git config entirely on update', async () => {
      // Create job with git config
      const createResult = await createJob(projectId, {
        description: 'Job with git config to replace',
        phase: 'backlog',
        git: {
          branch: 'original-branch',
          commit: 'manual',
        },
      }) as JobResponse;

      expect(createResult.git?.branch).toBe('original-branch');
      expect(createResult.git?.commit).toBe('manual');

      // Update replaces entire git config, not partial merge
      const updateResult = await updateJob(createResult.id, {
        git: {
          commit: 'auto',
        },
      }) as JobResponse;

      // Previous branch is gone because git config was replaced
      expect(updateResult.git?.branch).toBeUndefined();
      expect(updateResult.git?.commit).toBe('auto');
    });
  });
});
