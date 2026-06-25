import { describe, expect, it } from 'vitest';
import type { AttemptId, HarnessResult } from '@eve/shared';
import {
  deriveOrgFsMountContext,
  computeWaitingDeferUntil,
  evaluateAttemptInitHealth,
  evaluateAttemptStartupHealth,
  evaluateRunningAttemptHealth,
  extractEveControl,
  resolveWorkerPollTimeoutMs,
  resolveOrchestrationOutcome,
  ticksForIntervalMs,
  WAITING_BACKOFF_MS,
} from './loop.service';

describe('extractEveControl', () => {
  it('normalizes status and reads summary', () => {
    const control = extractEveControl({
      eve: {
        status: 'WAITING',
        summary: 'Paused for dependencies',
      },
    });

    expect(control).toEqual({
      status: 'waiting',
      summary: 'Paused for dependencies',
    });
  });

  it('ignores invalid status but keeps summary', () => {
    const control = extractEveControl({
      eve: {
        status: 42,
        summary: 'Partial output',
      },
    });

    expect(control).toEqual({
      summary: 'Partial output',
    });
  });
});

describe('resolveOrchestrationOutcome', () => {
  const baseResult = {
    attemptId: 'attempt_1' as unknown as AttemptId,
    success: true,
    exitCode: 0,
  } satisfies HarnessResult;

  it('uses eve status override', () => {
    expect(resolveOrchestrationOutcome(baseResult, 'waiting')).toBe('waiting');
    expect(resolveOrchestrationOutcome(baseResult, 'failed')).toBe('failed');
  });

  it('falls back to worker success', () => {
    expect(resolveOrchestrationOutcome(baseResult)).toBe('success');
    expect(resolveOrchestrationOutcome({ ...baseResult, success: false }, undefined)).toBe('failed');
  });
});

describe('computeWaitingDeferUntil', () => {
  it('applies backoff when unblocked', () => {
    const now = new Date('2026-01-19T00:00:00.000Z');
    const deferUntil = computeWaitingDeferUntil(false, now);

    expect(deferUntil?.getTime()).toBe(now.getTime() + WAITING_BACKOFF_MS);
  });

  it('returns null when blocked', () => {
    const now = new Date('2026-01-19T00:00:00.000Z');

    expect(computeWaitingDeferUntil(true, now)).toBeNull();
  });
});

describe('ticksForIntervalMs', () => {
  it('maps wall-clock interval to tick count', () => {
    expect(ticksForIntervalMs(5000, 60000)).toBe(12);
    expect(ticksForIntervalMs(1000, 15000)).toBe(15);
  });

  it('guards against sub-100ms loop values', () => {
    expect(ticksForIntervalMs(10, 1000)).toBe(10);
  });
});

describe('resolveWorkerPollTimeoutMs', () => {
  function job(overrides: Record<string, unknown>) {
    return {
      hints: {},
      action_input: null,
      action_type: null,
      script_timeout_seconds: null,
      ...overrides,
    } as any;
  }

  it('uses script_timeout_seconds plus worker-side timeout grace for script jobs', () => {
    expect(resolveWorkerPollTimeoutMs(job({
      script_timeout_seconds: 600,
      hints: { timeout_seconds: 30 },
    }), 'script')).toBe(660_000);
  });

  it('uses action-run timeout_seconds or timeout plus worker-side timeout grace', () => {
    expect(resolveWorkerPollTimeoutMs(job({
      action_type: 'run',
      action_input: { timeout_seconds: 120 },
      hints: { timeout_seconds: 30 },
    }), 'action')).toBe(180_000);

    expect(resolveWorkerPollTimeoutMs(job({
      action_type: 'run',
      action_input: { timeout: 45 },
      hints: { timeout_seconds: 30 },
    }), 'action')).toBe(105_000);
  });

  it('keeps non-run action timeout behavior on hints/defaults without extra grace', () => {
    expect(resolveWorkerPollTimeoutMs(job({
      action_type: 'deploy',
      hints: { timeout_seconds: 90 },
    }), 'action')).toBe(90_000);

    expect(resolveWorkerPollTimeoutMs(job({ action_type: 'deploy' }), 'action')).toBe(1_800_000);
  });
});

