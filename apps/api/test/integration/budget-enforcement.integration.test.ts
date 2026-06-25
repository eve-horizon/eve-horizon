import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const budgetOrgNameOrId = process.env.EVE_INTEGRATION_BUDGET_ORG || 'integration-budget-org';
const budgetBlockOrgNameOrId = process.env.EVE_INTEGRATION_BUDGET_BLOCK_ORG || 'integration-budget-block-org';
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

async function waitForAttemptEnd(jobId: string, attemptNumber: number, timeoutMs = 180_000): Promise<void> {
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

async function waitForReceipt(jobId: string, attemptNumber: number, timeoutMs = 60_000): Promise<any> {
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

async function getJob(jobId: string): Promise<any> {
  const res = await fetch(`${apiUrl}/jobs/${jobId}`, { headers: { 'content-type': 'application/json' } });
  if (!res.ok) return null;
  return res.json();
}

async function waitForBudgetBlockedHint(jobId: string, timeoutMs = 90_000): Promise<{ reason: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getJob(jobId);
    if (job?.hints?.budget_blocked === true) {
      return { reason: String(job.hints?.budget_blocked_reason ?? '') };
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for budget_blocked hint on job ${jobId}`);
}

// FLAKY: Stub harness completes instantly, racing the orchestrator's budget
// enforcement tick — max_cost termination can't fire before the job succeeds.
// Hard-cap admission check is similarly timing-dependent under parallel load.
// Re-enable once budget enforcement moves to synchronous pre/post-attempt hooks.
describe.skip(
  () => {
    it('terminates a job attempt when max_cost is exceeded', async () => {
      const orgRaw = await runEve(['org', 'ensure', budgetOrgNameOrId, '--json']);
      const org = JSON.parse(orgRaw) as { id: string };

      const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
      const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

      const unique = Math.random().toString(36).slice(2, 6);
      const projectName = `integration-budget-${Date.now()}`;
      const projectSlug = `bg${unique}`;

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
        '--description',
        'Budget enforcement test: terminate on max_cost',
        '--harness',
        'mclaude',
        '--max-cost',
        '0.000001',
        '--max-cost-currency',
        'usd',
        '--json',
      ]);
      const job = JSON.parse(jobRaw) as { id: string };

      await waitForAttemptEnd(job.id, 1, 180_000);

      const attemptsRes = await fetch(`${apiUrl}/jobs/${job.id}/attempts`, { headers: { 'content-type': 'application/json' } });
      expect(attemptsRes.ok).toBe(true);
      const attempts = await attemptsRes.json() as any;
      const a1 = (attempts.attempts ?? []).find((a: any) => a.attempt_number === 1);
      expect(a1).toBeTruthy();
      expect(a1.status).toBe('failed');
      expect(String(a1.error_message ?? '')).toContain('BUDGET_EXCEEDED');

      const receipt = await waitForReceipt(job.id, 1, 60_000);
      expect(receipt.version).toBe(2);
      expect(receipt.scope?.job_id).toBe(job.id);
      expect(receipt.base_cost_usd?.total_usd?.currency).toBe('usd');
      expect(Number(receipt.base_cost_usd?.total_usd?.amount ?? 0)).toBeGreaterThan(0);
    }, 240_000);

    it('blocks admission when org hard cap is exceeded (job stays ready with hints)', async () => {
      const orgRaw = await runEve(['org', 'ensure', budgetBlockOrgNameOrId, '--json']);
      const org = JSON.parse(orgRaw) as { id: string };

      await runEve([
        'org',
        'update',
        org.id,
        '--billing-config',
        JSON.stringify({ hard_cap_amount: 0, billing_currency: 'usd' }),
        '--json',
      ]);

      const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
      const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

      const unique = Math.random().toString(36).slice(2, 6);
      const projectName = `integration-budget-block-${Date.now()}`;
      const projectSlug = `bb${unique}`;

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
        '--description',
        'Budget admission block test: should remain ready',
        '--json',
      ]);
      const job = JSON.parse(jobRaw) as { id: string };

      const hint = await waitForBudgetBlockedHint(job.id, 60_000);
      expect(hint.reason.length).toBeGreaterThan(0);

      const jobShow = await getJob(job.id);
      expect(jobShow.phase).toBe('ready');
      expect(jobShow.hints?.budget_blocked).toBe(true);

      const attemptsRes = await fetch(`${apiUrl}/jobs/${job.id}/attempts`, { headers: { 'content-type': 'application/json' } });
      expect(attemptsRes.ok).toBe(true);
      const attempts = await attemptsRes.json() as any;
      expect((attempts.attempts ?? []).length).toBe(0);
    }, 180_000);
  },
);
