import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ManifestResponse, JobListResponse, PipelineRunListResponse } from '@eve/shared';

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';
const gitShaPush = '1111111111111111111111111111111111111111';
const gitShaFailure = '2222222222222222222222222222222222222222';
const gitShaPr = '3333333333333333333333333333333333333333';
const gitShaPrSync = '4444444444444444444444444444444444444444';

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

async function syncManifest(projectId: string, yaml: string): Promise<ManifestResponse> {
  const response = await fetch(`${apiUrl}/projects/${projectId}/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml }),
  });

  if (!response.ok) {
    throw new Error(`Manifest sync failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as ManifestResponse;
}

async function emitEvent(projectId: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${apiUrl}/projects/${projectId}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Event emit failed: ${response.status} ${await response.text()}`);
  }
}

async function poll<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 20000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (predicate(value)) {
      return value;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for event router result');
}

describe('Event router trigger integration', () => {
  let testOrgId: string;
  let testProjectId: string;

  beforeEach(async () => {
    const uniqueId = Math.random().toString(36).substring(2, 8);
    const org = await ensureOrg(`TriggerOrg${uniqueId}`);
    testOrgId = org.id;
    const project = await ensureProject(testOrgId, `TriggerProj${uniqueId}`);
    testProjectId = project.id;
  });

  afterEach(async () => {
    await deleteProject(testProjectId);
    await deleteOrg(testOrgId);
  });

  it('creates pipeline run and workflow job from triggers', async () => {
    const manifestYaml = `
services:
  api:
    image: test/api:latest

pipelines:
  deploy:
    trigger:
      github:
        event: push
        branch: main
    steps:
      - action:
          type: build

workflows:
  notify:
    trigger:
      slack:
        event: message
    hints:
      gates: ["remediate:${testProjectId}:staging"]
      timeout_seconds: 120
    steps:
      - agent:
          prompt: "Notify"
`;

    await syncManifest(testProjectId, manifestYaml);

    await emitEvent(testProjectId, {
      type: 'github.push',
      source: 'github',
      ref_sha: gitShaPush,
      ref_branch: 'main',
      actor_type: 'user',
      actor_id: 'testuser',
    });

    await emitEvent(testProjectId, {
      type: 'slack.message',
      source: 'slack',
      payload_json: { event: { channel: 'C1' } },
      actor_type: 'user',
      actor_id: 'U123',
    });

    await poll<PipelineRunListResponse>(
      async () => {
        const response = await fetch(`${apiUrl}/projects/${testProjectId}/pipelines/deploy/runs`);
        return (await response.json()) as PipelineRunListResponse;
      },
      (result) => result.data.length > 0,
    );

    await poll<JobListResponse>(
      async () => {
        const response = await fetch(`${apiUrl}/projects/${testProjectId}/jobs`);
        return (await response.json()) as JobListResponse;
      },
      (result) => {
        const job = result.jobs.find((entry) => entry.labels.includes('workflow:notify'));
        if (!job) return false;
        const gates = (job.hints as { gates?: string[] } | undefined)?.gates ?? [];
        return gates.includes(`remediate:${testProjectId}:staging`);
      },
    );
  }, 20000);

  it('routes pipeline failure events to remediation pipeline', async () => {
    const manifestYaml = `
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
          prompt: "Analyze failure and prepare remediation"
      - name: create-pr
        depends_on: [analyze]
        action:
          type: create-pr
          head: remediation/test
          base: main
          title: "Remediation"
          dry_run: true
`;

    await syncManifest(testProjectId, manifestYaml);

    await emitEvent(testProjectId, {
      type: 'system.pipeline.failed',
      source: 'system',
      ref_sha: gitShaFailure,
      payload_json: { pipeline_name: 'ci-cd-main', error_code: 'pipeline_failed' },
      actor_type: 'system',
      actor_id: 'orchestrator',
    });

    await poll<PipelineRunListResponse>(
      async () => {
        const response = await fetch(`${apiUrl}/projects/${testProjectId}/pipelines/remediation/runs`);
        return (await response.json()) as PipelineRunListResponse;
      },
      (result) => result.data.length > 0,
    );
  }, 20000);

  it('skips pipeline triggers when branch or pipeline name do not match', async () => {
    const manifestYaml = `
services:
  api:
    image: test/api:latest

pipelines:
  deploy:
    trigger:
      github:
        event: push
        branch: main
    steps:
      - action:
          type: build

  remediation:
    trigger:
      system:
        event: pipeline.failed
        pipeline: ci-cd-main
    steps:
      - agent:
          prompt: "Analyze failure and prepare remediation"
`;

    await syncManifest(testProjectId, manifestYaml);

    await emitEvent(testProjectId, {
      type: 'github.push',
      source: 'github',
      ref_sha: gitShaPush,
      ref_branch: 'feature/test',
      actor_type: 'user',
      actor_id: 'testuser',
    });

    await emitEvent(testProjectId, {
      type: 'system.pipeline.failed',
      source: 'system',
      ref_sha: gitShaFailure,
      payload_json: { pipeline_name: 'other-pipeline', error_code: 'pipeline_failed' },
      actor_type: 'system',
      actor_id: 'orchestrator',
    });

    await new Promise(resolve => setTimeout(resolve, 6500));

    const deployRuns = (await fetch(
      `${apiUrl}/projects/${testProjectId}/pipelines/deploy/runs`,
    ).then((response) => response.json())) as PipelineRunListResponse;

    const remediationRuns = (await fetch(
      `${apiUrl}/projects/${testProjectId}/pipelines/remediation/runs`,
    ).then((response) => response.json())) as PipelineRunListResponse;

    expect(deployRuns.data.length).toBe(0);
    expect(remediationRuns.data.length).toBe(0);
  }, 20000);

  it('creates workflow job from cron.tick event', async () => {
    const schedule = '* * * * *';
    const manifestYaml = `
services:
  api:
    image: test/api:latest

workflows:
  nightly-audit:
    trigger:
      cron:
        schedule: "${schedule}"
    steps:
      - agent:
          prompt: "Audit logs"
`;

    await syncManifest(testProjectId, manifestYaml);

    await emitEvent(testProjectId, {
      type: 'cron.tick',
      source: 'cron',
      payload_json: { schedule, trigger_name: 'nightly-audit' },
      actor_type: 'system',
      actor_id: 'scheduler',
    });

    await poll<JobListResponse>(
      async () => {
        const response = await fetch(`${apiUrl}/projects/${testProjectId}/jobs`);
        return (await response.json()) as JobListResponse;
      },
      (result) => result.jobs.some((job) => job.labels.includes('workflow:nightly-audit')),
      40000,
    );
  }, 45000);

  it('extracts PR metadata and creates pipeline run with env_name for pull_request events', async () => {
    const manifestYaml = `
services:
  api:
    image: test/api:latest

pipelines:
  pr-preview:
    trigger:
      github:
        event: pull_request
    steps:
      - action:
          type: build
`;

    await syncManifest(testProjectId, manifestYaml);

    // Emit a github.pull_request event with full PR payload
    await emitEvent(testProjectId, {
      type: 'github.pull_request',
      source: 'github',
      ref_sha: gitShaPr,
      ref_branch: 'feature/new-feature',
      actor_type: 'user',
      actor_id: 'testuser',
      payload_json: {
        action: 'opened',
        pull_request: {
          number: 42,
          html_url: 'https://github.com/test/repo/pull/42',
          head: {
            ref: 'feature/new-feature',
            sha: gitShaPr,
          },
          base: {
            ref: 'main',
          },
        },
        repository: {
          full_name: 'test/repo',
        },
      },
    });

    // Wait for pipeline run to be created
    const runsResult = await poll<PipelineRunListResponse>(
      async () => {
        const response = await fetch(`${apiUrl}/projects/${testProjectId}/pipelines/pr-preview/runs`);
        return (await response.json()) as PipelineRunListResponse;
      },
      (result) => result.data.length > 0,
      40000,
    );

    // Verify the pipeline run was created
    expect(runsResult.data.length).toBeGreaterThan(0);
    const run = runsResult.data[0];

    // Verify env_name is set to pr-42 (computed from PR number)
    expect(run.env_name).toBe('pr-42');

    // Verify inputs contain PR metadata
    const inputs = run.inputs as Record<string, unknown>;
    expect(inputs).toBeDefined();
    expect(inputs.pr_number).toBe(42);
    expect(inputs.pr_branch).toBe('feature/new-feature');
    expect(inputs.pr_sha).toBe(gitShaPr);
    expect(inputs.pr_url).toBe('https://github.com/test/repo/pull/42');
    expect(inputs.pr_action).toBe('opened');
    expect(inputs.base_branch).toBe('main');
    expect(inputs.repo).toBe('test/repo');
    expect(inputs.env_name).toBe('pr-42');
  }, 45000);

  it('extracts PR metadata for synchronize action', async () => {
    const manifestYaml = `
services:
  api:
    image: test/api:latest

pipelines:
  pr-ci:
    trigger:
      github:
        event: pull_request
    steps:
      - action:
          type: build
`;

    await syncManifest(testProjectId, manifestYaml);

    // Emit a github.pull_request event with synchronize action (push to PR branch)
    await emitEvent(testProjectId, {
      type: 'github.pull_request',
      source: 'github',
      ref_sha: gitShaPrSync,
      ref_branch: 'feature/updated-feature',
      actor_type: 'user',
      actor_id: 'testuser',
      payload_json: {
        action: 'synchronize',
        pull_request: {
          number: 99,
          html_url: 'https://github.com/org/project/pull/99',
          head: {
            ref: 'feature/updated-feature',
            sha: gitShaPrSync,
          },
          base: {
            ref: 'develop',
          },
        },
        repository: {
          full_name: 'org/project',
        },
      },
    });

    // Wait for pipeline run to be created
    const runsResult = await poll<PipelineRunListResponse>(
      async () => {
        const response = await fetch(`${apiUrl}/projects/${testProjectId}/pipelines/pr-ci/runs`);
        return (await response.json()) as PipelineRunListResponse;
      },
      (result) => result.data.length > 0,
      40000,
    );

    const run = runsResult.data[0];

    // Verify env_name and inputs
    expect(run.env_name).toBe('pr-99');
    const inputs = run.inputs as Record<string, unknown>;
    expect(inputs.pr_action).toBe('synchronize');
    expect(inputs.base_branch).toBe('develop');
    expect(inputs.repo).toBe('org/project');
  }, 45000);
});
