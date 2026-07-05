import type { ReasoningEffort } from '../../types/harness.js';

/**
 * How a harness consumes the normalized reasoning-effort levels:
 * - `thinking_tokens`: mapped to a thinking-token budget (Claude family)
 * - `effort`: mapped to the harness's effort flag values (`x-high` → `xhigh`)
 * - `passthrough`: forwarded as-is
 */
export type ReasoningMode = 'thinking_tokens' | 'effort' | 'passthrough';

const CLAUDE_THINKING_TOKENS: Record<ReasoningEffort, string> = {
  low: '1024',
  medium: '8192',
  high: '16000',
  'x-high': '32000',
};

const EFFORT_LEVELS: Record<ReasoningEffort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  'x-high': 'xhigh',
};

export function mapReasoningForMode(
  mode: ReasoningMode,
  effort?: ReasoningEffort | string,
): string | undefined {
  if (!effort) return undefined;
  if (!['low', 'medium', 'high', 'x-high'].includes(effort)) return undefined;
  const level = effort as ReasoningEffort;

  switch (mode) {
    case 'thinking_tokens':
      return CLAUDE_THINKING_TOKENS[level];
    case 'effort':
      return EFFORT_LEVELS[level];
    case 'passthrough':
      return level;
  }
}
