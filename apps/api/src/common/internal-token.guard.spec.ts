import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { InternalTokenGuard } from './internal-token.guard.js';
import { workerRequestHeaders } from './worker-url.js';

function contextWithHeaders(headers: Record<string, string | string[] | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('InternalTokenGuard', () => {
  beforeEach(() => {
    // loadConfig() validates the whole environment.
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/eve_test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts the configured internal key', () => {
    vi.stubEnv('EVE_INTERNAL_API_KEY', 'internal-key');
    const guard = new InternalTokenGuard();
    expect(guard.canActivate(contextWithHeaders({ 'x-eve-internal-token': 'internal-key' }))).toBe(true);
  });

  it('rejects a missing or wrong token', () => {
    vi.stubEnv('EVE_INTERNAL_API_KEY', 'internal-key');
    const guard = new InternalTokenGuard();
    expect(() => guard.canActivate(contextWithHeaders({}))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(contextWithHeaders({ 'x-eve-internal-token': 'internal-kez' }))).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(contextWithHeaders({ 'x-eve-internal-token': ['internal-key'] }))).toThrow(
      UnauthorizedException,
    );
  });

  it('fails closed when no key is configured', () => {
    vi.stubEnv('EVE_INTERNAL_API_KEY', '');
    const guard = new InternalTokenGuard();
    expect(() => guard.canActivate(contextWithHeaders({ 'x-eve-internal-token': '' }))).toThrow(
      UnauthorizedException,
    );
  });
});

describe('workerRequestHeaders', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('authenticates API-to-worker calls with the internal key', () => {
    vi.stubEnv('EVE_INTERNAL_API_KEY', 'internal-key');
    expect(workerRequestHeaders()).toEqual({
      'content-type': 'application/json',
      'x-eve-internal-token': 'internal-key',
    });
  });
});
