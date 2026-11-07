import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ calls: [] as Array<{ command: string; env: NodeJS.ProcessEnv }> }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn((command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      spawned.calls.push({ command, env: options.env });
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: { write: vi.fn(), end: vi.fn() },
      });
      setImmediate(() => child.emit('close', 1));
      return child;
    }),
  };
});

import { runInvocationInK8s } from './k8s-runner.js';

const SECRETS = { DATABASE_URL: 'postgres://secret', EVE_INTERNAL_API_KEY: 'internal', GITHUB_TOKEN: 'gh' };
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [key, value] of Object.entries({ ...SECRETS, EVE_RUNNER_IMAGE: 'worker:test' })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  spawned.calls = [];
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('worker runner kubectl', () => {
  it('runs kubectl without the worker credentials in its environment', async () => {
    await expect(runInvocationInK8s({ jobId: 'job', attemptId: 'att', projectId: 'proj', text: '' } as never))
      .rejects.toThrow(/Failed to apply runner manifests/);
    expect(spawned.calls.length).toBeGreaterThan(0);
    for (const call of spawned.calls) {
      expect(call.command).toBe('kubectl');
      for (const key of Object.keys(SECRETS)) expect(call.env).not.toHaveProperty(key);
      expect(call.env.PATH).toBeDefined();
    }
  });
});
