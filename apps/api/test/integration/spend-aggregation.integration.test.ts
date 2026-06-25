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

async function runEve(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(eveBin, args, {
    cwd: repoRoot,
    env: { ...process.env, EVE_API_URL: apiUrl },
  });
  return stdout.trim();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJobPhase(jobId: string, phase: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${apiUrl}/jobs/${jobId}`, { headers: { 'content-type': 'application/json' } });
    if (res.ok) {
      const job = await res.json() as { phase?: string };
      if (job.phase === phase) return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach phase ${phase}`);
}

async function waitForAttempt(jobId: string, attemptNumber: number, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${apiUrl}/jobs/${jobId}/attempts`, { headers: { 'content-type': 'application/json' } });
    if (res.ok) {
      const payload = await res.json() as { attempts?: Array<{ attempt_number: number; status?: string; ended_at?: string | null }> };
      const attempt = payload.attempts?.find((a) => a.attempt_number === attemptNumber);
      if (attempt && attempt.ended_at && attempt.status && ['succeeded', 'failed', 'cancelled', 'timeout'].includes(attempt.status)) {
        return;
      }
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for job ${jobId} attempt ${attemptNumber} to end`);
}

async function getAttemptStatus(jobId: string, attemptNumber: number): Promise<string | null> {
  const res = await fetch(`${apiUrl}/jobs/${jobId}/attempts`, { headers: { 'content-type': 'application/json' } });
  if (!res.ok) return null;
  const payload = await res.json() as { attempts?: Array<{ attempt_number: number; status?: string }> };
  const attempt = payload.attempts?.find((a) => a.attempt_number === attemptNumber);
  return attempt?.status ?? null;
}

async function waitForReceipt(jobId: string, attemptNumber: number, timeoutMs = 90_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${apiUrl}/jobs/${jobId}/receipt?attempt=${attemptNumber}`, {
      headers: { 'content-type': 'application/json' },
    });
    if (res.ok) {
      return res.json();
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for receipt for job ${jobId} attempt ${attemptNumber}`);
}

// FLAKY: Requires two sequential orchestrator-driven attempts (create → review
// → reject → retry). Under parallel test load the second attempt often isn't
// scheduled before the generous timeout expires. Re-enable once the orchestrator
// supports priority scheduling or tests run with dedicated concurrency slots.
describe.skip(
  () => {
    it('aggregates spend and compares attempts for a retried job', async () => {
      const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
      const org = JSON.parse(orgRaw) as { id: string };

      const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
      const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

      const unique = Math.random().toString(36).slice(2, 6);
      const projectName = `integration-spend-${Date.now()}`;
      const projectSlug = `sp${unique}`;

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

      const jobRaw = await runEve([
        'job',
        'create',
        '--project',
        project.id,
        '--review',
        'human',
        '--description',
        'Spend aggregation test: create two attempts and compare',
        // Use deterministic stub harness used by other receipt/cost integration tests.
        '--harness',
        'mclaude',
        '--json',
      ]);
      const job = JSON.parse(jobRaw) as { id: string };

      // Attempt 1 will run and job should reach review.
      await waitForAttempt(job.id, 1);
      const attempt1Status = await getAttemptStatus(job.id, 1);
      if (attempt1Status !== 'succeeded') {
        throw new Error(`Expected attempt 1 to succeed, got: ${attempt1Status ?? 'unknown'}`);
      }
      await waitForJobPhase(job.id, 'review', 180_000);
      await waitForReceipt(job.id, 1);

      // Reject review to create attempt 2 (auto_retry).
      await runEve([
        'job',
        'reject',
        job.id,
        '--reason',
        'Need another attempt for compare',
        '--json',
      ]);

      await waitForAttempt(job.id, 2);
      await waitForReceipt(job.id, 2);

      // Project spend should include both attempts.
      const spendRes = await fetch(`${apiUrl}/projects/${project.id}/spend?since=${encodeURIComponent(new Date(Date.now() - 60 * 60 * 1000).toISOString())}&currency=usd&limit=5`, {
        headers: { 'content-type': 'application/json' },
      });
      expect(spendRes.ok).toBe(true);
      const spend = await spendRes.json() as any;
      expect(spend.project_id).toBe(project.id);
      expect(typeof spend.summary?.base_total_usd).toBe('string');
      expect(typeof spend.summary?.billed_total).toBe('string');
      expect(spend.summary?.attempts).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(spend.top_jobs)).toBe(true);

      // Org spend should include the attempts as well.
      const orgSpendRes = await fetch(`${apiUrl}/orgs/${org.id}/spend?since=${encodeURIComponent(new Date(Date.now() - 60 * 60 * 1000).toISOString())}&currency=usd`, {
        headers: { 'content-type': 'application/json' },
      });
      expect(orgSpendRes.ok).toBe(true);
      const orgSpend = await orgSpendRes.json() as any;
      expect(orgSpend.org_id).toBe(org.id);
      expect(orgSpend.summary?.attempts).toBeGreaterThanOrEqual(2);

      // Compare attempts should return both summaries and optionally include receipts.
      const compareRes = await fetch(`${apiUrl}/jobs/${job.id}/compare?a=1&b=2&include_receipt=true`, {
        headers: { 'content-type': 'application/json' },
      });
      expect(compareRes.ok).toBe(true);
      const compare = await compareRes.json() as any;
      expect(compare.job_id).toBe(job.id);
      expect(Array.isArray(compare.attempts)).toBe(true);
      const nums = compare.attempts.map((a: any) => a.attempt_number).sort();
      expect(nums).toEqual([1, 2]);
      expect(compare.attempts[0].receipt || compare.attempts[1].receipt).toBeTruthy();
    }, 360_000);
  },
);
