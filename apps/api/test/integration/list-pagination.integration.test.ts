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

describe('integration list pagination', () => {
  it('paginates org list by limit/offset', async () => {
    await runEve(['org', 'ensure', `OrgPageA${Date.now()}`, '--json']);
    await runEve(['org', 'ensure', `OrgPageB${Date.now()}`, '--json']);
    await runEve(['org', 'ensure', `OrgPageC${Date.now()}`, '--json']);

    const first = await requestJson<{ data: Array<{ name: string }>; pagination: { count: number } }>(
      '/orgs?limit=2&offset=0'
    );
    const second = await requestJson<{ data: Array<{ name: string }>; pagination: { count: number } }>(
      '/orgs?limit=2&offset=2'
    );

    expect(first.data.length).toBe(2);
    expect(second.data.length).toBeGreaterThan(0);
  }, 60000);

  it('paginates project list by limit/offset', async () => {
    const orgRaw = await runEve(['org', 'ensure', `OrgProjPage${Date.now()}`, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };
    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = `file://${repoPath}`;

    await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      `ProjPage${Date.now()}A`,
      '--slug',
      'Pga01',
      '--repo-url',
      repoUrl,
      '--branch',
      'main',
      '--force',
      '--json',
    ]);
    await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      `ProjPage${Date.now()}B`,
      '--slug',
      'Pgb02',
      '--repo-url',
      repoUrl,
      '--branch',
      'main',
      '--force',
      '--json',
    ]);
    await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      `ProjPage${Date.now()}C`,
      '--slug',
      'Pgc03',
      '--repo-url',
      repoUrl,
      '--branch',
      'main',
      '--force',
      '--json',
    ]);

    const first = await requestJson<{ data: Array<{ id: string }>; pagination: { count: number } }>(
      `/projects?org_id=${org.id}&limit=2&offset=0`
    );
    const second = await requestJson<{ data: Array<{ id: string }>; pagination: { count: number } }>(
      `/projects?org_id=${org.id}&limit=2&offset=2`
    );

    expect(first.data.length).toBe(2);
    expect(second.data.length).toBe(1);
  }, 60000);

  it('paginates job list by limit/offset', async () => {
    const orgRaw = await runEve(['org', 'ensure', `OrgJobPage${Date.now()}`, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };
    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = `file://${repoPath}`;

    const uniqueId = Math.random().toString(36).substring(2, 6);
    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      `JobPageProj${Date.now()}`,
      '--slug',
      `jp${uniqueId}`,
      '--repo-url',
      repoUrl,
      '--branch',
      'main',
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string; slug: string };

    await requestJson(`/projects/${project.id}/jobs`, {
      method: 'POST',
      body: JSON.stringify({ description: 'Job page 1' }),
    });
    await requestJson(`/projects/${project.id}/jobs`, {
      method: 'POST',
      body: JSON.stringify({ description: 'Job page 2' }),
    });
    await requestJson(`/projects/${project.id}/jobs`, {
      method: 'POST',
      body: JSON.stringify({ description: 'Job page 3' }),
    });

    const listTarget = project.id;
    const all = await requestJson<{ jobs: Array<{ id: string }> }>(
      `/projects/${listTarget}/jobs?limit=50&offset=0`
    );
    const first = await requestJson<{ jobs: Array<{ id: string }> }>(
      `/projects/${listTarget}/jobs?limit=2&offset=0`
    );
    const second = await requestJson<{ jobs: Array<{ id: string }> }>(
      `/projects/${listTarget}/jobs?limit=2&offset=2`
    );

    expect(all.jobs.length).toBeGreaterThanOrEqual(3);
    expect(first.jobs.length).toBe(2);
    const expectedSecond = Math.min(2, Math.max(0, all.jobs.length - 2));
    expect(second.jobs.length).toBe(expectedSecond);

    const firstIds = new Set(first.jobs.map((job) => job.id));
    const overlap = second.jobs.filter((job) => firstIds.has(job.id));
    expect(overlap.length).toBe(0);
  }, 60000);
});
