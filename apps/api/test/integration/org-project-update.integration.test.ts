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

describe('integration org/project update + soft delete', () => {
  it('updates org name and toggles deleted flag', async () => {
    const orgName = `OrgUpdate${Date.now()}`;
    const ensureRaw = await runEve(['org', 'ensure', orgName, '--json']);
    const org = JSON.parse(ensureRaw) as { id: string; name: string; deleted: boolean };

    const updatedRaw = await runEve([
      'org',
      'update',
      org.id,
      '--name',
      `${orgName}-Renamed`,
      '--deleted',
      'true',
      '--json',
    ]);
    const updated = JSON.parse(updatedRaw) as { id: string; name: string; deleted: boolean };
    expect(updated.name).toBe(`${orgName}-Renamed`);
    expect(updated.deleted).toBe(true);

    const fetched = await requestJson<{ id: string; deleted: boolean }>(
      `/orgs/${org.id}?include_deleted=true`
    );
    expect(fetched.deleted).toBe(true);

    const undeleteRaw = await runEve([
      'org',
      'update',
      org.id,
      '--deleted',
      'false',
      '--json',
    ]);
    const undeleted = JSON.parse(undeleteRaw) as { deleted: boolean };
    expect(undeleted.deleted).toBe(false);
  }, 60000);

  it('updates project fields and toggles deleted flag', async () => {
    const orgRaw = await runEve(['org', 'ensure', `OrgProj${Date.now()}`, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = `file://${repoPath}`;
    const projectName = `ProjUpdate${Date.now()}`;

    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      projectName,
      '--slug',
      'ProjUp',
      '--repo-url',
      repoUrl,
      '--branch',
      'main',
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string; name: string; deleted: boolean };

    const updatedRaw = await runEve([
      'project',
      'update',
      project.id,
      '--name',
      `${projectName}-Renamed`,
      '--branch',
      'dev',
      '--deleted',
      'true',
      '--json',
    ]);
    const updated = JSON.parse(updatedRaw) as { name: string; branch: string; deleted: boolean };
    expect(updated.name).toBe(`${projectName}-Renamed`);
    expect(updated.branch).toBe('dev');
    expect(updated.deleted).toBe(true);

    const fetched = await requestJson<{ deleted: boolean }>(
      `/projects/${project.id}?include_deleted=true`
    );
    expect(fetched.deleted).toBe(true);

    const undeleteRaw = await runEve([
      'project',
      'update',
      project.id,
      '--deleted',
      'false',
      '--json',
    ]);
    const undeleted = JSON.parse(undeleteRaw) as { deleted: boolean };
    expect(undeleted.deleted).toBe(false);
  }, 60000);
});
