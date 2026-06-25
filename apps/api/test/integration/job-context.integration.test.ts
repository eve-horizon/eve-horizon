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

describe('integration job context endpoint', () => {
  it('returns relations and derived fields', async () => {
    const orgRaw = await runEve(['org', 'ensure', `OrgContext${Date.now()}`, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = `file://${repoPath}`;
    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      `ContextProj${Date.now()}`,
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
      'Parent context job',
      '--json',
    ]);
    const parent = JSON.parse(parentRaw) as { id: string };

    const child = await requestJson<{ id: string; parent_id: string }>(
      `/projects/${project.id}/jobs`,
      {
        method: 'POST',
        body: JSON.stringify({
          description: 'Child context job',
          parent_id: parent.id,
        }),
      }
    );

    const blockerRaw = await runEve([
      'job',
      'create',
      '--project',
      project.id,
      '--description',
      'Blocking job',
      '--json',
    ]);
    const blocker = JSON.parse(blockerRaw) as { id: string };

    await runEve([
      'job',
      'dep',
      'add',
      child.id,
      blocker.id,
      '--type',
      'blocks',
      '--json',
    ]);

    await requestJson(`/jobs/${child.id}/claim`, {
      method: 'POST',
      body: JSON.stringify({ agent_id: 'integration-context' }),
    });

    await requestJson(`/jobs/${child.id}/submit`, {
      method: 'POST',
      body: JSON.stringify({ summary: 'Ready for review', agent_id: 'integration-context' }),
    });

    const rejectionReason = 'Needs improvements';
    await requestJson(`/jobs/${child.id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reviewer_id: 'reviewer-1', reason: rejectionReason }),
    });

    // Get the latest attempt ID from context (rejection creates a new attempt)
    const contextAfterReject = await requestJson<{
      latest_attempt: { id: string; attempt_number: number } | null;
    }>(`/jobs/${child.id}/context`);

    if (!contextAfterReject.latest_attempt) {
      throw new Error('Expected latest_attempt to exist after rejection');
    }

    // Use internal API to update attempt result_json (instead of direct DB access)
    await internalRequest(`/internal/attempts/${contextAfterReject.latest_attempt.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        result_json: { eve: { status: 'waiting' } },
      }),
    });

    const parentContext = await requestJson<{ children: Array<{ id: string }> }>(
      `/jobs/${parent.id}/context`
    );
    expect(parentContext.children.some((node) => node.id === child.id)).toBe(true);

    const childContext = await requestJson<{
      job: { id: string; phase: string };
      parent: { id: string } | null;
      relations: {
        dependencies: Array<{ id: string }>;
        blocking: Array<{ id: string }>;
      };
      latest_attempt: {
        attempt_number: number;
        status: string;
        result_summary: string | null;
        result_json: Record<string, unknown> | null;
      } | null;
      latest_rejection_reason: string | null;
      blocked: boolean;
      waiting: boolean;
      effective_phase: string;
    }>(`/jobs/${child.id}/context`);

    expect(childContext.parent?.id).toBe(parent.id);
    expect(childContext.relations.dependencies.some((dep) => dep.id === blocker.id)).toBe(true);
    expect(childContext.relations.blocking.some((dep) => dep.id === blocker.id)).toBe(true);
    expect(childContext.latest_attempt?.attempt_number).toBe(2);
    expect(childContext.latest_attempt?.status).toBe('pending');
    expect(childContext.latest_attempt?.result_summary ?? '').toContain(rejectionReason);
    expect(childContext.latest_attempt?.result_json).toEqual({ eve: { status: 'waiting' } });
    expect(childContext.latest_rejection_reason).toBe(rejectionReason);
    expect(childContext.blocked).toBe(true);
    expect(childContext.waiting).toBe(true);
    expect(childContext.effective_phase).toBe('blocked');
  }, 60000);
});
