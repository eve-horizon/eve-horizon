import { mkdtemp, rm } from 'node:fs/promises';
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
