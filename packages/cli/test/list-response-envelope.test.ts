import { describe, expect, it } from 'vitest';
import { unwrapListResponse } from '../src/lib/client';

describe('unwrapListResponse', () => {
  it('returns data[] from canonical envelope', () => {
    const result = unwrapListResponse({ data: [{ id: 'a' }, { id: 'b' }] });
    expect(result).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('supports transitional raw array payloads', () => {
    const result = unwrapListResponse([{ id: 'a' }]);
    expect(result).toEqual([{ id: 'a' }]);
  });

  it('throws on invalid payload shape', () => {
    expect(() => unwrapListResponse({ items: [] } as never)).toThrow(
      'Expected list response envelope with data[]',
    );
  });
});
