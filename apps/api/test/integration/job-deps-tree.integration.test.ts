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

describe('integration job dependencies + tree', () => {
  it('adds dependencies and returns tree hierarchy', async () => {
    const orgRaw = await runEve(['org', 'ensure', `OrgDeps${Date.now()}`, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = `file://${repoPath}`;
    const projectName = `DepsProj${Date.now()}`;

    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      projectName,
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
      'Parent job',
      '--json',
    ]);
    const parent = JSON.parse(parentRaw) as { id: string };

    const child = await requestJson<{ id: string; parent_id: string }>(
      `/projects/${project.id}/jobs`,
      {
        method: 'POST',
        body: JSON.stringify({
          description: 'Child job',
          parent_id: parent.id,
        }),
      }
    );
    expect(child.parent_id).toBe(parent.id);

    const dependencyRaw = await runEve([
      'job',
      'create',
      '--project',
      project.id,
      '--description',
      'Dependency job',
      '--json',
    ]);
    const dependency = JSON.parse(dependencyRaw) as { id: string };

    await runEve([
      'job',
      'dep',
      'add',
      child.id,
      dependency.id,
      '--type',
      'blocks',
      '--json',
    ]);

    const deps = await requestJson<{
      dependencies: Array<{ id: string }>;
      dependents: Array<{ id: string }>;
      blocking: Array<{ id: string }>;
    }>(`/jobs/${child.id}/dependencies`);

    expect(deps.dependencies.some((dep) => dep.id === dependency.id)).toBe(true);
    expect(deps.blocking.some((dep) => dep.id === dependency.id)).toBe(true);

    const tree = await requestJson<{ id: string; children: Array<{ id: string }> }>(
      `/jobs/${parent.id}/tree`
    );
    expect(tree.id).toBe(parent.id);
    expect(tree.children.some((node) => node.id === child.id)).toBe(true);
  }, 60000);
});
