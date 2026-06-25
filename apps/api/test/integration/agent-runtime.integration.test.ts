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

describe('integration agent runtime', () => {
  it('records heartbeat and exposes status', async () => {
    const orgRaw = await runEve(['org', 'ensure', 'agent-runtime-org', '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const heartbeat = await requestJson<{ pod_name: string }>(
      `/internal/orgs/${org.id}/agent-runtime/heartbeat`,
      {
        method: 'POST',
        headers: { 'x-eve-internal-token': internalToken },
        body: JSON.stringify({
          pod_name: 'runtime-test-pod',
          status: 'healthy',
          capacity: 2,
        }),
      }
    );
    expect(heartbeat.pod_name).toBe('runtime-test-pod');

    const status = await requestJson<{ pods: Array<{ pod_name: string }> }>(
      `/orgs/${org.id}/agent-runtime/status`
    );
    expect(status.pods.map((pod) => pod.pod_name)).toContain('runtime-test-pod');
  });
});
