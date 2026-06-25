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

describe('integration job waiting requeue', () => {
  it('requeues to ready while remaining blocked by waits_for', async () => {
    const orgRaw = await runEve(['org', 'ensure', `OrgWaiting${Date.now()}`, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = `file://${repoPath}`;
    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      `WaitingProj${Date.now()}`,
      '--repo-url',
      repoUrl,
      '--branch',
      'main',
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    const parentRaw = await runEve([
      'job',
      'create',
      '--project',
      project.id,
      '--description',
      'Parent waiting job',
      '--json',
    ]);
    const parent = JSON.parse(parentRaw) as { id: string };

    const childRaw = await runEve([
      'job',
      'create',
      '--project',
      project.id,
      '--description',
      'Child waiting job',
      '--json',
    ]);
    const child = JSON.parse(childRaw) as { id: string };

    await requestJson(`/jobs/${parent.id}/dependencies`, {
      method: 'POST',
      body: JSON.stringify({ related_job_id: child.id, relation_type: 'waits_for' }),
    });

    const claimResponse = await requestJson<{ attempt: { id: string } }>(`/jobs/${parent.id}/claim`, {
      method: 'POST',
      body: JSON.stringify({ agent_id: 'integration-waiting' }),
    });

    // Use internal APIs to update attempt and requeue (instead of direct DB access)
    // 1. Update the attempt to succeeded with waiting result
    await internalRequest(`/internal/attempts/${claimResponse.attempt.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'succeeded',
        result_json: { eve: { status: 'waiting' } },
      }),
    });

    // 2. Requeue the job to ready phase
    await internalRequest(`/internal/jobs/${parent.id}/requeue`, {
      method: 'POST',
      body: JSON.stringify({
        agent_id: 'integration-test',
        reason: 'waiting on child job',
      }),
    });

    const context = await requestJson<{
      job: { id: string; phase: string; assignee: string | null };
      blocked: boolean;
      waiting: boolean;
      effective_phase: string;
    }>(`/jobs/${parent.id}/context`);

    expect(context.job.phase).toBe('ready');
    expect(context.job.assignee).toBeNull();
    expect(context.blocked).toBe(true);
    expect(context.waiting).toBe(true);
    expect(context.effective_phase).toBe('blocked');
  }, 60000);
});
