import { describe, expect, it } from 'vitest';
import { mapReasoningEffort, HARNESS_NAMES, type HarnessName } from '../index.js';

/**
 * Exhaustive lock-down of mapReasoningEffort's observable behavior for every
 * (harness, effort) combination. Written against the pre-refactor
 * implementation (SHD-1) — the refactored mapping must stay byte-identical.
 */

const EFFORTS = ['low', 'medium', 'high', 'x-high'] as const;

const CLAUDE_THINKING_TOKENS = {
  low: '1024',
  medium: '8192',
  high: '16000',
  'x-high': '32000',
} as const;

const EFFORT_LEVELS = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  'x-high': 'xhigh',
} as const;

const PASSTHROUGH = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  'x-high': 'x-high',
} as const;

const EXPECTED: Record<HarnessName, Record<(typeof EFFORTS)[number], string>> = {
  mclaude: CLAUDE_THINKING_TOKENS,
  claude: CLAUDE_THINKING_TOKENS,
  zai: CLAUDE_THINKING_TOKENS,
  gemini: PASSTHROUGH,
  code: EFFORT_LEVELS,
  coder: EFFORT_LEVELS,
  codex: EFFORT_LEVELS,
  pi: EFFORT_LEVELS,
};

describe('mapReasoningEffort (exhaustive)', () => {
  it('covers every harness name', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...HARNESS_NAMES].sort());
  });

  for (const harness of Object.keys(EXPECTED) as HarnessName[]) {
    for (const effort of EFFORTS) {
      it(`${harness} + ${effort} -> ${EXPECTED[harness][effort]}`, () => {
        expect(mapReasoningEffort(harness, effort)).toBe(EXPECTED[harness][effort]);
      });
    }

    it(`${harness} + undefined -> undefined`, () => {
      expect(mapReasoningEffort(harness, undefined)).toBeUndefined();
    });

    it(`${harness} + empty string -> undefined`, () => {
      expect(mapReasoningEffort(harness, '')).toBeUndefined();
    });

    it(`${harness} + unknown level -> undefined`, () => {
      expect(mapReasoningEffort(harness, 'bogus')).toBeUndefined();
      expect(mapReasoningEffort(harness, 'xhigh')).toBeUndefined();
      expect(mapReasoningEffort(harness, 'LOW')).toBeUndefined();
    });
  }
});
