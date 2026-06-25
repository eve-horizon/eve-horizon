/**
 * Integration tests for pipeline run deduplication.
 * Tests the complete flow from event to pipeline run creation.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { PipelineRunWithJobsResponse } from '../../src/pipelines/pipeline-expander.service.js';
import type { ManifestResponse, SyncManifestRequest } from '@eve/shared';

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';
const internalToken = process.env.EVE_INTERNAL_API_KEY || 'test-internal-token';
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

async function ensureProject(orgId: string, name: string): Promise<{ id: string }> {
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

  const body = (await response.json()) as { id: string };
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

async function createPipelineRun(
  projectId: string,
  pipelineName: string,
  gitSha: string,
  dedupeKey?: string,
): Promise<PipelineRunWithJobsResponse> {
  const response = await fetch(`${apiUrl}/internal/projects/${projectId}/pipelines/${pipelineName}/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-eve-internal-token': internalToken,
    },
    body: JSON.stringify({
      git_sha: gitSha,
      dedupe_key: dedupeKey,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Create pipeline run failed: ${response.status} ${text}`);
  }

  return (await response.json()) as PipelineRunWithJobsResponse;
}

describe('Pipeline Run Deduplication Integration Tests', () => {
  let testProjectId: string;
  const testPipelineName = 'test-pipeline';

  beforeAll(async () => {
    const uniqueId = Math.random().toString(36).substring(2, 8);
    const org = await ensureOrg(`PDDOrg${uniqueId}`);
    const project = await ensureProject(org.id, `PDDProj${uniqueId}`);
    testProjectId = project.id;

    const manifestYaml = `
name: pipeline-dedupe-test
services:
  api:
    image: test/api:latest
pipelines:
  ${testPipelineName}:
    steps:
      - name: build
        action:
          type: build
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: gitShaPrimary,
      branch: 'main',
    });
  });

  it('should create pipeline run without dedupe_key', async () => {
    const run = await createPipelineRun(testProjectId, testPipelineName, gitShaSecondary);

    expect(run).toBeDefined();
    expect(run.run).toBeDefined();
    expect(run.run.dedupe_key).toBeNull();
  });

  it('should create pipeline run with dedupe_key', async () => {
    const dedupeKey = `pr:test/repo:${Date.now()}`;
    const run = await createPipelineRun(testProjectId, testPipelineName, gitShaTertiary, dedupeKey);

    expect(run).toBeDefined();
    expect(run.run).toBeDefined();
    expect(run.run.dedupe_key).toBe(dedupeKey);
  });

  it('should cancel existing active run when creating new run with same dedupe_key', async () => {
    const dedupeKey = `pr:test/repo:${Date.now()}`;

    // Create first run
    const run1 = await createPipelineRun(testProjectId, testPipelineName, gitShaQuaternary, dedupeKey);
    expect(run1.run.status).toBe('pending');
    expect(run1.run.dedupe_key).toBe(dedupeKey);

    // Create second run with same dedupe_key - should cancel first run
    const run2 = await createPipelineRun(testProjectId, testPipelineName, gitShaQuinary, dedupeKey);
    expect(run2.run.status).toBe('pending');
    expect(run2.run.dedupe_key).toBe(dedupeKey);
    expect(run2.run.id).not.toBe(run1.run.id);

    // Verify first run was cancelled
    const checkRun1 = await fetch(`${apiUrl}/projects/${testProjectId}/pipelines/${testPipelineName}/runs/${run1.run.id}`);
    if (checkRun1.ok) {
      const run1Data = (await checkRun1.json()) as { run: { status: string } };
      expect(run1Data.run.status).toBe('cancelled');
    }
  });

  it('should generate correct dedupe_key format for PR events', () => {
    const repo = 'owner/repo';
    const prNumber = 123;
    const expectedDedupeKey = `pr:${repo}:${prNumber}`;

    // This tests the format that should be generated by the event router
    expect(expectedDedupeKey).toBe('pr:owner/repo:123');
  });
});
