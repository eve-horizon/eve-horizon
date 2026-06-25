const CLAUDE_OPUS_47_ALIASES = new Set([
  'opus47',
  'opus-4-7',
  'opus-4.7',
  'opus4.7',
  'claudeopus47',
  'claude-opus-4-7',
  'claude-opus-4.7',
  'claude-opus4.7',
  'anthropic/claudeopus47',
  'anthropic/claude-opus-4-7',
  'anthropic/claude-opus-4.7',
  'anthropic/claude-opus4.7',
]);

export function normalizeClaudeCodeModelAlias(model?: string): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;

  const lower = trimmed.toLowerCase();
  const compact = lower.replace(/[\s._-]/g, '');

  if (CLAUDE_OPUS_47_ALIASES.has(lower) || CLAUDE_OPUS_47_ALIASES.has(compact)) {
    return 'opus';
  }

  return trimmed;
}
