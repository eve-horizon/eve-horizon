import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttemptId, HarnessResult } from '@eve/shared';
import { invokeActionJob, invokeScriptJob } from './worker.client';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('script/action worker submit and poll client', () => {
  beforeEach(() => {
    vi.stubEnv('WORKER_URL', 'http://worker.test');
    vi.stubEnv('EVE_API_URL', 'http://api.test');
    vi.stubEnv('EVE_INTERNAL_API_KEY', 'internal-key');
    vi.stubEnv('EVE_WORKER_POLL_INTERVAL_MS', '100');
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/eve_test');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('submits script jobs with projectId and returns the terminal runner event result', async () => {
    const terminalResult: HarnessResult = {
      attemptId: 'att_1' as AttemptId,
      success: true,
      exitCode: 0,
      resultText: 'done',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'http://worker.test/scripts/execute') {
        expect(JSON.parse(String(init?.body))).toEqual({
          jobId: 'job_1',
          attemptId: 'att_1',
          projectId: 'proj_1',
        });
        return jsonResponse({ accepted: true, attemptId: 'att_1' }, { status: 202 });
      }
      if (url.startsWith('http://api.test/internal/projects/proj_1/events')) {
        return jsonResponse({
          data: [{
            type: 'runner.completed',
            payload_json: {
              attemptId: 'att_1',
              jobId: 'job_1',
              result: terminalResult,
            },
          }],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    await expect(invokeScriptJob('job_1', 'att_1' as AttemptId, 'proj_1', undefined, 5_000))
      .resolves.toEqual(terminalResult);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns worker_submit_failed for submit rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ accepted: false, error: 'bad request' }, { status: 202 }),
    );

    const result = await invokeActionJob('job_1', 'att_1' as AttemptId, 'proj_1', undefined, 5_000);

    expect(result).toMatchObject({
      success: false,
      exitCode: 1,
      error: 'worker_submit_failed: Worker rejected job: bad request',
    });
  });

  it('returns worker_submit_failed for non-2xx submit responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 500, statusText: 'Server Error' }),
    );

    const result = await invokeScriptJob('job_1', 'att_1' as AttemptId, 'proj_1', undefined, 5_000);

    expect(result).toMatchObject({
      success: false,
      exitCode: 1,
      error: 'worker_submit_failed: Worker returned 500: nope',
    });
  });

  it('returns poll_timeout when no terminal runner event arrives', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'http://worker.test/scripts/execute') {
        return jsonResponse({ accepted: true, attemptId: 'att_1' }, { status: 202 });
      }
      if (url.startsWith('http://api.test/internal/projects/proj_1/events')) {
        return jsonResponse({ data: [] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await invokeScriptJob('job_1', 'att_1' as AttemptId, 'proj_1', undefined, 30);

    expect(result).toMatchObject({
      success: false,
      exitCode: 1,
    });
    expect(result.error).toContain('poll_timeout: Runner timed out after 30ms');
  });
});
