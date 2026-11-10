import { describe, expect, it } from 'vitest';
import { isInternalApiPath } from '../server/internal-api-guard.js';

describe('isInternalApiPath', () => {
  it('matches /api/internal however it is spelled', () => {
    for (const path of [
      '/api/internal',
      '/api/internal/x?y=/z',
      '/api/%2F%2Finternal/x',
      '/api/%25%36%39nternal/x',
      '/api/x/./../INTERNAL/y',
    ]) {
      expect(isInternalApiPath(path), path).toBe(true);
    }
  });

  it('refuses a path still changing after five rounds of decoding', () => {
    let encoded = 'i';
    for (let i = 0; i < 6; i += 1) encoded = encodeURIComponent(encoded).replace('i', '%69');
    expect(isInternalApiPath(`/api/${encoded}nternal/x`)).toBe(true);
  });

  it('leaves other paths alone', () => {
    for (const path of ['/', '/jobs', '/internal', '/api', '/api/jobs?filter=/api/internal', '/api/internalize', '/apps/internal']) {
      expect(isInternalApiPath(path), path).toBe(false);
    }
  });
});
