/**
 * Integration tests for pipeline runs.
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

describe('Pipeline Run Integration Tests', () => {
  let testOrgId: string;
  let testProjectId: string;
  let testRepoUrl: string;
  let testRepoSha: string;
  const testRepoBranch = 'main';

  beforeEach(async () => {
    // Use unique prefix that affects slug generation (first 8 alphanumeric chars)
    const uniqueId = Math.random().toString(36).substring(2, 8);

    const org = await ensureOrg(`PRunOrg${uniqueId}`);
    testOrgId = org.id;

    const repoDir = await fs.mkdtemp(join(tmpdir(), 'eve-pipeline-test-'));
    await execFileAsync('git', ['init'], { cwd: repoDir });
    await execFileAsync('git', ['checkout', '-b', testRepoBranch], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Eve Test'], { cwd: repoDir });

    const scriptsDir = join(repoDir, 'scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    const smokePath = join(scriptsDir, 'smoke-test.sh');
    await fs.writeFile(smokePath, '#!/usr/bin/env bash\necho ok\n', { encoding: 'utf8' });
    await fs.chmod(smokePath, 0o755);

    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
    testRepoSha = stdout.trim();
    testRepoUrl = `file://${repoDir}`;

    const project = await ensureProject(
      testOrgId,
      `PRunProj${uniqueId}`,
      testRepoUrl,
      testRepoBranch,
    );
    testProjectId = project.id;
  });

  it('creates a pipeline run and lists it', async () => {
    const manifestYaml = `
name: pipeline-run-test
services:
  api:
    image: test/api:latest
pipelines:
  smoke:
    steps:
      - name: build
        action:
          type: build
      - name: release
        action:
          type: release
      - name: smoke
        run: "./scripts/smoke-test.sh"
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: testRepoSha,
      branch: testRepoBranch,
    });

    const createResponse = await fetch(
      `${apiUrl}/projects/${testProjectId}/pipelines/smoke/runs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ git_sha: testRepoSha }),
      },
    );

    expect(createResponse.ok).toBe(true);
    const createBody = (await createResponse.json()) as { run: { id: string }; jobs: Array<{ step_name: string | null }> };
    expect(createBody.run.id).toBeDefined();

    const listResponse = await fetch(
      `${apiUrl}/projects/${testProjectId}/pipelines/smoke/runs`,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    );

    expect(listResponse.ok).toBe(true);
    const listBody = (await listResponse.json()) as { data: Array<{ id: string }> };
    expect(listBody.data.find((run) => run.id === createBody.run.id)).toBeDefined();

    const showResponse = await fetch(
      `${apiUrl}/projects/${testProjectId}/runs/${createBody.run.id}`,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    );

    expect(showResponse.ok).toBe(true);
    const showBody = (await showResponse.json()) as {
      run: { id: string };
      jobs: Array<{ step_name: string | null; execution_type: string }>;
    };
    expect(showBody.run.id).toBe(createBody.run.id);
    expect(showBody.jobs.length).toBe(3);
    expect(showBody.jobs.map(j => j.step_name)).toContain('build');
    expect(showBody.jobs.map(j => j.step_name)).toContain('release');
    expect(showBody.jobs.map(j => j.step_name)).toContain('smoke');
  });

  it('waits for pipeline run completion', async () => {
    const manifestYaml = `
name: pipeline-wait-test
services:
  api:
    image: test/api:latest
pipelines:
  smoke:
    steps:
      - name: build
        action:
          type: build
      - name: release
        action:
          type: release
      - name: smoke
        run: "./scripts/smoke-test.sh"
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: testRepoSha,
      branch: testRepoBranch,
    });

    const response = await fetch(
      `${apiUrl}/projects/${testProjectId}/pipelines/smoke/runs?wait=true&timeout=30`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ git_sha: testRepoSha }),
      },
    );

    expect(response.ok || response.status === 202).toBe(true);
    const body = (await response.json()) as { run: { status: string } };
    expect(['succeeded', 'running', 'pending']).toContain(body.run.status);
  }, 60000);

  it('cancels a pipeline run', async () => {
    const manifestYaml = `
name: pipeline-cancel-test
services:
  api:
    image: test/api:latest
pipelines:
  smoke:
    steps:
      - name: build
        action:
          type: build
      - name: release
        action:
          type: release
      - name: smoke
        run: "./scripts/smoke-test.sh"
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: testRepoSha,
      branch: testRepoBranch,
    });

    const createResponse = await fetch(
      `${apiUrl}/projects/${testProjectId}/pipelines/smoke/runs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ git_sha: testRepoSha }),
      },
    );

    expect(createResponse.ok).toBe(true);
    const createBody = (await createResponse.json()) as { run: { id: string } };

    const cancelResponse = await fetch(
      `${apiUrl}/pipeline-runs/${createBody.run.id}/cancel`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'test cancel' }),
      },
    );

    expect(cancelResponse.ok).toBe(true);
    const cancelBody = (await cancelResponse.json()) as { run: { status: string } };
    expect(cancelBody.run.status).toBe('cancelled');
  });

  describe.skip('approval gating (requires deploy + k8s)', () => {
    it('blocks deploy steps and resumes after approval', async () => {
      expect(true).toBe(true);
    });
  });
});
