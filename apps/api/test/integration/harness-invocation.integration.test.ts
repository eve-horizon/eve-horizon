/**
 * Harness Invocation Integration Tests
 *
 * Tests real harness execution via the worker service in docker mode.
 * Only runs when EVE_INTEGRATION_USE_REAL_MCLAUDE=true (typically in docker stack).
 *
 * For each harness, verifies:
 * 1. Auth credentials are available (skips if missing)
 * 2. Job creation and claim work
 * 3. Worker invocation completes successfully
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  HARNESS_CANONICAL_NAMES,
  getHarnessAuthStatus,
  type HarnessCanonicalName,
} from '@eve/shared';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const orgNameOrId = process.env.EVE_INTEGRATION_ORG || 'harness-invocation-test-org';
const projectName = process.env.EVE_INTEGRATION_PROJECT_NAME || 'harness-invocation-test';
const repoBranch = process.env.EVE_INTEGRATION_REPO_BRANCH || 'main';

const apiUrl =
  process.env.EVE_API_URL ||
  `http://localhost:${process.env.EVE_API_PORT || '4701'}`;

const workerUrl =
  process.env.WORKER_URL ||
  `http://localhost:${process.env.EVE_WORKER_PORT || '4711'}`;

// Simple test prompt - should complete quickly
const TEST_PROMPT = 'Say "Hello from harness test" and exit immediately. Do not do anything else.';

// Timeout per harness invocation (3 minutes should be plenty for a simple hello)
const HARNESS_TIMEOUT_MS = 180_000;

// Overall test timeout (allow time for all harnesses)
const SUITE_TIMEOUT_MS = 600_000;

interface Job {
  id: string;
  project_id: string;
  phase: string;
  title: string;
}

interface JobAttempt {
  id: string;
  job_id: string;
  attempt_number: number;
  status: string;
}

interface LogsResponse {
  logs: Array<{ type: string; content: { meta?: Record<string, unknown> } }>;
}

interface HarnessInvocation {
  attemptId: string;
  jobId: string;
  projectId: string;
  text: string;
  workspacePath: string;
  repoUrl?: string;
  repoBranch?: string;
  harness?: string;
  variant?: string;
  permission?: string;
}

interface HarnessResult {
  attemptId: string;
  success: boolean;
  exitCode: number;
  error?: string;
}

async function runEve(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(eveBin, args, {
    cwd: repoRoot,
    env: { ...process.env, EVE_API_URL: apiUrl },
    timeout: 30_000,
  });
  return stdout.trim();
}

async function invokeWorker(invocation: HarnessInvocation): Promise<HarnessResult> {
  const response = await fetch(`${workerUrl}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(invocation),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    return {
      attemptId: invocation.attemptId,
      success: false,
      exitCode: 1,
      error: `Worker returned ${response.status}: ${errorText}`,
    };
  }

  return response.json();
}

async function requestJson<T>(requestPath: string): Promise<T> {
  const response = await fetch(`${apiUrl}${requestPath}`, {
    headers: { 'content-type': 'application/json' },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<T>;
}

function findHarnessOptions(logs: LogsResponse['logs']): Record<string, unknown> | undefined {
  for (const log of logs) {
    const meta = log.content?.meta;
    if (meta && typeof meta.harness_options === 'object' && meta.harness_options !== null) {
      return meta.harness_options as Record<string, unknown>;
    }
  }
  return undefined;
}

/**
 * Checks if the required auth for a harness is available.
 * Uses the same logic as @eve/shared/harnesses/auth.ts
 */
function isHarnessAuthAvailable(harness: HarnessCanonicalName): { available: boolean; reason: string } {
  const status = getHarnessAuthStatus(harness);
  return { available: status.available, reason: status.reason };
}

