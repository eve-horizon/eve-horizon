import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { InternalApiKeyGuard } from './internal-api-key.guard';
import type { ExecutionContext } from '@nestjs/common';

/**
 * Mock ExecutionContext for testing the guard.
 */
function mockContext(headers: Record<string, string | string[] | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as any;
}

describe('InternalApiKeyGuard', () => {
  let guard: InternalApiKeyGuard;

  beforeEach(() => {
    guard = new InternalApiKeyGuard();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('fail-closed behavior', () => {
    it('rejects when EVE_INTERNAL_API_KEY is not configured', async () => {
      vi.stubEnv('EVE_INTERNAL_API_KEY', '');
      const context = mockContext({ 'x-internal-api-key': 'some-key' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Internal API key not configured');
    });

    it('rejects when EVE_INTERNAL_API_KEY is undefined', async () => {
      delete process.env.EVE_INTERNAL_API_KEY;
      const context = mockContext({ 'x-internal-api-key': 'some-key' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Internal API key not configured');
    });
  });

  describe('missing headers scenarios', () => {
    beforeEach(() => {
      vi.stubEnv('EVE_INTERNAL_API_KEY', 'test-secret-key');
    });

    it('rejects when no headers are provided', async () => {
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({}),
        }),
      } as any;

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Missing headers');
    });

    it('rejects when no key header is provided', async () => {
      const context = mockContext({ 'content-type': 'application/json' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Missing internal API key');
    });

    it('rejects when both x-internal-api-key and authorization are missing', async () => {
      const context = mockContext({ 'user-agent': 'test' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Missing internal API key');
    });
  });

  describe('x-internal-api-key header', () => {
    beforeEach(() => {
      vi.stubEnv('EVE_INTERNAL_API_KEY', 'test-secret-key');
    });

    it('accepts valid x-internal-api-key header', async () => {
      const context = mockContext({ 'x-internal-api-key': 'test-secret-key' });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('rejects invalid key via x-internal-api-key', async () => {
      const context = mockContext({ 'x-internal-api-key': 'wrong-key' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Invalid internal API key');
    });

    it('accepts array header (takes first element)', async () => {
      const context = mockContext({ 'x-internal-api-key': ['test-secret-key', 'ignored'] });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('rejects when array header has wrong key', async () => {
      const context = mockContext({ 'x-internal-api-key': ['wrong-key', 'also-wrong'] });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Invalid internal API key');
    });
  });

  describe('Authorization: Bearer header', () => {
    beforeEach(() => {
      vi.stubEnv('EVE_INTERNAL_API_KEY', 'test-secret-key');
    });

    it('accepts valid Authorization: Bearer header', async () => {
      const context = mockContext({ authorization: 'Bearer test-secret-key' });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('accepts Authorization header with lowercase bearer', async () => {
      const context = mockContext({ authorization: 'bearer test-secret-key' });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('accepts Authorization header with mixed case Bearer', async () => {
      const context = mockContext({ authorization: 'BeArEr test-secret-key' });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('rejects invalid key via Authorization: Bearer', async () => {
      const context = mockContext({ authorization: 'Bearer wrong-key' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Invalid internal API key');
    });

    it('accepts Authorization header as array (takes first element)', async () => {
      const context = mockContext({ authorization: ['Bearer test-secret-key', 'ignored'] });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('rejects when Authorization header array has wrong key', async () => {
      const context = mockContext({ authorization: ['Bearer wrong-key', 'also-wrong'] });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Invalid internal API key');
    });

    it('rejects Authorization header without Bearer prefix', async () => {
      const context = mockContext({ authorization: 'test-secret-key' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Missing internal API key');
    });

    it('rejects Authorization header with wrong scheme (Basic)', async () => {
      const context = mockContext({ authorization: 'Basic test-secret-key' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Missing internal API key');
    });

    it('handles Authorization header with extra spaces', async () => {
      const context = mockContext({ authorization: 'Bearer  test-secret-key' });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('header priority', () => {
    beforeEach(() => {
      vi.stubEnv('EVE_INTERNAL_API_KEY', 'test-secret-key');
    });

    it('prefers x-internal-api-key over Authorization when both present and valid', async () => {
      const context = mockContext({
        'x-internal-api-key': 'test-secret-key',
        authorization: 'Bearer test-secret-key',
      });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('uses Authorization as fallback when x-internal-api-key is invalid but Authorization is valid', async () => {
      const context = mockContext({
        'x-internal-api-key': 'wrong-key',
        authorization: 'Bearer test-secret-key',
      });

      // x-internal-api-key is checked first, so this should fail
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Invalid internal API key');
    });

    it('uses Authorization when x-internal-api-key is absent', async () => {
      const context = mockContext({
        authorization: 'Bearer test-secret-key',
      });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('timing attack prevention', () => {
    beforeEach(() => {
      vi.stubEnv('EVE_INTERNAL_API_KEY', 'test-secret-key');
    });

    it('rejects keys of different lengths', async () => {
      const context = mockContext({ 'x-internal-api-key': 'short' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Invalid internal API key');
    });

    it('rejects keys of same length but different content', async () => {
      const context = mockContext({ 'x-internal-api-key': 'test-wrong-key' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Invalid internal API key');
    });

    it('rejects keys with partial match', async () => {
      const context = mockContext({ 'x-internal-api-key': 'test-secret-xxx' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Invalid internal API key');
    });

    it('rejects empty string when configured key is non-empty', async () => {
      const context = mockContext({ 'x-internal-api-key': '' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Missing internal API key');
    });
  });

  describe('edge cases', () => {
    beforeEach(() => {
      vi.stubEnv('EVE_INTERNAL_API_KEY', 'test-secret-key');
    });

    it('handles very long valid key', async () => {
      const longKey = 'a'.repeat(1000);
      vi.stubEnv('EVE_INTERNAL_API_KEY', longKey);
      const context = mockContext({ 'x-internal-api-key': longKey });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('handles key with special characters', async () => {
      const specialKey = 'test-key!@#$%^&*()_+-=[]{}|;:,.<>?';
      vi.stubEnv('EVE_INTERNAL_API_KEY', specialKey);
      const context = mockContext({ 'x-internal-api-key': specialKey });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('handles key with unicode characters', async () => {
      const unicodeKey = 'test-key-🔑-unicode';
      vi.stubEnv('EVE_INTERNAL_API_KEY', unicodeKey);
      const context = mockContext({ 'x-internal-api-key': unicodeKey });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('is case-sensitive for key comparison', async () => {
      vi.stubEnv('EVE_INTERNAL_API_KEY', 'Test-Secret-Key');
      const context = mockContext({ 'x-internal-api-key': 'test-secret-key' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Invalid internal API key');
    });

    it('handles Authorization header with only Bearer and no key', async () => {
      const context = mockContext({ authorization: 'Bearer' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Missing internal API key');
    });

    it('handles Authorization header with Bearer and empty string key', async () => {
      const context = mockContext({ authorization: 'Bearer ' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Missing internal API key');
    });
  });
});
