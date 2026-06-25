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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForReceipt(jobId: string, timeoutMs = 90_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;

  while (Date.now() < deadline) {
    const res = await fetch(`${apiUrl}/jobs/${jobId}/receipt`, {
      headers: { 'content-type': 'application/json' },
    });
    lastStatus = res.status;
    if (res.ok) {
      return res.json();
    }
    await sleep(500);
  }

  throw new Error(`Timed out waiting for receipt for job ${jobId} (last status: ${lastStatus})`);
}

describe.skipIf(process.env.EVE_INTEGRATION_USE_REAL_MCLAUDE === 'true')(
  'integration receipt v2 (phase 2/3)',
  () => {
    it('persists and serves an attempt receipt after completion', async () => {
      const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
      const org = JSON.parse(orgRaw) as { id: string };

      const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
      const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

      const unique = Math.random().toString(36).slice(2, 6);
      const projectName = `integration-receiptv2-${Date.now()}`;
      const projectSlug = `rv${unique}`;

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
        'Receipt v2 assembly test (persist receipt_json)',
        '--json',
      ]);
      const job = JSON.parse(jobRaw) as { id: string };

      const wait = await waitForTerminalJobStatus(job.id);
      expect(wait.jobId).toBe(job.id);
      expect(typeof wait.status).toBe('string');
      expect(['succeeded', 'failed']).toContain(wait.status);

      // Receipt persistence is orchestrator-driven and can lag under suite load.
      const receipt = await waitForReceipt(job.id);
      expect(receipt).toBeTruthy();
      expect(receipt.version).toBe(2);
      expect(receipt.scope?.job_id).toBe(job.id);
      expect(receipt.scope?.attempt_id).toMatch(/[0-9a-f-]{36}/);
      expect(receipt.base_cost_usd?.total_usd?.currency).toBe('usd');
      expect(typeof receipt.base_cost_usd?.total_usd?.amount).toBe('string');
      expect(receipt.billed_cost?.total?.currency).toBeTruthy();
    }, 360_000);
  },
);
