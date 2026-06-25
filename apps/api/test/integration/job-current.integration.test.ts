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

async function runEve(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execFileAsync(eveBin, args, {
    cwd: repoRoot,
    env: { ...process.env, EVE_API_URL: apiUrl, ...extraEnv },
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

describe('integration job current', () => {
  it('returns JSON by default and supports tree output', async () => {
    const orgRaw = await runEve(['org', 'ensure', `OrgCurrent${Date.now()}`, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = `file://${repoPath}`;
    const projectName = `CurrentProj${Date.now()}`;

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

    const jobRaw = await runEve([
      'job',
      'create',
      '--project',
      project.id,
      '--description',
      'Current job integration test',
      '--phase',
      'backlog',
      '--json',
    ]);
    const job = JSON.parse(jobRaw) as { id: string };

    const child = await requestJson<{ id: string }>(`/projects/${project.id}/jobs`, {
      method: 'POST',
      body: JSON.stringify({
        description: 'Current job child',
        parent_id: job.id,
      }),
    });

    const currentRaw = await runEve(['job', 'current', job.id]);
    const currentParsed = JSON.parse(currentRaw) as { job?: { id: string }; id?: string };
    const currentJobId = currentParsed.job?.id ?? currentParsed.id;
    expect(currentJobId).toBe(job.id);

    const currentEnvRaw = await runEve(['job', 'current'], { EVE_JOB_ID: job.id });
    const currentEnvParsed = JSON.parse(currentEnvRaw) as { job?: { id: string }; id?: string };
    const currentEnvJobId = currentEnvParsed.job?.id ?? currentEnvParsed.id;
    expect(currentEnvJobId).toBe(job.id);

    const treeOutput = await runEve(['job', 'current', '--tree'], { EVE_JOB_ID: job.id });
    expect(treeOutput).toContain(job.id);
    expect(treeOutput).toContain(child.id);
  }, 60000);
});
