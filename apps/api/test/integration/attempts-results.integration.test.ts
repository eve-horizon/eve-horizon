import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const orgNameOrId = process.env.EVE_INTEGRATION_ORG || 'default-test-org';
const projectName = `integration-attempts-${Date.now()}`;
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

async function requestJson<T>(requestPath: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${requestPath}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<T>;
}

describe('integration attempts and results', () => {
  it('lists attempts and returns results for cancelled attempts', async () => {
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
      projectName,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    // Far-future defer_until keeps the orchestrator from claiming the job before the test
    // claims it manually (claim queries exclude deferred jobs; manual claim ignores it).
    const jobRaw = await runEve([
      'job',
      'create',
      '--project',
      project.id,
      '--description',
      'Attempt/result integration test',
      '--defer-until',
      new Date(Date.now() + 3_600_000).toISOString(),
      '--json',
    ]);
    const job = JSON.parse(jobRaw) as { id: string };

    const claim = await requestJson<{ attempt: { id: string; attempt_number: number; status: string } }>(
      `/jobs/${job.id}/claim`,
      {
        method: 'POST',
        body: JSON.stringify({ agent_id: 'integration-attempts' }),
      },
    );
    expect(claim.attempt.status).toBe('running');

    await requestJson<{ job: { id: string; phase: string } }>(`/jobs/${job.id}/release`, {
      method: 'POST',
      body: JSON.stringify({ agent_id: 'integration-attempts', reason: 'Integration release' }),
    });

    const attempts = await requestJson<{
      attempts: Array<{ attempt_number: number; status: string; job_id: string }>;
    }>(`/jobs/${job.id}/attempts`);

    expect(attempts.attempts.length).toBe(1);
    expect(attempts.attempts[0]?.attempt_number).toBe(1);
    expect(attempts.attempts[0]?.status).toBe('cancelled');
    expect(attempts.attempts[0]?.job_id).toBe(job.id);

    const result = await requestJson<{
      jobId: string;
      attemptNumber: number;
      status: string;
      resultText: string | null;
    }>(`/jobs/${job.id}/result`);

    expect(result.jobId).toBe(job.id);
    expect(result.attemptNumber).toBe(1);
    expect(result.status).toBe('cancelled');
    expect(result.resultText).toBeNull();
  }, 60_000);
});
