import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchJobCancellation, type HarnessInvocation } from '@eve/shared';
import { InvokeService } from './invoke.service.js';

vi.mock('@eve/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eve/shared')>()),
  resolveBudgetEnforcementConfig: async () => null,
}));

afterEach(() => vi.restoreAllMocks());
const invocation = { jobId: 'job_1', attemptId: 'att_1', projectId: 'proj_1', text: '', workspacePath: '/tmp/eve-cancellation-test' } as unknown as HarnessInvocation;

describe('agent cancellation', () => {
  it('rejects a cancelled job before starting execution', async () => {
    const service = new InvokeService(null as never);
    (service as any).jobs = { findById: vi.fn().mockResolvedValue({ phase: 'cancelled' }) };
    const execute = vi.spyOn(service as any, 'executeCancellable');
    expect(await service.execute(invocation)).toMatchObject({ success: false, exitCode: 130, error: expect.stringContaining('job_cancelled') });
    expect(execute).not.toHaveBeenCalled();
  });

  it('stops a running harness and rejects a zero exit code from its TERM handler', async () => {
    const service = new InvokeService(null as never);
    let phase = 'active';
    const cancellation = await watchJobCancellation(async () => phase, 20);
    let markReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    (service as any).logs = { appendLog: vi.fn(async (_id: string, type: string) => { if (type === 'ready') markReady(); }) };
    const ctx = { invocationWithOptions: invocation, lifecycleLogger: vi.fn().mockResolvedValue(undefined) };
    const plan = { isClaudeHarness: false, claudeAuthDecision: null,
      harnessOptionsResolved: { harness: 'codex', permission: 'auto_edit' },
      harnessBinary: { binary: process.execPath, prefixArgs: [] },
      harnessArgs: ['-e', `process.on('SIGTERM', () => process.exit(0)); console.log(JSON.stringify({type:'ready'})); setTimeout(() => process.exit(2), 2000);`] };
    const setup = { startTime: Date.now(), logs: [], processEnv: { PATH: process.env.PATH } };
    const relay = { processEvent: vi.fn().mockResolvedValue(undefined), processLine: vi.fn().mockResolvedValue(undefined) };
    try {
      const running = (service as any).runHarness(ctx, plan, setup, relay, process.cwd(), cancellation);
      await Promise.race([ready, running.then(() => { throw new Error('Harness exited before readiness'); })]);
      phase = 'cancelled';
      expect(await running).toMatchObject({ success: false, exitCode: 130, error: expect.stringContaining('job_cancelled') });
    } finally { cancellation.stop(); }
  });

  it('does not publish a successful result when cancellation wins the completion race', async () => {
    const service = new InvokeService(null as never);
    let phase = 'active';
    (service as any).jobs = { findById: vi.fn(async () => ({ phase })) };
    vi.spyOn(service as any, 'executeCancellable').mockImplementation(async () => {
      phase = 'cancelled';
      return { attemptId: invocation.attemptId, success: true, exitCode: 0 };
    });
    expect(await service.execute(invocation)).toMatchObject({ success: false, exitCode: 130, error: expect.stringContaining('job_cancelled') });
  });
});