describe.skipIf(process.env.EVE_INTEGRATION_USE_REAL_MCLAUDE !== 'true')(
  'integration harness invocation',
  () => {
    let orgId: string;
    let projectId: string;
    let projectRepoUrl: string;

    beforeAll(async () => {
      // Setup org
      const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
      const org = JSON.parse(orgRaw) as { id: string; name: string };
      orgId = org.id;

      // Setup project with the e2e fixture repo
      const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
      projectRepoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

      const projectRaw = await runEve([
        'project',
        'ensure',
        '--org',
        orgId,
        '--name',
        projectName,
        '--repo-url',
        projectRepoUrl,
        '--branch',
        repoBranch,
        '--force',
        '--json',
      ]);
      const project = JSON.parse(projectRaw) as { id: string };
      projectId = project.id;

      // Configure git auth secret if using GitHub URL and token is available
      const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      const isGitHubUrl = projectRepoUrl.includes('github.com');
      if (isGitHubUrl && githubToken) {
        console.log('Configuring GITHUB_TOKEN secret for private repo access');
        try {
          await runEve([
            'secrets',
            'set',
            '--project',
            projectId,
            '--key',
            'GITHUB_TOKEN',
            '--value',
            githubToken,
            '--type',
            'github_token',
            '--json',
          ]);
        } catch (err) {
          console.warn('Failed to set GITHUB_TOKEN secret:', err);
        }
      } else if (isGitHubUrl) {
        console.warn(
          'Warning: Using GitHub URL without GITHUB_TOKEN - private repos will fail to clone',
        );
      }
    }, 60_000);

    // Test each canonical harness
    const harnessesToTest: HarnessCanonicalName[] = [
      'mclaude',
    ];

    for (const harness of harnessesToTest) {
      it(
        `invokes ${harness} harness and completes successfully`,
        async () => {
          // Check auth availability
          const authCheck = isHarnessAuthAvailable(harness);
          if (!authCheck.available) {
            console.log(`Skipping ${harness}: ${authCheck.reason}`);
            return;
          }
          console.log(`Testing ${harness}: ${authCheck.reason}`);

          const variant = 'plan';

          // Create a job for this harness test
          const jobRaw = await runEve([
            'job',
            'create',
            '--project',
            projectId,
            '--description',
            `${TEST_PROMPT} (harness: ${harness})`,
            '--json',
          ]);
          const job = JSON.parse(jobRaw) as Job;
          expect(job.id).toBeTruthy();
          expect(job.phase).toBe('ready');

          // Claim the job to create an attempt
          const claimRaw = await runEve([
            'job',
            'claim',
            job.id,
            '--agent',
            `integration-harness-test-${harness}`,
            '--harness',
            `${harness}:${variant}`,
            '--json',
          ]);
          const claimResult = JSON.parse(claimRaw) as { attempt: JobAttempt };
          expect(claimResult.attempt).toBeTruthy();
          expect(claimResult.attempt.status).toBe('running');

          const attemptId = claimResult.attempt.id;

          // Verify job is now active
          const showRaw = await runEve(['job', 'show', job.id, '--json']);
          const shownJob = JSON.parse(showRaw) as Job;
          expect(shownJob.phase).toBe('active');

          // Create workspace path for the attempt
          const workspaceRoot = process.env.WORKSPACE_ROOT || '/opt/eve/workspaces';
          const workspacePath = path.join(workspaceRoot, attemptId);

          // Invoke the worker with the harness
          const invocation: HarnessInvocation = {
            attemptId,
            jobId: job.id,
            projectId,
            text: TEST_PROMPT,
            workspacePath,
            repoUrl: projectRepoUrl,
            repoBranch: 'main',
            harness,
            variant,
            permission: 'default',
          };

          console.log(`Invoking ${harness} via worker...`);
          const result = await invokeWorker(invocation);

          console.log(`${harness} result: success=${result.success}, exitCode=${result.exitCode}`);
          if (result.error) {
            console.log(`${harness} error: ${result.error}`);
          }

          // Verify the harness completed successfully
          expect(result.attemptId).toBe(attemptId);
          expect(result.success).toBe(true);
          expect(result.exitCode).toBe(0);

          const logsAfter = await requestJson<LogsResponse>(
            `/projects/${projectId}/jobs/${job.id}/attempts/1/logs`,
          );
          const optionsAfter = findHarnessOptions(logsAfter.logs);
          expect(optionsAfter?.variant).toBe(variant);

          // Close the job
          await runEve([
            'job',
            'close',
            job.id,
            '--reason',
            `${harness} harness test completed`,
            '--json',
          ]);
        },
        HARNESS_TIMEOUT_MS,
      );
    }
  },
  SUITE_TIMEOUT_MS,
);
