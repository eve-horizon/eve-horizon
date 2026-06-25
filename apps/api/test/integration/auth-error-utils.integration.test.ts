import { describe, it, expect } from 'vitest';
import { isAuthErrorMessage } from '@eve/shared';

describe('auth error utils', () => {
  it('detects auth-related error messages', () => {
    expect(isAuthErrorMessage('API Error: 401 Unauthorized')).toBe(true);
    expect(isAuthErrorMessage('OAuth token has expired')).toBe(true);
    expect(isAuthErrorMessage('missing field id_token at line 1')).toBe(true);
    expect(isAuthErrorMessage('run /login to authenticate')).toBe(true);
    expect(isAuthErrorMessage('403 Forbidden')).toBe(true);
    expect(isAuthErrorMessage('invalid_grant error')).toBe(true);
    expect(isAuthErrorMessage('some other failure')).toBe(false);
    expect(isAuthErrorMessage(undefined)).toBe(false);
  });
});
