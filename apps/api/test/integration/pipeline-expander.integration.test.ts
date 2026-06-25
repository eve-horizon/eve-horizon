/**
 * Integration tests for pipeline expander (job graph execution).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type { SyncManifestRequest, ManifestResponse, ProjectResponse } from '@eve/shared';

const execFileAsync = promisify(execFile);

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
  branch: string,
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

async function waitForJobsDone(projectId: string, runId: string, timeoutMs = 60000) {
  const start = Date.now();
  let lastJobPhases: string[] = [];
  while (Date.now() - start < timeoutMs) {
    const response = await fetch(`${apiUrl}/projects/${projectId}/runs/${runId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Fetch run failed: ${response.status} ${text}`);
    }

    const body = (await response.json()) as { run: { step_outputs?: Record<string, unknown> | null }; jobs: Array<{ phase: string }> };
    lastJobPhases = body.jobs.map((job) => job.phase);
    const allDone = body.jobs.length > 0 && body.jobs.every(job => ['done', 'cancelled'].includes(job.phase));
    if (allDone) {
      return body;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(
    `Timed out waiting for pipeline run ${runId}. Last phases: ${lastJobPhases.join(', ') || 'none'}`,
  );
}

describe('Pipeline Expander Integration Tests', () => {
  let testOrgId: string;
  let testProjectId: string;
  let testRepoUrl: string;
  let testRepoSha: string;
  const testRepoBranch = 'main';

  beforeEach(async () => {
    const uniqueId = Math.random().toString(36).substring(2, 8);

    const org = await ensureOrg(`PExpOrg${uniqueId}`);
    testOrgId = org.id;

    const repoDir = await fs.mkdtemp(join(tmpdir(), 'eve-pipeline-expander-'));
    await execFileAsync('git', ['init'], { cwd: repoDir });
    await execFileAsync('git', ['checkout', '-b', testRepoBranch], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Eve Test'], { cwd: repoDir });

    await fs.writeFile(join(repoDir, 'README.md'), '# test', { encoding: 'utf8' });
    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'feat: initial'], { cwd: repoDir });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
    testRepoSha = stdout.trim();
    testRepoUrl = `file://${repoDir}`;

    const project = await ensureProject(
      testOrgId,
      `PExpProj${uniqueId}`,
      testRepoUrl,
      testRepoBranch,
    );
    testProjectId = project.id;
  });

  it('executes action + script steps and records outputs', async () => {
    const manifestYaml = `
name: pipeline-expander-test
services:
  api:
    image: test/api:latest
pipelines:
  release:
    steps:
      - name: release
        action:
          type: release
          image_digests:
            api: sha256:1111111111111111111111111111111111111111111111111111111111111111
      - name: smoke
        run: "echo ok"
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: testRepoSha,
      branch: testRepoBranch,
    });

    const createResponse = await fetch(
      `${apiUrl}/projects/${testProjectId}/pipelines/release/runs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ git_sha: testRepoSha }),
      },
    );

    expect(createResponse.ok).toBe(true);
    const createBody = (await createResponse.json()) as {
      run: { id: string };
      jobs: Array<{ step_name: string | null; execution_type: string }>;
    };
    expect(createBody.run.id).toBeDefined();
    expect(createBody.jobs.length).toBe(2);

    const releaseJob = createBody.jobs.find(job => job.step_name === 'release');
    const smokeJob = createBody.jobs.find(job => job.step_name === 'smoke');
    expect(releaseJob?.execution_type).toBe('action');
    expect(smokeJob?.execution_type).toBe('script');

    const finalBody = await waitForJobsDone(testProjectId, createBody.run.id, 300_000);
    const outputs = finalBody.run.step_outputs ?? {};

    const releaseOutput = outputs.release as Record<string, unknown> | undefined;
    expect(typeof releaseOutput?.release_id).toBe('string');

    const smokeOutput = outputs.smoke as Record<string, unknown> | undefined;
    expect(typeof smokeOutput?.stdout).toBe('string');
    expect((smokeOutput?.stdout as string) || '').toContain('ok');
  }, 360_000);

  it('rejects remediation pipelines without create-pr actions', async () => {
    const manifestYaml = `
name: pipeline-expander-remediation
services:
  api:
    image: test/api:latest
pipelines:
  remediation:
    trigger:
      system:
        event: pipeline.failed
        pipeline: ci-cd-main
    steps:
      - name: analyze
        agent:
          prompt: "Analyze failure"
      - name: release
        action:
          type: release
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: testRepoSha,
      branch: testRepoBranch,
    });

    const response = await fetch(
      `${apiUrl}/projects/${testProjectId}/pipelines/remediation/runs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ git_sha: testRepoSha }),
      },
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
  });

  it('dry_run mode returns job graph without persisting to database', async () => {
    const manifestYaml = `
name: pipeline-expander-dry-run-test
services:
  api:
    image: test/api:latest
pipelines:
  test-pipeline:
    steps:
      - name: build
        run: "echo building"
      - name: test
        run: "echo testing"
        depends_on:
          - build
      - name: deploy
        action:
          type: release
          image_digests:
            api: sha256:1111111111111111111111111111111111111111111111111111111111111111
        depends_on:
          - test
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: testRepoSha,
      branch: testRepoBranch,
    });

    const dryRunResponse = await fetch(
      `${apiUrl}/projects/${testProjectId}/pipelines/test-pipeline/runs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ git_sha: testRepoSha, dry_run: true }),
      },
    );

    expect(dryRunResponse.ok).toBe(true);
    const dryRunBody = (await dryRunResponse.json()) as {
      run: { id: string; status: string; run_mode: string };
      jobs: Array<{ id: string; step_name: string | null; execution_type: string; phase: string }>;
      relations: Array<{ from_job_id: string; to_job_id: string; relation_type: string }>;
    };

    expect(dryRunBody.run.id).toMatch(/^dry-run-/);
    expect(dryRunBody.run.status).toBe('dry_run');
    expect(dryRunBody.run.run_mode).toBe('dry_run');
    expect(dryRunBody.jobs.length).toBe(3);

    const buildJob = dryRunBody.jobs.find(job => job.step_name === 'build');
    const testJob = dryRunBody.jobs.find(job => job.step_name === 'test');
    const deployJob = dryRunBody.jobs.find(job => job.step_name === 'deploy');

    expect(buildJob).toBeDefined();
    expect(testJob).toBeDefined();
    expect(deployJob).toBeDefined();

    expect(buildJob?.id).toMatch(/^dry-/);
    expect(testJob?.id).toMatch(/^dry-/);
    expect(deployJob?.id).toMatch(/^dry-/);

    expect(buildJob?.execution_type).toBe('script');
    expect(testJob?.execution_type).toBe('script');
    expect(deployJob?.execution_type).toBe('action');

    expect(dryRunBody.relations.length).toBe(2);
    const testBlocksRelation = dryRunBody.relations.find(
      r => r.from_job_id === testJob?.id && r.to_job_id === buildJob?.id
    );
    const deployBlocksRelation = dryRunBody.relations.find(
      r => r.from_job_id === deployJob?.id && r.to_job_id === testJob?.id
    );
    expect(testBlocksRelation).toBeDefined();
    expect(deployBlocksRelation).toBeDefined();

    const listRunsResponse = await fetch(
      `${apiUrl}/projects/${testProjectId}/pipelines/test-pipeline/runs`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      },
    );

    expect(listRunsResponse.ok).toBe(true);
    const listRunsBody = (await listRunsResponse.json()) as {
      data: Array<{ id: string }>;
    };

    const persistedDryRun = listRunsBody.data.find(run => run.id === dryRunBody.run.id);
    expect(persistedDryRun).toBeUndefined();
  });

  it('propagates env_name from pipeline definition when not in request', async () => {
    const manifestYaml = `
name: pipeline-env-propagation-test
services:
  api:
    image: test/api:latest
pipelines:
  deploy:
    env: staging
    steps:
      - name: build
        run: "echo building"
      - name: deploy
        depends_on: [build]
        action:
          type: release
          image_digests:
            api: sha256:1111111111111111111111111111111111111111111111111111111111111111
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: testRepoSha,
      branch: testRepoBranch,
    });

    // Request without env_name — should inherit from pipeline.env
    const dryRunResponse = await fetch(
      `${apiUrl}/projects/${testProjectId}/pipelines/deploy/runs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ git_sha: testRepoSha, dry_run: true }),
      },
    );

    expect(dryRunResponse.ok).toBe(true);
    const body = (await dryRunResponse.json()) as {
      run: { id: string; env_name: string | null };
      jobs: Array<{ env_name: string | null; step_name: string | null }>;
    };

    // Pipeline run should have env_name from pipeline definition
    expect(body.run.env_name).toBe('staging');

    // All jobs should inherit env_name
    for (const job of body.jobs) {
      expect(job.env_name).toBe('staging');
    }
  });

  it('request env_name overrides pipeline definition env', async () => {
    const manifestYaml = `
name: pipeline-env-override-test
services:
  api:
    image: test/api:latest
pipelines:
  deploy:
    env: staging
    steps:
      - name: build
        run: "echo building"
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: testRepoSha,
      branch: testRepoBranch,
    });

    // Request with explicit env_name — should override pipeline.env
    const dryRunResponse = await fetch(
      `${apiUrl}/projects/${testProjectId}/pipelines/deploy/runs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ git_sha: testRepoSha, env_name: 'production', dry_run: true }),
      },
    );

    expect(dryRunResponse.ok).toBe(true);
    const body = (await dryRunResponse.json()) as {
      run: { env_name: string | null };
      jobs: Array<{ env_name: string | null }>;
    };

    expect(body.run.env_name).toBe('production');
    for (const job of body.jobs) {
      expect(job.env_name).toBe('production');
    }
  });
});