describe('evaluateRunningAttemptHealth', () => {
  it('marks attempts stale when runtime exceeds timeout + grace', () => {
    const now = new Date('2026-02-13T00:00:30.000Z');
    const startedAt = new Date('2026-02-13T00:00:00.000Z');
    const lastLogAt = new Date('2026-02-13T00:00:25.000Z');

    const health = evaluateRunningAttemptHealth({
      startedAt,
      lastLogAt,
      timeoutSeconds: 20,
      timeoutGraceSeconds: 5,
      staleRunningSeconds: 900,
      staleIdleSeconds: 900,
      now,
    });

    expect(health.stale).toBe(true);
    expect(health.errorCode).toBe('attempt_timeout');
  });

  it('marks attempts stale when idle beyond stale thresholds', () => {
    const now = new Date('2026-02-13T00:16:00.000Z');
    const startedAt = new Date('2026-02-13T00:00:00.000Z');
    const lastLogAt = new Date('2026-02-13T00:00:10.000Z');

    const health = evaluateRunningAttemptHealth({
      startedAt,
      lastLogAt,
      timeoutSeconds: 1800,
      timeoutGraceSeconds: 30,
      staleRunningSeconds: 900,
      staleIdleSeconds: 600,
      now,
    });

    expect(health.stale).toBe(true);
    expect(health.errorCode).toBe('attempt_stale');
  });

  it('keeps healthy attempts running', () => {
    const now = new Date('2026-02-13T00:10:00.000Z');
    const startedAt = new Date('2026-02-13T00:00:00.000Z');
    const lastLogAt = new Date('2026-02-13T00:09:30.000Z');

    const health = evaluateRunningAttemptHealth({
      startedAt,
      lastLogAt,
      timeoutSeconds: 1800,
      timeoutGraceSeconds: 30,
      staleRunningSeconds: 900,
      staleIdleSeconds: 900,
      now,
    });

    expect(health).toEqual({ stale: false });
  });
});

describe('evaluateAttemptInitHealth', () => {
  it('marks unaccepted attempts stale after the init timeout', () => {
    const now = new Date('2026-02-13T00:05:01.000Z');
    const startedAt = new Date('2026-02-13T00:00:00.000Z');

    const health = evaluateAttemptInitHealth({
      startedAt,
      initTimeoutSeconds: 300,
      now,
    });

    expect(health.stale).toBe(true);
    expect(health.errorCode).toBe('attempt_init_timeout');
    expect(health.reason).toContain('runtime acceptance');
  });

  it('keeps unaccepted attempts healthy inside the init window', () => {
    const now = new Date('2026-02-13T00:04:59.000Z');
    const startedAt = new Date('2026-02-13T00:00:00.000Z');

    expect(evaluateAttemptInitHealth({
      startedAt,
      initTimeoutSeconds: 300,
      now,
    })).toEqual({ stale: false });
  });
});

describe('evaluateAttemptStartupHealth', () => {
  it('marks accepted attempts stale when harness start is missing after startup timeout', () => {
    const now = new Date('2026-02-13T00:10:00.000Z');
    const executionStartedAt = new Date('2026-02-13T00:00:00.000Z');

    const health = evaluateAttemptStartupHealth({
      executionStartedAt,
      startupTimeoutSeconds: 600,
      now,
    });

    expect(health.stale).toBe(true);
    expect(health.errorCode).toBe('attempt_startup_timeout');
    expect(health.reason).toContain('harness');
  });

  it('keeps accepted attempts healthy inside the startup window', () => {
    const now = new Date('2026-02-13T00:09:59.000Z');
    const executionStartedAt = new Date('2026-02-13T00:00:00.000Z');

    expect(evaluateAttemptStartupHealth({
      executionStartedAt,
      startupTimeoutSeconds: 600,
      now,
    })).toEqual({ stale: false });
  });
});

describe('deriveOrgFsMountContext', () => {
  it('denies mount when no scoped orgfs grants exist', () => {
    const context = deriveOrgFsMountContext([
      {
        role_permissions: ['projects:read'],
        scope_json: null,
      },
    ]);

    expect(context).toEqual({
      mode: 'none',
      allow_prefixes: [],
      read_only_prefixes: [],
    });
  });

  it('maps orgfs reader grants to read-only scoped mounts', () => {
    const context = deriveOrgFsMountContext([
      {
        role_permissions: ['orgfs:read'],
        scope_json: {
          orgfs: {
            allow_prefixes: ['/groups/pm/**'],
          },
        },
      },
    ]);

    expect(context).toEqual({
      mode: 'read',
      allow_prefixes: ['/groups/pm/**'],
      read_only_prefixes: ['/groups/pm/**'],
    });
  });

  it('keeps read-only prefixes for non-writable grants when writers are also present', () => {
    const context = deriveOrgFsMountContext([
      {
        role_permissions: ['orgfs:read'],
        scope_json: {
          orgfs: {
            allow_prefixes: ['/groups/pm/**'],
          },
        },
      },
      {
        role_permissions: ['orgfs:write'],
        scope_json: {
          orgfs: {
            allow_prefixes: ['/groups/eng/**'],
          },
        },
      },
    ]);

    expect(context.mode).toBe('write');
    expect(context.allow_prefixes).toEqual(['/groups/eng/**', '/groups/pm/**']);
    expect(context.read_only_prefixes).toContain('/groups/pm/**');
    expect(context.read_only_prefixes).not.toContain('/groups/eng/**');
  });
});
