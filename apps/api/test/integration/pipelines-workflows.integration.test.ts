/**
 * Integration tests for pipeline/workflow list/show endpoints.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { SyncManifestRequest, ManifestResponse, ProjectResponse } from '@eve/shared';

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';
const gitShaPrimary = '1111111111111111111111111111111111111111';
const gitShaSecondary = '2222222222222222222222222222222222222222';
const gitShaTertiary = '3333333333333333333333333333333333333333';
const gitShaQuaternary = '4444444444444444444444444444444444444444';
const gitShaFifth = '5555555555555555555555555555555555555555';
const gitShaSixth = '6666666666666666666666666666666666666666';
const gitShaSeventh = '7777777777777777777777777777777777777777';
const gitShaEighth = '8888888888888888888888888888888888888888';

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

describe('Pipeline/Workflow Manifest Integration Tests', () => {
  let testOrgId: string;
  let testProjectId: string;

  beforeEach(async () => {
    // Use unique prefix that affects slug generation (first 8 alphanumeric chars)
    const uniqueId = Math.random().toString(36).substring(2, 8);

    const org = await ensureOrg(`PipeOrg${uniqueId}`);
    testOrgId = org.id;

    const project = await ensureProject(
      testOrgId,
      `PipeProj${uniqueId}`,
      'https://github.com/test/repo',
      'main',
    );
    testProjectId = project.id;
  });

  it('lists pipelines and workflows from the latest manifest', async () => {
    const manifestYaml = `
name: pipeline-test
services:
  api:
    image: test/api:latest
pipelines:
  release:
    steps:
      - script:
          run: "echo release"
  deploy:
    steps:
      - script:
          run: "echo deploy"
workflows:
  qa-review:
    steps:
      - script:
          run: "echo qa"
  release-notes:
    steps:
      - script:
          run: "echo notes"
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: gitShaPrimary,
      branch: 'main',
    });

    const pipelinesResponse = await fetch(`${apiUrl}/projects/${testProjectId}/pipelines`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(pipelinesResponse.ok).toBe(true);
    const pipelinesBody = (await pipelinesResponse.json()) as { data: { name: string }[] };
    const pipelineNames = pipelinesBody.data.map((p) => p.name);
    expect(pipelineNames).toContain('release');
    expect(pipelineNames).toContain('deploy');

    const workflowsResponse = await fetch(`${apiUrl}/projects/${testProjectId}/workflows`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(workflowsResponse.ok).toBe(true);
    const workflowsBody = (await workflowsResponse.json()) as { data: { name: string }[] };
    const workflowNames = workflowsBody.data.map((w) => w.name);
    expect(workflowNames).toContain('qa-review');
    expect(workflowNames).toContain('release-notes');
  });

  it('shows a pipeline definition by name', async () => {
    const manifestYaml = `
name: pipeline-show-test
services:
  api:
    image: test/api:latest
pipelines:
  release:
    steps:
      - script:
          run: "echo release"
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: gitShaSecondary,
      branch: 'main',
    });

    const response = await fetch(`${apiUrl}/projects/${testProjectId}/pipelines/release`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.ok).toBe(true);
    const body = (await response.json()) as { name: string; definition: { steps: unknown[] } };
    expect(body.name).toBe('release');
    expect(Array.isArray(body.definition.steps)).toBe(true);
  });

  it('shows a workflow definition by name', async () => {
    const manifestYaml = `
name: workflow-show-test
services:
  api:
    image: test/api:latest
workflows:
  qa-review:
    steps:
      - script:
          run: "echo qa"
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: gitShaTertiary,
      branch: 'main',
    });

    const response = await fetch(`${apiUrl}/projects/${testProjectId}/workflows/qa-review`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.ok).toBe(true);
    const body = (await response.json()) as { name: string; definition: { steps: unknown[] } };
    expect(body.name).toBe('qa-review');
    expect(Array.isArray(body.definition.steps)).toBe(true);
  });

  it('materializes workflow script steps as script child jobs', async () => {
    const manifestYaml = `
name: workflow-script-test
services:
  api:
    image: test/api:latest
workflows:
  setup-and-review:
    steps:
      - name: setup
        script:
          run: "echo hello && eve job list --json"
          timeout_seconds: 60
        permissions: ["jobs:read"]
      - name: review
        depends_on: [setup]
        agent:
          prompt: "Review setup output"
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: gitShaQuaternary,
      branch: 'main',
    });

    const invokeResponse = await fetch(`${apiUrl}/projects/${testProjectId}/workflows/setup-and-review/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(invokeResponse.ok).toBe(true);
    const invokeBody = (await invokeResponse.json()) as {
      step_jobs: Array<{ job_id: string; step_name: string; depends_on?: string[] }>;
    };
    const setup = invokeBody.step_jobs.find((step) => step.step_name === 'setup')!;
    const review = invokeBody.step_jobs.find((step) => step.step_name === 'review')!;
    expect(review.depends_on).toEqual(['setup']);

    const [setupResponse, reviewResponse, reviewDepsResponse] = await Promise.all([
      fetch(`${apiUrl}/jobs/${setup.job_id}`, { headers: { 'Content-Type': 'application/json' } }),
      fetch(`${apiUrl}/jobs/${review.job_id}`, { headers: { 'Content-Type': 'application/json' } }),
      fetch(`${apiUrl}/jobs/${review.job_id}/dependencies`, { headers: { 'Content-Type': 'application/json' } }),
    ]);

    expect(setupResponse.ok).toBe(true);
    expect(reviewResponse.ok).toBe(true);
    expect(reviewDepsResponse.ok).toBe(true);

    const setupJob = (await setupResponse.json()) as {
      execution_type: string;
      script_command: string | null;
      script_timeout_seconds: number | null;
      token_permissions: string[] | null;
      harness: string | null;
      assignee: string | null;
    };
    const reviewJob = (await reviewResponse.json()) as { execution_type: string; script_command: string | null };
    const reviewDeps = (await reviewDepsResponse.json()) as { dependencies: Array<{ id: string }> };

    expect(setupJob.execution_type).toBe('script');
    expect(setupJob.script_command).toBe('echo hello && eve job list --json');
    expect(setupJob.script_timeout_seconds).toBe(60);
    expect(setupJob.token_permissions).toEqual(['jobs:read']);
    expect(setupJob.harness).toBeNull();
    expect(setupJob.assignee).toBeNull();
    expect(reviewJob.execution_type).toBe('agent');
    expect(reviewJob.script_command).toBeNull();
    expect(reviewDeps.dependencies.map((dep) => dep.id)).toContain(setup.job_id);
  });

  it('persists resolved app links on env-scoped workflow script jobs', async () => {
    const producerProject = await ensureProject(
      testOrgId,
      `PipeProducer${Math.random().toString(36).substring(2, 8)}`,
      'https://github.com/test/producer',
      'main',
    );

    const producerManifest = `
name: workflow-app-link-producer
services:
  api:
    image: test/api:latest
    ports: [80]
    x-eve:
      api_spec:
        type: openapi
        spec_path: ./openapi.yaml
        auth: eve
environments:
  local: {}
x-eve:
  app_links:
    exports:
      apis:
        observation:
          service: api
          scopes: [observations:read]
          consumers:
            - project: ${testProjectId}
              scopes: [observations:read]
              envs: [local]
`;

    await syncManifest(producerProject.id, {
      yaml: producerManifest,
      git_sha: gitShaEighth,
      branch: 'main',
    });

    const consumerManifest = `
name: workflow-app-link-consumer
services:
  api:
    image: test/api:latest
environments:
  local: {}
x-eve:
  app_links:
    consumes:
      observation:
        project: ${producerProject.id}
        api: observation
        environment: same
        scopes: [observations:read]
        inject_into:
          jobs: true
workflows:
  app-link-script:
    env: local
    steps:
      - name: smoke
        script:
          run: "env | sort | grep '^EVE_APP_LINK_OBSERVATION_'"
`;

    await syncManifest(testProjectId, {
      yaml: consumerManifest,
      git_sha: '9999999999999999999999999999999999999999',
      branch: 'main',
    });

    const invokeResponse = await fetch(`${apiUrl}/projects/${testProjectId}/workflows/app-link-script/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const invokeText = await invokeResponse.text();
    expect(invokeResponse.ok, invokeText).toBe(true);
    const invokeBody = JSON.parse(invokeText) as {
      job_id: string;
      step_jobs: Array<{ job_id: string; step_name: string }>;
    };
    const smoke = invokeBody.step_jobs.find((step) => step.step_name === 'smoke')!;

    const [rootResponse, smokeResponse] = await Promise.all([
      fetch(`${apiUrl}/jobs/${invokeBody.job_id}`, { headers: { 'Content-Type': 'application/json' } }),
      fetch(`${apiUrl}/jobs/${smoke.job_id}`, { headers: { 'Content-Type': 'application/json' } }),
    ]);
    expect(rootResponse.ok).toBe(true);
    expect(smokeResponse.ok).toBe(true);

    const rootJob = (await rootResponse.json()) as {
      env_name: string | null;
      hints: Record<string, unknown>;
    };
    const smokeJob = (await smokeResponse.json()) as {
      env_name: string | null;
      execution_type: string;
      script_command: string | null;
      hints: Record<string, unknown>;
    };
    const rootLinks = rootJob.hints.resolved_app_links as Array<Record<string, unknown>>;
    const smokeLinks = smokeJob.hints.resolved_app_links as Array<Record<string, unknown>>;

    expect(rootJob.env_name).toBe('local');
    expect(smokeJob.env_name).toBe('local');
    expect(smokeJob.execution_type).toBe('script');
    expect(smokeJob.script_command).toBe("env | sort | grep '^EVE_APP_LINK_OBSERVATION_'");
    expect(rootJob.hints.app_links).toEqual(['observation']);
    expect(smokeJob.hints.app_links).toEqual(['observation']);
    expect(rootLinks).toHaveLength(1);
    expect(smokeLinks).toHaveLength(1);
    expect(smokeLinks[0]).toMatchObject({
      alias: 'observation',
      name: 'observation',
      origin: 'app_link',
      producer_project_id: producerProject.id,
      producer_env: 'local',
      scopes: ['observations:read'],
    });
    expect(smokeLinks[0]?.subscription_id).toEqual(expect.stringMatching(/^apls_/));
    expect(smokeLinks[0]?.base_url).toEqual(expect.stringContaining('http://local-api.eve-'));
    expect(smokeLinks[0]?.base_url).toEqual(expect.stringContaining('.svc.cluster.local:80'));
  });

  it('rejects workflows with invalid remediation gate keys', async () => {
    const manifestYaml = `
name: workflow-gate-test
services:
  api:
    image: test/api:latest
workflows:
  bad-gate:
    hints:
      gates: ["remediate:wrong-project:staging"]
    steps:
      - agent:
          prompt: "Analyze"
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: gitShaQuaternary,
      branch: 'main',
    });

    const response = await fetch(`${apiUrl}/projects/${testProjectId}/workflows/bad-gate/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { env: 'staging' } }),
    });

    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
  });

  it('propagates git config from workflow definition to the created job', async () => {
    const manifestYaml = `
name: workflow-git-test
services:
  api:
    image: test/api:latest
workflows:
  sync-docs:
    git:
      ref: main
      commit: auto
      push: on_success
    steps:
      - agent:
          prompt: "Sync docs"
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: gitShaFifth,
      branch: 'main',
    });

    // Invoke the workflow
    const invokeResponse = await fetch(`${apiUrl}/projects/${testProjectId}/workflows/sync-docs/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(invokeResponse.ok).toBe(true);
    const invokeBody = (await invokeResponse.json()) as { job_id: string; status: string };
    expect(invokeBody.job_id).toBeDefined();

    // Fetch the created job and verify git config was propagated
    const jobResponse = await fetch(`${apiUrl}/jobs/${invokeBody.job_id}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(jobResponse.ok).toBe(true);
    const jobBody = (await jobResponse.json()) as { git: { ref: string; commit: string; push: string } | null };
    expect(jobBody.git).not.toBeNull();
    expect(jobBody.git).toEqual({
      ref: 'main',
      commit: 'auto',
      push: 'on_success',
    });
  });

  it('materializes step-level git config on workflow child jobs', async () => {
    const manifestYaml = `
name: workflow-step-git-test
services:
  api:
    image: test/api:latest
workflows:
  make-plan:
    inputs:
      slug:
        required: true
    steps:
      - name: plan
        agent:
          prompt: "Plan"
        git:
          ref_policy: project_default
          branch: "plans/\${inputs.slug}"
          create_branch: if_missing
          commit: required
          push: on_success
      - name: review
        depends_on: [plan]
        agent:
          prompt: "Review"
        git:
          ref_policy: explicit
          ref: "plans/\${inputs.slug}"
          branch: "plans/\${inputs.slug}"
          create_branch: never
          commit: auto
          push: on_success
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: gitShaSeventh,
      branch: 'main',
    });

    const invokeResponse = await fetch(`${apiUrl}/projects/${testProjectId}/workflows/make-plan/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { slug: 'camera-portal-healthz' } }),
    });

    expect(invokeResponse.ok).toBe(true);
    const invokeBody = (await invokeResponse.json()) as {
      step_jobs: Array<{ job_id: string; step_name: string }>;
    };
    const planStep = invokeBody.step_jobs.find((step) => step.step_name === 'plan');
    const reviewStep = invokeBody.step_jobs.find((step) => step.step_name === 'review');
    expect(planStep?.job_id).toBeDefined();
    expect(reviewStep?.job_id).toBeDefined();

    const planResponse = await fetch(`${apiUrl}/jobs/${planStep!.job_id}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    const reviewResponse = await fetch(`${apiUrl}/jobs/${reviewStep!.job_id}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(planResponse.ok).toBe(true);
    expect(reviewResponse.ok).toBe(true);
    const planJob = (await planResponse.json()) as { git: unknown };
    const reviewJob = (await reviewResponse.json()) as { git: unknown };

    expect(planJob.git).toEqual({
      ref_policy: 'project_default',
      branch: 'plans/camera-portal-healthz',
      create_branch: 'if_missing',
      commit: 'required',
      push: 'on_success',
    });
    expect(reviewJob.git).toEqual({
      ref_policy: 'explicit',
      ref: 'plans/camera-portal-healthz',
      branch: 'plans/camera-portal-healthz',
      create_branch: 'never',
      commit: 'auto',
      push: 'on_success',
    });
  });

  it('creates job with git: null when workflow has no git config', async () => {
    const manifestYaml = `
name: workflow-no-git-test
services:
  api:
    image: test/api:latest
workflows:
  simple-workflow:
    steps:
      - agent:
          prompt: "Do something"
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: gitShaSixth,
      branch: 'main',
    });

    const invokeResponse = await fetch(`${apiUrl}/projects/${testProjectId}/workflows/simple-workflow/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(invokeResponse.ok).toBe(true);
    const invokeBody = (await invokeResponse.json()) as { job_id: string; status: string };

    const jobResponse = await fetch(`${apiUrl}/jobs/${invokeBody.job_id}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(jobResponse.ok).toBe(true);
    const jobBody = (await jobResponse.json()) as { git: unknown };
    expect(jobBody.git).toBeNull();
  });

  it('retries a workflow from a failed tail without cloning successful predecessors', async () => {
    const manifestYaml = `
name: workflow-retry-test
services:
  api:
    image: test/api:latest
workflows:
  make-plan:
    inputs:
      slug:
        required: true
    steps:
      - name: plan
        agent:
          prompt: "Plan"
        git:
          ref_policy: project_default
          branch: "plans/\${inputs.slug}"
          create_branch: if_missing
          commit: required
          push: on_success
      - name: review
        depends_on: [plan]
        agent:
          prompt: "Review"
        git:
          ref_policy: explicit
          ref: "plans/\${inputs.slug}"
          branch: "plans/\${inputs.slug}"
          create_branch: never
          commit: auto
          push: on_success
      - name: publish
        depends_on: [review]
        agent:
          prompt: "Publish"
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: '7777777777777777777777777777777777777778',
      branch: 'main',
    });

    const invokeResponse = await fetch(`${apiUrl}/projects/${testProjectId}/workflows/make-plan/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { slug: 'retry-tail' } }),
    });
    expect(invokeResponse.ok).toBe(true);
    const invokeBody = (await invokeResponse.json()) as {
      job_id: string;
      step_jobs: Array<{ job_id: string; step_name: string }>;
    };

    const plan = invokeBody.step_jobs.find((step) => step.step_name === 'plan')!;
    const review = invokeBody.step_jobs.find((step) => step.step_name === 'review')!;
    const publish = invokeBody.step_jobs.find((step) => step.step_name === 'publish')!;

    for (const [jobId, phase, closeReason] of [
      [plan.job_id, 'active', undefined],
      [plan.job_id, 'done', 'planned'],
      [review.job_id, 'active', undefined],
      [review.job_id, 'cancelled', 'transient harness failure'],
      [publish.job_id, 'cancelled', 'Upstream job failed'],
    ] as Array<[string, string, string | undefined]>) {
      const response = await fetch(`${apiUrl}/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase, ...(closeReason ? { close_reason: closeReason } : {}) }),
      });
      expect(response.ok).toBe(true);
    }

    const retryResponse = await fetch(`${apiUrl}/projects/${testProjectId}/workflows/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root_job_id: invokeBody.job_id, from_step: 'review' }),
    });
    const retryText = await retryResponse.text();
    expect(retryResponse.ok, retryText).toBe(true);
    const retryBody = JSON.parse(retryText) as {
      root_job_id: string;
      status: string;
      mode: string;
      retried_steps: Array<{ step_name: string; previous_job_id: string; retry_job_id: string }>;
      superseded_job_ids: string[];
    };

    expect(retryBody.root_job_id).toBe(invokeBody.job_id);
    expect(retryBody.status).toBe('active');
    expect(retryBody.mode).toBe('from');
    expect(retryBody.superseded_job_ids).toEqual([review.job_id, publish.job_id]);
    expect(retryBody.retried_steps.map((step) => step.step_name)).toEqual(['review', 'publish']);

    const retryReview = retryBody.retried_steps.find((step) => step.step_name === 'review')!;
    const retryPublish = retryBody.retried_steps.find((step) => step.step_name === 'publish')!;

    const [oldReviewResponse, newReviewResponse, newPublishDepsResponse, newReviewDepsResponse] = await Promise.all([
      fetch(`${apiUrl}/jobs/${review.job_id}`, { headers: { 'Content-Type': 'application/json' } }),
      fetch(`${apiUrl}/jobs/${retryReview.retry_job_id}`, { headers: { 'Content-Type': 'application/json' } }),
      fetch(`${apiUrl}/jobs/${retryPublish.retry_job_id}/dependencies`, { headers: { 'Content-Type': 'application/json' } }),
      fetch(`${apiUrl}/jobs/${retryReview.retry_job_id}/dependencies`, { headers: { 'Content-Type': 'application/json' } }),
    ]);

    expect(oldReviewResponse.ok).toBe(true);
    expect(newReviewResponse.ok).toBe(true);
    expect(newPublishDepsResponse.ok).toBe(true);
    expect(newReviewDepsResponse.ok).toBe(true);

    const oldReview = (await oldReviewResponse.json()) as { hints: Record<string, unknown> };
    const newReview = (await newReviewResponse.json()) as {
      phase: string;
      git: unknown;
      hints: Record<string, unknown>;
    };
    const newPublishDeps = (await newPublishDepsResponse.json()) as { dependencies: Array<{ id: string }> };
    const newReviewDeps = (await newReviewDepsResponse.json()) as { dependencies: Array<{ id: string }> };

    expect(oldReview.hints.workflow_retry_superseded_by).toBe(retryReview.retry_job_id);
    expect(newReview.phase).toBe('ready');
    expect(newReview.hints.workflow_retry_of).toBe(review.job_id);
    expect(newReview.git).toEqual({
      ref_policy: 'explicit',
      ref: 'plans/retry-tail',
      branch: 'plans/retry-tail',
      create_branch: 'never',
      commit: 'auto',
      push: 'on_success',
    });
    expect(newPublishDeps.dependencies.map((dep) => dep.id)).toContain(retryReview.retry_job_id);
    expect(newPublishDeps.dependencies.map((dep) => dep.id)).not.toContain(review.job_id);
    expect(newReviewDeps.dependencies.map((dep) => dep.id)).toContain(plan.job_id);
  });

  it('retries failed workflow script steps as script jobs', async () => {
    const manifestYaml = `
name: workflow-script-retry-test
services:
  api:
    image: test/api:latest
workflows:
  scripted:
    steps:
      - name: setup
        script:
          run: "echo setup"
          timeout_seconds: 25
`;

    await syncManifest(testProjectId, {
      yaml: manifestYaml,
      git_sha: '8888888888888888888888888888888888888888',
      branch: 'main',
    });

    const invokeResponse = await fetch(`${apiUrl}/projects/${testProjectId}/workflows/scripted/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(invokeResponse.ok).toBe(true);
    const invokeBody = (await invokeResponse.json()) as {
      job_id: string;
      step_jobs: Array<{ job_id: string; step_name: string }>;
    };
    const setup = invokeBody.step_jobs.find((step) => step.step_name === 'setup')!;

    const failResponse = await fetch(`${apiUrl}/jobs/${setup.job_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'cancelled', close_reason: 'script failed' }),
    });
    expect(failResponse.ok).toBe(true);

    const retryResponse = await fetch(`${apiUrl}/projects/${testProjectId}/workflows/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root_job_id: invokeBody.job_id, from_step: 'setup' }),
    });
    const retryText = await retryResponse.text();
    expect(retryResponse.ok, retryText).toBe(true);
    const retryBody = JSON.parse(retryText) as {
      retried_steps: Array<{ step_name: string; retry_job_id: string }>;
    };
    const retrySetup = retryBody.retried_steps.find((step) => step.step_name === 'setup')!;

    const retryJobResponse = await fetch(`${apiUrl}/jobs/${retrySetup.retry_job_id}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(retryJobResponse.ok).toBe(true);
    const retryJob = (await retryJobResponse.json()) as {
      execution_type: string;
      script_command: string | null;
      script_timeout_seconds: number | null;
    };
    expect(retryJob.execution_type).toBe('script');
    expect(retryJob.script_command).toBe('echo setup');
    expect(retryJob.script_timeout_seconds).toBe(25);
  });

  it('returns 404 for missing pipeline or workflow', async () => {
    const response = await fetch(`${apiUrl}/projects/${testProjectId}/pipelines/missing`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);

    const workflowResponse = await fetch(`${apiUrl}/projects/${testProjectId}/workflows/missing`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(workflowResponse.ok).toBe(false);
    expect(workflowResponse.status).toBe(404);
  });
});
