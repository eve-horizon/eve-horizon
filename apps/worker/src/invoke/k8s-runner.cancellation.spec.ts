import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessInvocation } from '@eve/shared';
import { runInvocationInK8s } from './k8s-runner.js';

const state = vi.hoisted(() => ({ calls: [] as string[][], ready: false }));
vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), spawn: vi.fn((_command: string, args: string[], options: { signal?: AbortSignal }) => {
  state.calls.push(args);
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  queueMicrotask(() => {
    if (options.signal?.aborted) { child.emit('error', options.signal.reason); return; }
    if (args.includes('get') && args.includes('json')) {
      child.stdout.write(JSON.stringify({ status: { conditions: [{ type: 'Ready', status: state.ready ? 'True' : 'False' }] } }));
    } else if (args.includes('jsonpath={.status.podIP}')) { child.stdout.write('10.0.0.1'); }
    child.stdout.end(); child.stderr.end(); child.emit('close', 0);
  });
  return child;
}) }));

const invocation = { jobId: 'job_test', attemptId: 'attempt_test', projectId: 'proj_test', text: '', workspacePath: '/opt/eve/workspaces/attempt_test' } as unknown as HarnessInvocation;
beforeEach(() => {
  state.calls = []; state.ready = false;
  vi.stubEnv('EVE_RUNNER_IMAGE', 'runtime:test');
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  vi.stubEnv('EVE_API_URL', 'http://api.test');
  vi.stubEnv('EVE_INTERNAL_API_KEY', 'test');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function run(controller: AbortController, onCreated?: () => Promise<void>) {
  return runInvocationInK8s(invocation, onCreated, undefined, { signal: controller.signal });
}

describe('dedicated runner cancellation', () => {
  it('creates no resources for a job cancelled before dispatch', async () => {
    const controller = new AbortController();
    controller.abort(new Error('job_cancelled'));
    await expect(run(controller)).rejects.toThrow('job_cancelled');
    expect(state.calls).toEqual([]);
  });

  it('deletes a runner cancelled during startup with a bounded grace period', async () => {
    const controller = new AbortController();
    await expect(run(controller, async () => { controller.abort(new Error('job_cancelled')); }))
      .rejects.toThrow('job_cancelled');
    expect(state.calls).toContainEqual(expect.arrayContaining(['delete', 'pod', '--grace-period=5']));
    expect(state.calls).toContainEqual(expect.arrayContaining(['delete', 'pvc']));
  });

  it('aborts completion polling and cleans the running pod', async () => {
    const controller = new AbortController(); state.ready = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: { signal?: AbortSignal }) => {
      if (url.includes('/events')) {
        expect(options?.signal).toBe(controller.signal);
        controller.abort(new Error('job_cancelled'));
        throw controller.signal.reason;
      }
      return { ok: true, json: async () => ({ accepted: true }) };
    }));
    await expect(run(controller)).rejects.toThrow('job_cancelled');
    expect(state.calls).toContainEqual(expect.arrayContaining(['delete', 'pod', '--grace-period=5']));
    expect(state.calls).toContainEqual(expect.arrayContaining(['delete', 'pvc']));
  });
});
