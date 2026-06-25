import type { HarnessName } from '../registry.js';

type ReasoningEffort = 'low' | 'medium' | 'high' | 'x-high';

const CLAUDE_THINKING_TOKENS: Record<ReasoningEffort, string> = {
  low: '1024',
  medium: '8192',
  high: '16000',
  'x-high': '32000',
};

const CODE_REASONING_MAP: Record<ReasoningEffort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  'x-high': 'xhigh',
};

const PI_REASONING_MAP: Record<ReasoningEffort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  'x-high': 'xhigh',
};

export function mapReasoningEffort(
  harness: HarnessName,
  effort?: ReasoningEffort | string,
): string | undefined {
  if (!effort) return undefined;
  if (!['low', 'medium', 'high', 'x-high'].includes(effort)) return undefined;

  if (harness === 'mclaude' || harness === 'claude' || harness === 'zai') {
    return CLAUDE_THINKING_TOKENS[effort as ReasoningEffort];
  }

  if (harness === 'code' || harness === 'coder' || harness === 'codex') {
    return CODE_REASONING_MAP[effort as ReasoningEffort];
  }

  if (harness === 'gemini') {
    return effort as ReasoningEffort;
  }

  if (harness === 'pi') {
    return PI_REASONING_MAP[effort as ReasoningEffort] ?? effort;
  }

  return undefined;
}
