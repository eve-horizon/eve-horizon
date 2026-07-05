import { describe, it, expect } from 'vitest';
import { configSchema } from '../config/schema';

const BASE_ENV = { DATABASE_URL: 'postgres://user:pass@localhost:5432/eve_test' };

function parse(env: Record<string, string> = {}) {
  return configSchema.parse({ ...BASE_ENV, ...env });
}

describe('configSchema — orchestrator hot-path keys (ORC-6)', () => {
  it('applies the documented defaults when unset', () => {
    const config = parse();
    expect(config.EVE_AGENT_RUNTIME_URL).toBeUndefined();
    expect(config.EVE_AGENT_RUNTIME_URLS).toBe('');
    expect(config.EVE_WORKER_URLS).toBe('');
    expect(config.WORKER_URL).toBe('http://localhost:4749');
    expect(config.WORKER_TIMEOUT_MS).toBe(1_800_000);
    expect(config.EVE_WORKER_POLL_INTERVAL_MS).toBe(5000);
    expect(config.EVE_AGENT_RUNTIME_POLL_INTERVAL_MS).toBe(250);
    expect(config.EVE_WORKER_SUBMIT_TIMEOUT_MS).toBe(30_000);
    expect(config.EVE_ORCH_RECOVERY_INTERVAL_TICKS).toBeUndefined();
    expect(config.EVE_ORCH_STALE_RECOVERY_INTERVAL_TICKS).toBeUndefined();
  });

  it('passes through configured values', () => {
    const config = parse({
      EVE_AGENT_RUNTIME_URL: 'http://agent-runtime:4812',
      WORKER_URL: 'http://worker:4749',
      WORKER_TIMEOUT_MS: '60000',
      EVE_WORKER_POLL_INTERVAL_MS: '100',
      EVE_ORCH_RECOVERY_INTERVAL_TICKS: '5',
    });
    expect(config.EVE_AGENT_RUNTIME_URL).toBe('http://agent-runtime:4812');
    expect(config.WORKER_URL).toBe('http://worker:4749');
    expect(config.WORKER_TIMEOUT_MS).toBe(60_000);
    expect(config.EVE_WORKER_POLL_INTERVAL_MS).toBe(100);
    expect(config.EVE_ORCH_RECOVERY_INTERVAL_TICKS).toBe('5');
  });

  it('treats an empty WORKER_URL as unset (original `||` fallback semantics)', () => {
    expect(parse({ WORKER_URL: '' }).WORKER_URL).toBe('http://localhost:4749');
  });

  it('treats an empty WORKER_TIMEOUT_MS as unset (original `||` fallback semantics)', () => {
    expect(parse({ WORKER_TIMEOUT_MS: '' }).WORKER_TIMEOUT_MS).toBe(1_800_000);
  });

  it('lets a malformed WORKER_TIMEOUT_MS degrade to NaN instead of failing config parse', () => {
    // Preserves parseInt('garbage') behavior from the pre-config call sites.
    expect(parse({ WORKER_TIMEOUT_MS: 'garbage' }).WORKER_TIMEOUT_MS).toBeNaN();
  });

  it('falls back to poll-interval defaults for malformed or sub-100ms values', () => {
    expect(parse({ EVE_WORKER_POLL_INTERVAL_MS: 'nope' }).EVE_WORKER_POLL_INTERVAL_MS).toBe(5000);
    expect(parse({ EVE_WORKER_POLL_INTERVAL_MS: '99' }).EVE_WORKER_POLL_INTERVAL_MS).toBe(5000);
    expect(parse({ EVE_AGENT_RUNTIME_POLL_INTERVAL_MS: '50' }).EVE_AGENT_RUNTIME_POLL_INTERVAL_MS).toBe(250);
    expect(parse({ EVE_WORKER_SUBMIT_TIMEOUT_MS: '' }).EVE_WORKER_SUBMIT_TIMEOUT_MS).toBe(30_000);
  });
});
