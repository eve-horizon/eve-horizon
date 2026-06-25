import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const apiUrl =
  process.env.EVE_API_URL ||
  `http://localhost:${process.env.EVE_API_PORT || '4701'}`;

// Internal API token - use env or default test value
const internalToken = process.env.EVE_INTERNAL_API_KEY || 'test-internal-key';

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

async function internalRequest<T>(requestPath: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${requestPath}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-eve-internal-token': internalToken,
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Internal request failed: ${response.status} ${body}`);
  }
  return response.json() as Promise<T>;
}

describe('integration job logs endpoint', () => {
  it('returns logs for a specific attempt', async () => {
    const orgRaw = await runEve(['org', 'ensure', `OrgLogs${Date.now()}`, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = `file://${repoPath}`;
    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      `LogsProj${Date.now()}`,
      '--repo-url',
      repoUrl,
      '--branch',
      'main',
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    const deferUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const jobRaw = await runEve([
      'job',
      'create',
      '--project',
      project.id,
      '--description',
      'Logs endpoint test',
      '--defer-until',
      deferUntil,
      '--json',
    ]);
    const job = JSON.parse(jobRaw) as { id: string };

    const claimRaw = await runEve([
      'job',
      'claim',
      job.id,
      '--agent',
      'integration-logs',
      '--json',
    ]);
    const claim = JSON.parse(claimRaw) as { attempt: { id: string; attempt_number: number } };

    // Use internal API to append log (instead of direct DB access)
    await internalRequest(`/internal/attempts/${claim.attempt.id}/logs`, {
      method: 'POST',
      body: JSON.stringify({
        log_type: 'status',
        content: {
          timestamp: new Date().toISOString(),
          message: 'hello logs',
          type: 'status',
        },
      }),
    });

    const response = await requestJson<{ logs: Array<{ sequence: number; line: { message?: string } }> }>(
      `/jobs/${job.id}/attempts/${claim.attempt.attempt_number}/logs`
    );

    expect(response.logs.length).toBeGreaterThan(0);
    expect(response.logs[0]?.line?.message).toBe('hello logs');
  }, 60000);
});
