import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStreamingCommand } from './streaming-command.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('runStreamingCommand', () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    for (const workspace of workspaces.splice(0)) {
      await rm(workspace, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  async function tempWorkspace(): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), 'eve-streaming-command-'));
    workspaces.push(workspace);
    return workspace;
  }

  it('writes stdout incrementally before process exit', async () => {
    const workspace = await tempWorkspace();
    const logs: Array<{ type: string; content: Record<string, unknown> }> = [];

    const promise = runStreamingCommand({
      command: 'printf "first\\n"; sleep 0.3; printf "second\\n"',
      cwd: workspace,
      env: { PATH: process.env.PATH },
      attemptId: 'att_stream',
      timeoutMs: 5_000,
      timeoutCode: 'script_timeout',
      flushLineCount: 1,
      flushIntervalMs: 25,
      appendLog: async (_attemptId, type, content) => {
        logs.push({ type, content });
      },
    });

    await delay(100);

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'output',
          content: expect.objectContaining({ stream: 'stdout', text: 'first\n' }),
        }),
      ]),
    );

    const result = await promise;
    expect(result).toMatchObject({ success: true, exitCode: 0, timedOut: false });
    expect(result.stdout).toContain('second');
  });

  it('does not spawn a command whose cancellation signal is already aborted', async () => {
    const workspace = await tempWorkspace();
    const controller = new AbortController();
    controller.abort();
    const result = await runStreamingCommand({
      command: 'touch should-not-exist', cwd: workspace, env: { PATH: process.env.PATH },
      attemptId: 'att_cancelled', timeoutMs: 5_000, timeoutCode: 'script_timeout',
      signal: controller.signal, appendLog: async () => {},
    } as Parameters<typeof runStreamingCommand>[0] & { signal: AbortSignal });
    expect(result).toMatchObject({ success: false, exitCode: 130, cancelled: true });
    await expect(access(join(workspace, 'should-not-exist'))).rejects.toThrow();
  });

  it('cancels the shell and TERM-resistant descendants before they can continue work', async () => {
    const workspace = await tempWorkspace();
    const controller = new AbortController();
    const resultPromise = runStreamingCommand({
      command: "trap 'exit 0' TERM; bash -c 'trap \"\" TERM; sleep 0.7; touch should-not-exist' & wait",
      cwd: workspace, env: { PATH: process.env.PATH }, attemptId: 'att_cancelled',
      timeoutMs: 5_000, timeoutCode: 'script_timeout', killGraceMs: 50,
      signal: controller.signal, appendLog: async () => {},
    } as Parameters<typeof runStreamingCommand>[0] & { signal: AbortSignal });
    await delay(100);
    controller.abort();
    const result = await resultPromise;
    expect(result).toMatchObject({ success: false, exitCode: 130, cancelled: true });
    await delay(750);
    await expect(access(join(workspace, 'should-not-exist'))).rejects.toThrow();
  });

  it('also stops descendants that detach into their own process group', async () => {
    const workspace = await tempWorkspace();
    const controller = new AbortController();
    const descendant = `process.on('SIGTERM', () => {}); console.log('detached-ready'); setTimeout(() => { require('fs').writeFileSync('should-not-exist', 'escaped'); process.exit(0); }, 700);`;
    const parent = `const {spawn} = require('child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {detached:true, stdio:'inherit'}); setTimeout(() => {}, 2000);`;
    const command = `${JSON.stringify(process.execPath)} -e '${parent.replaceAll("'", "'\\''")}'`;
    let markReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const running = runStreamingCommand({ command, cwd: workspace, env: { PATH: process.env.PATH },
      attemptId: 'att_detached', timeoutMs: 5_000, timeoutCode: 'script_timeout', killGraceMs: 50,
      flushLineCount: 1,
      signal: controller.signal, appendLog: async (_id, type, content) => {
        if (type === 'output' && String(content.text).includes('detached-ready')) markReady();
      } });
    await Promise.race([ready, running.then(() => { throw new Error('Detached child never became ready'); })]);
    controller.abort();
    expect(await running).toMatchObject({ success: false, exitCode: 130 });
    await delay(750);
    await expect(access(join(workspace, 'should-not-exist'))).rejects.toThrow();
  });

  it('truncates output above the cap with one warning per stream', async () => {
    const workspace = await tempWorkspace();
    const logs: Array<{ type: string; content: Record<string, unknown> }> = [];

    const result = await runStreamingCommand({
      command: 'printf "1234567890\\n"',
      cwd: workspace,
      env: { PATH: process.env.PATH },
      attemptId: 'att_cap',
      timeoutMs: 5_000,
      timeoutCode: 'script_timeout',
      outputCapBytes: 5,
      flushLineCount: 1,
      flushIntervalMs: 25,
      appendLog: async (_attemptId, type, content) => {
        logs.push({ type, content });
      },
    });

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(5);
    expect(logs.filter((entry) => entry.type === 'warning')).toHaveLength(1);
    expect(logs.find((entry) => entry.type === 'warning')?.content).toMatchObject({
      code: 'output_truncated',
      stream: 'stdout',
      cap_bytes: 5,
    });
  });

  it('applies the output cap to long lines without waiting for a newline', async () => {
    const workspace = await tempWorkspace();
    const logs: Array<{ type: string; content: Record<string, unknown> }> = [];

    const result = await runStreamingCommand({
      command: 'printf "abcdefghijklmnop"',
      cwd: workspace,
      env: { PATH: process.env.PATH },
      attemptId: 'att_long_line_cap',
      timeoutMs: 5_000,
      timeoutCode: 'script_timeout',
      outputCapBytes: 5,
      flushIntervalMs: 25,
      appendLog: async (_attemptId, type, content) => {
        logs.push({ type, content });
      },
    });

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(result.stdout).toBe('abcde');
    expect(logs.filter((entry) => entry.type === 'warning')).toHaveLength(1);
    expect(logs.find((entry) => entry.type === 'output')?.content).toMatchObject({
      stream: 'stdout',
      text: 'abcde',
    });
  });

  it('kills timed-out commands and writes a structured timeout log', async () => {
    const workspace = await tempWorkspace();
    const logs: Array<{ type: string; content: Record<string, unknown> }> = [];

    const result = await runStreamingCommand({
      command: 'sleep 5',
      cwd: workspace,
      env: { PATH: process.env.PATH },
      attemptId: 'att_timeout',
      timeoutMs: 100,
      timeoutCode: 'script_timeout',
      killGraceMs: 50,
      flushIntervalMs: 25,
      appendLog: async (_attemptId, type, content) => {
        logs.push({ type, content });
      },
    });

    expect(result).toMatchObject({
      success: false,
      exitCode: 124,
      timedOut: true,
    });
    expect(result.error).toContain('script_timeout');
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          content: expect.objectContaining({
            code: 'script_timeout',
            timeout_seconds: 1,
          }),
        }),
      ]),
    );
  });
});
