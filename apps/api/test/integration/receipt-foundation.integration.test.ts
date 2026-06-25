import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const orgNameOrId = process.env.EVE_INTEGRATION_ORG || 'default-test-org';
const repoBranch = process.env.EVE_INTEGRATION_REPO_BRANCH || 'main';

const apiUrl =
  process.env.EVE_API_URL ||
  `http://localhost:${process.env.EVE_API_PORT || '4701'}`;
const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

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

async function waitForTerminalJobStatus(
  jobId: string,
  timeoutMs = 300_000,
): Promise<{ jobId: string; status: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'timeout';

  while (Date.now() < deadline) {
    const remainingSeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    const waitTimeoutSeconds = Math.min(30, remainingSeconds);
    const waitResponse = await fetch(`${apiUrl}/jobs/${jobId}/wait?timeout=${waitTimeoutSeconds}`, {
      headers: { 'content-type': 'application/json' },
    });
    if (!waitResponse.ok) {
      const body = await waitResponse.text();
      throw new Error(`Wait failed: ${waitResponse.status} ${body}`);
    }

    const wait = await waitResponse.json() as { jobId?: string; status?: string };
    lastStatus = wait.status ?? 'unknown';

    if (wait.jobId === jobId && wait.status && TERMINAL_JOB_STATUSES.has(wait.status)) {
      return { jobId: wait.jobId, status: wait.status };
    }
  }

  throw new Error(`Timed out waiting for job ${jobId} to finish (last status: ${lastStatus})`);
}

describe.skipIf(process.env.EVE_INTEGRATION_USE_REAL_MCLAUDE === 'true')(
  'integration receipt foundation (phase 0)',
  () => {
    it('sets jobs.ready_at on create and on transition to ready', async () => {
      const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
      const org = JSON.parse(orgRaw) as { id: string };

      const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
      const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

      const unique = Math.random().toString(36).slice(2, 6);
      const projectName = `integration-readyat-${Date.now()}`;
      const projectSlug = `ra${unique}`;

      const projectRaw = await runEve([
        'project',
        'ensure',
        '--org',
        org.id,
        '--name',
        projectName,
        '--slug',
        projectSlug,
        '--repo-url',
        repoUrl,
        '--branch',
        repoBranch,
        '--force',
        '--json',
      ]);
      const project = JSON.parse(projectRaw) as { id: string };

      // Created in ready phase by default -> ready_at should be set.
      const readyJobRaw = await runEve([
        'job',
        'create',
        '--project',
        project.id,
        '--description',
        'Receipt foundation test (ready_at on create)',
        '--json',
      ]);
      const readyJob = JSON.parse(readyJobRaw) as { id: string; phase: string; ready_at: string | null };

      expect(readyJob.phase).toBe('ready');
      expect(typeof readyJob.ready_at).toBe('string');

      // Created in backlog -> ready_at should remain null until transitioned to ready.
      const backlogJobRaw = await runEve([
        'job',
        'create',
        '--project',
        project.id,
        '--description',
        'Receipt foundation test (ready_at transition)',
        '--phase',
        'backlog',
        '--json',
      ]);
      const backlogJob = JSON.parse(backlogJobRaw) as { id: string; phase: string; ready_at: string | null };

      expect(backlogJob.phase).toBe('backlog');
      expect(backlogJob.ready_at).toBeNull();

      const toReadyRaw = await runEve([
        'job',
        'update',
        backlogJob.id,
        '--phase',
        'ready',
        '--json',
      ]);
      const toReady = JSON.parse(toReadyRaw) as { id: string; phase: string; ready_at: string | null };
      expect(toReady.phase).toBe('ready');
      expect(typeof toReady.ready_at).toBe('string');
    }, 60_000);

    it('sets job_attempts.execution_started_at when worker begins execution', async () => {
      const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
      const org = JSON.parse(orgRaw) as { id: string };

      const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
      const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

      const unique = Math.random().toString(36).slice(2, 6);
      const projectName = `integration-execstart-${Date.now()}`;
      const projectSlug = `es${unique}`;

      const projectRaw = await runEve([
        'project',
        'ensure',
        '--org',
        org.id,
        '--name',
        projectName,
        '--slug',
        projectSlug,
        '--repo-url',
        repoUrl,
        '--branch',
        repoBranch,
        '--force',
        '--json',
      ]);
      const project = JSON.parse(projectRaw) as { id: string };

      // Create a job in ready phase so the orchestrator will execute it via the worker.
      const jobRaw = await runEve([
        'job',
        'create',
        '--project',
        project.id,
        '--description',
        'Receipt foundation test (execution_started_at)',
        '--harness',
        'mclaude',
        '--execution-mode',
        'ephemeral',
        '--json',
      ]);
      const job = JSON.parse(jobRaw) as { id: string };

      // Wait for the job to complete (orchestrator -> worker).
      const wait = await waitForTerminalJobStatus(job.id);
      expect(wait.jobId).toBe(job.id);
      expect(typeof wait.status).toBe('string');
      expect(['succeeded', 'failed']).toContain(wait.status);

      const attempts = await requestJson<{
        attempts: Array<{ attempt_number: number; status: string; execution_started_at?: string | null }>;
      }>(`/jobs/${job.id}/attempts`);

      expect(attempts.attempts.length).toBeGreaterThan(0);
      const latest = attempts.attempts[attempts.attempts.length - 1];
      expect(latest.attempt_number).toBe(1);
      expect(['succeeded', 'failed']).toContain(latest.status);
      expect(
        latest.execution_started_at === null || typeof latest.execution_started_at === 'string'
      ).toBe(true);
    }, 360_000);
  },
);
