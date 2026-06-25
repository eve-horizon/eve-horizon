import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
// Use the CLI package (runtime commands) not bin/eh (dev helpers)
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const orgNameOrId = process.env.EVE_INTEGRATION_ORG || 'integration-review-org';
const projectName = `integration-review-${Date.now()}`;
const repoBranch = process.env.EVE_INTEGRATION_REPO_BRANCH || 'main';

const apiUrl =
  process.env.EVE_API_URL ||
  `http://localhost:${process.env.EVE_API_PORT || '4701'}`;
const deferUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();

async function runEve(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(eveBin, args, {
    cwd: repoRoot,
    env: { ...process.env, EVE_API_URL: apiUrl },
  });
  return stdout.trim();
}

describe('integration job review + cancel flow', () => {
  let projectId: string;

  beforeAll(async () => {
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
    projectId = project.id;
  }, 60_000);

  async function createJob(description: string): Promise<{ id: string; phase: string }> {
    const jobRaw = await runEve([
      'job',
      'create',
      '--project',
      projectId,
      '--description',
      description,
      '--defer-until',
      deferUntil,
      '--json',
    ]);
    return JSON.parse(jobRaw) as { id: string; phase: string };
  }

  async function claimJob(jobId: string): Promise<{ attempt: { id: string; status: string } }> {
    const claimRaw = await runEve([
      'job',
      'claim',
      jobId,
      '--agent',
      'integration-review-test',
      '--json',
    ]);
    return JSON.parse(claimRaw) as { attempt: { id: string; status: string } };
  }

  it('submits a job for review and approves it', async () => {
    const job = await createJob('Review approval happy path');
    expect(job.phase).toBe('ready');

    const claim = await claimJob(job.id);
    expect(claim.attempt.status).toBe('running');

    const submitRaw = await runEve([
      'job',
      'submit',
      job.id,
      '--summary',
      'Completed work for approval',
      '--json',
    ]);
    const submitted = JSON.parse(submitRaw) as {
      id: string;
      phase: string;
      review_status: string | null;
    };

    expect(submitted.id).toBe(job.id);
    expect(submitted.phase).toBe('review');
    expect(submitted.review_status).toBe('pending');

    const approveRaw = await runEve([
      'job',
      'approve',
      job.id,
      '--comment',
      'LGTM',
      '--json',
    ]);
    const approved = JSON.parse(approveRaw) as {
      phase: string;
      review_status: string | null;
      reviewer: string | null;
      close_reason: string | null;
    };

    expect(approved.phase).toBe('done');
    expect(approved.review_status).toBe('approved');
    expect(approved.reviewer).toBe('cli-user');
    expect(approved.close_reason).toBe('LGTM');
  }, 60_000);

  it('submits a job for review and rejects it', async () => {
    const job = await createJob('Review rejection happy path');
    expect(job.phase).toBe('ready');

    const claim = await claimJob(job.id);
    expect(claim.attempt.status).toBe('running');

    const submitRaw = await runEve([
      'job',
      'submit',
      job.id,
      '--summary',
      'Needs another pass',
      '--json',
    ]);
    const submitted = JSON.parse(submitRaw) as {
      phase: string;
      review_status: string | null;
    };

    expect(submitted.phase).toBe('review');
    expect(submitted.review_status).toBe('pending');

    const rejectRaw = await runEve([
      'job',
      'reject',
      job.id,
      '--reason',
      'Missing tests',
      '--json',
    ]);
    const rejected = JSON.parse(rejectRaw) as {
      phase: string;
      review_status: string | null;
      reviewer: string | null;
    };

    expect(rejected.phase).toBe('active');
    expect(rejected.review_status).toBe('rejected');
    expect(rejected.reviewer).toBe('cli-user');

    const attemptsRaw = await runEve(['job', 'attempts', job.id, '--json']);
    const attemptsResponse = JSON.parse(attemptsRaw) as {
      attempts: Array<{
        attempt_number: number;
        status: string;
        trigger_type: string;
      }>;
    };

    expect(attemptsResponse.attempts.length).toBe(2);

    const latest = attemptsResponse.attempts[0];
    const initial = attemptsResponse.attempts[1];

    expect(latest.status).toBe('pending');
    expect(latest.trigger_type).toBe('auto_retry');
    expect(latest.attempt_number).toBeGreaterThan(initial.attempt_number);
    expect(initial.status).toBe('succeeded');
  }, 60_000);

  it('cancels a job with a reason', async () => {
    const job = await createJob('Cancellation happy path');
    expect(job.phase).toBe('ready');

    const cancelRaw = await runEve([
      'job',
      'cancel',
      job.id,
      '--reason',
      'No longer needed',
      '--json',
    ]);
    const cancelled = JSON.parse(cancelRaw) as {
      phase: string;
      close_reason: string | null;
    };

    expect(cancelled.phase).toBe('cancelled');
    expect(cancelled.close_reason).toBe('No longer needed');
  }, 60_000);
});
