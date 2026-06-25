import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const orgNameOrId = process.env.EVE_INTEGRATION_ORG || 'default-test-org';
const projectName = `integration-harness-fields-${Date.now()}`;
const projectSlug = `hfs${Math.random().toString(36).substring(2, 6)}`;
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

describe('integration job harness fields', () => {
  it('creates job with top-level harness fields', async () => {
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

    const job = await requestJson<{
      id: string;
      phase: string;
      harness: string | null;
      harness_profile: string | null;
      harness_options: { variant?: string; model?: string; reasoning_effort?: string } | null;
      hints?: Record<string, unknown>;
    }>(`/projects/${project.id}/jobs`, {
      method: 'POST',
      body: JSON.stringify({
        description: 'Harness fields integration test',
        phase: 'backlog',
        harness: 'mclaude',
        harness_profile: 'primary-reviewer',
        harness_options: {
          variant: 'plan',
          model: 'opus-4.5',
          reasoning_effort: 'high',
        },
      }),
    });

    expect(job.id).toBeTruthy();
    expect(job.phase).toBe('backlog');
    expect(job.harness).toBe('mclaude');
    expect(job.harness_profile).toBe('primary-reviewer');
    expect(job.harness_options?.variant).toBe('plan');
    expect(job.harness_options?.model).toBe('opus-4.5');
    expect(job.harness_options?.reasoning_effort).toBe('high');
    expect(job.hints?.harness).toBeUndefined();
  }, 60_000);
});
