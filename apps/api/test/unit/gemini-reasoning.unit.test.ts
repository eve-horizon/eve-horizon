import { describe, expect, it } from 'vitest';
import { mapReasoningEffort } from '@eve/shared';

describe('mapReasoningEffort (gemini)', () => {
  it('returns canonical effort for gemini', () => {
    expect(mapReasoningEffort('gemini', 'low')).toBe('low');
    expect(mapReasoningEffort('gemini', 'medium')).toBe('medium');
    expect(mapReasoningEffort('gemini', 'high')).toBe('high');
    expect(mapReasoningEffort('gemini', 'x-high')).toBe('x-high');
  });

  it('returns mapped values for other harnesses', () => {
    expect(mapReasoningEffort('mclaude', 'low')).toBe('1024');
    expect(mapReasoningEffort('code', 'x-high')).toBe('xhigh');
  });
});
