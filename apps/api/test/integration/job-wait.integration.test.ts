import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const orgNameOrId = process.env.EVE_INTEGRATION_ORG || 'default-test-org';
const uniqueId = Date.now();
// Use short unique prefixes to avoid slug collisions (slug = first 8 chars)
const projectNames = {
  done: `WaitDone${uniqueId}`,
  timeout: `WaitTout${uniqueId}`,
  cancelled: `WaitCanx${uniqueId}`,
  reason: `WaitRsn${uniqueId}`,
};
const repoBranch = process.env.EVE_INTEGRATION_REPO_BRANCH || 'main';

const apiUrl =
  process.env.EVE_API_URL ||
  `http://localhost:${process.env.EVE_API_PORT || '4701'}`;

async function runEve(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(eveBin, args, {
    cwd: repoRoot,
    env: { ...process.env, EVE_API_URL: apiUrl },
  });
  return stdout.trim();
}

async function request(requestPath: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiUrl}${requestPath}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  });
}

describe('integration job wait endpoint', () => {
  it('returns completion result when job is done', async () => {
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      projectNames.done,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    // Far-future defer_until keeps the orchestrator from claiming this job before the test
    // drives it manually (claim -> submit -> approve -> done). Claim queries exclude
    // deferred jobs; manual claim/submit/approve ignore defer_until.
    const jobRaw = await runEve([
      'job',
      'create',
      '--project',
      project.id,
      '--description',
      'Job wait endpoint test',
      '--defer-until',
      new Date(Date.now() + 3_600_000).toISOString(),
      '--json',
    ]);
    const job = JSON.parse(jobRaw) as { id: string };

    await request(`/jobs/${job.id}/claim`, {
      method: 'POST',
      body: JSON.stringify({ agent_id: 'integration-wait' }),
    });

    await runEve([
      'job',
      'submit',
      job.id,
      '--summary',
      'Ready for review',
      '--json',
    ]);

    await runEve([
      'job',
      'approve',
      job.id,
      '--comment',
      'approved for wait test',
      '--json',
    ]);

    const response = await request(`/jobs/${job.id}/wait?timeout=1`);
    expect(response.status).toBe(200);
    const result = await response.json() as {
      jobId?: string;
      attemptNumber?: number;
      status?: string;
    };

    expect(result.jobId).toBe(job.id);
    expect(result.attemptNumber).toBe(1);
    expect(result.status).toBe('succeeded');
  }, 60000);

  it('returns timeout when job is not complete', async () => {
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      projectNames.timeout,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    // Far-future defer_until keeps the orchestrator from claiming (and completing)
    // the job during the wait window, so the 202/timeout outcome is deterministic.
    const jobRaw = await runEve([
      'job',
      'create',
      '--project',
      project.id,
      '--description',
      'Job wait timeout test',
      '--defer-until',
      new Date(Date.now() + 3_600_000).toISOString(),
      '--json',
    ]);
    const job = JSON.parse(jobRaw) as { id: string };

    const response = await request(`/jobs/${job.id}/wait?timeout=1`);
    expect(response.status).toBe(202);
    const result = await response.json() as {
      jobId: string;
      status: string;
      phase: string;
    };

    expect(result.jobId).toBe(job.id);
    expect(result.status).toBe('timeout');
    expect(result.phase).toBe('ready');
  }, 60000);

  it('returns immediately when job is cancelled (fail-fast)', async () => {
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      projectNames.cancelled,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    // Create a job. Far-future defer_until keeps the orchestrator from claiming it in the
    // window before the test cancels it (claim queries exclude deferred jobs; manual
    // cancel ignores defer_until), so the cancelled-state assertions stay deterministic.
    const jobRaw = await runEve([
      'job',
      'create',
      '--project',
      project.id,
      '--description',
      'Job wait cancelled test',
      '--defer-until',
      new Date(Date.now() + 3_600_000).toISOString(),
      '--json',
    ]);
    const job = JSON.parse(jobRaw) as { id: string };

    // Cancel the job immediately
    await runEve([
      'job',
      'cancel',
      job.id,
      '--reason',
      'Cancelled for fail-fast test',
      '--json',
    ]);

    // Wait should return immediately with status 200 (completed)
    const response = await request(`/jobs/${job.id}/wait?timeout=30`);
    expect(response.status).toBe(200);
    const result = await response.json() as {
      jobId?: string;
      status?: string;
      exitCode?: number;
    };

    expect(result.jobId).toBe(job.id);
    expect(result.status).toBe('cancelled');
    expect(result.exitCode).toBe(1);
  }, 60000);

  it('returns immediately when job is cancelled with failure reason (fail-fast)', async () => {
    // Note: Eve Horizon represents job "failures" as cancelled jobs with a close_reason
    // The 'failed' status is for attempts, not job phases
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      projectNames.reason,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    // Create a job. Far-future defer_until keeps the orchestrator from claiming it before
    // the test moves it to cancelled (claim queries exclude deferred jobs; manual updates
    // ignore defer_until).
    const jobRaw = await runEve([
      'job',
      'create',
      '--project',
      project.id,
      '--description',
      'Job wait cancelled with reason test',
      '--defer-until',
      new Date(Date.now() + 3_600_000).toISOString(),
      '--json',
    ]);
    const job = JSON.parse(jobRaw) as { id: string };

    // Update job to cancelled phase with a failure reason
    await request(`/jobs/${job.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        phase: 'cancelled',
        close_reason: 'Cancelled due to failure',
      }),
    });

    // Wait should return immediately with status 200 (completed)
    const response = await request(`/jobs/${job.id}/wait?timeout=30`);
    expect(response.status).toBe(200);
    const result = await response.json() as {
      jobId?: string;
      status?: string;
      exitCode?: number;
      errorMessage?: string;
    };

    expect(result.jobId).toBe(job.id);
    expect(result.status).toBe('cancelled');
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe('Cancelled due to failure');
  }, 60000);
});
