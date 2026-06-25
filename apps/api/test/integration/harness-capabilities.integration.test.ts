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

async function requestJson<T>(requestPath: string): Promise<T> {
  const response = await fetch(`${apiUrl}${requestPath}`, {
    headers: { 'content-type': 'application/json' },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<T>;
}

describe('integration harness capabilities', () => {
  it('returns capabilities in API responses', async () => {
    const list = await requestJson<{ data: Array<{ name: string; capabilities?: { supports_model: boolean } }> }>(
      '/harnesses',
    );

    expect(list.data.length).toBeGreaterThan(0);
    const mclaude = list.data.find((h) => h.name === 'mclaude');
    expect(mclaude).toBeTruthy();
    expect(typeof mclaude?.capabilities?.supports_model).toBe('boolean');

    const detail = await requestJson<{ capabilities?: { supports_model: boolean; reasoning?: { supported: boolean } } }>(
      '/harnesses/mclaude',
    );
    expect(typeof detail.capabilities?.supports_model).toBe('boolean');
    expect(typeof detail.capabilities?.reasoning?.supported).toBe('boolean');
  }, 30_000);

  it('shows capabilities in CLI output', async () => {
    const listOut = await runEve(['harness', 'list', '--capabilities']);
    expect(listOut).toContain('Harness:');
    expect(listOut).toContain('Model:');
    expect(listOut).toContain('Reasoning:');

    const detailOut = await runEve(['harness', 'get', 'mclaude']);
    expect(detailOut).toContain('Harness:');
    expect(detailOut).toContain('Model:');
    expect(detailOut).toContain('Reasoning:');
  }, 30_000);
});
