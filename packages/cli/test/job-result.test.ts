import { describe, expect, it } from 'vitest';
import { readResultErrorCode, readResultTokenUsage } from '../src/commands/job';

describe('job result token usage', () => {
  it('reads nested tokenUsage from current API responses', () => {
    expect(readResultTokenUsage({
      tokenInput: undefined,
      tokenOutput: undefined,
      tokenUsage: { input: 24, output: 988 },
    } as never)).toEqual({ input: 24, output: 988 });
  });

  it('reads legacy flat token fields', () => {
    expect(readResultTokenUsage({
      tokenInput: 10,
      tokenOutput: 20,
      tokenUsage: null,
    } as never)).toEqual({ input: 10, output: 20 });
  });

  it('returns null when no token counts are present', () => {
    expect(readResultTokenUsage({
      tokenInput: null,
      tokenOutput: null,
      tokenUsage: null,
    } as never)).toBeNull();
  });
});

describe('job result error code', () => {
  it('reads object result_json error codes', () => {
    expect(readResultErrorCode({ error_code: 'attempt_init_timeout' })).toBe('attempt_init_timeout');
  });

  it('reads legacy stringified result_json error codes', () => {
    expect(readResultErrorCode('{"error_code":"attempt_init_timeout"}')).toBe('attempt_init_timeout');
  });
});
