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

async function requestRaw(requestPath: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiUrl}${requestPath}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  });
}

describe('integration repo branch handling', () => {
  it('allows CLI project ensure without repo-url, then adopts repo-url later without force', async () => {
    const orgRaw = await runEve(['org', 'ensure', `OrgNoRepo${Date.now()}`, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const projectName = `NoRepoProj${Date.now()}`;
    const ensuredRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      projectName,
      '--json',
    ]);
    const ensured = JSON.parse(ensuredRaw) as { id: string; repo_url: string; branch: string };
    expect(ensured.id).toMatch(/^proj_/);
    expect(ensured.repo_url).toBe('');
    expect(ensured.branch).toBe('main');

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = `file://${repoPath}`;
    const adopted = await requestRaw('/projects/ensure', {
      method: 'POST',
      body: JSON.stringify({
        org_id: org.id,
        name: projectName,
        repo_url: repoUrl,
        branch: 'main',
      }),
    });
    expect(adopted.ok).toBe(true);

    const updated = await adopted.json() as { id: string; repo_url: string; branch: string };
    expect(updated.id).toBe(ensured.id);
    expect(updated.repo_url).toBe(repoUrl);
    expect(updated.branch).toBe('main');
  }, 60000);

  it('requires force to change repo branch on ensure', async () => {
    const orgRaw = await runEve(['org', 'ensure', `OrgRepo${Date.now()}`, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = `file://${repoPath}`;
    const projectName = `RepoProj${Date.now()}`;

    const initial = await requestRaw('/projects/ensure', {
      method: 'POST',
      body: JSON.stringify({
        org_id: org.id,
        name: projectName,
        repo_url: repoUrl,
        branch: 'main',
      }),
    });
    expect(initial.ok).toBe(true);
    const created = await initial.json() as { id: string; branch: string; slug: string };
    expect(created.branch).toBe('main');

    const conflict = await requestRaw('/projects/ensure', {
      method: 'POST',
      body: JSON.stringify({
        org_id: org.id,
        name: projectName,
        repo_url: repoUrl,
        branch: 'dev',
      }),
    });
    expect([400, 409]).toContain(conflict.status);

    const forced = await requestRaw('/projects/ensure', {
      method: 'POST',
      body: JSON.stringify({
        org_id: org.id,
        name: projectName,
        repo_url: repoUrl,
        branch: 'dev',
        force: true,
      }),
    });
    expect(forced.ok).toBe(true);
    const updated = await forced.json() as { id: string; branch: string };
    expect(updated.id).toBe(created.id);
    expect(updated.branch).toBe('dev');
  }, 60000);
});
