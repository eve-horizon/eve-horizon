import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERNAL_TOKEN_HEADER, registerInternalAuthHook, type HarnessInvocation } from '@eve/shared';
import { runInvocationInK8s } from './k8s-runner.js';

/**
 * A runner pod runs the worker app, so its HTTP guard requires the internal
 * key on every route but /health, while the pod itself gets no service
 * account token. End to end through runInvocationInK8s: the applied pod must
 * carry the key, and the submit request must present it to a guard set up
 * from that pod's own environment. The pod must also keep the image's
 * hardened start command.
 */
const state = vi.hoisted(() => ({ applied: '' }));
vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), spawn: vi.fn((_command: string, args: string[]) => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  if (args.includes('apply')) child.stdin.on('data', (chunk: Buffer) => { state.applied += chunk.toString('utf8'); });
  queueMicrotask(() => {
    if (args.includes('get') && args.includes('json')) {
      child.stdout.write(JSON.stringify({ status: { conditions: [{ type: 'Ready', status: 'True' }] } }));
    } else if (args.includes('jsonpath={.status.podIP}')) { child.stdout.write('10.0.0.1'); }
    child.stdout.end(); child.stderr.end(); child.emit('close', 0);
  });
  return child;
}) }));

const invocation = { jobId: 'job_test', attemptId: 'attempt_test', projectId: 'proj_test', text: '', workspacePath: '/opt/eve/workspaces/attempt_test' } as unknown as HarnessInvocation;

function appliedRunnerPod() {
  const manifest = JSON.parse(state.applied);
  return manifest.items.find((item: { kind: string }) => item.kind === 'Pod');
}

/** The runner app's onRequest guard, configured the way main.ts does it from the pod's env. */
function runnerGuard(key: string | undefined) {
  let hook: (request: unknown, reply: unknown, done: () => void) => void = () => undefined;
  // The pod's env is the only source: never fall back to this test process's key.
  registerInternalAuthHook({ addHook: (_name: string, fn: typeof hook) => { hook = fn; } } as never, { key: key ?? '' });
  return (url: string, headers: Record<string, string> = {}): number => {
    let status = 0;
    const reply = { code(code: number) { status = code; return reply; }, send() { return reply; } };
    const lowerCased = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    hook({ url, headers: lowerCased }, reply, () => { status = 200; });
    return status;
  };
}

beforeEach(() => {
  state.applied = '';
  vi.stubEnv('EVE_RUNNER_IMAGE', 'worker:test');
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  vi.stubEnv('EVE_API_URL', 'http://api.test');
  vi.stubEnv('EVE_INTERNAL_API_KEY', 'platform-internal-key');
  vi.stubEnv('EVE_RUNNER_SERVICE_ACCOUNT', '');
  vi.stubEnv('EVE_RUNNER_AUTOMOUNT_SERVICE_ACCOUNT_TOKEN', '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('worker runner pods and the internal-key guard', () => {
  it.each(['invoke', 'scripts/execute'] as const)('the runner accepts the worker\'s %s submit, and has no service account token', async (submitPath) => {
    const guardStatuses: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: { headers?: Record<string, string> }) => {
      if (url.endsWith('/health')) return { ok: true };
      if (url === `http://10.0.0.1:4749/${submitPath}`) {
        const runnerKey = appliedRunnerPod().spec.containers[0].env
          .find((entry: { name: string }) => entry.name === 'EVE_INTERNAL_API_KEY')?.value;
        const status = runnerGuard(runnerKey)(`/${submitPath}`, options?.headers);
        guardStatuses.push(status);
        return status === 200
          ? { ok: true, json: async () => ({ accepted: true }) }
          : { ok: false, status, text: async () => 'Unauthorized' };
      }
      if (url.includes('/events')) {
        return { ok: true, json: async () => ({ data: [{ id: 'evt_1', type: 'runner.completed',
          payload_json: { attemptId: 'attempt_test', jobId: 'job_test', result: { attemptId: 'attempt_test', success: true, exitCode: 0 } } }] }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const result = await runInvocationInK8s(invocation, undefined, undefined, { submitPath });

    expect(result.success).toBe(true);
    expect(guardStatuses).toEqual([200]);
    const pod = appliedRunnerPod();
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec).not.toHaveProperty('serviceAccountName');
    // No command override: the runner starts from the image's ENTRYPOINT/CMD,
    // i.e. eve-tini and execute-only eve-node with --disable-sigusr1.
    expect(pod.spec.containers[0]).not.toHaveProperty('command');
    expect(pod.spec.containers[0]).not.toHaveProperty('args');
  });

  it('a submit without the key would be refused by the runner', () => {
    const guard = runnerGuard('platform-internal-key');
    expect(guard('/invoke')).toBe(401);
    expect(guard('/invoke', { [INTERNAL_TOKEN_HEADER]: 'platform-internal-key' })).toBe(200);
    expect(guard('/health')).toBe(200);
  });
});
